import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  canUserPerformLayerAction,
  computeGroupedAscendingNonMaskIds,
  computeTidiedAscendingNonMaskIds,
  filterTopLevelSelectedLayers,
  findTopAnchorForParent,
  orderLayersForReparenting,
  selectLayerRange,
  tidyLayerModels,
  type LayerModel,
  type TileData,
  type VectorStroke,
} from '@atelier/shared';
import { LayerManager } from '../src/engine/LayerManager.ts';
import { ScopedUndoManager } from '../src/engine/ScopedUndoManager.ts';
import { LayerHierarchy, resolveLayerClipBases } from '../src/engine/layerHierarchy.ts';
import { compositeLayers, type LayerCanvasItem } from '../src/engine/layerComposite.ts';
import {
  collectGroupTransformLayers, groupTransformPreview, liftTransformPixels, pushGroupTransformUndo,
  readTransformContentBounds, transformGroupVectorStroke, transformRect, unionTransformBounds,
} from '../src/components/workspace/tools/groupTransform.ts';
import type { Renderer } from 'pixi.js';

function mkLayer(overrides: Partial<LayerModel> & { id: string; sortOrder: number }): LayerModel {
  return {
    canvasId: 'c1',
    parentId: null,
    ownerId: 'u1',
    name: overrides.id,
    layerType: 'raster',
    blendMode: 'normal',
    opacity: 1,
    isVisible: true,
    isLocked: false,
    alphaLocked: false,
    clipToBelow: false,
    aclMode: 'owner_only',
    isPublic: true,
    createdAt: overrides.sortOrder,
    updatedAt: overrides.sortOrder,
    ...overrides,
  };
}

test('folder transform collects editable nested raster, vector and mask layers', () => {
  const layers = [
    mkLayer({ id: 'parent', sortOrder: 100, layerType: 'group' }),
    mkLayer({ id: 'group', sortOrder: 90, parentId: 'parent', layerType: 'group' }),
    mkLayer({ id: 'nested', sortOrder: 60, parentId: 'group', layerType: 'group' }),
    mkLayer({ id: 'hidden-vector', sortOrder: 30, parentId: 'nested', layerType: 'vector', isVisible: false }),
    mkLayer({ id: 'mask', sortOrder: 20, parentId: 'raster', layerType: 'mask' }),
    mkLayer({ id: 'raster', sortOrder: 10, parentId: 'group' }),
    mkLayer({ id: 'adjustment', sortOrder: 40, parentId: 'group', layerType: 'adjustment' }),
    mkLayer({ id: 'adjustment-mask', sortOrder: 41, parentId: 'adjustment', layerType: 'mask' }),
    mkLayer({ id: 'locked-group', sortOrder: 70, parentId: 'group', layerType: 'group', isLocked: true }),
    mkLayer({ id: 'locked-branch', sortOrder: 65, parentId: 'locked-group' }),
    mkLayer({ id: 'locked-raster', sortOrder: 45, parentId: 'nested', isLocked: true }),
    mkLayer({ id: 'locked-mask', sortOrder: 46, parentId: 'locked-raster', layerType: 'mask' }),
    mkLayer({ id: 'no-permission', sortOrder: 50, parentId: 'group', ownerId: 'u2' }),
    mkLayer({ id: 'other', sortOrder: 5, parentId: 'parent' }),
  ];
  const canEdit = (layer: LayerModel) => layer.ownerId === 'u1';
  assert.deepEqual(collectGroupTransformLayers(layers, 'group', canEdit).map(({ id }) => id),
    ['raster', 'mask', 'hidden-vector', 'adjustment-mask']);
  for (const lockedId of ['parent', 'group']) {
    assert.deepEqual(collectGroupTransformLayers(
      layers.map((layer) => layer.id === lockedId ? { ...layer, isLocked: true } : layer), 'group', canEdit,
    ), []);
  }
  assert.deepEqual(collectGroupTransformLayers(layers, 'group', () => false), []);
});

