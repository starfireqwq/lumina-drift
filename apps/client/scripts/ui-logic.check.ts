/**
 * Self-check for the pure UI logic added in the workspace redesign.
 * Run: npx tsx apps/client/scripts/ui-logic.check.ts   (from the repo root; exits non-zero on failure)
 */
import assert from 'node:assert/strict';
import { FLOATS_PER_DAB, StrokeWorkerEngine, type WorkerBrushConfig } from '../src/workers/stroke.worker';
import { contrastRatio, resolveTheme, THEME_PRESETS, DEFAULT_CUSTOM_THEME } from '../src/theme/themes';
import { nextSizeStep } from '../src/components/workspace/toolCatalog';
import { findContentBounds } from '../src/utils/pixelBounds';
import {
  alignBlocker, alignCrops, alignDestination, alignOffset, copyRgbaRect, rectMinus, resolveAlignBasis, selectionFrame,
  type AlignRect,
} from '../src/utils/layerAlign';
import { applyColorOutline } from '../src/engine/colorOutline';
import { addRecentVisit, lastVisitOn, normalizeServer, parseRecentVisits, removeRecentVisit, RECENT_VISITS_LIMIT, type RecentVisit } from '../src/utils/recentVisits';
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
import {
  AnimationEngine, animationDisplay, celEntriesOf, celInsertAt, celOfLayer, entryIndexAt, exportSegments, formatTimecode, frameSignature, MAX_HOLD, MAX_TIMELINE_FRAMES, movedByKeyframes,
  parseTimecode, placeEntries, playbackFrame, removeTransformKeyframe,
  timeOfCel, trackLength, upsertTransformKeyframe,
} from '../src/engine/AnimationEngine';
import { cleanLightTable, clearLightTable, emptyLightTable, lightIdsFor, toggleLightCel } from '../src/engine/lightTable';
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
import { apiErrorMessage, isForeignApiReply } from '../src/utils/apiErrors';
import { translations, type Language } from '../src/locales';
import {
  DEFAULT_COMMUNITY_PRESETS, MIN_BRUSH_SPACING, PIXEL_FILTER_RUNNERS, distanceField, runPixelFilter, toneHistogram,
  type CanvasModel, type FilterValues,
} from '@atelier/shared';
import {
  BUILTIN_FILTERS, FILTER_GROUPS, defaultFilterValues, filterFitsLayer, filterGroupsInUse, filterPointParam, getFilter,
  normalizeFilterValues, paramShown, snapRange,
} from '../src/utils/filterRegistry';

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
  (player as any).playing = true;
  (player as any).startClock(0);
  (player as any).tick(1000 / player.getFps()); // one frame later
  (player as any).playing = false;
  assert.equal(player.getTime(), 4, 'loops back to the range start');
  player.setLength(5);
  assert.deepEqual(player.getRange(), { start: 4, end: 4 });
  player.setOnionSkinConfig({ prevFramesCount: 19, opacity: 5 });
  assert.equal(player.getOnionSkinConfig().prevFramesCount, 10, 'up to 10 drawings each way');
  assert.equal(player.getOnionSkinConfig().opacity, 0.9);
  assert.equal(player.getOnionSkinConfig().mode, 'tint', 'settings saved before the choice keep the flat colour');
  player.setOnionSkinConfig({ mode: 'shade' });
  assert.equal(player.getOnionSkinConfig().mode, 'shade');
  player.setOnionSkinConfig({ mode: 'sepia' as never });
  assert.equal(player.getOnionSkinConfig().mode, 'tint', 'an unknown look falls back to the flat colour');

  // CSP in-between: a cel added at the playhead splits the cel there, later cels keep their frames
  {
    const ab = [{ hold: 8 }, { hold: 4 }]; // A on frames 1–8, B from frame 9
    assert.deepEqual(celInsertAt(ab, 4), { index: 0, keep: 4, hold: 4, start: 4 }, 'frame 5: A keeps 1–4, the new cel runs 5–8, B stays on 9');
    assert.deepEqual(celInsertAt(ab, 0), { index: 0, keep: 1, hold: 7, start: 1 }, "on A's first frame the new cel goes on the next frame");
    assert.deepEqual(celInsertAt(ab, 9), { index: 1, keep: 1, hold: 3, start: 9 });
    assert.equal(celInsertAt([{ hold: 1 }, { hold: 2 }], 0), null, 'a one-frame cel has no frame to give');
    assert.equal(celInsertAt(ab, 12), null, 'past the end of the track');
    assert.equal(celInsertAt(ab, -1), null);
  }
  // Seconds + frames, as CSP shows time
  assert.deepEqual([0, 23, 24, 49].map((f) => formatTimecode(f, 24, 'sf')), ['0+1', '0+24', '1+1', '2+2']);
  assert.equal(formatTimecode(24, 24, 'frames'), '25');
  assert.deepEqual(['1+1', '0+24', ' 2 + 2 ', '25', '1'].map((s) => parseTimecode(s, 24)), [24, 23, 49, 24, 0]);
  assert.deepEqual(['0+0', '0', 'x', '', '1+'].map((s) => parseTimecode(s, 24)), [null, null, null, null, null]);
  assert.equal(parseTimecode('1+3', 12), 14, 'seconds follow the FPS');
  // Loop off: playback stops on the last frame; play again starts from the top
  {
    const once = new AnimationEngine();
    once.setLength(5);
    once.setLoop(false);
    once.goTo(4);
    (once as any).playing = true;
    (once as any).startClock(0);
    (once as any).tick(1000 / once.getFps());
    assert.equal(once.getTime(), 4);
    assert.equal(once.getIsPlaying(), false, 'stopped at the end');
    once.play();
    assert.equal(once.getTime(), 0, 'play on the last frame starts again from the first');
    once.pause();
    once.goToEnd();
    assert.equal(once.getTime(), 4);
    once.setRange({ start: 1, end: 3 });
    once.goToStart();
    assert.equal(once.getTime(), 1, 'first frame of the playback range');
    once.goToEnd();
    assert.equal(once.getTime(), 3);
  }
  // Playback clock: frames come from elapsed time, not from counting ticks
  {
    assert.equal(playbackFrame(0, 60_000, 24, 0, 5999, true).frame, 1440, '60 s at 24 FPS is frame 1440');
    assert.equal(playbackFrame(0, 1000 / 24, 24, 0, 99, true).frame, 1, 'one frame time is one frame (no rounding loss)');
    assert.equal(playbackFrame(0, 500, 24, 0, 99, true).frame, 12, 'a late tick skips ahead to keep the pace');
    assert.deepEqual(playbackFrame(8, (1000 / 12) * 3, 12, 4, 9, true), { frame: 5, ended: false }, 'loops inside the range');
    assert.deepEqual(playbackFrame(8, 1000, 12, 0, 9, false), { frame: 9, ended: true }, 'played once: stops on the last frame');
    const bg = new AnimationEngine();
    bg.setLength(100);
    bg.setFps(24);
    bg.goTo(0);
    (bg as any).playing = true;
    (bg as any).startClock(0);
    // Display ticks about every 16 ms
    const run = (from: number, to: number) => {
      for (let now = from; now < to; now += 16) (bg as any).tick(now);
      (bg as any).tick(to);
    };
    run(16, 1000);
    assert.equal(bg.getTime(), 24);
    (bg as any).tick(1300); // a 300 ms stall (a heavy frame): skips to where it should be
    assert.equal(bg.getTime(), 31, 'a slow frame skips ahead, keeping the pace');
    run(1316, 2000);
    assert.equal(bg.getTime(), 48);
    (bg as any).tick(6000); // no ticks for 4 s (a hidden tab): count again from here, no jump
    assert.equal(bg.getTime(), 48, 'back from a background tab: no jump');
    (bg as any).tick(6000 + 1000 / 24);
    assert.equal(bg.getTime(), 49, 'then on frame by frame');
    bg.goTo(60); // moved by hand while playing
    (bg as any).tick(6100);
    assert.equal(bg.getTime(), 60);
    (bg as any).tick(6100 + (2 * 1000) / 24);
    assert.equal(bg.getTime(), 62, 'playback goes on from where it was put');
    (bg as any).playing = false;
  }
  // Blank frames (ref ''), long holds, export frames and onion skin looks
  {
    const track = [
      L('bg2', null, 1),
      L('T', null, 2, { layerType: 'group', meta: { animation: { fps: 24 } } }),
      L('tA', 'T', 3, { meta: { cel: { hold: 6 } } }),
      L('tX', 'T', 4, { layerType: 'group', meta: { cel: { ref: '', hold: 3 } } }),
      L('tB', 'T', 5, { meta: { cel: { hold: 4 } } }),
      L('tGone', 'T', 6, { layerType: 'group', meta: { cel: { ref: 'deleted-cel' } } }),
    ];
    const entries = celEntriesOf(track, 'T');
    assert.equal(entries[1].blank, true, 'ref "" is a blank frame');
    assert.equal(entries[3].ref, '', 'a reuse of a deleted cel shows nothing too…');
    assert.equal(entries[3].blank, undefined, '…but is not a blank frame (the timeline flags it)');
    const shownAt = (t: number) => animationDisplay(track, { time: t, activeFolderId: null, onion: null }).filter((l) => l.isVisible && l.parentId === 'T').map((l) => l.id);
    assert.deepEqual([0, 5, 6, 8, 9, 12].map(shownAt), [['tA'], ['tA'], [], [], ['tB'], ['tB']], 'frames 1–6 A, 7–9 blank, 10– B');
    assert.deepEqual(exportSegments(track, 0, 12, null, 100, 100), [{ time: 0, hold: 6 }, { time: 6, hold: 3 }, { time: 9, hold: 4 }], 'the export has the blank too');
    // Holds as long as the timeline (240 frames = 10 s at 24 FPS)
    assert.equal(MAX_HOLD, MAX_TIMELINE_FRAMES);
    assert.equal(celEntriesOf([L('F', null, 1, { layerType: 'group', meta: { animation: { fps: 24 } } }), L('f', 'F', 2, { meta: { cel: { hold: 240 } } })], 'F')[0].hold, 240);
    assert.equal(placeEntries([{ id: 'a', hold: 1 }, { id: 'b', hold: 1 }], new Map([['b', 3000]])).find((e) => e.id === 'a')!.hold, 3000, 'a long gap is one long hold');
  }
  {
    // A still drawing moved only by keyframes: every step is a frame; a pure hold stays one long frame
    const kf = (frame: number, x: number) => ({ frame, x, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 50, pivotY: 50, easing: 'linear' as const });
    const scene = (keyframes: unknown, extra: unknown[] = []) => [
      L('M', null, 1, { layerType: 'group', meta: { animation: { fps: 12 } } }),
      L('m1', 'M', 2, { meta: { cel: { hold: 10 }, ...(keyframes ? { keyframes } : {}) } }),
      ...(extra as ReturnType<typeof L>[]),
    ];
    assert.deepEqual(exportSegments(scene(null), 0, 9, null, 100, 100), [{ time: 0, hold: 10 }], 'held drawing: one frame, as before');
    assert.equal(exportSegments(scene([kf(0, 0), kf(9, 90)]), 0, 9, null, 100, 100).length, 10, 'moving by keyframes: a frame per step');
    assert.deepEqual(exportSegments(scene([kf(0, 0), kf(5, 50)]), 0, 9, null, 100, 100).map((s) => s.hold), [1, 1, 1, 1, 1, 5], 'still again after the last keyframe: merged');
    // A moving cel that is off screen does not split the frames of the one that is on
    const two = [
      L('N', null, 1, { layerType: 'group', meta: { animation: { fps: 12 } } }),
      L('n1', 'N', 2, { meta: { cel: { hold: 3 }, keyframes: [kf(0, 0), kf(9, 90)] } }),
      L('n2', 'N', 3, { meta: { cel: { hold: 7 } } }),
    ];
    assert.deepEqual(exportSegments(two, 0, 9, null, 100, 100), [{ time: 0, hold: 1 }, { time: 1, hold: 1 }, { time: 2, hold: 1 }, { time: 3, hold: 7 }]);
    // Reuses merge like before: A, A again, then B
    const reuse = [
      L('R', null, 1, { layerType: 'group', meta: { animation: { fps: 12 } } }),
      L('r1', 'R', 2, { meta: { cel: { hold: 2 } } }),
      L('r2', 'R', 3, { layerType: 'group', meta: { cel: { ref: 'r1', hold: 2 } } }),
      L('r3', 'R', 4, { meta: { cel: { hold: 3 } } }),
    ];
    assert.deepEqual(exportSegments(reuse, 0, 6, null, 100, 100), [{ time: 0, hold: 4 }, { time: 4, hold: 3 }]);
    // Only the exported folders count: a keyframed layer outside them does not split frames
    const outside = scene(null, [L('logo', null, 9, { meta: { keyframes: [kf(0, 0), kf(9, 90)] } })]);
    assert.equal(exportSegments(outside, 0, 9, new Set(['M']), 100, 100).length, 1);
    assert.equal(exportSegments(outside, 0, 9, null, 100, 100).length, 10, 'the whole picture: the logo moves');
    // A hidden group hides what is in it
    assert.equal(frameSignature([L('g', null, 1, { layerType: 'group', isVisible: false }), L('c', 'g', 2)]), '');
    // Without keyframes the drawings on screen are the key: the same frames as the full comparison
    // (a keyframe that changes nothing forces the full one)
    const still = { frame: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 0, pivotY: 0, easing: 'linear' as const };
    const blankTrack = [
      L('W', null, 1, { layerType: 'group', meta: { animation: { fps: 24 } } }),
      L('w1', 'W', 2, { meta: { cel: { hold: 6 } } }),
      L('w2', 'W', 3, { layerType: 'group', meta: { cel: { ref: '', hold: 3 } } }),
      L('w3', 'W', 4, { meta: { cel: { hold: 4 } } }),
      L('V', null, 5, { layerType: 'group', meta: { animation: { fps: 24 } } }),
      L('v1', 'V', 6, { meta: { cel: { hold: 4 } } }),
      L('v2', 'V', 7, { meta: { cel: { hold: 5 } } }),
    ];
    for (const [name, sc] of [['blank frame, two tracks', blankTrack], ['reuses', reuse]] as const) {
      const forced = [...sc, L('still', null, 99, { meta: { keyframes: [still] } })];
      assert.deepEqual(exportSegments(sc, 0, 12, null, 100, 100), exportSegments(forced, 0, 12, null, 100, 100), `fast key = full key (${name})`);
    }
    // How long a long export takes to plan (6000 frames, about 200 layers)
    const big = [L('BG', null, 0, { meta: { keyframes: [kf(0, 0), kf(5999, 500)] } })];
    for (let f = 0; f < 8; f++) {
      big.push(L(`F${f}`, null, 1 + f * 30, { layerType: 'group', meta: { animation: { fps: 24 } } }));
      for (let c = 0; c < 24; c++) big.push(L(`F${f}c${c}`, `F${f}`, 2 + f * 30 + c, { meta: { cel: { hold: 250 } } }));
    }
    for (const [name, layersIn] of [['with keyframes', big], ['no keyframes', big.slice(1)]] as const) {
      const t0 = performance.now();
      const segs = exportSegments(layersIn, 0, 5999, null, 1920, 1080);
      console.log(`  exportSegments (${name}): ${layersIn.length} layers × 6000 frames → ${segs.length} frames in ${(performance.now() - t0).toFixed(0)} ms`);
    }
  }
  {
    // Onion skin looks: flat colour (default), shaded (same colour, the drawing's lights and darks), or the drawing itself faded
    const look = (mode?: 'tint' | 'shade' | 'original') => animationDisplay(layers, { time: 2, activeFolderId: 'anim', onion: { ...onion, mode } }).find((l) => l.id === 'f2')!;
    assert.equal(look().onionTint, 0xff0000);
    assert.equal(look().onionMode, undefined);
    assert.equal(look('shade').onionTint, 0xff0000);
    assert.equal(look('shade').onionMode, 'shade');
    assert.equal(look('original').onionTint, undefined, 'original: no colour, no filter');
    assert.equal(look('original').opacity, 0.3, 'original: still faded like onion skin');
    // 10 each way: the furthest is the faintest
    const many = [L('o', null, 1, { layerType: 'group', meta: { animation: { fps: 12 } } }), ...Array.from({ length: 21 }, (_, i) => L(`o${i}`, 'o', 2 + i))];
    const ten = animationDisplay(many, { time: 10, activeFolderId: 'o', onion: { ...onion, opacity: 0.5, prevFramesCount: 10, nextFramesCount: 10 } });
    assert.equal(ten.filter((l) => l.parentId === 'o' && l.isVisible).length, 21);
    assert.ok(Math.abs(ten.find((l) => l.id === 'o0')!.opacity - 0.05) < 1e-9, '10th back at a tenth of the opacity');
  }
  // Light table: picked cels show at its opacity, untinted, and come before onion skin
  {
    const light = { opacity: 0.5, ids: new Set(['a2']) };
    assert.deepEqual(at(0, { light }), ['bg', 'A', 'a1', 'a2', 'B', 'b1']);
    const lit = animationDisplay(timed, { time: 0, activeFolderId: 'A', onion: null, light });
    assert.equal(lit.find((l) => l.id === 'a2')!.opacity, 0.5);
    assert.equal(lit.find((l) => l.id === 'a2')!.onionTint, undefined, 'not tinted');
    const both = animationDisplay(timed, { time: 2, activeFolderId: 'A', onion: { ...onion, prevFramesCount: 1 }, light: { opacity: 0.4, ids: new Set(['a1']) } });
    assert.equal(both.find((l) => l.id === 'a1')!.onionTint, undefined, 'the light table wins over onion skin');
    assert.equal(both.find((l) => l.id === 'a1')!.opacity, 0.4);
    // A folder cel on the light table shows what is inside it
    assert.deepEqual(at(0, { light: { opacity: 0.5, ids: new Set(['b2']) } }).filter((id) => /^b\d/.test(id)), ['b1', 'b2', 'b2line']);
    // The cel on screen is never dimmed by its own light table
    assert.equal(animationDisplay(timed, { time: 0, activeFolderId: 'A', onion: null, light: { opacity: 0.3, ids: new Set(['a1']) } }).find((l) => l.id === 'a1')!.opacity, 1);
  }
  {
    let s = emptyLightTable();
    s = toggleLightCel(s, { kind: 'cel', id: 'c5' }, 'c1');
    s = toggleLightCel(s, { kind: 'cel', id: 'c5' }, 'c9');
    s = toggleLightCel(s, { kind: 'track', id: 'A' }, 'bg1');
    assert.deepEqual([...lightIdsFor(s, 'A', 'c5')].sort(), ['bg1', 'c1', 'c9']);
    assert.deepEqual([...lightIdsFor(s, 'A', 'c1')], ['bg1'], 'another cel has only the track-wide picks (and never itself)');
    assert.equal(lightIdsFor({ ...s, enabled: false }, 'A', 'c5').size, 0, 'switched off');
    s = toggleLightCel(s, { kind: 'cel', id: 'c5' }, 'c1');
    assert.deepEqual(s.cels.c5, ['c9'], 'a second click takes it off');
    s = clearLightTable(s, { kind: 'cel', id: 'c5' });
    assert.equal(s.cels.c5, undefined);
    const cleaned = cleanLightTable({ enabled: 0, opacity: 9, cels: { x: ['a', 'a', 7, 'b'] }, tracks: [] });
    assert.deepEqual(cleaned, { enabled: false, opacity: 1, cels: { x: ['a', 'b'] }, tracks: {} });
    assert.deepEqual(cleanLightTable('junk'), emptyLightTable());
  }
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
  // 原位作畫: drawing on the hand shows it (and the group moving it) where it is drawn; other layers keep moving
  {
    const withOther = [...hier, { id: 'other', parentId: null, layerType: 'raster', sortOrder: 3, isVisible: true, opacity: 1, meta: { keyframes: [kfs[1]] } }];
    const drawing = animationDisplay(withOther, { time: 10, activeFolderId: null, onion: null, original: 'hand' }, 1000, 1000);
    const moved = (id: string) => (drawing.find((l) => l.id === id) as { renderTransform?: Affine2D }).renderTransform;
    assert.equal(moved('hand'), undefined, 'the layer drawn on sits where it is drawn');
    assert.equal(moved('armGrp'), undefined, 'and so does the group that moves it');
    assert.ok(moved('other') && !moved('other')!.isIdentity, 'other keyframed layers still move');
    assert.equal(movedByKeyframes(withOther, 'hand'), true, 'moved through its group');
    assert.equal(movedByKeyframes(withOther, 'other'), true);
    assert.equal(movedByKeyframes([{ ...hier[1], parentId: null }], 'hand'), false);
    assert.equal(movedByKeyframes(withOther, null), false);
  }
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

  // API replies: a static host (404 page or HTML fallback) is not a Lumina server; real errors stay as they are
  assert.equal(isForeignApiReply(404, 'text/html'), true);
  assert.equal(isForeignApiReply(404, 'application/json; charset=utf-8'), true);
  assert.equal(isForeignApiReply(200, 'text/html; charset=utf-8'), true);
  assert.equal(isForeignApiReply(200, 'application/json; charset=utf-8'), false);
  assert.equal(isForeignApiReply(500, 'text/html'), false);
  assert.equal(isForeignApiReply(401, null), false);
  // Error text: the server's own message wins; otherwise it follows the interface language
  assert.equal(apiErrorMessage(translations['zh-CN'].server, 404, {}), translations['zh-CN'].server.apiNotFound);
  assert.equal(apiErrorMessage(translations['en-US'].server, 502, null), 'Server request failed (HTTP 502).');
  assert.equal(apiErrorMessage(translations['ja-JP'].server, 409, { error: 'Name taken' }), 'Name taken');
  assert.equal(apiErrorMessage(translations['zh-TW'].server, 400, { error: '', message: 'Bad input' }), 'Bad input');
  for (const lang of Object.keys(translations) as Language[]) {
    const text = translations[lang].server;
    assert.ok(text.apiNotFound.includes('404'), `${lang}: the 404 message names the status`);
    assert.ok(text.apiRequestFailed.includes('{status}'), `${lang}: the generic message keeps its {status} slot`);
    assert.ok(apiErrorMessage(text, 503, {}).includes('503'), `${lang}: the generic message shows the status`);
  }

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

