import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import type { CanvasModel, LayerModel } from '@atelier/shared';
import { LuminaProjectEngine, type LuminaProjectProgress } from '../src/engine/LuminaProjectEngine';
import { computeProportionalThumbSize } from '../src/engine/layerThumb';
import { OfflineSessionStore } from '../src/services/offlineStore';

const canvas: CanvasModel = {
  id: 'canvas', ownerId: 'owner', title: 'Test project', width: 800, height: 400,
  dpi: 300, bgColor: '#FFFFFF', accessMode: 'whitelist', inviteCode: null, roomPassHash: null,
  latestSeq: 0, createdAt: 1, updatedAt: 1,
};

const layer: LayerModel = {
  id: 'paint', canvasId: canvas.id, name: 'Paint', parentId: null, ownerId: canvas.ownerId,
  layerType: 'raster', blendMode: 'normal', opacity: 1, isVisible: false, isLocked: false,
  alphaLocked: false, clipToBelow: false, sortOrder: 0, aclMode: 'owner_only', isPublic: false,
  createdAt: 1, updatedAt: 1,
};
const mask: LayerModel = { ...layer, id: 'mask', layerType: 'mask', parentId: layer.id };
const group: LayerModel = { ...layer, id: 'group', layerType: 'group', sortOrder: 1 };
const layers = [layer, mask, group];
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XCcAAAAASUVORK5CYII=',
  'base64',
);

function fakeCanvas() {
  return {
    width: 1, height: 1,
    getContext: () => ({ save() {}, restore() {}, fillRect() {}, drawImage() {} }),
    toBlob: (callback: BlobCallback) => callback(new Blob([png], { type: 'image/png' })),
    toDataURL: () => `data:image/png;base64,${png.toString('base64')}`,
  } as unknown as HTMLCanvasElement;
}

const readLayers = async () => [
  { layer, canvas: fakeCanvas(), mask: { id: mask.id, canvas: fakeCanvas(), enabled: true } },
  { layer: group, canvas: fakeCanvas() },
];

function readZipCompression(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  const methods = new Map<string, number>();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    methods.set(buffer.toString('utf8', nameStart, nameStart + nameLength), buffer.readUInt16LE(offset + 8));
    offset = nameStart + nameLength + extraLength + buffer.readUInt32LE(offset + 18);
  }
  return methods;
}

test('thumbnail size preserves portrait, landscape and square proportions', () => {
  assert.deepEqual(computeProportionalThumbSize(5100, 8500), { width: 38, height: 64 });
  assert.deepEqual(computeProportionalThumbSize(1920, 1080), { width: 64, height: 36 });
  assert.deepEqual(computeProportionalThumbSize(2048, 2048), { width: 64, height: 64 });
  assert.deepEqual(computeProportionalThumbSize(1, 5000), { width: 12, height: 64 });
  assert.deepEqual(computeProportionalThumbSize(5000, 1, 48), { width: 48, height: 12 });
});

test('packing reports layer and ZIP progress and stores PNGs without recompressing them', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: fakeCanvas },
  });
  try {
    const progress: LuminaProjectProgress[] = [];
    const packed = await LuminaProjectEngine.packProject(canvas, layers, async () => {
      assert.equal(progress[0]?.stage, 'prepare');
      return readLayers();
    }, (update) => progress.push(update));
    assert.deepEqual([...new Set(progress.map(({ stage }) => stage))], ['prepare', 'layers', 'preview', 'zip']);
    assert.deepEqual(progress.filter(({ stage }) => stage === 'layers').map(({ done, total, percent }) =>
      [done, total, percent]), [[0, 2, 0], [1, 2, 50], [2, 2, 100]]);
    const zipProgress = progress.filter(({ stage }) => stage === 'zip');
    assert.ok(zipProgress.length > 1);
    assert.ok(zipProgress.every(({ done, total, percent }, index) =>
      done === percent && total === 100 && percent >= (zipProgress[index - 1]?.percent ?? 0) && percent <= 100));
    assert.equal(zipProgress.at(-1)?.percent, 100);

    const methods = readZipCompression(packed.uint8);
    const zip = await JSZip.loadAsync(packed.uint8, { checkCRC32: true });
    for (const name of ['layers/layer_paint.png', 'layers/layer_mask.png', 'preview.png']) {
      assert.equal(methods.get(name), 0, name); // ZIP STORE
      assert.deepEqual(await zip.file(name)?.async('nodebuffer'), png);
    }
    for (const name of ['layers/hierarchy.json', 'vectors.json', 'animation.json', 'project.json']) {
      assert.equal(methods.get(name), 8, name); // ZIP DEFLATE
    }
    assert.equal(zip.file('layers/layer_group.png'), null);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('save-as forwards progress through the desktop write and returns a cancellation', async (t) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: fakeCanvas } });
  const progress: LuminaProjectProgress[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      atelierDesktop: {
        async saveLuminaFile(payload: { defaultName: string; existingFilePath?: string; data: Uint8Array }) {
          assert.match(payload.defaultName, /\.lumina$/);
          assert.equal(payload.existingFilePath, undefined);
          assert.ok(payload.data.length > 0);
          assert.equal(progress.at(-1)?.stage, 'write');
          return { saved: false };
        },
      },
    },
  });
  const associatePath = t.mock.method(OfflineSessionStore, 'setCanvasFilePath', () => {});
  assert.deepEqual(await LuminaProjectEngine.saveProject(canvas, layers, readLayers, {
    saveAs: true,
    onProgress: (update) => progress.push(update),
  }), { saved: false });
  assert.ok(progress.some(({ stage }) => stage === 'zip'));
  assert.equal(associatePath.mock.callCount(), 0);
});