test('folder transform unions actual alpha bounds and uses inclusive selection coordinates', async () => {
  const manager = {
    occupiedTiles(id: string) {
      if (id === 'empty') return [];
      return id === 'left' ? [{ col: 0, row: 1 }] : [{ col: 2, row: 0 }];
    },
    async readAsync(id: string, [rect]: Array<{ x: number; y: number; w: number; h: number }>) {
      const pixels = new Uint8Array(rect.w * rect.h * 4);
      pixels[((id === 'left' ? 1 : 0) * rect.w + 2) * 4 + 3] = 255;
      return [pixels];
    },
  } as unknown as LayerManager;
  const boundsOf = (id: string) => readTransformContentBounds(manager, id, 24, 20, 8, () => true);
  const bounds = unionTransformBounds(await Promise.all(['left', 'empty', 'right'].map(boundsOf)));
  assert.deepEqual(bounds, { minX: 2, minY: 0, maxX: 19, maxY: 10 });
  assert.deepEqual(transformRect(bounds!, 24, 20, false), { x: 2, y: 0, w: 17, h: 10 });
  assert.deepEqual(transformRect({ minX: 4, minY: 5, maxX: 4, maxY: 5 }, 24, 20, true),
    { x: 4, y: 5, w: 1, h: 1 });
  assert.equal(unionTransformBounds([null]), null);
  await assert.rejects(readTransformContentBounds(manager, 'left', 24, 20, 8, () => false), RangeError);
});

test('folder transform records all child edits as one undo and redo step', () => {
  const undo = new ScopedUndoManager();
  const tile = (col: number, row: number): TileData =>
    ({ col, row, width: 1, height: 1, compression: 'raw', data: new Uint8Array(4) });
  const edits = ['raster', 'mask', 'vector'].map((layerId, index) => ({
    layerId,
    beforeTiles: [tile(index, 0)],
    afterTiles: [tile(index, 1)],
  }));
  pushGroupTransformUndo(undo, 'folder-edit', edits, 'user', 'Folder transform', null, null);
  assert.deepEqual(undo.undoGroup('user', (layerId) => layerId !== 'mask'), []);
  const undone = undo.undoGroup('user');
  assert.deepEqual(undone.map(({ layerId, groupId }) => [layerId, groupId]),
    [['vector', 'folder-edit'], ['mask', 'folder-edit'], ['raster', 'folder-edit']]);
  assert.deepEqual(undone[0].beforeTiles, edits[2].beforeTiles);
  assert.equal(undo.canUndo('user'), false);
  const redone = undo.redoGroup('user');
  assert.deepEqual(redone.map(({ layerId }) => layerId), ['raster', 'mask', 'vector']);
  assert.deepEqual(redone[1].afterTiles, edits[1].afterTiles);
  assert.equal(undo.canRedo('user'), false);
});

test('whole-layer folder transforms also move editable vector anchors and handles', () => {
  const stroke: VectorStroke = {
    id: 'stroke', layerId: 'vector', color: '#000000', opacity: 1, baseWidth: 2, createdAt: 0,
    anchors: [
      { x: 10, y: 10, cp2x: 11, cp2y: 10, width: 2, pressure: 1 },
      { x: 14, y: 10, cp1x: 13, cp1y: 10, width: 2, pressure: 1 },
    ],
    bounds: { minX: 9, minY: 9, maxX: 15, maxY: 11 },
  };
  const moved = transformGroupVectorStroke(stroke,
    { x: 10, y: 10, width: 4, height: 4, rotation: 0 },
    { x: 20, y: 20, width: 8, height: 8, rotation: Math.PI / 2 });
  assert.deepEqual(moved.anchors, [
    { x: 28, y: 20, cp2x: 28, cp2y: 22, width: 4, pressure: 1 },
    { x: 28, y: 28, cp1x: 28, cp1y: 26, width: 4, pressure: 1 },
  ]);
  assert.equal(moved.layerId, stroke.layerId);
  assert.equal(moved.baseWidth, 4);
  assert.equal(stroke.anchors[0].x, 10);
});