// Filter registry: every entry is computable, values are stored by key and survive bad storage
{
  assert.equal(new Set(BUILTIN_FILTERS.map((def) => def.id)).size, BUILTIN_FILTERS.length, 'Filter ids are unique');
  for (const def of BUILTIN_FILTERS) {
    assert.ok(FILTER_GROUPS.includes(def.group), `${def.id} sits in a known group`);
    if (def.tool) assert.equal(PIXEL_FILTER_RUNNERS[def.id], undefined, `${def.id} only opens a tool`);
    else assert.ok(PIXEL_FILTER_RUNNERS[def.id], `${def.id} has a pixel runner`);
    assert.equal(new Set(def.params.map((param) => param.key)).size, def.params.length, `${def.id} parameter keys are unique`);
    for (const param of def.params) {
      if (param.kind === 'range') assert.ok(param.min <= param.initial && param.initial <= param.max, `${def.id}.${param.key} default is in range`);
    }
  }
  assert.deepEqual(filterGroupsInUse(), ['color', 'lineart', 'effect', 'blur', 'distort'], 'Groups with no filters yet stay out of the menu');
  assert.equal(filterFitsLayer(getFilter('despeckle')!, 'mask'), false, 'Line-art fixes stay off masks');
  assert.equal(filterFitsLayer(getFilter('despeckle')!, 'raster'), true);

  const halftone = getFilter('halftone')!;
  assert.deepEqual(normalizeFilterValues(halftone, null), defaultFilterValues(halftone), 'Nothing stored: defaults');
  assert.deepEqual(
    normalizeFilterValues(halftone, { density: 999, angle: 'x', dotSize: 0.37, stray: 5 }),
    { density: 128, angle: 45, dotSize: 0.4 },
    'Out of range is clamped, the wrong type falls back, steps snap, unknown keys drop',
  );
  const dot = halftone.params.find((param) => param.key === 'dotSize')!;
  assert.ok(dot.kind === 'range');
  assert.equal(snapRange(dot, 2.04), 2, 'Snapping never passes max');
  assert.equal(snapRange(dot, 0.05), 0.1, 'Snapping never passes min');

  // The centre is dragged on the canvas each time: never a stored default, never kept from storage
  const twirl = getFilter('twirl')!;
  assert.ok(filterPointParam(twirl), 'Twirl has a centre');
  assert.equal(filterPointParam(halftone), null, 'Halftone has none');
  assert.equal('center' in defaultFilterValues(twirl), false, 'The centre is not a default value');
  assert.equal('center' in normalizeFilterValues(twirl, { center: { x: 1, y: 2 }, radius: 50 }), false, 'A stored centre is dropped');
  for (const def of BUILTIN_FILTERS) {
    if (def.pointRadius) {
      const radius = def.params.find((param) => param.key === def.pointRadius);
      assert.ok(radius?.kind === 'range', `${def.id} draws its centre circle from a range parameter`);
    }
    for (const param of def.params) {
      if (param.when) assert.ok(def.params.some((other) => other.key === param.when!.key), `${def.id}.${param.key} depends on a parameter it has`);
    }
  }
  assert.equal(paramShown({ kind: 'toggle', key: 'a', label: 'center', initial: true, when: { key: 'mode', is: ['radial'] } }, { mode: 'shift' }), false,
    'A parameter for another mode is hidden');
  assert.equal(paramShown({ kind: 'toggle', key: 'a', label: 'center', initial: true, when: { key: 'mode', is: ['radial'] } }, { mode: 'radial' }), true);
  assert.equal(filterFitsLayer(twirl, 'mask'), true, 'Only line-art fixes stay off masks');
}

