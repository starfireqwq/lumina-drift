/**
 * Self-check for the pure UI logic added in the workspace redesign.
 * Run: npx tsx apps/client/scripts/ui-logic.check.ts   (from the repo root; exits non-zero on failure)
 */
import assert from 'node:assert/strict';
import { FLOATS_PER_DAB, StrokeWorkerEngine, type WorkerBrushConfig } from '../src/workers/stroke.worker';
import { contrastRatio, resolveTheme, THEME_PRESETS, DEFAULT_CUSTOM_THEME } from '../src/theme/themes';
import { nextSizeStep } from '../src/components/workspace/toolCatalog';
import { findContentBounds } from '../src/utils/pixelBounds';
import { applyColorOutline } from '../src/engine/colorOutline';
import { healUnderMask } from '../src/engine/VectorEngine';
import { ScopedUndoManager } from '../src/engine/ScopedUndoManager';
import {
  Affine2D,
  computeSmartEncloseFillMask,
  DynamicStabilizer,
  clampDpi,
  evaluateEasing,
  evaluateTransformKeyframes,
  formatCanvasDimensions,
  MAX_STABILIZER_LEVEL,
  multiplyAffine,
  pixelsToUnit,
  STABILIZER_LEVEL_STEP,
  tileToRgba,
  type ScopedUndoOp,
  type TileData,
  transformToAffineMatrix,
  unitToPixels,
} from '@atelier/shared';
import { getBoxPivotCanvasPoint, type TransformBox } from '../src/utils/transformProjection';
import { AnimationEngine, animationDisplay, celEntriesOf, celOfLayer, entryIndexAt, placeEntries, removeTransformKeyframe, timeOfCel, trackLength, upsertTransformKeyframe } from '../src/engine/AnimationEngine';
import { nextGroupName } from '../src/utils/canvasName';
import { verticalRuns } from '../src/engine/textLayer';
import { deleteAnchor, isCornerAnchor, moveHandle, penPointsToAnchors, toggleCorner } from '../src/engine/vectorEditing';
import {
  barycentricToHsv,
  clampPointToTriangleBarycentric,
  getTriangleVertices,
  hslToRgb,
  hsvToBarycentric,
  hsvToRgb,
  rgbToHsl,
  rgbToHsv,
} from '../src/utils/colorWheelMath';
import { getDockLayout } from '../src/components/workspace/dockStore';
import { buildCanvasGroupEntries, toggleCollapsedCanvasGroup } from '../src/utils/canvasGroups';
import { buildRoomShareUrl } from '../src/utils/serverLinks';
import { DEFAULT_COMMUNITY_PRESETS, MIN_BRUSH_SPACING, type CanvasModel } from '@atelier/shared';