test('clipping chains resolve only non-mask siblings, including folders and hidden bases', () => {
  const layers = [
    mkLayer({ id: 'base', sortOrder: 10 }),
    mkLayer({ id: 'base-mask', sortOrder: 11, parentId: 'base', layerType: 'mask' }),
    mkLayer({ id: 'inside', sortOrder: 20, parentId: 'folder', clipToBelow: true }),
    mkLayer({ id: 'folder', sortOrder: 30, layerType: 'group', clipToBelow: true }),
    mkLayer({ id: 'second', sortOrder: 40, layerType: 'group', clipToBelow: true }),
    mkLayer({ id: 'above', sortOrder: 50, clipToBelow: true }),
    mkLayer({ id: 'group-base', sortOrder: 60, layerType: 'group', isVisible: false }),
    mkLayer({ id: 'shade', sortOrder: 70, clipToBelow: true }),
  ];
  const clipBases = resolveLayerClipBases([...layers].reverse());
  assert.equal(clipBases.has('base-mask'), false);
  assert.equal(clipBases.get('inside'), null);
  assert.equal(clipBases.get('folder'), 'base');
  assert.equal(clipBases.get('second'), 'base');
  assert.equal(clipBases.get('above'), 'base');
  assert.equal(clipBases.get('shade'), 'group-base');
  const hierarchy = new LayerHierarchy(layers);
  assert.equal(hierarchy.visible(hierarchy.byId.get('shade')!), false);
  const hiddenBase = new LayerHierarchy(layers.map((layer) => layer.id === 'base' ? { ...layer, isVisible: false } : layer));
  assert.equal(hiddenBase.visible(hiddenBase.byId.get('inside')!), false);
  assert.equal(hiddenBase.visible(hiddenBase.byId.get('above')!), false);
});

test('folder fill references enumerate visible raster and vector descendants across nested folders', async (t) => {
  installTestCanvas(t);
  const layers = [
    mkLayer({ id: 'outer', sortOrder: 70, layerType: 'group' }),
    mkLayer({ id: 'raster', sortOrder: 10, parentId: 'outer' }),
    mkLayer({ id: 'ignored', sortOrder: 20, parentId: 'outer', isVisible: false }),
    mkLayer({ id: 'vector', sortOrder: 30, parentId: 'inner', layerType: 'vector' }),
    mkLayer({ id: 'inner', sortOrder: 40, parentId: 'outer', layerType: 'group' }),
    mkLayer({ id: 'inner-mask', sortOrder: 45, parentId: 'inner', layerType: 'mask' }),
    mkLayer({ id: 'isolated', sortOrder: 50, parentId: 'hidden', layerType: 'vector' }),
    mkLayer({ id: 'hidden', sortOrder: 60, parentId: 'outer', layerType: 'group', isVisible: false }),
    mkLayer({ id: 'outside', sortOrder: 80 }),
  ];
  const hierarchy = new LayerHierarchy(layers);
  assert.deepEqual(hierarchy.visibleGroupLayers('outer').map(({ id }) => id), ['raster', 'vector']);
  assert.deepEqual(hierarchy.visibleGroupLayers('hidden'), []);
  const manager = new LayerManager({ render() {} } as Renderer, 16, 16);
  try {
    manager.syncLayers(layers);
    assert.equal(manager.isGroup('outer'), true);
    assert.equal(manager.isGroup('raster'), false);
    assert.equal(manager.isGroupEmpty('hidden'), true);
    const rects = [{ x: 1, y: 1, w: 2, h: 1 }];
    assert.deepEqual(await manager.readGroupRegionsAsync('hidden', rects), [new Uint8Array(8)]);
    const before = manager.getGroupCompositeVersion('outer');
    manager.clearLayer('outside');
    assert.equal(manager.getGroupCompositeVersion('outer'), before);
    manager.clearLayer('vector');
    assert.notEqual(manager.getGroupCompositeVersion('outer'), before);
  } finally {
    manager.destroy();
  }
});