// Filter runners: colour-only filters keep alpha and empty pixels, the mask limits the change, input is never written
{
  const width = 4, height = 2;
  const source = new Uint8Array([
    0, 0, 0, 0, 100, 50, 0, 128, 200, 100, 50, 255, 10, 20, 30, 255,
    255, 255, 255, 255, 0, 0, 0, 255, 64, 64, 64, 64, 1, 2, 3, 255,
  ]);
  const before = source.slice();
  const inverted = runPixelFilter(PIXEL_FILTER_RUNNERS.invert, source, width, height, {});
  assert.deepEqual(source, before, 'The caller\'s pixels stay as they were');
  for (let i = 0; i < source.length; i += 4) assert.equal(inverted[i + 3], source[i + 3], 'Invert keeps alpha');
  assert.deepEqual([...inverted.slice(0, 4)], [0, 0, 0, 0], 'An empty pixel stays empty');
  assert.deepEqual([...inverted.slice(8, 12)], [55, 155, 205, 255], 'Opaque colour is inverted');
  assert.deepEqual([...inverted.slice(4, 8)], [28, 78, 128, 128], 'Half-transparent colour is inverted on straight colour, then premultiplied');

  const mask = new Uint8Array(width * height);
  mask[2] = 255;
  const masked = runPixelFilter(PIXEL_FILTER_RUNNERS.posterize, source, width, height, { levels: 2 }, mask);
  for (let p = 0; p < width * height; p++) {
    if (p === 2) assert.deepEqual([...masked.slice(8, 12)], [255, 0, 0, 255], 'Inside the selection the filter applies');
    else assert.deepEqual([...masked.slice(p * 4, p * 4 + 4)], [...source.slice(p * 4, p * 4 + 4)], 'Outside the selection nothing changes');
  }
  const blurred = runPixelFilter(PIXEL_FILTER_RUNNERS.box, source, width, height, { radius: 1 });
  assert.equal(blurred.length, source.length);
  assert.notDeepEqual(blurred, source, 'Blur changes the pixels');
}