const hex = (channels: string) => `#${channels.split(' ').map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;

// Every preset keeps body text, strong text and accent text readable on panels
for (const preset of [...THEME_PRESETS.map((p) => p.id), 'custom' as const]) {
  const { vars } = resolveTheme(preset, DEFAULT_CUSTOM_THEME);
  const panel = hex(vars['--n-900']);
  assert.ok(contrastRatio(hex(vars['--n-200']), panel) >= 4.5, `${preset}: body text contrast`);
  assert.ok(contrastRatio(hex(vars['--text-strong']), panel) >= 7, `${preset}: strong text contrast`);
  assert.ok(contrastRatio(hex(vars['--n-400']), panel) >= 3, `${preset}: muted text contrast`);
  assert.ok(contrastRatio(hex(vars['--a-300']), panel) >= 3, `${preset}: accent text contrast`);
}

// A fast stroke or a zoomed-out view can leave hundreds of canvas pixels between pointer events.
{
  const config: WorkerBrushConfig = {
    size: 12, minSize: 12, hardness: 1, flow: 1, spacing: 0.02, opacity: 1,
    stabilizerLevel: 0, isEraser: false, scatter: 0,
  };
  function draw(xs: number[], brush = config) {
    const engine = new StrokeWorkerEngine();
    const point = (x: number) => ({ x, y: 48, pressure: 1 });
    const batches = [engine.initStroke(brush, point(0))];
    for (const x of xs) batches.push(engine.addRawPoints([point(x)]));
    batches.push(engine.finishStroke(point(960)));
    return batches.flatMap((batch) => Array.from(batch).filter((_, i) => i % FLOATS_PER_DAB === 0));
  }
  const fast = draw([480]);
  const slow = draw(Array.from({ length: 95 }, (_, i) => (i + 1) * 10));
  const maxGap = (xs: number[]) => xs.reduce((gap, x, i) => i ? Math.max(gap, x - xs[i - 1]) : gap, 0);
  assert.ok(maxGap(fast) <= 0.801, `fast brush spacing: ${maxGap(fast)} px`);
  assert.ok(maxGap(slow) <= 0.801, `slow brush spacing: ${maxGap(slow)} px`);
  assert.equal(fast.length, slow.length, 'speed leaves dab density unchanged');
  assert.equal(fast.length, 1201, 'one initial dab plus one dab every 0.8 px');
  assert.ok(fast.at(-1)! >= 959.2, 'the worker finishes the entire fast stroke');
  const spaced = draw([480], { ...config, spacing: 1.5 });
  assert.ok(Math.abs(maxGap(spaced) - 18) < 0.001, 'intentional wide spacing remains available');
}

// Stabilizer: a shaky straight line must not coil (levels 1–3 used to ring like a phone cord),
// must not run past where the pen stopped, and must end where the pen lifted
{
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  // 100 → 900 in 250 ms (fast), minimum-jerk speed, ±1 px tremor, 120 Hz, then 150 ms resting at 900
  const pts: Array<{ x: number; y: number; pressure: number; time: number }> = [];
  for (let t = 0; t <= 250; t += 1000 / 120) {
    const s = t / 250, e = 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5;
    pts.push({ x: 100 + 800 * e + rand(), y: 300 + rand() * 2, pressure: 0.7, time: 1000 + t });
  }
  for (let t = 1000 / 120; t <= 150; t += 1000 / 120) pts.push({ x: 900, y: 300, pressure: 0.7, time: 1250 + t });
  const rawDev = Math.max(...pts.map((p) => Math.abs(p.y - 300)));
  let previousDabs: number[] = [];
  for (let level = STABILIZER_LEVEL_STEP; level <= MAX_STABILIZER_LEVEL; level += STABILIZER_LEVEL_STEP) {
    const engine = new StrokeWorkerEngine();
    const brush: WorkerBrushConfig = { size: 4, minSize: 4, hardness: 1, flow: 1, spacing: 0.1, opacity: 1, stabilizerLevel: level, isEraser: false, scatter: 0 };
    const out = [...engine.initStroke(brush, pts[0])];
    for (let i = 1; i < pts.length - 1; i += 2) out.push(...engine.addRawPoints(pts.slice(i, Math.min(i + 2, pts.length - 1))));
    out.push(...engine.finishStroke(pts[pts.length - 1]));
    assert.notDeepEqual(out, previousDabs, `L${level}: adjacent levels must stamp different dabs`);
    previousDabs = out;
    const xs = out.filter((_, i) => i % FLOATS_PER_DAB === 0);
    const ys = out.filter((_, i) => i % FLOATS_PER_DAB === 1);
    const back = xs.reduce((sum, x, i) => (i && x < xs[i - 1] ? sum + xs[i - 1] - x : sum), 0);
    assert.ok(Math.max(...ys.map((y) => Math.abs(y - 300))) <= rawDev, `L${level}: smoothing must not widen the wobble`);
    assert.ok(back < 2, `L${level}: the line doubles back ${back.toFixed(1)} px (coil)`);
    assert.ok(Math.max(...xs) <= 901, `L${level}: runs ${(Math.max(...xs) - 900).toFixed(1)} px past the stop`);
    assert.ok(Math.abs(xs[xs.length - 1] - 900) <= 1, `L${level}: ends at ${xs[xs.length - 1].toFixed(1)}, pen lifted at 900`);
  }
}

// A peer's undo beneath a newer stroke must not reappear when that stroke is undone.
{
  const blank = [0, 0, 0, 0];
  const blue = [59, 130, 246, 255];
  const red = [253, 0, 48, 255];
  const tile = (...pixels: number[][]): TileData => ({
    col: 0, row: 0, width: pixels.length, height: 1, compression: 'raw', data: Uint8Array.from(pixels.flat()),
  });
  const manager = new ScopedUndoManager();
  const makeStroke = (baseSeq: number): ScopedUndoOp => ({
    opId: String(baseSeq), userId: 'artist', layerId: 'layer', opType: 'STROKE', timestamp: 0, baseSeq,
    beforeTiles: [tile(blue, blue, red)], afterTiles: [tile(red, blue, blue)],
  });
  const older = makeStroke(2);
  const newer = makeStroke(4);
  manager.push(older);
  manager.push(newer);
  manager.rebaseBeforeTiles('layer', 3, 5, tile(blue, blue, blue), tile(blank, blank, blank));
  assert.deepEqual(Array.from(tileToRgba(newer.beforeTiles[0])), [...blank, ...blue, ...red]);
  assert.deepEqual(Array.from(tileToRgba(older.beforeTiles[0])), [...blue, ...blue, ...red]);
  assert.deepEqual(Array.from(tileToRgba(newer.afterTiles[0])), [...red, ...blue, ...blue]);
}

// Brush size steps
assert.equal(nextSizeStep(24, 1), 28);
assert.equal(nextSizeStep(24, -1), 20);
assert.equal(nextSizeStep(1, -1), 1);
assert.equal(nextSizeStep(500, 1), 500);
assert.equal(nextSizeStep(25, -1), 24);

// Content bounds (transform without a selection)
const w = 8, h = 6;
const px = new Uint8Array(w * h * 4);
assert.equal(findContentBounds(px, w, h), null);
px[(2 * w + 3) * 4 + 3] = 255;
px[(4 * w + 6) * 4 + 3] = 10;
assert.deepEqual(findContentBounds(px, w, h), { minX: 3, minY: 2, maxX: 6, maxY: 4 });

// Healing under an erased line: a red fill closes up, empty stays empty, other lines do not bleed
{
  const W = 5, H = 3;
  const layer = new Uint8Array(W * H * 4);
  const mask = new Uint8ClampedArray(W * H * 4);
  const redraw = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < W * H; p++) { layer[p * 4] = 255; layer[p * 4 + 3] = 255; } // red everywhere
  for (let x = 0; x < W; x++) { mask[(1 * W + x) * 4 + 3] = 255; layer[(1 * W + x) * 4] = 0; } // middle row = old line (black)
  const healed = healUnderMask(layer, mask, redraw, W, H);
  assert.equal(Math.round(healed[(1 * W + 2) * 4]), 255, 'fill heals into the gap');
  assert.equal(Math.round(healed[(1 * W + 2) * 4 + 3]), 255);
  const empty = healUnderMask(new Uint8Array(W * H * 4), mask, redraw, W, H);
  assert.equal(empty[(1 * W + 2) * 4 + 3], 0, 'empty layer stays empty');
  redraw.fill(0);
  for (let x = 0; x < W; x++) { redraw[(0 * W + x) * 4 + 3] = 255; redraw[(2 * W + x) * 4 + 3] = 255; } // other lines all around
  const blocked = healUnderMask(layer, mask, redraw, W, H);
  assert.equal(blocked[(1 * W + 2) * 4 + 3], 0, 'remaining lines are not used as a source');
}

// Pen / node editing
{
  const anchors = penPointsToAnchors([{ x: 0, y: 0 }, { x: 10, y: 0, hx: 15, hy: 5 }, { x: 20, y: 0 }], 'pen', 4, false);
  assert.equal(anchors.length, 3);
  assert.ok(isCornerAnchor(anchors[0]), 'click = corner');
  assert.ok(!isCornerAnchor(anchors[1]), 'drag = smooth');
  assert.deepEqual([anchors[1].cp1x, anchors[1].cp1y], [5, -5], 'incoming handle mirrors the dragged one');
  const curve = penPointsToAnchors([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }], 'curve', 4, false);
  assert.ok(!isCornerAnchor(curve[1]), 'continuous curve joins smoothly');
  const stroke = { id: 's', layerId: 'l', color: '#000', opacity: 1, baseWidth: 4, anchors, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, createdAt: 0 };
  const moved = moveHandle(stroke, 1, 'cp2', { x: 10, y: 8 }, false);
  assert.ok(!isCornerAnchor(moved.anchors[1]), 'smooth anchor stays smooth');
  assert.ok(Math.abs((moved.anchors[1].cp1x ?? 0) - 10) < 1e-6 && (moved.anchors[1].cp1y ?? 0) < 0, 'opposite handle turns with it');
  const broken = moveHandle(stroke, 1, 'cp2', { x: 10, y: 8 }, true);
  assert.ok(isCornerAnchor(broken.anchors[1]), 'Alt breaks the tangent');
  assert.ok(isCornerAnchor(toggleCorner(stroke, 1).anchors[1]));
  assert.ok(!isCornerAnchor(toggleCorner(toggleCorner(stroke, 1), 1).anchors[1]));
  assert.equal(deleteAnchor(stroke, 1)?.anchors.length, 2);
  assert.equal(deleteAnchor({ ...stroke, anchors: anchors.slice(0, 2) }, 0), null);
}

// Outline brush: same colour merges under one ring; the ring paints over other colours
{
  const W = 20, H = 9;
  const img = new Uint8Array(W * H * 4);
  const put = (x: number, y: number, rgb: [number, number, number]) => { const i = (y * W + x) * 4; img[i] = rgb[0]; img[i + 1] = rgb[1]; img[i + 2] = rgb[2]; img[i + 3] = 255; };
  for (let x = 3; x <= 8; x++) for (let y = 3; y <= 5; y++) put(x, y, [255, 0, 0]); // red blob A
  for (let x = 9; x <= 14; x++) for (let y = 3; y <= 5; y++) put(x, y, [255, 0, 0]); // red blob B touching A
  for (let y = 0; y < H; y++) put(17, y, [0, 0, 255]); // blue line 2 px from B
  assert.ok(applyColorOutline(img, W, H, '#ff0000', { enabled: true, width: 2, color: '#000000' }));
  const at = (x: number, y: number) => Array.from(img.slice((y * W + x) * 4, (y * W + x) * 4 + 4));
  assert.deepEqual(at(8, 4), [255, 0, 0, 255], 'seam between same-colour blobs has no outline');
  assert.deepEqual(at(9, 4), [255, 0, 0, 255]);
  assert.deepEqual(at(4, 2), [0, 0, 0, 255], 'outline just outside the region');
  assert.deepEqual(at(16, 4), [0, 0, 0, 255], 'outline drawn over empty space');
  assert.deepEqual(at(10, 0), [0, 0, 0, 0], 'nothing beyond the outline width');
  assert.deepEqual(at(17, 0), [0, 0, 255, 255], 'other colour outside the ring kept');
}

// Outline brush: the ring goes under the stroke's anti-aliased edge, so no see-through gap is left
// between the stroke and its ring; a translucent stroke's inside stays as it was
{
  const W = 24, H = 13;
  const img = new Uint8Array(W * H * 4);
  const put = (x: number, y: number, a: number) => { const i = (y * W + x) * 4; img[i] = a; img[i + 1] = 0; img[i + 2] = 0; img[i + 3] = a; }; // premultiplied red
  for (let x = 4; x <= 19; x++) for (let y = 3; y <= 9; y++) put(x, y, 120); // translucent red plateau
  for (let x = 4; x <= 19; x++) { put(x, 2, 60); put(x, 10, 60); } // its faint anti-aliased rim
  const out = img.slice();
  assert.ok(applyColorOutline(out, W, H, '#ff0000', { enabled: true, width: 2, color: '#0000ff' }));
  const at = (x: number, y: number) => Array.from(out.slice((y * W + x) * 4, (y * W + x) * 4 + 4));
  assert.deepEqual(at(10, 2), [60, 0, 195, 255], 'faint rim: stroke over the ring, opaque (no gap)');
  assert.deepEqual(at(10, 3), [120, 0, 135, 255], 'edge band inside the region: ring under it, opaque');
  assert.deepEqual(at(10, 6), [120, 0, 0, 120], 'translucent inside away from the edge is untouched');
  assert.deepEqual(at(10, 1), [0, 0, 255, 255], 'ring outside');
  assert.deepEqual(at(10, 0), [0, 0, 0, 0], 'nothing beyond the outline width');
  for (let y = 1; y <= 6; y++) assert.equal(at(10, y)[3] >= 120, true, `no see-through seam at row ${y}`);
}

// Animation folders: one frame shown; the played folder shows its current frame plus onion skin
{
  const L = (id: string, parentId: string | null, sortOrder: number, extra: Record<string, unknown> = {}) =>
    ({ id, parentId, sortOrder, layerType: 'raster', isVisible: true, opacity: 1, meta: null, ...extra });
  const layers = [
    L('bg', null, 10),
    L('anim', null, 20, { layerType: 'group', meta: { animation: { fps: 12 } } }),
    L('f1', 'anim', 21), L('f2', 'anim', 22), L('f3', 'anim', 23), L('f4', 'anim', 24),
    L('f2mask', 'f2', 25, { layerType: 'mask' }),
  ];
  const onion = { enabled: true, prevColor: '#ff0000', nextColor: '#00ff00', opacity: 0.3, prevFramesCount: 1, nextFramesCount: 1 };
  const shown = (out: any[]) => out.filter((l) => l.isVisible).map((l) => l.id + (l.onionTint !== undefined ? `~${l.onionTint.toString(16)}` : ''));
  // Nothing bound: frame 1 of every folder
  assert.deepEqual(shown(animationDisplay(layers, null)), ['bg', 'anim', 'f1', 'f2mask']);
  // Frame 3 with onion skin: frame 2 tinted red, frame 4 green, frame 1 hidden
  const out = animationDisplay(layers, { time: 2, activeFolderId: 'anim', onion });
  assert.deepEqual(shown(out), ['bg', 'anim', 'f2~ff0000', 'f3', 'f4~ff00', 'f2mask']);
  assert.equal(out.find((l) => l.id === 'f2')!.opacity, 0.3);
  // Export / playback: no onion skin
  assert.deepEqual(shown(animationDisplay(layers, { time: 3, activeFolderId: 'anim', onion: null })), ['bg', 'anim', 'f4', 'f2mask']);
  // Two cels back, none ahead
  const twoBack = animationDisplay(layers, { time: 3, activeFolderId: 'anim', onion: { ...onion, prevFramesCount: 2, nextFramesCount: 0 } });
  assert.deepEqual(shown(twoBack), ['bg', 'anim', 'f2~ff0000', 'f3~ff0000', 'f4', 'f2mask']);
  // Krita-style placement: cels sit on frames, a gap keeps showing the drawing before it
  {
    const abc = [{ id: 'a', hold: 1 }, { id: 'b', hold: 1 }, { id: 'c', hold: 1 }];
    const fmt = (p: Array<{ id: string; start: number; hold: number }>) => p.map((x) => `${x.id}@${x.start}+${x.hold}`).join(' ');
    // b dragged to frame 5: a holds on over b's old frame, c stays on frame 3, the gap before b shows c
    assert.equal(fmt(placeEntries(abc, new Map([['b', 4]]))), 'a@0+2 c@2+2 b@4+1');
    // Dragged left into a long hold: the held drawing ends where the moved one now starts
    assert.equal(fmt(placeEntries([{ id: 'a', hold: 3 }, { id: 'b', hold: 2 }], new Map([['b', 1]]))), 'a@0+1 b@1+2');
    // Dropped on a taken frame: it takes it and the rest move along by one
    assert.equal(fmt(placeEntries(abc, new Map([['a', 1]]))), 'a@0+2 b@2+1 c@3+1');
    // Pasted past the end: the last drawing holds until it
    assert.equal(fmt(placeEntries(abc, new Map([['p', 7]]), [{ id: 'p', hold: 2 }])), 'a@0+1 b@1+1 c@2+5 p@7+2');
    // Pasted onto the middle of a hold
    assert.equal(fmt(placeEntries([{ id: 'a', hold: 6 }], new Map([['p', 2]]), [{ id: 'p', hold: 1 }])), 'a@0+2 p@2+1');
  }
  // Further from the current frame = fainter: the nearest at the set opacity, the next at half
  assert.equal(twoBack.find((l) => l.id === 'f3')!.opacity, 0.3);
  assert.ok(Math.abs(twoBack.find((l) => l.id === 'f2')!.opacity - 0.15) < 1e-9, 'second onion cel is fainter');

  // Holds, a reused cel and a second track (another painter) on the same clock
  const timed = [
    L('bg', null, 10),
    L('A', null, 20, { layerType: 'group', meta: { animation: { fps: 12 } } }),
    L('a1', 'A', 21, { meta: { cel: { hold: 2 } } }), L('a2', 'A', 22),
    L('a3', 'A', 23, { layerType: 'group', meta: { cel: { ref: 'a1' } } }), // shows a1 again
    L('B', null, 30, { layerType: 'group', meta: { animation: { fps: 12, shared: true } } }),
    L('b1', 'B', 31), L('b2', 'B', 32, { layerType: 'group', meta: { cel: { hold: 3 } } }),
    L('b2line', 'b2', 33), // b2 is a cel folder
  ];
  const ea = celEntriesOf(timed, 'A');
  assert.deepEqual(ea.map((e) => [e.id, e.hold, e.ref ?? null]), [['a1', 2, null], ['a2', 1, null], ['a3', 1, 'a1']]);
  assert.equal(trackLength(ea), 4);
  assert.deepEqual([0, 1, 2, 3, 4].map((t) => entryIndexAt(ea, t)), [0, 0, 1, 2, -1]);
  assert.equal(timeOfCel(ea, 'a2'), 2);
  // What is really on screen: a hidden group hides what is inside it
  const onScreen = (out: any[]) => {
    const byId = new Map(out.map((l) => [l.id, l]));
    const visible = (l: any): boolean => l.isVisible && (!l.parentId || visible(byId.get(l.parentId)));
    return shown(out.filter(visible));
  };
  const at = (t: number, extra: Record<string, unknown> = {}) =>
    onScreen(animationDisplay(timed, { time: t, activeFolderId: 'A', onion: null, ...extra }));
  assert.deepEqual(at(1), ['bg', 'A', 'a1', 'B', 'b2', 'b2line']);
  assert.deepEqual(at(3), ['bg', 'A', 'a1', 'B', 'b2', 'b2line'], 'reused cel shows a1');
  assert.deepEqual(at(4), ['bg', 'A', 'B'], 'past the end of both tracks nothing is shown');
  // Onion skin: only the edited track, and a reused cel is not its own neighbour
  assert.deepEqual(at(3, { onion: { ...onion, prevFramesCount: 2 } }), ['bg', 'A', 'a1', 'a2~ff0000', 'B', 'b2', 'b2line']);
  // A tinted cel folder tints what is inside it
  assert.deepEqual(at(0, { activeFolderId: 'B', onion: { ...onion, prevFramesCount: 0 } }).filter((id) => /^b\d/.test(id)), ['b1', 'b2', 'b2line~ff00']);
  // Export scope: one folder only (the background and the other track are left out)
  assert.deepEqual(at(0, { only: new Set(['A']) }), ['A', 'a1', 'B']);
  assert.deepEqual(celOfLayer(timed, 'b2line'), { folderId: 'B', celId: 'b2' });
  assert.equal(celOfLayer(timed, 'bg'), null);
  // A reference to a deleted cel shows nothing
  assert.equal(celEntriesOf(timed.filter((l) => l.id !== 'a1'), 'A').find((e) => e.id === 'a3')!.ref, '');

  // Player: playback range loops inside it
  const player = new AnimationEngine();
  player.setLength(10);
  player.setRange({ start: 7, end: 4 });
  assert.deepEqual(player.getRange(), { start: 4, end: 7 });
  player.goTo(7);
  (player as any).tick();
  assert.equal(player.getTime(), 4, 'loops back to the range start');
  player.setLength(5);
  assert.deepEqual(player.getRange(), { start: 4, end: 4 });
  player.setOnionSkinConfig({ prevFramesCount: 9, opacity: 5 });
  assert.equal(player.getOnionSkinConfig().prevFramesCount, 5);
  assert.equal(player.getOnionSkinConfig().opacity, 0.9);
}

// Group names count plain groups only (animation folders and their cels are not groups for this)
{
  const g = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, layerType: 'group', parentId: null, meta: null, ...extra });
  assert.equal(nextGroupName([g('a', '動畫 1', { meta: { animation: { fps: 12 } } }), g('c', '2', { parentId: 'a' }), g('r', '↻ 1', { parentId: 'a', meta: { cel: { ref: 'x' } } })]), '圖層組 1');
  assert.equal(nextGroupName([g('a', '圖層組 1'), g('b', '圖層組 2')]), '圖層組 3');
  assert.equal(nextGroupName([g('b', '圖層組 1', { layerType: 'raster' })]), '圖層組 2', 'a name already in use is skipped');
}

// Vertical text: punctuation in vertical forms, Latin words sideways, 1–2 digit numbers upright (縱中橫)
{
  const kinds = (line: string) => verticalRuns(line).map((r) => `${r.kind}:${r.text}`);
  assert.deepEqual(kinds('你好，世界。'), ['glyph:你', 'glyph:好', 'glyph:︐', 'glyph:世', 'glyph:界', 'glyph:︒']);
  assert.deepEqual(kinds('第12話'), ['glyph:第', 'tcy:12', 'glyph:話']);
  assert.deepEqual(kinds('用CSP畫'), ['glyph:用', 'sideways:CSP', 'glyph:畫']);
  assert.deepEqual(kinds('2026年'), ['sideways:2026', 'glyph:年'], 'longer numbers lie on their side');
  assert.deepEqual(kinds('Hello World!'), ['sideways:Hello World!']);
  assert.deepEqual(kinds('「好」(笑)'), ['glyph:﹁', 'glyph:好', 'glyph:﹂', 'glyph:︵', 'glyph:笑', 'glyph:︶']);
}

// Keyframe interpolation, cubic-bezier curves, pivot rigid rotation, and physical canvas units/DPI
{
  assert.equal(evaluateEasing(0, 'linear'), 0);
  assert.equal(evaluateEasing(1, 'linear'), 1);
  assert.equal(evaluateEasing(0.5, 'step'), 0);
  assert.equal(evaluateEasing(1, 'step'), 1);
  assert.ok(evaluateEasing(0.25, 'easeIn') < evaluateEasing(0.25, 'easeOut'));
  const bez = evaluateEasing(0.5, 'cubicBezier', [0.25, 0.1, 0.25, 1.0]);
  assert.ok(bez > 0.7 && bez <= 1.0, `cubicBezier fast-out easing at t=0.5 was ${bez}`);

  const kfs = upsertTransformKeyframe(
    upsertTransformKeyframe([], {
      frame: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 100, pivotY: 200, easing: 'linear',
    }),
    {
      frame: 10, x: 100, y: 50, scaleX: 2, scaleY: 2, rotation: Math.PI / 2, pivotX: 100, pivotY: 200, easing: 'linear',
    }
  );
  assert.equal(kfs.length, 2);
  const mid = evaluateTransformKeyframes(kfs, 5, 100, 200);
  assert.ok(Math.abs(mid.x - 50) < 1e-6 && Math.abs(mid.y - 25) < 1e-6);
  assert.ok(Math.abs(mid.scaleX - 1.5) < 1e-6 && Math.abs(mid.rotation - Math.PI / 4) < 1e-6);
  const m = transformToAffineMatrix(mid);
  assert.ok(!m.isIdentity);
  // Check pivot maps cleanly to pivot + (x, y)
  const pxAfter = m.a * 100 + m.c * 200 + m.tx;
  const pyAfter = m.b * 100 + m.d * 200 + m.ty;
  assert.ok(Math.abs(pxAfter - 150) < 1e-5 && Math.abs(pyAfter - 225) < 1e-5, 'pivot rotates/scales around joint');
  assert.equal(removeTransformKeyframe(kfs, 0).length, 1);

  // Hierarchical group keyframes inherit onto child cels via animationDisplay
  const hier = [
    { id: 'armGrp', parentId: null, layerType: 'group', sortOrder: 1, isVisible: true, opacity: 1, meta: { keyframes: [kfs[1]] } },
    { id: 'hand', parentId: 'armGrp', layerType: 'raster', sortOrder: 2, isVisible: true, opacity: 1, meta: null },
  ];
  const disp = animationDisplay(hier, { time: 10, activeFolderId: null, onion: null }, 1000, 1000);
  const handTransform = (disp.find((l) => l.id === 'hand') as { renderTransform?: Affine2D } | undefined)?.renderTransform;
  assert.ok(handTransform && !handTransform.isIdentity, 'child layer inherits animated parent group matrix');
  const identTest = multiplyAffine(transformToAffineMatrix(mid), { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0, isIdentity: true });
  assert.equal(identTest.tx, m.tx);

  // Free transform pivot retention under rotation
  const box0: TransformBox = { x: 100, y: 200, width: 400, height: 200, rotation: 0, pivotX: 0.1, pivotY: 0.9 };
  const piv0 = getBoxPivotCanvasPoint(box0);
  const rot = Math.PI / 3;
  const ox = (0.1 - 0.5) * 400;
  const oy = (0.9 - 0.5) * 200;
  const newCenterX = piv0.x - (ox * Math.cos(rot) - oy * Math.sin(rot));
  const newCenterY = piv0.y - (ox * Math.sin(rot) + oy * Math.cos(rot));
  const box1: TransformBox = { ...box0, x: newCenterX - 200, y: newCenterY - 100, rotation: rot };
  const piv1 = getBoxPivotCanvasPoint(box1);
  assert.ok(Math.hypot(piv1.x - piv0.x, piv1.y - piv0.y) < 1e-6, 'rotated box keeps pivot anchored in canvas space');

  // Canvas physical units & DPI conversions (A4 @ 300 DPI ~ 21 x 29.7 cm = 2480 x 3508 px)
  assert.equal(unitToPixels(21, 'cm', 300), 2480);
  assert.equal(unitToPixels(29.7, 'cm', 300), 3508);
  assert.equal(clampDpi(9999), 1200);
  assert.ok(Math.abs(pixelsToUnit(300, 'in', 300) - 1) < 1e-6);
  assert.ok(formatCanvasDimensions(2480, 3508, 'cm', 300).includes('cm'));
}

// HLS triangle & barycentric color-wheel math + dock color panel minimum size
{
  for (const [h, s, l] of [
    [0, 1, 0.5],
    [135, 0.75, 0.4],
    [220, 0.6, 0.7],
    [310, 0.9, 0.25],
  ] as Array<[number, number, number]>) {
    const [r, g, b] = hslToRgb(h, s, l);
    const [h2, s2, l2] = rgbToHsl(r, g, b);
    assert.ok(Math.abs(((h2 - h + 540) % 360) - 180) <= 2, `hsl roundtrip H ${h} vs ${h2}`);
    assert.ok(Math.abs(s2 - s) < 0.03, `hsl roundtrip S ${s} vs ${s2}`);
    assert.ok(Math.abs(l2 - l) < 0.02, `hsl roundtrip L ${l} vs ${l2}`);
  }

  // White & pure hue round-trip through HSV <-> barycentric coordinates on rotated triangle
  const tri = getTriangleVertices(100, 100, 60, 210);
  for (const [s, v] of [[1, 1], [0, 1], [0.45, 0.72], [0.8, 0.3]] as Array<[number, number]>) {
    const [wc, ww, wk] = hsvToBarycentric(s, v);
    assert.ok(Math.abs(wc + ww + wk - 1) < 1e-6, 'barycentric weights sum to 1');
    const px = tri.c[0] * wc + tri.w[0] * ww + tri.k[0] * wk;
    const py = tri.c[1] * wc + tri.w[1] * ww + tri.k[1] * wk;
    const [wc2, ww2, wk2] = clampPointToTriangleBarycentric(px, py, tri);
    assert.ok(Math.abs(wc2 - wc) < 1e-6 && Math.abs(ww2 - ww) < 1e-6 && Math.abs(wk2 - wk) < 1e-6);
    const [, sBack, vBack] = barycentricToHsv(210, wc2, ww2, s);
    assert.ok(Math.abs(sBack - s) < 1e-5 && Math.abs(vBack - v) < 1e-5);
  }

  // Exterior points clamp onto the nearest triangle edge with non-negative normalized weights
  const outBlack = clampPointToTriangleBarycentric(tri.k[0] + 80, tri.k[1] + 80, tri);
  assert.ok(outBlack[0] >= 0 && outBlack[1] >= 0 && outBlack[2] >= 0);
  assert.ok(Math.abs(outBlack[0] + outBlack[1] + outBlack[2] - 1) < 1e-6);
  const [, sClamped, vClamped] = barycentricToHsv(210, outBlack[0], outBlack[1], 0.5);
  assert.ok(sClamped >= 0 && sClamped <= 1 && vClamped >= 0 && vClamped <= 1);
  const [rr, gg, bb] = hsvToRgb(210, 0.5, 0.5);
  const [rh, rs, rv] = rgbToHsv(rr, gg, bb);
  assert.ok(Math.abs(rh - 210) <= 1 && Math.abs(rs - 0.5) < 0.02 && Math.abs(rv - 0.5) < 0.02);

  // Color dock panel gives generous height/weight for mode tabs + transparent swatch + wheel
  const colorPanel = getDockLayout().panels.color;
  assert.ok(colorPanel.weight >= 1.28, `expected color dock weight >= 1.28, got ${colorPanel.weight}`);
  assert.ok(colorPanel.float.h >= 430, `expected color float height >= 430, got ${colorPanel.float.h}`);
}

// Collapsible canvas groups, in-canvas room share URLs, and brush pressure-opacity + binary AA=none
{
  const mockCanvases = [
    { id: 'c1', title: 'Solo 1' },
    { id: 'c2', title: 'Group A - 1', group: { id: 'gA', title: 'Project A', ownerId: 'u1' } },
    { id: 'c3', title: 'Solo 2' },
    { id: 'c4', title: 'Group A - 2', group: { id: 'gA', title: 'Project A', ownerId: 'u1' } },
  ] as unknown as CanvasModel[];

  const entries = buildCanvasGroupEntries(mockCanvases);
  assert.equal(entries.length, 3, 'Canvases sharing a group ID coalesce into one folder entry');
  assert.equal(entries[0].kind, 'canvas');
  assert.equal(entries[1].kind, 'group');
  if (entries[1].kind === 'group') {
    assert.equal(entries[1].group.title, 'Project A');
    assert.deepEqual(entries[1].canvases.map((c) => c.id), ['c2', 'c4']);
  }
  assert.equal(entries[2].kind, 'canvas');

  let collapsed = new Set<string>();
  collapsed = toggleCollapsedCanvasGroup(collapsed, 'gA');
  assert.equal(collapsed.has('gA'), true);
  collapsed = toggleCollapsedCanvasGroup(collapsed, 'gA');
  assert.equal(collapsed.has('gA'), false);

  assert.equal(
    buildRoomShareUrl('https://demo.trycloudflare.com/', 'room-42'),
    'https://demo.trycloudflare.com/?room=room-42'
  );
  assert.equal(
    buildRoomShareUrl('http://192.168.1.20:3000', 'offline-local'),
    'http://192.168.1.20:3000'
  );

  // Brush presets: no third-party software names in preset titles, and pressure modulates opacity for painting/airbrush
  for (const preset of DEFAULT_COMMUNITY_PRESETS) {
    assert.equal(preset.properties.spacing, MIN_BRUSH_SPACING, `Preset spacing must start at the minimum: ${preset.name}`);
    const pressureWorker = new StrokeWorkerEngine();
    const config: WorkerBrushConfig = { ...preset.properties, pressureCurve: 'linear' };
    const faint = pressureWorker.initStroke(config, { x: 10, y: 10, pressure: 0.0001 });
    if (preset.properties.brushType === 'pen') {
      assert.ok(faint[2] > 0 && faint[2] < 1, `${preset.id}: very light pressure should produce a sub-pixel tip`);
    } else {
      assert.ok(faint[2] >= preset.properties.minSize, `${preset.id}: preserve the brush's minimum size`);
    }
    const lifted = pressureWorker.initStroke(config, { x: 10, y: 10, pressure: 0 });
    assert.equal(lifted[2], 0, `${preset.id}: zero pressure should have zero diameter`);
    assert.equal(lifted[4], 0, `${preset.id}: zero pressure should deposit no paint`);
    assert.ok(!/CSP|Photoshop|Clip Studio|Krita|SAI/i.test(preset.name), `Preset name must be clean: ${preset.name}`);
  }

  const impasto = DEFAULT_COMMUNITY_PRESETS.find((p) => p.id === 'preset_thick_oil_impasto')!;
  const watercolor = DEFAULT_COMMUNITY_PRESETS.find((p) => p.id === 'preset_csp_watercolor')!;
  const airbrush = DEFAULT_COMMUNITY_PRESETS.find((p) => p.id === 'preset_soft_airbrush')!;
  const gpen = DEFAULT_COMMUNITY_PRESETS.find((p) => p.id === 'preset_csp_gpen')!;

  for (const preset of [impasto, watercolor, airbrush]) {
    const worker = new StrokeWorkerEngine();
    const cfg: WorkerBrushConfig = {
      ...preset.properties,
      pressureCurve: (preset.properties.pressureCurve as any) ?? 'linear',
    };
    const lightDab = worker.initStroke(cfg, { x: 10, y: 10, pressure: 0.15 });
    const heavyDab = worker.initStroke(cfg, { x: 10, y: 10, pressure: 0.95 });
    assert.ok(lightDab[4] < heavyDab[4] * 0.35, `${preset.id}: light pressure alpha (${lightDab[4]}) must be much more transparent than heavy (${heavyDab[4]})`);
  }

  // G-Pen stays high-opacity ink while tapering size
  {
    const worker = new StrokeWorkerEngine();
    const cfg: WorkerBrushConfig = {
      ...gpen.properties,
      pressureCurve: 's-curve',
    };
    const lightDab = worker.initStroke(cfg, { x: 10, y: 10, pressure: 0.15 });
    const heavyDab = worker.initStroke(cfg, { x: 10, y: 10, pressure: 0.95 });
    assert.ok(lightDab[2] < heavyDab[2] * 0.3, 'G-Pen tapers size strongly with pressure');
    assert.ok(lightDab[4] >= 0.78, 'G-Pen keeps crisp ink opacity at light pressure');
  }

  // Binary antiAlias='none' forces integer size and 1.0 alpha (zero semi-transparent blocks)
  {
    const worker = new StrokeWorkerEngine();
    const dab = worker.initStroke(
      { ...impasto.properties, antiAlias: 'none', pressureCurve: 'linear' },
      { x: 10, y: 10, pressure: 0.23 }
    );
    assert.equal(dab[2], Math.round(dab[2]), 'antiAlias=none emits exact integer dab diameter');
    assert.equal(dab[4], 1.0, 'antiAlias=none emits 1.0 dab alpha');
  }
}