// Small straight-RGBA canvas for the pixel tests, which run in Node without a DOM.
class TestCanvas {
  width = 3;
  height = 1;
  pixels = new Uint8ClampedArray(12);
  private states: Array<[number, string]> = [];
  private readonly context = {
    canvas: this,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save: () => this.states.push([this.context.globalAlpha, this.context.globalCompositeOperation]),
    restore: () => {
      [this.context.globalAlpha, this.context.globalCompositeOperation] = this.states.pop()!;
    },
    getImageData: () => ({ data: this.pixels.slice(0, this.width * this.height * 4) }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: ({ data }: { data: Uint8ClampedArray }) => { this.pixels.set(data); },
    clearRect: () => this.pixels.fill(0),
    drawImage: (source: TestCanvas) => {
      const { globalAlpha, globalCompositeOperation: op } = this.context;
      for (let i = 0; i < this.width * this.height * 4; i += 4) {
        const a = (source.pixels[i + 3] ?? 0) / 255 * globalAlpha;
        const b = this.pixels[i + 3] / 255;
        if (op === 'destination-in') {
          this.pixels[i + 3] = 255 * a * b;
          continue;
        }
        const alpha = a + b * (1 - a);
        for (let c = 0; c < 3; c++) {
          const s = source.pixels[i + c] / 255;
          const d = this.pixels[i + c] / 255;
          let blend = s;
          if (op === 'multiply') blend = s * d;
          if (op === 'screen') blend = s + d - s * d;
          if (op === 'soft-light') {
            const curve = d <= 0.25 ? ((16 * d - 12) * d + 4) * d : Math.sqrt(d);
            blend = s <= 0.5 ? d - (1 - 2 * s) * d * (1 - d) : d + (2 * s - 1) * (curve - d);
          }
          this.pixels[i + c] = alpha ? 255 * (s * a * (1 - b) + blend * a * b + d * b * (1 - a)) / alpha : 0;
        }
        this.pixels[i + 3] = 255 * alpha;
      }
    },
  };

  getContext(type = '2d') { return type === '2d' ? this.context : null; }
}

function testCanvas(...pixels: number[][]): HTMLCanvasElement {
  const canvas = new TestCanvas();
  canvas.pixels.set(pixels.flat());
  return canvas as unknown as HTMLCanvasElement;
}

function compositePixels(items: LayerCanvasItem[]): number[][] {
  const merged = compositeLayers(items, 3, 1, null);
  const { data } = merged.getContext('2d')!.getImageData(0, 0, 3, 1);
  return [0, 4, 8].map((offset) => Array.from(data.slice(offset, offset + 4)));
}

function installTestCanvas(t: TestContext): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { createElement: () => new TestCanvas() },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
}

test('pinning a folder’s transform targets keeps sparse layers sparse across layer sync', (t) => {
  installTestCanvas(t);
  const layers = [mkLayer({ id: 'first', sortOrder: 10 }), mkLayer({ id: 'second', sortOrder: 20 })];
  const manager = new LayerManager({ render() {} } as Renderer, 16, 16);
  try {
    manager.syncLayers(layers);
    manager.pin('transform', ['first', 'second']);
    manager.syncLayers(layers.map((layer) => ({ ...layer })));
    assert.deepEqual(manager.occupiedTiles('first'), []);
    assert.deepEqual(manager.occupiedTiles('second'), []);
    manager.pin('transform', null);
  } finally {
    manager.destroy();
  }
});

test('folder transform previews feathered pixels in layer order with masks and opacity', (t) => {
  installTestCanvas(t);
  const pixels = new Uint8Array([64, 0, 0, 128, 0, 0, 0, 0, 255, 0, 0, 255]);
  const coverage = new Uint8ClampedArray([0, 0, 0, 128, 0, 0, 0, 255, 0, 0, 0, 0]);
  const lifted = liftTransformPixels(pixels, 3, 1, coverage);
  assert.deepEqual(Array.from(pixels), [31, 0, 0, 63, 0, 0, 0, 0, 255, 0, 0, 255]);
  assert.deepEqual(Array.from(lifted.getContext('2d')!.getImageData(0, 0, 3, 1).data.slice(0, 4)), [128, 0, 0, 64]);

  const layers = [
    mkLayer({ id: 'group', sortOrder: 40, layerType: 'group', opacity: 0.5 }),
    mkLayer({ id: 'hidden', sortOrder: 31, parentId: 'group', isVisible: false }),
    mkLayer({ id: 'top', sortOrder: 30, parentId: 'group', blendMode: 'multiply' }),
    mkLayer({ id: 'bottom', sortOrder: 10, parentId: 'group' }),
    mkLayer({ id: 'mask', sortOrder: 11, parentId: 'top', layerType: 'mask' }),
  ];
  const preview = groupTransformPreview(layers, new Map([
    ['top', testCanvas([0, 255, 0, 255], [0, 255, 0, 255])],
    ['bottom', testCanvas([128, 128, 128, 255])],
    ['mask', testCanvas([255, 255, 255, 255])],
    ['hidden', testCanvas([255, 0, 0, 255], [255, 0, 0, 255])],
  ]), 3, 1);
  const { data } = preview.getContext('2d')!.getImageData(0, 0, 3, 1);
  assert.deepEqual(Array.from(data.slice(0, 8)), [43, 170, 43, 192, 0, 0, 0, 0]);
});