// Filters with a centre turn round the given point, and fall back to the middle without one
{
  const width = 9, height = 9;
  const source = new Uint8Array(width * height * 4);
  for (let x = 0; x < width; x++) source.set([255, 255, 255, 255], (4 * width + x) * 4);
  const middle = runPixelFilter(PIXEL_FILTER_RUNNERS.twirl, source, width, height, { radius: 6, angle: 90 });
  const atMiddle = runPixelFilter(PIXEL_FILTER_RUNNERS.twirl, source, width, height, { radius: 6, angle: 90, center: { x: 4.5, y: 4.5 } });
  const corner = runPixelFilter(PIXEL_FILTER_RUNNERS.twirl, source, width, height, { radius: 6, angle: 90, center: { x: 0, y: 0 } });
  assert.deepEqual(middle, atMiddle, 'No centre means the middle');
  assert.notDeepEqual(corner, middle, 'Moving the centre moves the twirl');
  const spun = runPixelFilter(PIXEL_FILTER_RUNNERS.spin, source, width, height, { angle: 60, center: { x: 0, y: 4 } });
  assert.notDeepEqual(spun, runPixelFilter(PIXEL_FILTER_RUNNERS.spin, source, width, height, { angle: 60 }), 'Spin blur turns round its centre');
}

/** One premultiplied pixel through a filter */
const filterPixel = (id: string, values: FilterValues, pixel: number[]) =>
  [...runPixelFilter(PIXEL_FILTER_RUNNERS[id], new Uint8Array(pixel), 1, 1, values)];