// Sparse browser reports: low settings reduce tremor without the native tablet path changing.
{
  const deviation = (level: number, browser: boolean) => {
    const stabilizer = new DynamicStabilizer(level);
    stabilizer.setLowRateInput(browser);
    stabilizer.reset({ x: 0, y: 0, pressure: 1, time: 0 });
    const ys = Array.from({ length: 60 }, (_, i) => stabilizer.pushRawPoint({
      x: (i + 1) * 4, y: i % 2 ? -2 : 2, pressure: 1, time: (i + 1) * 1000 / 60,
    }).y).slice(10);
    return Math.sqrt(ys.reduce((sum, y) => sum + y * y, 0) / ys.length);
  };
  const raw = deviation(0, true);
  for (const level of [0.5, 1, 2, 4]) {
    assert.ok(deviation(level, true) < raw * 0.65, `Browser L${level} should already suppress tremor`);
  }
  assert.ok(deviation(1, false) > deviation(1, true), 'Native tablet response stays separate');
}

// A one-pixel pale outline must hold even when expansion exceeds its thickness.
{
  const width = 48, height = 48;
  const lasso = [{ x: 2, y: 2 }, { x: 46, y: 2 }, { x: 46, y: 46 }, { x: 2, y: 46 }];
  for (const white of [false, true]) {
    const pixels = new Uint8Array(width * height * 4);
    if (white) pixels.fill(255);
    for (let y = 10; y <= 37; y++) for (let x = 10; x <= 37; x++) {
      if (x !== 10 && x !== 37 && y !== 10 && y !== 37) continue;
      pixels.set([160, 195, 250, 255], (y * width + x) * 4);
    }
    const mask = computeSmartEncloseFillMask(lasso, pixels, width, height, { gapClosingRadius: 0, expandRadius: 6 });
    assert.equal(mask.data[24 * width + 24], 255, 'Enclosed centre is filled');
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (x < 10 || x > 37 || y < 10 || y > 37) assert.equal(mask.data[y * width + x], 0, 'Expansion cannot spill past the outline');
    }
    // An open contour must not paint the lasso itself.
    pixels.set(white ? [255,255,255,255] : [0,0,0,0], (10 * width + 24) * 4);
    const open = computeSmartEncloseFillMask(lasso, pixels, width, height, { gapClosingRadius: 0, expandRadius: 2 });
    assert.equal(open.activePixelCount, 0);
    const closed = computeSmartEncloseFillMask(lasso, pixels, width, height, { gapClosingRadius: 2, expandRadius: 2 });
    assert.equal(closed.data[24 * width + 24], 255, 'Gap closing still seals a small break');
  }
}

console.log('ui-logic checks passed');