test('folder blending applies once to assembled content at folder opacity', (t) => {
  installTestCanvas(t);
  const grey = (value: number) => [value, value, value, 255];
  const make = (layer: LayerModel, canvas = testCanvas()): LayerCanvasItem => ({ layer, canvas });
  for (const [blendMode, result] of [['multiply', 112], ['screen', 176], ['soft_light', 141]] as const) {
    const items = [
      make(mkLayer({ id: 'base', sortOrder: 10 }), testCanvas(grey(128))),
      make(mkLayer({ id: 'child1', sortOrder: 20, parentId: 'folder' }), testCanvas(grey(64))),
      make(mkLayer({ id: 'child2', sortOrder: 30, parentId: 'folder' }), testCanvas(grey(192), grey(192))),
      make(mkLayer({ id: 'folder', sortOrder: 40, layerType: 'group', blendMode, opacity: 0.5 })),
    ];
    const pixels = compositePixels(items);
    assert.deepEqual(pixels[0], grey(result), blendMode);
    assert.deepEqual(pixels[1], [192, 192, 192, 128], blendMode);
  }
});

test('nested clipped folders use the entire masked base silhouette and preserve nested effects', (t) => {
  installTestCanvas(t);
  const clear = [0, 0, 0, 0], blue = [0, 0, 255, 255], green = [0, 255, 0, 255], red = [255, 0, 0, 255];
  const white = [255, 255, 255, 255], black = [0, 0, 0, 255];
  const make = (layer: LayerModel, canvas = testCanvas()): LayerCanvasItem => ({ layer, canvas });
  const base = {
    ...make(mkLayer({ id: 'base-group', sortOrder: 40, layerType: 'group' })),
    mask: { enabled: true, canvas: testCanvas([128, 128, 128, 255], white, black) },
  };
  const items = [
    make(mkLayer({ id: 'base-a', sortOrder: 20, parentId: 'base-group' }), testCanvas(blue, clear, blue)),
    make(mkLayer({ id: 'base-b', sortOrder: 30, parentId: 'base-group' }), testCanvas(clear, blue)),
    base,
    make(mkLayer({ id: 'content', sortOrder: 50, parentId: 'inner' }), testCanvas(red, red, red)),
    make(mkLayer({ id: 'inner', sortOrder: 60, layerType: 'group', parentId: 'styled', opacity: 0.5,
      meta: { effects: { enabled: true, colorOverlay: { enabled: true, color: '#00ff00', opacity: 1 } } } })),
    make(mkLayer({ id: 'styled', sortOrder: 70, layerType: 'group', clipToBelow: true })),
    make(mkLayer({ id: 'above', sortOrder: 80, clipToBelow: true }), testCanvas(clear, green, green)),
  ];
  assert.deepEqual(compositePixels(items), [[0, 102, 153, 160], green, clear]);
  base.layer.isVisible = false;
  assert.deepEqual(compositePixels(items), [clear, clear, clear]);
});

function verifySequentialReparenting(
  initial: LayerModel[],
  roots: LayerModel[],
  target: string | null,
  ascendingIds: string[],
  expectedMembers: string[],
): LayerModel[] {
  let layers = tidyLayerModels(initial).layers;
  const memberIds = () => layers.filter((l) => l.layerType !== 'mask' && l.parentId === target).map((l) => l.id);
  for (const { id } of orderLayersForReparenting(initial, roots, target)) {
    // Each parent update normalizes the whole tree in the offline store and multiplayer server.
    layers = tidyLayerModels(layers.map((l) => l.id === id ? { ...l, parentId: target } : l)).layers;
    const members = memberIds();
    assert.ok(members.includes(id));
    assert.deepEqual(members, expectedMembers.filter((member) => members.includes(member)), `after moving ${id}`);
  }
  assert.deepEqual(memberIds(), expectedMembers);

  const order = new Map(ascendingIds.map((id, i) => [id, (i + 1) * 10]));
  layers = tidyLayerModels(layers.map((l) => ({ ...l, sortOrder: order.get(l.id) ?? l.sortOrder }))).layers;
  assert.deepEqual(memberIds(), expectedMembers, 'after final reorder');
  assert.deepEqual(layers.filter((l) => l.layerType !== 'mask').map((l) => l.id), ascendingIds);
  return layers;
}