// 色彩濾鏡: neutral settings change nothing, each setting moves colour the right way, alpha stays
{
  const grey = [100, 100, 100, 255];
  assert.deepEqual(filterPixel('colorAdjust', {}, grey), grey, 'Neutral colour adjust changes nothing');
  assert.ok(filterPixel('colorAdjust', { brightness: 50 }, grey)[0] > 100, 'Brightness lightens');
  assert.ok(filterPixel('colorAdjust', { contrast: 50 }, [200, 200, 200, 255])[0] > 200, 'Contrast pushes light tones lighter');
  assert.ok(filterPixel('colorAdjust', { contrast: -50 }, [200, 200, 200, 255])[0] < 200, 'Less contrast pulls them to grey');
  const warm = filterPixel('colorAdjust', { temperature: 60 }, grey);
  assert.ok(warm[0] > warm[2], 'Warmer is redder than bluer');
  const magenta = filterPixel('colorAdjust', { tint: 60 }, grey);
  assert.ok(magenta[1] < magenta[0] && magenta[1] < magenta[2], 'Towards magenta pulls green down');
  const flat = filterPixel('colorAdjust', { saturation: -100 }, [200, 50, 50, 255]);
  assert.ok(Math.abs(flat[0] - flat[1]) <= 1 && Math.abs(flat[1] - flat[2]) <= 1, 'No saturation is grey');
  const turned = filterPixel('colorAdjust', { hue: 120 }, [200, 40, 40, 255]);
  assert.ok(turned[1] > turned[0] && turned[1] > turned[2], 'Red turned 120° is green');
  assert.deepEqual(filterPixel('colorAdjust', { brightness: 40 }, [50, 50, 50, 128]), [76, 76, 76, 128], 'Half-clear colour is adjusted straight, alpha kept');
  assert.deepEqual(filterPixel('colorAdjust', { brightness: 40 }, [0, 0, 0, 0]), [0, 0, 0, 0], 'Clear stays clear');

  assert.deepEqual(filterPixel('levels', {}, [10, 128, 250, 255]), [10, 128, 250, 255], 'Default levels change nothing');
  assert.deepEqual(filterPixel('levels', { inBlack: 50, inWhite: 200 }, [50, 125, 200, 255]), [0, 128, 255, 255], 'Input points stretch the range');
  assert.ok(filterPixel('levels', { midtones: 50 }, grey)[0] > 100, 'Positive midtones brighten');
  assert.ok(filterPixel('levels', { midtones: -50 }, grey)[0] < 100, 'Negative midtones darken');
  assert.deepEqual(filterPixel('levels', { outBlack: 20, outWhite: 220 }, [0, 0, 255, 255]), [20, 20, 220, 255], 'Output points squeeze it');
  assert.deepEqual(filterPixel('levels', { inBlack: 200, inWhite: 100 }, [150, 150, 150, 255]).length, 4, 'Crossed points do not break');

  assert.deepEqual(filterPixel('grayscale', {}, [255, 0, 0, 255]), [76, 76, 76, 255], 'Grayscale uses luma weights');

  assert.deepEqual(filterPixel('threshold', { threshold: 128, target: 'color' }, [200, 200, 200, 255]), [255, 255, 255, 255]);
  assert.deepEqual(filterPixel('threshold', { threshold: 128, target: 'color' }, [30, 30, 30, 255]), [0, 0, 0, 255]);
  assert.deepEqual(filterPixel('threshold', { threshold: 128, target: 'alpha' }, [60, 30, 0, 100]), [0, 0, 0, 0], 'Faint alpha clears');
  assert.deepEqual(filterPixel('threshold', { threshold: 128, target: 'alpha' }, [100, 50, 0, 200]), [128, 64, 0, 255], 'Strong alpha turns opaque, colour kept');
  assert.deepEqual(filterPixel('threshold', { threshold: 128, target: 'both' }, [100, 50, 0, 200]), [0, 0, 0, 255], 'Both: opaque and black');

  const bins = toneHistogram(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0, 32, 32, 32, 128]), 3, 1);
  assert.equal(bins[255], 1, 'White counted');
  assert.equal(bins[64], 1, 'Half-clear grey counted by its straight tone');
  assert.equal(bins.reduce((sum, n) => sum + n, 0), 2, 'Clear pixels are not counted');
  assert.equal(toneHistogram(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1, new Uint8Array([0, 255]))[255], 0, 'Only inside the selection');
}

/** A width × height picture filled by `paint(x, y)` (premultiplied RGBA, or null for clear) */
const picture = (width: number, height: number, paint: (x: number, y: number) => number[] | null) => {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = paint(x, y);
    if (color) pixels.set(color, (y * width + x) * 4);
  }
  return pixels;
};
const alphaAt = (pixels: Uint8Array, width: number, x: number, y: number) => pixels[(y * width + x) * 4 + 3];

// 修正線稿: exact distances, growing and thinning lines, specks and gaps, line extraction and colour
{
  const marked = new Uint8Array(7 * 5);
  marked[2 * 7 + 3] = 1;
  const field = distanceField(marked, 7, 5);
  assert.equal(field.dist2[2 * 7 + 3], 0, 'A marked pixel is at distance 0');
  assert.equal(field.dist2[0], 13, 'Corner to (3,2) is √13 away');
  assert.equal(field.nearest[0], 2 * 7 + 3, 'And that is its nearest mark');
  assert.equal(distanceField(new Uint8Array(4), 2, 2).nearest[0], -1, 'Nothing marked: no nearest');

  const W = 9, H = 9;
  const run = (id: string, values: FilterValues, pixels: Uint8Array) => runPixelFilter(PIXEL_FILTER_RUNNERS[id], pixels, W, H, values);
  const line = (from: number, to: number) => picture(W, H, (x) => (x >= from && x <= to ? [0, 0, 0, 255] : null));

  const grown = run('lineWidth', { amount: 2 }, line(4, 4));
  assert.equal(alphaAt(grown, W, 5, 4), 255, 'One pixel out is fully inked');
  assert.ok(alphaAt(grown, W, 6, 4) > 100 && alphaAt(grown, W, 6, 4) < 160, 'The new edge is soft');
  assert.equal(alphaAt(grown, W, 7, 4), 0, 'Three pixels out stays clear');
  assert.deepEqual([...grown.slice((4 * W + 5) * 4, (4 * W + 5) * 4 + 3)], [0, 0, 0], 'Grown ink takes the line colour');

  const thinned = run('lineWidth', { amount: -2, keepThin: false }, line(3, 5));
  assert.equal(alphaAt(thinned, W, 3, 4), 0, 'Thinning clears the edges');
  assert.ok(alphaAt(thinned, W, 4, 4) > 0 && alphaAt(thinned, W, 4, 4) < 255, 'The middle fades');
  assert.equal(alphaAt(run('lineWidth', { amount: -2, keepThin: true }, line(3, 5)), W, 4, 4), 255, 'Keeping thin lines keeps the middle');
  assert.equal(alphaAt(run('lineWidth', { amount: -3, keepThin: true }, line(4, 4)), W, 4, 4), 255, 'A 1 px line survives');
  assert.equal(alphaAt(run('lineWidth', { amount: -3, keepThin: false }, line(4, 4)), W, 4, 4), 0, 'Unless asked not to keep it');

  const S = 20;
  const specks = picture(S, S, (x, y) => ((x >= 3 && x <= 4 && y >= 3 && y <= 4) || (x >= 10 && x <= 15 && y >= 10 && y <= 15) ? [0, 0, 0, 255] : null));
  const cleaned = runPixelFilter(PIXEL_FILTER_RUNNERS.despeckle, specks, S, S, { size: 3, mode: 'opaque' });
  assert.equal(alphaAt(cleaned, S, 3, 3), 0, 'A 2 × 2 speck is removed');
  assert.equal(alphaAt(cleaned, S, 12, 12), 255, 'A 6 × 6 block stays');

  const red = [255, 0, 0, 255];
  const holed = (hx: number, hy: number) => picture(W, H, (x, y) => (x === hx && y === hy ? null : red));
  const filled = run('despeckle', { size: 2, mode: 'fillAround' }, holed(4, 4));
  assert.deepEqual([...filled.slice((4 * W + 4) * 4, (4 * W + 4) * 4 + 4)], red, 'A small hole takes the colour around it');
  assert.equal(alphaAt(run('despeckle', { size: 2, mode: 'fillAround' }, holed(0, 4)), W, 0, 4), 0, 'A hole on the edge is left open');
  const painted = run('despeckle', { size: 2, mode: 'fillCurrent', currentColor: '#00ff00' }, holed(4, 4));
  assert.deepEqual([...painted.slice((4 * W + 4) * 4, (4 * W + 4) * 4 + 4)], [0, 255, 0, 255], 'Or the current colour');
  const page = run('despeckle', { size: 2, mode: 'onWhite' }, picture(W, H, (x, y) => (x === 4 && y === 4 ? [0, 0, 0, 255] : [255, 255, 255, 255])));
  assert.deepEqual([...page.slice((4 * W + 4) * 4, (4 * W + 4) * 4 + 4)], [255, 255, 255, 255], 'A dark dot on white paper turns white');

  assert.deepEqual(filterPixel('extractLines', { whiteRange: 0 }, [255, 255, 255, 255]), [0, 0, 0, 0], 'White paper turns clear');
  assert.deepEqual(filterPixel('extractLines', { whiteRange: 0 }, [0, 0, 0, 255]), [0, 0, 0, 255], 'Black ink stays');
  assert.deepEqual(filterPixel('extractLines', { whiteRange: 0 }, [128, 128, 128, 255]), [0, 0, 0, 127], 'Grey becomes half-clear black');
  assert.deepEqual(filterPixel('extractLines', { whiteRange: 20 }, [230, 230, 230, 255]), [0, 0, 0, 0], 'Near-white within the range is paper');
  assert.deepEqual(filterPixel('extractLines', { whiteRange: 0, keepColor: true }, [255, 128, 128, 255]), [127, 0, 0, 127],
    'Kept colour is unmixed from the paper');

  assert.deepEqual(filterPixel('lineColor', { currentColor: '#ff0000' }, [0, 0, 0, 128]), [128, 0, 0, 128], 'Lines take the current colour, alpha kept');
  assert.deepEqual(filterPixel('lineColor', { useCurrent: false, color: '#0000ff', currentColor: '#ff0000' }, [0, 0, 0, 255]), [0, 0, 255, 255],
    'Or a chosen colour');
}