test('folders retain management permissions and reject pixel operations even for admins', () => {
  const folder = { id: 'folder', layerType: 'group', ownerId: 'admin', isLocked: false } as LayerModel;
  const context = { user: { id: 'admin', serverRole: 'admin' as const }, layer: folder };
  for (const action of ['draw', 'erase', 'filter'] as const) {
    assert.equal(canUserPerformLayerAction(context, action).allowed, false);
  }
  assert.equal(canUserPerformLayerAction(context, 'modify_props').allowed, true);
  assert.equal(canUserPerformLayerAction({ ...context, layer: { ...folder, layerType: 'raster' } }, 'draw').allowed, true);
});

test('duplicate layer responses cannot create duplicate Pixi children or folder textures', () => {
  const manager = new LayerManager({ render() {} } as Renderer, 64, 64);
  const raster = { id: 'a', name: 'A', sortOrder: 10, layerType: 'raster', opacity: 1, isVisible: true, blendMode: 'normal' } as LayerModel;
  const folder = { ...raster, id: 'folder', layerType: 'group' as const, sortOrder: 20, opacity: 0.5 };
  const child = { ...raster, id: 'b', sortOrder: 30, parentId: folder.id };
  try {
    manager.syncLayers([raster, folder, child, child]);
    assert.equal(manager.layersContainer.children.length, 2);
    assert.equal(manager.getLayerItem(folder.id), undefined);
    assert.equal(manager.getLayerItem(child.id)?.display.alpha, 0.5);
  } finally {
    manager.destroy();
  }
});

test('non-contiguous layers grouped together move directly underneath their new group in display order', () => {
  // Bottom-to-top initial stack: L2(10), SF_bottom(20), SF_pick(30), 9-5(40), L5(50), L6(60), L7_pick(70)
  const initial: LayerModel[] = [
    mkLayer({ id: 'L2', sortOrder: 10 }),
    mkLayer({ id: 'SF_bottom', sortOrder: 20 }),
    mkLayer({ id: 'SF_pick', sortOrder: 30 }),
    mkLayer({ id: '9-5', sortOrder: 40 }),
    mkLayer({ id: 'L5', sortOrder: 50 }),
    mkLayer({ id: 'L6', sortOrder: 60 }),
    mkLayer({ id: 'L7_pick', sortOrder: 70 }),
  ];

  const selected = filterTopLevelSelectedLayers(initial, ['L7_pick', 'SF_pick']);
  assert.deepEqual(selected.map((l) => l.id), ['SF_pick', 'L7_pick']);

  const top = selected[selected.length - 1];
  const anchor = findTopAnchorForParent(initial, top, null);
  assert.equal(anchor.id, 'L7_pick');

  const group = mkLayer({ id: 'G1', layerType: 'group', sortOrder: anchor.sortOrder + 5 });
  const ascending = computeGroupedAscendingNonMaskIds(initial, group, anchor.id, null, new Set(['SF_pick', 'L7_pick']));
  const descending = [...ascending].reverse();
  // Display order (top-to-bottom): G1 -> L7_pick -> SF_pick -> L6 -> L5 -> 9-5 -> SF_bottom -> L2
  assert.deepEqual(descending, ['G1', 'L7_pick', 'SF_pick', 'L6', 'L5', '9-5', 'SF_bottom', 'L2']);

  // Verify masks stay attached to their moved owners
  const mask = mkLayer({ id: 'M_SF', layerType: 'mask', parentId: 'SF_pick', sortOrder: 35 });
  const withMask = verifySequentialReparenting([...initial, group, mask], selected, group.id, ascending, ['SF_pick', 'L7_pick']);
  const sfIdx = withMask.findIndex((l) => l.id === 'SF_pick');
  assert.equal(withMask[sfIdx + 1]?.id, 'M_SF');
});