// 對齊 L1: basis, whole-pixel offsets, off-canvas parts, and a pixel-level run of the move
{
  assert.equal(resolveAlignBasis('auto', false), 'canvas', 'Auto without a selection uses the canvas');
  assert.equal(resolveAlignBasis('auto', true), 'selection', 'Auto with a selection uses the selection');
  assert.equal(resolveAlignBasis('selection', false), null, 'The selection basis needs a selection');
  assert.equal(resolveAlignBasis('canvas', true), 'canvas');

  const canvasFrame: AlignRect = { x: 0, y: 0, w: 100, h: 80 };
  const content: AlignRect = { x: 10, y: 20, w: 30, h: 40 };
  assert.deepEqual(alignOffset(content, canvasFrame, 'left', null), { dx: -10, dy: 0 });
  assert.deepEqual(alignOffset(content, canvasFrame, 'right', null), { dx: 60, dy: 0 });
  assert.deepEqual(alignOffset(content, canvasFrame, 'center', null), { dx: 25, dy: 0 });
  assert.deepEqual(alignOffset(content, canvasFrame, null, 'top'), { dx: 0, dy: -20 });
  assert.deepEqual(alignOffset(content, canvasFrame, null, 'bottom'), { dx: 0, dy: 20 });
  assert.deepEqual(alignOffset(content, canvasFrame, 'center', 'center'), { dx: 25, dy: 0 });
  // Odd leftover: 100 - 31 = 69 → 34 on the left, 35 on the right
  assert.equal(alignOffset({ x: 0, y: 0, w: 31, h: 1 }, canvasFrame, 'center', null).dx, 34);

  assert.deepEqual(selectionFrame({ minX: 5, minY: 6, maxX: 14, maxY: 9 }), { x: 5, y: 6, w: 10, h: 4 }, 'Selection bounds are inclusive');
  assert.deepEqual(selectionFrame({ minX: 5.4, minY: 6, maxX: 14.2, maxY: 9 }), { x: 5, y: 6, w: 11, h: 4 }, 'A fractional lasso frame covers the pixels it touches');

  assert.equal(alignCrops(content, -10, 0, 100, 80), false);
  assert.equal(alignCrops(content, -11, 0, 100, 80), true, 'One pixel past the left edge is cut off');
  assert.equal(alignCrops(content, 0, 21, 100, 80), true, 'One pixel past the bottom edge is cut off');
  assert.deepEqual(alignDestination({ x: 0, y: 0, w: 10, h: 10 }, -4, 0, 100, 80), { x: 0, y: 0, w: 6, h: 10, sx: 4, sy: 0 });
  assert.equal(alignDestination({ x: 0, y: 0, w: 10, h: 10 }, -10, 0, 100, 80), null, 'Nothing left on the canvas');

  const area = (rs: AlignRect[]) => rs.reduce((n, r) => n + r.w * r.h, 0);
  const a: AlignRect = { x: 0, y: 0, w: 10, h: 10 };
  assert.deepEqual(rectMinus(a, null), [a]);
  assert.deepEqual(rectMinus(a, { x: 20, y: 0, w: 5, h: 5 }), [a], 'Apart: all of it');
  assert.deepEqual(rectMinus(a, { x: 3, y: 0, w: 10, h: 10 }), [{ x: 0, y: 0, w: 3, h: 10 }]);
  assert.equal(area(rectMinus(a, { x: 4, y: 6, w: 10, h: 10 })) + 6 * 4, 100, 'Strips + overlap = the whole rect');
  assert.deepEqual(rectMinus(a, { x: -5, y: -5, w: 30, h: 30 }), [], 'Fully covered: nothing to clear');

  assert.equal(alignBlocker(null, { canEdit: true, busy: false, hasMask: false, movedByKeyframes: false }), 'noLayer');
  const raster = { id: 'r', layerType: 'raster' };
  assert.equal(alignBlocker(raster, { canEdit: true, busy: false, hasMask: false, movedByKeyframes: false }), null);
  assert.equal(alignBlocker(raster, { canEdit: true, busy: true, hasMask: false, movedByKeyframes: false }), 'busy');
  assert.equal(alignBlocker({ id: 'g', layerType: 'group' }, { canEdit: true, busy: false, hasMask: false, movedByKeyframes: false }), 'group');
  assert.equal(alignBlocker({ id: 'm', layerType: 'mask' }, { canEdit: true, busy: false, hasMask: false, movedByKeyframes: false }), 'mask');
  assert.equal(alignBlocker(raster, { canEdit: false, busy: false, hasMask: true, movedByKeyframes: true }), 'notEditable');
  assert.equal(alignBlocker(raster, { canEdit: true, busy: false, hasMask: true, movedByKeyframes: false }), 'hasMask');
  assert.equal(alignBlocker({ id: 't', layerType: 'text' }, { canEdit: true, busy: false, hasMask: false, movedByKeyframes: true }), 'keyframes');

  // The move as useLayerAlign does it, on a CPU buffer: clear what the pixels leave, write them where they land
  const W = 40;
  const H = 30;
  const paint = (rects: AlignRect[]) => {
    const px = new Uint8Array(W * H * 4);
    for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) px.set([200, 100, 50, 255], (y * W + x) * 4);
    return px;
  };
  const boundsOf = (px: Uint8Array): AlignRect => {
    const b = findContentBounds(px, W, H)!;
    return { x: b.minX, y: b.minY, w: b.maxX - b.minX + 1, h: b.maxY - b.minY + 1 };
  };
  const move = (px: Uint8Array, frame: AlignRect, x: 'left' | 'center' | 'right' | null, y: 'top' | 'center' | 'bottom' | null) => {
    const r = boundsOf(px);
    const { dx, dy } = alignOffset(r, frame, x, y);
    const dest = alignDestination(r, dx, dy, W, H);
    const moved = dest && copyRgbaRect(px, W, { x: r.x + dest.sx, y: r.y + dest.sy, w: dest.w, h: dest.h });
    const out = px.slice();
    const write = (rect: AlignRect, src: Uint8Array | null) => {
      for (let row = 0; row < rect.h; row++) {
        const at = ((rect.y + row) * W + rect.x) * 4;
        if (src) out.set(src.subarray(row * rect.w * 4, (row + 1) * rect.w * 4), at);
        else out.fill(0, at, at + rect.w * 4);
      }
    };
    for (const s of rectMinus(r, dest)) write(s, null);
    if (dest && moved) write(dest, moved);
    return out;
  };
  // An L of two strokes (bounds 7×6 at 9,5) with a gap inside the bounds
  const shape = paint([{ x: 9, y: 5, w: 2, h: 6 }, { x: 9, y: 9, w: 7, h: 2 }]);
  const full: AlignRect = { x: 0, y: 0, w: W, h: H };
  assert.deepEqual(boundsOf(move(shape, full, 'left', null)), { x: 0, y: 5, w: 7, h: 6 }, 'Left edge of the canvas');
  assert.deepEqual(boundsOf(move(shape, full, 'center', null)), { x: 16, y: 5, w: 7, h: 6 }, 'Horizontal centre: (40 - 7) / 2 → 16');
  assert.deepEqual(boundsOf(move(shape, full, null, 'bottom')), { x: 9, y: 24, w: 7, h: 6 }, 'Bottom edge of the canvas');
  const cornered = move(shape, full, 'right', 'bottom');
  assert.deepEqual(boundsOf(cornered), { x: 33, y: 24, w: 7, h: 6 });
  let opaque = 0;
  for (let i = 3; i < cornered.length; i += 4) if (cornered[i]) opaque++;
  assert.equal(opaque, 2 * 6 + 7 * 2 - 2 * 2, 'Every pixel moved, none lost or doubled');
  // A selection frame smaller than the layer: the whole layer moves to the frame's edge and nothing is cut
  const selFrame = selectionFrame({ minX: 20, minY: 2, maxX: 23, maxY: 4 });
  assert.deepEqual(boundsOf(move(shape, selFrame, 'left', 'top')), { x: 20, y: 2, w: 7, h: 6 }, 'The selection is only the frame');
}

// Recent visits: the gateway's continue card and room preselection
{
  const v = (over: Partial<RecentVisit>): RecentVisit => ({ mode: 'online', server: 'http://192.168.1.5:3000', canvasId: 'a', title: 'A', width: 100, height: 80, at: 1, ...over });
  assert.equal(normalizeServer('http://localhost:3000/'), 'http://127.0.0.1:3000', 'localhost and 127.0.0.1 are one server');
  assert.equal(normalizeServer('not a url'), undefined);
  let list = addRecentVisit([], v({}));
  list = addRecentVisit(list, v({ canvasId: 'b', at: 2 }));
  list = addRecentVisit(list, v({ mode: 'offline', server: 'http://x', canvasId: 's', at: 3 }));
  assert.deepEqual(list.map((e) => e.canvasId), ['s', 'b', 'a'], 'Newest first');
  assert.equal(list[0].server, undefined, 'A solo canvas has no server');
  list = addRecentVisit(list, v({ at: 4, title: 'A2' }));
  assert.deepEqual(list.map((e) => e.canvasId), ['a', 's', 'b'], 'Visiting again moves it to the front, no copy');
  assert.equal(list[0].title, 'A2');
  assert.equal(lastVisitOn(list, 'http://192.168.1.5:3000')?.canvasId, 'a', 'Last room on that server');
  assert.equal(lastVisitOn(list, 'http://other:3000'), undefined);
  assert.equal(lastVisitOn(addRecentVisit([], v({ server: 'http://localhost:3000' })), 'http://127.0.0.1:3000')?.canvasId, 'a');
  assert.deepEqual(removeRecentVisit(list, list[0]).map((e) => e.canvasId), ['s', 'b']);
  assert.equal(addRecentVisit([], v({ server: 'bad' })).length, 0, 'An online visit needs a valid server');
  let many: RecentVisit[] = [];
  for (let i = 0; i < RECENT_VISITS_LIMIT + 5; i++) many = addRecentVisit(many, v({ canvasId: 'c' + i, at: i }));
  assert.equal(many.length, RECENT_VISITS_LIMIT, 'The list is capped');
  assert.deepEqual(parseRecentVisits(JSON.stringify([...list, { mode: 'online', server: 'nope', canvasId: 'z', title: '', width: 1, height: 1, at: 1 }, 5, null])), list, 'Bad entries are dropped');
  assert.deepEqual(parseRecentVisits('{broken'), []);
  assert.deepEqual(parseRecentVisits(null), []);
}
console.log('ui-logic checks passed');