for (const { count, selectedIds, expected } of [
  { count: 7, selectedIds: ['L1', 'L4', 'L7'], expected: ['L2', 'L3', 'L5', 'L6', 'L1', 'L4', 'L7', 'G1'] },
  { count: 5, selectedIds: ['L1', 'L3'], expected: ['L2', 'L1', 'L3', 'G1', 'L4', 'L5'] },
]) {
  test(`grouping ${selectedIds.join(', ')} preserves the order and respects the anchor`, () => {
    const initial = Array.from({ length: count }, (_, i) => mkLayer({ id: `L${i + 1}`, sortOrder: (i + 1) * 10 }));
    const roots = filterTopLevelSelectedLayers(initial, selectedIds);
    const anchor = findTopAnchorForParent(initial, roots.at(-1)!, null);
    const group = mkLayer({ id: 'G1', layerType: 'group', sortOrder: anchor.sortOrder + 5 });
    const staleGroup = { ...group, sortOrder: 1000 };
    const ascendingIds = computeGroupedAscendingNonMaskIds([...initial, staleGroup], staleGroup, anchor.id, null, new Set(selectedIds));
    assert.deepEqual(ascendingIds, expected);
    verifySequentialReparenting([...initial, group], roots, group.id, ascendingIds, selectedIds);
  });
}

for (const { label, stack, target, members } of [
  { label: 'a group above', stack: ['L1', 'keep', 'L2', 'L3', 'G'], target: 'G', members: ['L1', 'L2', 'L3'] },
  { label: 'a group above with children', stack: ['L1', 'keep', 'L2', 'L3', 'C1', 'C2', 'G'], target: 'G', members: ['L1', 'L2', 'L3', 'C1', 'C2'] },
  { label: 'a group below', stack: ['G', 'L1', 'keep', 'L2', 'L3'], target: 'G', members: ['L1', 'L2', 'L3'] },
  { label: 'a group between the selected layers', stack: ['L1', 'C1', 'C2', 'G', 'L2', 'keep', 'L3'], target: 'G', members: ['L1', 'C1', 'C2', 'L2', 'L3'] },
  { label: 'the root stack', stack: ['keep', 'L1', 'C1', 'L2', 'L3', 'G'], target: null, members: ['keep', 'L1', 'L2', 'L3', 'G'] },
]) {
  test(`moving layers to ${label} keeps their order after every update`, () => {
    const selected = new Set(['L1', 'L2', 'L3']);
    const initial = stack.map((id, i) => mkLayer({
      id,
      sortOrder: (i + 1) * 10,
      layerType: id === 'G' ? 'group' : 'raster',
      parentId: id.startsWith('C') || (target === null && selected.has(id)) ? 'G' : null,
    }));
    const roots = filterTopLevelSelectedLayers(initial, selected);
    const patched = initial.map((l) => selected.has(l.id) ? { ...l, parentId: target } : l);
    const ascendingIds = computeTidiedAscendingNonMaskIds(patched);
    verifySequentialReparenting(initial, roots, target, ascendingIds, members);
  });
}

test('grouping a nested folder along with its child keeps the child inside the inner folder', () => {
  const layers: LayerModel[] = [
    mkLayer({ id: 'inner_child', parentId: 'inner_group', sortOrder: 10 }),
    mkLayer({ id: 'inner_group', layerType: 'group', sortOrder: 20 }),
    mkLayer({ id: 'outer_layer', sortOrder: 30 }),
  ];
  const roots = filterTopLevelSelectedLayers(layers, ['inner_group', 'inner_child', 'outer_layer']);
  assert.deepEqual(roots.map((l) => l.id), ['inner_group', 'outer_layer']);
});

test('selectLayerRange supports Shift+click and Shift+drag sweep (forward, backward, and additive)', () => {
  const visible = ['L7', 'L6', 'L5', 'L4', 'L3', 'L2'];
  // Sweep downward from L6 to L3
  assert.deepEqual([...selectLayerRange(visible, 'L6', 'L3')], ['L6', 'L5', 'L4', 'L3']);
  // Sweep upward from L3 to L6
  assert.deepEqual([...selectLayerRange(visible, 'L3', 'L6')], ['L6', 'L5', 'L4', 'L3']);
  // Shrink sweep back to L5
  assert.deepEqual([...selectLayerRange(visible, 'L6', 'L5')], ['L6', 'L5']);
  // Additive range (Ctrl+Shift) preserves previous selection
  const existing = new Set(['L2']);
  assert.deepEqual([...selectLayerRange(visible, 'L7', 'L6', true, existing)], ['L2', 'L7', 'L6']);
});
