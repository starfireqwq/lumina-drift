/**
 * Self-check for the pure UI logic added in the workspace redesign.
 * Run: npx tsx apps/client/scripts/ui-logic.check.ts   (from the repo root; exits non-zero on failure)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLOATS_PER_DAB, StrokeWorkerEngine, type WorkerBrushConfig } from '../src/workers/stroke.worker';
import { contrastRatio, resolveLuminaGlowVars, resolveTheme, THEME_PRESETS, DEFAULT_CUSTOM_THEME } from '../src/theme/themes';
import { ALL_SUB_TOOLS, nextSizeStep, TOOL_CATEGORIES } from '../src/components/workspace/toolCatalog';
import { createSubToolStore, SUB_TOOL_STORAGE_KEY, type StorageLike } from '../src/components/workspace/subToolStore';
import { findContentBounds } from '../src/utils/pixelBounds';
import {
  clampSubViewZoom, computeSubViewFitScale, DEFAULT_SUB_VIEW_TRANSFORM, normalizeSubViewRotation,
  sampleSubViewPixel, subViewImageToScreen, subViewScreenToImage, zoomSubViewAroundPoint,
} from '../src/utils/subViewMath';
import { COLOR_HISTORY_MAX, createColorHistoryStore } from '../src/services/colorHistoryStore';
import { normalizeHexColor, parseAcoPalette, parseGplPalette, serializeAcoPalette, serializeGplPalette } from '../src/utils/colorPaletteIO';
import { blendPigmentRgba, paintMixingDab, sampleMixingBuffer, seedDefaultMixingPad, strokeMixingSegment } from '../src/utils/mixingPadEngine';
import { computePopupPalettePosition, computeRadialSlotPositions, hitTestPopupRing } from '../src/utils/popupPaletteMath';
import {
  getQuickShapeDelayMs, getQuickShapeEnabled, setQuickShapeDelayMs, setQuickShapeEnabled,
  shouldOpenDesktopPopupOnContextMenu,
} from '../src/engine/inputPreferences';
import {
  adjustQuickShapeByPointer, buildQuickShapeDabs, recognizeQuickShape, sampleQuickShapePoints,
  type QuickShapeCandidate, type QuickShapePoint,
} from '../src/engine/quickShape';
import {
  attachPinToMesh, buildPuppetMeshFromAlpha, rasterizePuppetWarpToRgba, solvePuppetWarp,
  type PuppetMesh, type PuppetPin,
} from '../src/engine/PuppetWarpEngine';
import {
  computeWrappedFloodFillMask, getWrapAroundBoundsOffsets, getWrappedDirtyTilesForBounds,
  getWrappedDirtyTilesForPoints, getWrappedStampPoints, wrapCoord, wrapPoint,
} from '../src/engine/wrapAround';
import {
  alignCrops, alignDestination, alignManyOffsets, alignOffset, alignTargetsBlocker,
  computeVectorLayerAlignRect, computeVectorStrokeAlignRect, copyRgbaRect,
  distributeOffsets, guideAlignManyOffsets, guideAlignOffset, guideAxisAvailability,
  guideDistributeFrame, rectMinus, resolveAlignBasis, resolveAlignTargets,
  selectionFrame, summarizeGuides, unionRect,
  type AlignLayerLike, type AlignRect, type DistributeMode,
} from '../src/utils/layerAlign';
import { RulerManager } from '../src/engine/RulerManager';
import { shiftVectorStroke } from '../src/services/offlineStore';
import { getEffectivePaperColor, getPaletteContrastColor, readLayerColorPreferences, updateColorOverrides } from '../src/utils/layerColorDisplay';
import { applyColorOutline } from '../src/engine/colorOutline';
import { addRecentVisit, lastVisitOn, normalizeServer, parseRecentVisits, removeRecentVisit, RECENT_VISITS_LIMIT, type RecentVisit } from '../src/utils/recentVisits';
import { healUnderMask } from '../src/engine/VectorEngine';
import { ScopedUndoManager } from '../src/engine/ScopedUndoManager';
import {
  ADJUSTMENT_BLEND_MODE_IDS,
  ADJUSTMENT_GLSL,
  ADJUSTMENT_KINDS,
  adjustmentBlendModeId,
  adjustmentClipBaseId,
  applyAdjustmentStep,
  applyCompiledAdjustmentRgb,
  applyLayerColorToImageData,
  blendAdjustmentRgb,
  compileAdjustment,
  compiledAdjustmentUniforms,
  createDefaultAdjustment,
  isAdjustmentIdentity,
  normalizeAdjustment,
  resolveAdjustmentScope,
  resolveEffectiveLayerColor,
  resolveEffectivePaletteColor,
  sanitizeLayerMetaForType,
  type LayerAdjustment,
  Affine2D,
  applyAffinePoint,
  BEZIER_PRESETS,
  canManageCanvasMemberRole,
  computeCameraCanvasToOutputMatrix,
  computeCameraPreviewViewport,
  computeAudioPlaybackWindow,
  computePaintUnfilledAreaMask,
  computeSmartEncloseFillMask,
  computeStrokeBounds,
  computeWaveformPeaks,
  DynamicStabilizer,
  clampDpi,
  eraseStrokePartial,
  evaluateCameraFrame,
  evaluateEasing,
  evaluateTransformKeyframes,
  findCameraLayer,
  formatCanvasDimensions,
  getCanvasRoleCapabilities,
  hitTestVectorStroke,
  invertAffine,
  isAssignableCanvasRole,
  isAudioLayer,
  isCameraLayer,
  matchBezierPreset,
  MAX_STABILIZER_LEVEL,
  multiplyAffine,
  normalizeAudioTrackMeta,
  normalizeCameraMeta,
  pixelsToUnit,
  rasterizeLassoMask,
  resolveAudioClipFrameRange,
  sampleCameraMotionPath,
  STABILIZER_LEVEL_STEP,
  tileToRgba,
  type ScopedUndoOp,
  type TileData,
  type VectorStroke,
  transformToAffineMatrix,
  unitToPixels,
} from '@atelier/shared';
import { getBoxPivotCanvasPoint, type TransformBox } from '../src/utils/transformProjection';
import { normalizeLuminaLayers } from '../src/engine/LuminaProjectEngine';
import { combineMaskCoverages, isAdjustmentItem } from '../src/engine/layerComposite';
import { luminaToPsdAdjustment, psdIsolatedGroupIds, psdToLuminaAdjustment } from '../src/engine/psdAdjustmentMapping';
import { adjustmentScopeIsFresh, adjustmentScopeKey, adjustmentScopeRenderResolution, MAX_SCOPE_PIXELS } from '../src/engine/adjustmentView';
import {
  applyKeyframeHandleDrag,
  buildKeyframeFromEval,
  resolveParentWorldAffine,
  sampleKeyframeMotionPath,
} from '../src/utils/keyframeTransform';
import {
  adjacentKeyframeFrame, AnimationEngine, animationDisplay, celEntriesOf, celInsertAt, celOfLayer, entryIndexAt, exportSegments, findAdjacentKeyframe, formatTimecode, frameSignature, MAX_HOLD, MAX_TIMELINE_FRAMES, movedByKeyframes,
  normalizeTimelineLabels, parseTimecode, placeEntries, planRepeatCels, planSequentialCelRenames, playbackFrame, removeTimelineLabel, removeTransformKeyframe,
  timeOfCel, trackLength, upsertTimelineLabel, upsertTransformKeyframe,
} from '../src/engine/AnimationEngine';
import {
  binarizeLineArt,
  computeScaledExportDimensions,
  DEFAULT_LINE_COLOR_RULES,
  encodeBmp24,
  encodeTga,
  formatCelFileName,
  formatSequenceFileName,
  planSequenceFrames,
  resolveExportFrameRange,
  resolveExportRegion,
  sanitizeFileNameSegment,
} from '../src/engine/animationExport';
import {
  buildWebCodecsCandidates,
  computeFrameDurationUs,
  computeFrameTimestampUs,
} from '../src/engine/videoExport';
import {
  DEFAULT_SHORTCUTS,
  ShortcutManager,
  makePluginCommandShortcutId,
  makePluginPanelShortcutId,
  makePluginToolShortcutId,
  parsePluginShortcutId,
} from '../src/engine/ShortcutManager';
import {
  applySelectionPostProcess,
  combineSelectionMasks,
  computeMarqueeRect,
  rasterizeEllipseMask,
  rasterizeRectMask,
} from '../src/engine/selectionMaskOps';
import {
  buildInitialToolOptions,
  collectEnabledPluginTools,
  PluginToolPointerController,
} from '../src/plugins/pluginTools';
import {
  applyPanelPatchValues,
  buildInitialPanelValues,
  isPluginPanelFieldVisible,
} from '../src/components/PluginPanelWindow';
import {
  addExternalLightRef,
  cleanLightTable,
  clearLightTable,
  emptyLightTable,
  externalRefsFor,
  getLightTableTransform,
  lightIdsFor,
  lightTableTransformToAffine,
  removeExternalLightRef,
  resetLightTableTransform,
  resolveLightTableTargetCel,
  setPinnedLightTarget,
  toggleLightCel,
  updateLightTableTransform,
} from '../src/engine/lightTable';
import { nextGroupName } from '../src/utils/canvasName';
import {
  PLUGIN_LIMITS,
  PLUGIN_PERMISSIONS_V2_CORE,
  parsePlugin,
  parsePluginAction,
  resolvePluginDescription,
  resolvePluginName,
  resolvePluginText,
  type PluginManifestV2,
} from '../src/plugins/pluginApi';
import {
  createPluginStore,
  PLUGIN_STORAGE_KEY_V1,
  PLUGIN_STORAGE_KEY_V2,
  type PluginStorageBackend,
} from '../src/plugins/pluginStore';
import { executePluginV1 } from '../src/plugins/pluginSandboxCore';
import { startPluginToolDirect, startPluginV2Direct } from '../src/plugins/pluginHost';
import {
  PluginCanvasTransaction,
  premultipliedToStraight,
  straightToPremultiplied,
  type PluginBrushState,
  type PluginCanvasHostAdapter,
  type PluginTimelineBridge,
} from '../src/plugins/pluginCanvasBridge';
import { getPluginLabels, getPluginPermissionLabel } from '../src/plugins/pluginLabels';
import { resetPluginEasingsForTests } from '../src/plugins/pluginEasingRegistry';
import { createHeadlessSelectionBridge } from '../src/plugins/pluginSelectionBridge';
import type { LayerModel } from '@atelier/shared';
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
  DEFAULT_COMMUNITY_PRESETS, MIN_BRUSH_SPACING, PIXEL_FILTER_RUNNERS, distanceField, downscale, runDraftFilter, runPixelFilter, toneHistogram, upscale,
  type CanvasModel, type FilterValues,
  AbrParser, SutParser, SqliteReader, parseSutEffectorBlob,
  evaluateDynamicChannel, evaluateAngleJitterRadians, evaluateFgBgMixRatio,
  resolveDefaultBrushDynamics, normalizeBrushDynamics,
} from '@atelier/shared';
import {
  BUILTIN_FILTERS, FILTER_DRAFT, FILTER_GROUPS, defaultFilterValues, filterDraftFactor, filterFitsLayer, filterGroupsInUse, filterLabel,
  filterParamLabel, filterPointParam, filtersInGroup, getFilter, makePluginFilterId, normalizeFilterValues, paramShown, snapRange,
  syncPluginFilters,
} from '../src/utils/filterRegistry';
import { runPluginFilterTiled } from '../src/plugins/pluginFilterCore';
import { COLOR_ADJUST_PRESETS, matchColorPreset } from '../src/utils/filterPresets';
import { assessFilterCompositeMemory, filterNewLayerPlacement, filterNonEmptyTileCoords } from '../src/utils/filterMemoryGuard';
import { BUILTIN_LIBRARY_CARDS, createFavoriteCard, parseFavoriteCards, scaleFilterValuesForThumbnail } from '../src/utils/filterLibrary';

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

// ScopedUndoManager groupId: atomic multi-layer undo/redo, rollback, permission skip, non-splitting trim, and foreign merge
{
  const blank = [0, 0, 0, 0];
  const blue = [59, 130, 246, 255];
  const red = [253, 0, 48, 255];
  const tile = (...pixels: number[][]): TileData => ({
    col: 0, row: 0, width: pixels.length, height: 1, compression: 'raw', data: Uint8Array.from(pixels.flat()),
  });
  const makeOp = (opId: string, layerId: string, userId = 'artist', groupId?: string, extra: Partial<ScopedUndoOp> = {}): ScopedUndoOp => ({
    opId,
    userId,
    layerId,
    opType: extra.opType ?? 'ALIGN',
    groupId,
    timestamp: 0,
    beforeTiles: [tile(blank, blank)],
    afterTiles: [tile(red, blank)],
    ...extra,
  });

  // 1. undoGroup / redoGroup / rollbackGroup / logical counts
  const mgr = new ScopedUndoManager();
  const single = makeOp('s0', 'l0');
  const peer = makeOp('p0', 'l0', 'other');
  const gA = makeOp('gA', 'l1', 'artist', 'grp-1');
  const gB = makeOp('gB', 'l2', 'artist', 'grp-1');
  const gC = makeOp('gC', 'l3', 'artist', 'grp-1');
  mgr.push(single);
  mgr.push(peer);
  mgr.push(gA);
  mgr.push(gB);
  mgr.push(gC);
  assert.equal(mgr.getUndoCount(), 3, 'Grouped ops count as 1 logical step globally');
  assert.equal(mgr.getUndoCount('artist'), 2);
  assert.equal(mgr.getUndoCount('other'), 1);
  assert.equal(mgr.getRedoCount(), 0);

  const undone = mgr.undoGroup('artist');
  assert.deepEqual(undone.map((o) => o.opId), ['gC', 'gB', 'gA'], 'undoGroup returns ops in reverse push order');
  assert.equal(mgr.getUndoCount('artist'), 1);
  assert.equal(mgr.getRedoCount('artist'), 1);

  mgr.rollbackGroup(undone, true);
  assert.equal(mgr.getUndoCount('artist'), 2);
  assert.equal(mgr.getRedoCount('artist'), 0);
  assert.deepEqual(mgr.inspect().undo.map((o) => o.opId), ['s0', 'p0', 'gA', 'gB', 'gC'], 'rollbackGroup restores undo order');

  const undone2 = mgr.undoGroup('artist');
  assert.deepEqual(undone2.map((o) => o.opId), ['gC', 'gB', 'gA']);
  const redone = mgr.redoGroup('artist');
  assert.deepEqual(redone.map((o) => o.opId), ['gA', 'gB', 'gC'], 'redoGroup returns ops in original order');
  assert.equal(mgr.getUndoCount('artist'), 2);
  assert.equal(mgr.getRedoCount('artist'), 0);

  mgr.rollbackGroup(redone, false);
  assert.equal(mgr.getUndoCount('artist'), 1);
  assert.equal(mgr.getRedoCount('artist'), 1);
  assert.deepEqual(mgr.inspect().redo.map((o) => o.opId), ['gC', 'gB', 'gA']);
  assert.deepEqual(mgr.redoGroup('artist').map((o) => o.opId), ['gA', 'gB', 'gC']);

  // 2. Whole-group permission skip & SELECTION exemption & other-user skip
  const permMgr = new ScopedUndoManager();
  const baseOp = makeOp('base', 'l1');
  const lockA = makeOp('la', 'l1', 'artist', 'grp-lock');
  const selInGroup = makeOp('sel', '__selection__', 'artist', 'grp-lock', { opType: 'SELECTION' });
  const lockB = makeOp('lb', 'l-locked', 'artist', 'grp-lock');
  const otherG1 = makeOp('og1', 'l1', 'other', 'grp-other');
  const otherG2 = makeOp('og2', 'l2', 'other', 'grp-other');
  permMgr.push(baseOp);
  permMgr.push(lockA);
  permMgr.push(selInGroup);
  permMgr.push(lockB);
  permMgr.push(otherG1);
  permMgr.push(otherG2);

  const popped = permMgr.undoGroup('artist', (layerId) => layerId !== 'l-locked' && layerId !== '__selection__');
  assert.deepEqual(popped.map((o) => o.opId), ['base'], 'Skips other user group and partially-locked group intact');
  assert.deepEqual(permMgr.inspect().undo.map((o) => o.opId), ['la', 'sel', 'lb', 'og1', 'og2']);

  // SELECTION inside an editable group passes permission check
  const selMgr = new ScopedUndoManager();
  selMgr.push(makeOp('sa', 'l1', 'artist', 'grp-sel'));
  selMgr.push(makeOp('ss', '__selection__', 'artist', 'grp-sel', { opType: 'SELECTION' }));
  assert.deepEqual(
    selMgr.undoGroup('artist', (layerId) => layerId !== '__selection__').map((o) => o.opId),
    ['ss', 'sa'],
  );

  // redoGroup permission skip mirrors undoGroup
  const redoSkipMgr = new ScopedUndoManager();
  redoSkipMgr.push(makeOp('ok1', 'l1', 'artist', 'grp-ok'));
  redoSkipMgr.push(makeOp('ok2', 'l2', 'artist', 'grp-ok'));
  redoSkipMgr.push(makeOp('bad1', 'l1', 'artist', 'grp-bad'));
  redoSkipMgr.push(makeOp('bad2', 'l-locked', 'artist', 'grp-bad'));
  redoSkipMgr.undoGroup('artist'); // pops grp-bad -> redoStack = [bad2, bad1]
  redoSkipMgr.undoGroup('artist'); // pops grp-ok -> redoStack = [bad2, bad1, ok2, ok1]
  assert.deepEqual(
    redoSkipMgr.redoGroup('artist', (layerId) => layerId !== 'l1').map((o) => o.opId),
    [],
    'Returns [] when no group passes',
  );
  assert.deepEqual(
    redoSkipMgr.redoGroup('artist', (layerId) => layerId !== 'l2').map((o) => o.opId),
    ['bad1', 'bad2'],
    'Skips grp-ok when one member is locked and redoes grp-bad instead',
  );

  // 3. trimStacks counts logical steps and drops whole group without splitting
  const trimMgr = new ScopedUndoManager(5);
  const t1 = makeOp('t1', 'l1', 'artist', 'g-old', { foreign: new Map([['0_0', new Uint8Array([1])]]) });
  const t2 = makeOp('t2', 'l2', 'artist', 'g-old');
  const t3 = makeOp('t3', 'l3', 'artist', 'g-old');
  trimMgr.push(t1);
  trimMgr.push(t2);
  trimMgr.push(t3);
  for (let k = 1; k <= 4; k++) trimMgr.push(makeOp(`u${k}`, 'l1'));
  assert.equal(trimMgr.getUndoCount(), 5, '1 group of 3 + 4 singles = 5 logical steps');
  assert.equal(trimMgr.inspect().undo.length, 7, 'All 3 ops of oldest group stay intact at limit');
  trimMgr.push(makeOp('u5', 'l1'));
  assert.equal(trimMgr.getUndoCount(), 5);
  assert.deepEqual(trimMgr.inspect().undo.map((o) => o.opId), ['u1', 'u2', 'u3', 'u4', 'u5'], 'Entire oldest group dropped at once');
  for (const dropped of [t1, t2, t3]) {
    assert.equal(dropped.beforeTiles.length, 0);
    assert.equal(dropped.afterTiles.length, 0);
    assert.equal(dropped.foreign, undefined);
  }

  // redoStack trimming also drops whole group without splitting
  const redoTrim = new ScopedUndoManager(6);
  for (let k = 1; k <= 5; k++) redoTrim.push(makeOp(`rs${k}`, 'l1'));
  const rOld1 = makeOp('ro1', 'l1', 'artist', 'g-redo-old');
  const rOld2 = makeOp('ro2', 'l2', 'artist', 'g-redo-old');
  redoTrim.push(rOld1);
  redoTrim.push(rOld2);
  for (let k = 1; k <= 6; k++) redoTrim.undoGroup('artist'); // 1st undo pops g-redo-old -> oldest on redoStack
  redoTrim.setMaxStackSize(5);
  assert.equal(redoTrim.getRedoCount(), 5);
  assert.equal(redoTrim.inspect().redo.length, 5, 'Oldest redo group dropped as one unit');
  assert.equal(rOld1.beforeTiles.length, 0);
  assert.equal(rOld2.beforeTiles.length, 0);

  // 4. opsTouchingTile / recordForeignTile / setForeignEditActive / mergeForeignTile / rebaseBeforeTiles / remapLayer on grouped ops
  const fxMgr = new ScopedUndoManager();
  const fxA = makeOp('fxA', 'layer-a', 'artist', 'grp-fx', {
    baseSeq: 4,
    beforeTiles: [tile(blue, blank)],
    afterTiles: [tile(red, blank)],
  });
  const fxB = makeOp('fxB', 'layer-b', 'artist', 'grp-fx', {
    baseSeq: 4,
    beforeTiles: [tile(blank, blank)],
    afterTiles: [tile(red, red)],
  });
  fxMgr.push(fxA);
  fxMgr.push(fxB);
  fxMgr.rebaseBeforeTiles('layer-a', 2, 5, tile(blue, blank), tile(blank, blank));
  assert.deepEqual(Array.from(tileToRgba(fxA.beforeTiles[0])), [...blank, ...blank], 'rebaseBeforeTiles updates grouped op');
  const touching = fxMgr.opsTouchingTile('layer-a', 0, 0);
  assert.deepEqual(touching.map((o) => o.opId), ['fxA']);
  fxMgr.recordForeignTile(touching, '0_0', {
    edit: fxMgr.foreignEdit('peer', 2),
    changed: Uint8Array.from([0, 1]),
  });
  fxMgr.remapLayer('layer-a', 'layer-a-remapped');
  assert.equal(fxA.layerId, 'layer-a-remapped');
  const poppedFx = fxMgr.undoGroup('artist');
  assert.deepEqual(poppedFx.map((o) => o.opId), ['fxB', 'fxA']);
  const current = tile(red, blue).data as Uint8Array;
  const target = tileToRgba(fxA.beforeTiles[0]);
  const mine = tileToRgba(fxA.afterTiles[0]);
  const merged = fxMgr.mergeForeignTile(fxA, '0_0', target, mine, current);
  assert.equal(merged.conflicts, 0);
  assert.deepEqual(Array.from(merged.pixels), [...blank, ...blue], 'Foreign pixel untouched when own edit did not touch index 1');

  // When own edit DID touch index 1 and peer also painted index 1, conflict is preserved (and disabled when peer undoes)
  const fxA2 = makeOp('fxA2', 'layer-a2', 'artist', 'grp-fx2', {
    beforeTiles: [tile(blank, blank)],
    afterTiles: [tile(red, red)],
  });
  fxMgr.push(fxA2);
  fxMgr.recordForeignTile(fxMgr.opsTouchingTile('layer-a2', 0, 0), '0_0', {
    edit: fxMgr.foreignEdit('peer2', 3),
    changed: Uint8Array.from([0, 1]),
  });
  const [poppedA2] = fxMgr.undoGroup('artist');
  const merged2 = fxMgr.mergeForeignTile(
    poppedA2,
    '0_0',
    tileToRgba(poppedA2.beforeTiles[0]),
    tileToRgba(poppedA2.afterTiles[0]),
    tile(red, blue).data as Uint8Array,
  );
  assert.equal(merged2.conflicts, 1, 'Conflict preserved for grouped op');
  assert.deepEqual(Array.from(merged2.pixels), [...blank, ...blue]);
  fxMgr.setForeignEditActive('layer-a2', 3, false);
  const mergedAfterPeerUndo = fxMgr.mergeForeignTile(
    poppedA2,
    '0_0',
    tileToRgba(poppedA2.beforeTiles[0]),
    tileToRgba(poppedA2.afterTiles[0]),
    tile(red, red).data as Uint8Array,
  );
  assert.equal(mergedAfterPeerUndo.conflicts, 0, 'Deactivating foreign edit on grouped op restores cleanly');
  assert.deepEqual(Array.from(mergedAfterPeerUndo.pixels), [...blank, ...blank]);
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
    assert.deepEqual(cleaned, {
      enabled: false,
      opacity: 1,
      cels: { x: ['a', 'b'] },
      tracks: {},
      transforms: {},
      externalRefs: [],
      pinnedTargetId: null,
    });
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

  // Phase C1 + C4: opacity keyframes, legacy default, overshoot clamping, bezier presets, affine invert
  {
    assert.equal(mid.opacity, 1, 'legacy keyframes without opacity evaluate to 1');
    const fadeKfs = [
      { frame: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 100, pivotY: 100, opacity: 0, easing: 'linear' as const },
      { frame: 4, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 100, pivotY: 100, opacity: 1, easing: 'linear' as const },
    ];
    assert.equal(evaluateTransformKeyframes(fadeKfs, 0, 100, 100).opacity, 0);
    assert.ok(Math.abs(evaluateTransformKeyframes(fadeKfs, 2, 100, 100).opacity - 0.5) < 1e-6);
    assert.equal(evaluateTransformKeyframes(fadeKfs, 4, 100, 100).opacity, 1);

    // Overshoot bezier preset exceeds 1 for spatial props, but opacity stays clamped in [0, 1]
    const strongOvershoot = BEZIER_PRESETS.find((p) => p.id === 'strongOvershoot')!;
    assert.equal(matchBezierPreset(strongOvershoot.bezier), 'strongOvershoot');
    assert.equal(matchBezierPreset([0.11, 0.22, 0.33, 0.44]), null);
    const bounceKfs = [
      { frame: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 0, pivotY: 0, opacity: 0, easing: 'cubicBezier' as const, bezier: strongOvershoot.bezier },
      { frame: 10, x: 100, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 0, pivotY: 0, opacity: 1, easing: 'linear' as const },
    ];
    let sawOvershootX = false;
    for (let f = 1; f < 10; f++) {
      const ev = evaluateTransformKeyframes(bounceKfs, f, 0, 0);
      if (ev.x > 100) sawOvershootX = true;
      assert.ok(ev.opacity >= 0 && ev.opacity <= 1, `overshoot opacity must stay in [0, 1], got ${ev.opacity}`);
    }
    assert.ok(sawOvershootX, 'strongOvershoot preset should overshoot spatial motion');

    // animationDisplay multiplies keyframe opacity (and skips during original-position edit)
    const fadeLayer = { id: 'fade', parentId: null, layerType: 'raster', sortOrder: 1, isVisible: true, opacity: 0.8, meta: { keyframes: fadeKfs } };
    const dispFadeMid = animationDisplay([fadeLayer], { time: 2, activeFolderId: null, onion: null }, 200, 200);
    assert.ok(Math.abs(dispFadeMid[0].opacity - 0.4) < 1e-6, 'layer opacity multiplies with keyframe opacity');
    assert.equal(dispFadeMid[0].renderOpacityApplied, true);
    const dispFadeOrig = animationDisplay([fadeLayer], { time: 0, activeFolderId: null, onion: null, original: 'fade' }, 200, 200);
    assert.equal(dispFadeOrig[0].opacity, 0.8, 'original-position editing keeps base opacity visible');

    // exportSegments emits each distinct opacity step for GIF / video export
    const fadeSegs = exportSegments([fadeLayer], 0, 4, null, 200, 200);
    assert.equal(fadeSegs.length, 5, '0->1 fade over frames 0..4 produces 5 distinct export segments');

    // invertAffine + applyAffinePoint round-trip
    const inv = invertAffine(m);
    assert.ok(inv, 'non-singular transform matrix must be invertible');
    const pt = applyAffinePoint(m, 37, -19);
    const back = applyAffinePoint(inv!, pt.x, pt.y);
    assert.ok(Math.hypot(back.x - 37, back.y - -19) < 1e-5, 'invertAffine round-trips points');

    // Phase C2 + C3: direct canvas keyframe handle solver & motion path sampling
    const baseEval = {
      x: 20, y: -10, scaleX: 1.5, scaleY: 0.8, rotation: Math.PI / 6,
      pivotX: 100, pivotY: 120, opacity: 0.75, active: true,
    };
    const mBefore = transformToAffineMatrix(baseEval);
    // Dragging pivot by (+40, -25) must preserve the resulting affine matrix (zero visual jump)
    const afterPivot = applyKeyframeHandleDrag({
      handle: 'pivot',
      startEval: baseEval,
      parentWorld: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0, isIdentity: true },
      startCanvas: { x: 120, y: 110 },
      curCanvas: { x: 160, y: 85 },
    });
    const mAfter = transformToAffineMatrix(afterPivot);
    const testPx = applyAffinePoint(mBefore, 45, 70);
    const testPxAfter = applyAffinePoint(mAfter, 45, 70);
    assert.ok(
      Math.hypot(testPx.x - testPxAfter.x, testPx.y - testPxAfter.y) < 0.35,
      `pivot drag must not shift rendered pixels (delta=${Math.hypot(testPx.x - testPxAfter.x, testPx.y - testPxAfter.y)})`
    );

    // Move handle under a 90-degree rotated parent group maps canvas +X into local -Y
    const rotParentLayer = {
      id: 'grp90', parentId: null, layerType: 'group', sortOrder: 1, isVisible: true, opacity: 1,
      meta: { keyframes: [{ frame: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: Math.PI / 2, pivotX: 0, pivotY: 0, easing: 'linear' as const }] },
    };
    const childLayer = {
      id: 'child1', parentId: 'grp90', layerType: 'raster', sortOrder: 2, isVisible: true, opacity: 1,
      meta: { keyframes: [] },
    };
    const parentW = resolveParentWorldAffine([rotParentLayer, childLayer], 'child1', 0, 200, 200);
    const movedLocal = applyKeyframeHandleDrag({
      handle: 'move',
      startEval: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 100, pivotY: 100, opacity: 1, active: false },
      parentWorld: parentW,
      startCanvas: { x: 0, y: 0 },
      curCanvas: { x: 100, y: 0 },
    });
    assert.ok(Math.abs(movedLocal.x) < 1e-3 && Math.abs(movedLocal.y - -100) < 1e-3, 'rotated parent inverse maps world +X to local -Y');

    // Rotate handle with 15-degree snap & uniform corner scale
    const rotSnapped = applyKeyframeHandleDrag({
      handle: 'rotate',
      startEval: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 100, pivotY: 100, opacity: 1, active: true },
      parentWorld: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0, isIdentity: true },
      startCanvas: { x: 100, y: 50 },
      curCanvas: { x: 130, y: 60 },
      snapAngle: true,
    });
    const degSnap = (rotSnapped.rotation * 180) / Math.PI;
    assert.ok(Math.abs(degSnap - Math.round(degSnap / 15) * 15) < 0.05, 'snapAngle rounds rotation to 15-degree steps');

    const scaled = applyKeyframeHandleDrag({
      handle: 'se',
      startEval: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 100, pivotY: 100, opacity: 1, active: true },
      parentWorld: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0, isIdentity: true },
      startCanvas: { x: 150, y: 150 },
      curCanvas: { x: 200, y: 200 },
      maintainAspect: true,
    });
    assert.ok(Math.abs(scaled.scaleX - 2) < 1e-3 && Math.abs(scaled.scaleY - 2) < 1e-3, 'uniform corner drag doubles scale');

    // buildKeyframeFromEval preserves existing opacity & easing
    const preserved = buildKeyframeFromEval(fadeKfs, 0, { ...baseEval, x: 55 });
    assert.equal(preserved.opacity, 0);
    assert.equal(preserved.easing, 'linear');
    assert.equal(preserved.x, 55);

    // sampleKeyframeMotionPath returns samples & keyPoints and updates with liveOverride
    const pathLayer = {
      id: 'mover', parentId: null, layerType: 'raster', sortOrder: 1, isVisible: true, opacity: 1,
      meta: {
        keyframes: [
          { frame: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 100, pivotY: 100, easing: 'linear' as const },
          { frame: 4, x: 80, y: 40, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 100, pivotY: 100, easing: 'linear' as const },
        ],
      },
    };
    const path = sampleKeyframeMotionPath([pathLayer], 'mover', 200, 200);
    assert.ok(path && path.hasMovement);
    assert.equal(path!.samples.length, 5);
    assert.equal(path!.keyPoints.length, 2);
    assert.ok(Math.abs(path!.samples[2].x - 140) < 1e-5 && Math.abs(path!.samples[2].y - 120) < 1e-5);
    const livePath = sampleKeyframeMotionPath([pathLayer], 'mover', 200, 200, {
      frame: 4,
      evaluated: { x: 200, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 100, pivotY: 100, opacity: 1, active: true },
    });
    assert.ok(livePath && Math.abs(livePath.keyPoints[1].x - 300) < 1e-5, 'liveOverride updates motion path in real time');
  }

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
      pressureCurve: gpen.properties.pressureCurve as WorkerBrushConfig['pressureCurve'],
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

// Phase 2: category definitions, eraser toolset, and unified fill sub-tool defaults
{
  assert.deepEqual(TOOL_CATEGORIES.map(({ id }) => id), [
    'paint', 'eraser', 'blend', 'fill', 'gradient', 'eyedropper', 'select',
    'transform', 'vector', 'shape', 'text', 'comic', 'animation', 'hand',
  ]);
  for (const category of TOOL_CATEGORIES) {
    assert.ok(category.subTools.some(({ id }) => id === category.defaultSubToolId));
    assert.ok(category.subTools.every(({ categoryId }) => categoryId === category.id));
  }
  assert.equal(new Set(ALL_SUB_TOOLS.map(({ id }) => id)).size, ALL_SUB_TOOLS.length);

  const eraser = TOOL_CATEGORIES.find(({ id }) => id === 'eraser');
  assert.ok(eraser);
  assert.deepEqual(eraser.subTools.map(({ id }) => id), [
    'eraser_hard', 'eraser_soft', 'eraser_pressure_size', 'eraser_fixed_size', 'eraser_pressure_opacity',
  ]);

  const fill = TOOL_CATEGORIES.find(({ id }) => id === 'fill');
  assert.ok(fill);
  assert.equal(fill.shortcutId, 'tool_bucket');
  assert.equal(fill.defaultSubToolId, 'fill_bucket');
  assert.deepEqual(fill.subTools.map(({ id, tool, defaultParams }) => ({ id, tool, defaultParams })), [
    { id: 'fill_bucket', tool: 'bucket', defaultParams: { bucketMode: 'click', bucketReference: 'all', bucketTolerance: 32, bucketExpand: 1 } },
    {
      id: 'fill_enclose', tool: 'smart_fill',
      defaultParams: { smartFillMode: 'enclose', gapClosingRadius: 4, expandRadius: 2, bucketReference: 'all', bucketRefLayerId: null, bucketTolerance: 32, brushSize: 24 },
    },
    { id: 'fill_lasso', tool: 'bucket', defaultParams: { bucketMode: 'lasso', antialias: 'medium', outlineEnabled: false, lassoErase: false } },
  ]);
}

// Phase 2: independently saved parameters, last sub-tools and rail mode
{
  const saved = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { saved.set(key, value); },
  };
  const store = createSubToolStore(storage);
  assert.equal(store.getState().railMode, 'compact');
  const remembered = TOOL_CATEGORIES.map((category) => ({
    categoryId: category.id,
    subToolId: category.subTools[category.subTools.length - 1].id,
  }));
  for (const { subToolId } of remembered) store.selectSubTool(subToolId);
  for (const { categoryId, subToolId } of remembered) assert.equal(store.selectCategory(categoryId).id, subToolId);

  store.updateSubToolParams('fill_bucket', { bucketTolerance: 44, bucketExpand: 4 });
  store.updateSubToolParams('fill_enclose', { smartFillMode: 'paint', gapClosingRadius: 6, expandRadius: -2 });
  store.selectCategory('fill');
  store.setRailMode('classic');

  const restored = createSubToolStore(storage);
  assert.equal(restored.getState().activeCategoryId, 'fill');
  assert.equal(restored.getState().activeSubToolId, 'fill_lasso');
  assert.equal(restored.getState().railMode, 'classic');
  for (const { categoryId, subToolId } of remembered) assert.equal(restored.selectCategory(categoryId).id, subToolId);
  assert.deepEqual(restored.getSubToolParams('fill_bucket'), {
    bucketMode: 'click', bucketReference: 'all', bucketTolerance: 44, bucketExpand: 4,
  });
  assert.deepEqual(restored.getSubToolParams('fill_enclose'), {
    smartFillMode: 'paint', gapClosingRadius: 6, expandRadius: -2, bucketReference: 'all', bucketRefLayerId: null, bucketTolerance: 32, brushSize: 24,
  });

  const defaultBucket = { bucketMode: 'click', bucketReference: 'all', bucketTolerance: 32, bucketExpand: 1 };
  assert.deepEqual(restored.resetSubToolParams('fill_bucket'), defaultBucket);
  assert.deepEqual(restored.getSubToolParams('fill_bucket'), defaultBucket);
  restored.setRailMode('compact');
  const afterReset = createSubToolStore(storage);
  assert.deepEqual(afterReset.getSubToolParams('fill_bucket'), defaultBucket);
  assert.equal(afterReset.getSubToolParams('fill_enclose').smartFillMode, 'paint');
  assert.equal(afterReset.getState().railMode, 'compact');
}

// Phase 3.3: legacy shape/fill state migration and independently remembered blend parameters.
{
  const saved = new Map<string, string>([[SUB_TOOL_STORAGE_KEY, JSON.stringify({
    activeCategoryId: 'shape',
    lastSubToolByCategory: { shape: 'text', comic: 'comic_balloon', fill: 'fill_refer_edit' },
    paramsBySubTool: { fill_paint_unfilled: { gapClosingRadius: 5 } },
  })]]);
  const storage: StorageLike = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { saved.set(key, value); },
  };
  const migrated = createSubToolStore(storage);
  assert.equal(migrated.getState().activeCategoryId, 'text');
  assert.equal(migrated.getState().activeSubToolId, 'text');
  assert.equal(migrated.getState().lastSubToolByCategory.fill, 'fill_bucket');
  assert.equal(migrated.getSubToolParams('fill_enclose').smartFillMode, 'paint');
  assert.equal(migrated.getSubToolParams('fill_enclose').gapClosingRadius, 5);
  migrated.selectSubTool('blur');
  migrated.updateSubToolParams('blur', { brushSize: 48, brushStrength: 0.3 });
  migrated.updateSubToolParams('smudge', { smudgeMode: 'blend' });
  const restored = createSubToolStore(storage);
  assert.equal(restored.getState().activeCategoryId, 'blend');
  assert.deepEqual(restored.getSubToolParams('blur'), { brushSize: 48, brushStrength: 0.3 });
  assert.deepEqual(restored.getSubToolParams('smudge'), { brushSize: 32, brushStrength: 0.6, smudgeMode: 'blend' });
  assert.deepEqual(restored.resetSubToolParams('blur'), { brushSize: 32, brushStrength: 0.6 });
  assert.equal(restored.selectCategory('comic').id, 'comic_balloon');
}

// Phase 2: CSP shortcuts recall the last tool on entry and cycle on repeated presses.
{
  const store = createSubToolStore({ getItem: () => null, setItem: () => {} });
  store.selectSubTool('pencil');
  store.selectSubTool('fill_lasso');
  assert.equal(store.activateCategoryShortcut('paint').id, 'pencil');
  assert.equal(store.activateCategoryShortcut('fill').id, 'fill_lasso');
  for (const id of ['fill_bucket', 'fill_enclose', 'fill_lasso']) {
    assert.equal(store.activateCategoryShortcut('fill').id, id);
  }
  assert.equal(store.getState().lastSubToolByCategory.fill, 'fill_lasso');
}

// Phase 2: exact gap-fill masks for thin line art, broken outlines and painted pixels
{
  const width = 42, height = 26;
  const rgba = (x: number, y: number) => (y * width + x) * 4;
  const lineart = new Uint8Array(width * height * 4);
  for (const [left, right] of [[8, 20], [29, 35]]) {
    for (let y = 8; y <= 18; y++) {
      for (let x = left; x <= right; x++) {
        if (x === left || x === right || y === 8 || y === 18) lineart[rgba(x, y) + 3] = 255;
      }
    }
  }
  const stroke = [{ x: 19, y: 13 }, { x: 2, y: 13 }];
  const options = { brushRadius: 1 };
  const inside = (x: number, y: number) => x > 8 && x < 20 && y > 8 && y < 18;
  const assertMask = (
    mask: ReturnType<typeof computePaintUnfilledAreaMask>,
    expected: (x: number, y: number) => boolean,
    message: string,
  ) => {
    let count = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const fill = expected(x, y);
        assert.equal(mask.data[y * width + x], fill ? 255 : 0, `${message} at (${x}, ${y})`);
        if (fill) count++;
      }
    }
    assert.equal(mask.activePixelCount, count, message);
  };

  const closed = computePaintUnfilledAreaMask(stroke, lineart, width, height, options);
  assertMask(closed, inside, 'Brush fills the touched pocket, leaving exterior and the untouched pocket empty');

  const brokenLineart = lineart.slice();
  brokenLineart[rgba(13, 8) + 3] = 0;
  brokenLineart[rgba(14, 8) + 3] = 0;
  assertMask(computePaintUnfilledAreaMask(stroke, brokenLineart, width, height, options), () => false, 'An open pocket is skipped');
  assertMask(computePaintUnfilledAreaMask(stroke, brokenLineart, width, height, { ...options, gapClosingRadius: 3 }),
    inside, 'Closing a 2px gap seals the same pocket without spilling');

  const expanded = computePaintUnfilledAreaMask(stroke, lineart, width, height, { ...options, expandRadius: 1 });
  assertMask(expanded, (x, y) => inside(x, y) || inside(x - 1, y) || inside(x + 1, y) || inside(x, y - 1) || inside(x, y + 1),
    'One-pixel expansion covers adjacent line art and never reaches the exterior');
  const contracted = computePaintUnfilledAreaMask(stroke, lineart, width, height, { ...options, expandRadius: -1 });
  assertMask(contracted, (x, y) => x > 9 && x < 19 && y > 9 && y < 17, 'One-pixel contraction removes the inner rim');
  assert.ok(contracted.activePixelCount < closed.activePixelCount);

  const editPixels = new Uint8Array(lineart.length);
  for (let y = 9; y < 18; y++) {
    for (let x = 16; x < 18; x++) editPixels.set([40, 100, 200, 255], rgba(x, y));
  }
  assertMask(computePaintUnfilledAreaMask([{ x: 2, y: 13 }, { x: 16, y: 13 }], lineart, width, height, { ...options, editPixels }),
    (x, y) => inside(x, y) && x < 16, 'Painted pixels block the fill, preserving their color and the separated pocket');
  const expandedWithEdit = computePaintUnfilledAreaMask([{ x: 2, y: 13 }, { x: 16, y: 13 }], lineart, width, height, { ...options, editPixels, expandRadius: 1 });
  assertMask(expandedWithEdit,
    (x, y) => (inside(x, y) && x < 16) || ((x === 8 && y >= 9 && y <= 17) || ((y === 8 || y === 18) && x >= 9 && x <= 15)),
    'Expansion tucks under line art without overwriting already-painted editPixels');
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
  assert.deepEqual(filterGroupsInUse(), ['color', 'library', 'lineart', 'render', 'effect', 'blur', 'distort', 'sharpen'], 'All 8 filter groups are active');
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

// Draft previews: the registry and the runners agree, big layers only, a draft keeps what it leaves alone
{
  for (const def of BUILTIN_FILTERS) {
    const draft = PIXEL_FILTER_RUNNERS[def.id]?.draft;
    assert.equal(Boolean(def.draft), Boolean(draft), `${def.id}: the registry and the runner agree on a draft`);
    for (const key of draft?.lengths ?? []) {
      assert.ok(def.params.some((param) => param.key === key && param.kind === 'range'), `${def.id}.${key} (scaled in a draft) is a range parameter`);
    }
    for (const key of draft?.points ?? []) {
      assert.ok(def.params.some((param) => param.key === key && param.kind === 'point'), `${def.id}.${key} (scaled in a draft) is a point`);
    }
  }
  const glowDef = getFilter('glow')!;
  assert.equal(filterDraftFactor(glowDef, 2000, 2000, false), 0, 'A layer up to the desktop limit previews in full');
  assert.equal(filterDraftFactor(glowDef, 4000, 3000, false), 3, '4000 × 3000 on a desktop: a draft a third the size');
  assert.equal(filterDraftFactor(glowDef, 2000, 1000, true), 2, 'Touch screens draft smaller layers');
  assert.equal(filterDraftFactor(getFilter('unsharp')!, 8000, 8000, false), 0, 'Sharpening never drafts (it is all fine detail)');
  assert.ok(FILTER_DRAFT.touch.above < FILTER_DRAFT.desktop.above);

  // Shrink and stretch: a flat colour comes back the same, sizes round up
  const flat = new Uint8Array(5 * 3 * 4).fill(200);
  const small = downscale(flat, 5, 3, 2);
  assert.deepEqual([small.width, small.height], [3, 2], 'Shrunk sizes round up');
  assert.ok(small.pixels.every((value) => value === 200), 'A flat colour shrinks to itself');
  assert.ok(upscale(small.pixels, 3, 2, 5, 3, 2).every((value) => value === 200), 'And stretches back to itself');

  // A blot in one corner of a 64 × 48 layer, a selection over its left half
  const width = 64, height = 48;
  const source = new Uint8Array(width * height * 4);
  for (let y = 4; y < 14; y++) for (let x = 4; x < 14; x++) source.set([240, 240, 240, 255], (y * width + x) * 4);
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) mask.fill(255, y * width, y * width + 32);
  const drafted = runDraftFilter(PIXEL_FILTER_RUNNERS.gaussian, source, width, height, { radius: 4 }, mask, 2);
  const full = runPixelFilter(PIXEL_FILTER_RUNNERS.gaussian, source, width, height, { radius: 4 }, mask);
  assert.equal(drafted.length, source.length, 'A draft has the layer\'s size');
  for (let p = 0; p < width * height; p++) {
    const x = p % width, y = Math.floor(p / width);
    if (x > 30 || y > 30) assert.deepEqual([...drafted.slice(p * 4, p * 4 + 4)], [...source.slice(p * 4, p * 4 + 4)], 'Outside the selection and far from the blot: untouched');
  }
  const at = (pixels: Uint8Array, x: number, y: number) => pixels[(y * width + x) * 4 + 3];
  assert.ok(at(drafted, 16, 9) > 0 && Math.abs(at(drafted, 16, 9) - at(full, 16, 9)) < 48, 'Next to the blot the draft blurs about as far as the full filter');
  assert.deepEqual(runDraftFilter(PIXEL_FILTER_RUNNERS.unsharp, source, width, height, { radius: 2 }, null, 3),
    runPixelFilter(PIXEL_FILTER_RUNNERS.unsharp, source, width, height, { radius: 2 }), 'A filter without a draft runs in full');
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
  assert.equal(alphaAt(grown, W, 5, 4), 255, 'One pixel out is inked');
  assert.equal(alphaAt(grown, W, 6, 4), 255, 'Two pixels out is inked: 2 px more on each side');
  assert.equal(alphaAt(grown, W, 7, 4), 0, 'Three pixels out stays clear');
  assert.deepEqual([...grown.slice((4 * W + 5) * 4, (4 * W + 5) * 4 + 3)], [0, 0, 0], 'Grown ink takes the line colour');
  const dot = picture(W, H, (x, y) => (x === 4 && y === 4 ? [0, 0, 0, 255] : null));
  const ring = alphaAt(run('lineWidth', { amount: 1 }, dot), W, 5, 5);
  assert.ok(ring > 0 && ring < 255, 'Diagonal edges come out soft');

  const thinned = run('lineWidth', { amount: -1, keepThin: false }, line(3, 5));
  assert.equal(alphaAt(thinned, W, 3, 4), 0, 'Thinning by 1 clears one pixel on each side');
  assert.equal(alphaAt(thinned, W, 4, 4), 255, 'And keeps the middle');
  assert.equal(alphaAt(run('lineWidth', { amount: -2, keepThin: false }, line(3, 5)), W, 4, 4), 0, 'Thinning a 3 px line by 2 clears it');
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

// 效果: radial colour split, mosaic, glow and outline
{
  const W = 9, H = 9;
  const run = (id: string, values: FilterValues, pixels: Uint8Array) => runPixelFilter(PIXEL_FILTER_RUNNERS[id], pixels, W, H, values);
  const pixelAt = (pixels: Uint8Array, x: number, y: number) => [...pixels.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];

  const ramp = picture(W, H, (x) => [x * 28, 0, 255 - x * 28, 255]);
  const split = run('chromatic', { mode: 'radial', spread: 6, center: { x: 0, y: 4 } }, ramp);
  assert.ok(pixelAt(split, 8, 4)[0] < pixelAt(ramp, 8, 4)[0], 'Far from the centre, red comes from nearer it');
  assert.deepEqual(pixelAt(split, 0, 4), pixelAt(ramp, 0, 4), 'The centre itself does not move');
  assert.deepEqual(run('chromatic', { offsetX: 2 }, ramp), run('chromatic', { mode: 'shift', offsetX: 2 }, ramp), 'Settings stored before the mode existed still shift');

  const checker = picture(4, 4, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  const tiles = runPixelFilter(PIXEL_FILTER_RUNNERS.mosaic, checker, 4, 4, { cell: 2 });
  for (let p = 0; p < 16; p++) assert.deepEqual([...tiles.slice(p * 4, p * 4 + 4)], [128, 128, 128, 255], 'Each cell is the average of what it covers');

  const spark = picture(W, H, (x, y) => (x === 4 && y === 4 ? [255, 255, 255, 255] : null));
  const glowed = run('glow', { radius: 4, strength: 100, threshold: 0 }, spark);
  assert.ok(alphaAt(glowed, W, 5, 4) > 0, 'The halo spills onto clear pixels');
  assert.deepEqual(pixelAt(glowed, 4, 4), [255, 255, 255, 255], 'The bright pixel stays');
  const ember = picture(W, H, (x, y) => (x === 4 && y === 4 ? [40, 40, 40, 255] : null));
  assert.deepEqual(run('glow', { radius: 4, strength: 100, threshold: 200 }, ember), ember, 'Nothing above the threshold: no glow');

  const block = picture(W, H, (x, y) => (x >= 3 && x <= 5 && y >= 3 && y <= 5 ? [0, 0, 0, 255] : null));
  const outside = run('outline', { size: 1, color: '#ff0000', position: 'outside' }, block);
  assert.deepEqual(pixelAt(outside, 6, 4), [255, 0, 0, 255], 'Outside: the pixel next to the shape is stroked');
  assert.equal(alphaAt(outside, W, 7, 4), 0, 'Two pixels out stays clear');
  assert.deepEqual(pixelAt(outside, 5, 4), [0, 0, 0, 255], 'The shape itself is untouched');
  const inside = run('outline', { size: 1, color: '#ff0000', position: 'inside' }, block);
  assert.deepEqual(pixelAt(inside, 5, 4), [255, 0, 0, 255], 'Inside: the shape edge is stroked');
  assert.deepEqual(pixelAt(inside, 4, 4), [0, 0, 0, 255], 'Its middle is not');
  assert.equal(alphaAt(inside, W, 6, 4), 0, 'Nothing outside');
  const straddle = run('outline', { size: 2, color: '#ff0000', position: 'center' }, block);
  assert.deepEqual(pixelAt(straddle, 6, 4), [255, 0, 0, 255], 'On the edge: half outside');
  assert.deepEqual(pixelAt(straddle, 5, 4), [255, 0, 0, 255], 'and half inside');
}

// 模糊、變形、銳化: streaks follow the angle and direction, the distortions move what they should
{
  const W = 15, H = 9;
  const run = (id: string, values: FilterValues, pixels: Uint8Array) => runPixelFilter(PIXEL_FILTER_RUNNERS[id], pixels, W, H, values);
  const dot = picture(W, H, (x, y) => (x === 7 && y === 4 ? [255, 255, 255, 255] : null));

  const both = run('motionBlur', { distance: 4, angle: 0, direction: 'both' }, dot);
  assert.ok(alphaAt(both, W, 5, 4) > 0 && alphaAt(both, W, 9, 4) > 0, 'Both ways: the streak runs left and right');
  assert.equal(alphaAt(both, W, 7, 6), 0, 'Not up or down');
  const forward = run('motionBlur', { distance: 4, angle: 0, direction: 'forward' }, dot);
  assert.ok(alphaAt(forward, W, 10, 4) > 0 && alphaAt(forward, W, 5, 4) === 0, 'Forward at 0°: the streak trails to the right');
  const backward = run('motionBlur', { distance: 4, angle: 0, direction: 'backward' }, dot);
  assert.ok(alphaAt(backward, W, 4, 4) > 0 && alphaAt(backward, W, 9, 4) === 0, 'Backward: to the left');
  const upward = run('motionBlur', { distance: 4, angle: 90, direction: 'forward' }, dot);
  assert.ok(alphaAt(upward, W, 7, 1) > 0 && alphaAt(upward, W, 7, 6) === 0, 'Forward at 90°: upwards');
  const slanted = run('motionBlur', { distance: 6, angle: 45, direction: 'both' }, dot);
  assert.ok(alphaAt(slanted, W, 9, 2) > 0 && alphaAt(slanted, W, 9, 6) === 0, '45°: up and to the right');

  const zoomed = run('radialBlur', { strength: 60, direction: 'out', center: { x: 7, y: 4 } }, dot);
  assert.ok(alphaAt(zoomed, W, 7, 4) > 0, 'Zoom blur keeps what sits on its centre');
  const ray = picture(W, H, (x, y) => (y === 4 && x >= 10 ? [255, 255, 255, 255] : null));
  assert.equal(alphaAt(run('radialBlur', { strength: 60, direction: 'out', center: { x: 0, y: 4 } }, ray), W, 10, 0), 0,
    'It smears along lines through the centre, not across them');

  const soft = run('soften', {}, dot);
  assert.deepEqual([alphaAt(soft, W, 7, 4), alphaAt(soft, W, 8, 4), alphaAt(soft, W, 8, 5)], [64, 32, 16], 'Soften spreads with 1-2-1 weights');

  const column = picture(W, H, (x) => (x === 7 ? [255, 255, 255, 255] : null));
  const swayed = run('wave', { direction: 'horizontal', amplitude: 2, wavelength: 8 }, column);
  assert.equal(alphaAt(swayed, W, 9, 2), 255, 'A quarter wave down, the row moves 2 px over');
  assert.equal(alphaAt(swayed, W, 7, 2), 0, 'and leaves its old place');
  assert.equal(alphaAt(swayed, W, 7, 0), 255, 'Rows on the axis stay');
  const bobbed = run('wave', { direction: 'vertical', amplitude: 2, wavelength: 8 }, column);
  assert.ok(alphaAt(bobbed, W, 7, 3) === 255 && alphaAt(bobbed, W, 8, 3) === 0, 'Swaying up and down keeps a vertical line in its column');

  const grid = picture(W, H, (x, y) => (x % 3 === 0 || y % 3 === 0 ? [0, 0, 0, 255] : null));
  const bulged = run('spherize', { strength: 80, radius: 4, squash: 0, center: { x: 7, y: 4 } }, grid);
  assert.notDeepEqual(bulged, grid, 'Spherize moves what is inside its circle');
  for (const [x, y] of [[0, 0], [14, 8], [1, 4], [13, 4]]) {
    assert.deepEqual([...bulged.slice((y * W + x) * 4, (y * W + x) * 4 + 4)], [...grid.slice((y * W + x) * 4, (y * W + x) * 4 + 4)], 'and nothing outside it');
  }
  assert.deepEqual(run('spherize', { strength: 0, radius: 4, center: { x: 7, y: 4 } }, grid), grid, 'No strength, no change');

  const step = picture(W, H, (x) => (x < 7 ? [100, 100, 100, 255] : [150, 150, 150, 255]));
  const crisp = run('unsharp', { radius: 1, amount: 100, threshold: 0 }, step);
  assert.ok(crisp[(4 * W + 6) * 4] < 100 && crisp[(4 * W + 7) * 4] > 150, 'Sharpening pushes the two sides of an edge apart');
  assert.equal(crisp[(4 * W + 0) * 4], 100, 'Flat areas stay');
  assert.deepEqual(run('unsharp', { radius: 1, amount: 100, threshold: 100 }, step), step, 'Differences under the threshold are left alone');
  assert.notDeepEqual(run('unsharp', { radius: 1, amount: 100 }, step), run('unsharp', { radius: 2, amount: 100 }, step), 'Each radius step sharpens differently');
  const fringe = run('sharpen', {}, picture(W, H, (x) => (x < 7 ? [200, 200, 200, 200] : null)));
  for (let i = 0; i < fringe.length; i += 4) {
    assert.ok(fringe[i] <= fringe[i + 3] && fringe[i + 1] <= fringe[i + 3] && fringe[i + 2] <= fringe[i + 3], 'Sharpened colour never exceeds alpha');
  }
}

// 濾鏡 F3 Batch 1: 單色著色、平滑鋸齒、柏林雜訊、格線、集中線
{
  // monoTint: colorOnly keeps alpha & clear pixels, shifts midtones to chosen tint
  assert.deepEqual(filterPixel('monoTint', { color: '#ff8040', strength: 100, preserveLuma: true }, [0, 0, 0, 0]), [0, 0, 0, 0], 'MonoTint leaves clear pixels clear');
  const tintedMid = filterPixel('monoTint', { color: '#ff8040', strength: 100, preserveLuma: true }, [128, 128, 128, 255]);
  assert.ok(tintedMid[0] > tintedMid[1] && tintedMid[1] > tintedMid[2] && tintedMid[3] === 255, 'MonoTint tints midtones toward chosen hue');
  const tintedSemi = filterPixel('monoTint', { color: '#0080ff', strength: 100, preserveLuma: false }, [64, 64, 64, 128]);
  assert.equal(tintedSemi[3], 128, 'MonoTint keeps semi-transparent alpha intact');
  assert.ok(tintedSemi[2] > tintedSemi[0], 'MonoTint shifts blue channel higher for blue tint');

  // smoothJaggies: softens diagonal staircase corners while keeping flat & vertical lines sharp
  const W = 12, H = 12;
  const diag = picture(W, H, (x, y) => (x === y ? [0, 0, 0, 255] : null));
  const smoothed = runPixelFilter(PIXEL_FILTER_RUNNERS.smoothJaggies, diag, W, H, { strength: 80 });
  assert.ok(alphaAt(smoothed, W, 5, 4) > 0 && alphaAt(smoothed, W, 4, 5) > 0, 'SmoothJaggies softens diagonal staircase corners');
  const vert = picture(W, H, (x) => (x === 6 ? [0, 0, 0, 255] : null));
  assert.deepEqual(runPixelFilter(PIXEL_FILTER_RUNNERS.smoothJaggies, vert, W, H, { strength: 80 }), vert, 'SmoothJaggies leaves straight vertical strokes sharp');

  // perlinNoise: deterministic non-flat opaque greyscale
  const blank = new Uint8Array(24 * 24 * 4);
  const p1 = runPixelFilter(PIXEL_FILTER_RUNNERS.perlinNoise, blank, 24, 24, { scale: 12, amplitude: 80, persistence: 0.5, octaves: 4, offsetX: 0, offsetY: 0 });
  const p2 = runPixelFilter(PIXEL_FILTER_RUNNERS.perlinNoise, blank, 24, 24, { scale: 12, amplitude: 80, persistence: 0.5, octaves: 4, offsetX: 0, offsetY: 0 });
  assert.deepEqual(p1, p2, 'PerlinNoise is deterministic between preview and apply');
  let pMin = 255, pMax = 0;
  for (let i = 0; i < p1.length; i += 4) {
    assert.equal(p1[i + 3], 255, 'PerlinNoise output is opaque');
    assert.ok(p1[i] === p1[i + 1] && p1[i + 1] === p1[i + 2], 'PerlinNoise is greyscale');
    if (p1[i] < pMin) pMin = p1[i];
    if (p1[i] > pMax) pMax = p1[i];
  }
  assert.ok(pMax - pMin > 40, 'PerlinNoise produces varied values');

  // gridPattern: draws grid lines on cell intervals and leaves interior clear on blank layer
  const gridded = runPixelFilter(PIXEL_FILTER_RUNNERS.gridPattern, blank, 24, 24, { cell: 8, lineWidth: 1, color: '#ff0000', opacity: 100, offsetX: 0, offsetY: 0 });
  assert.equal(alphaAt(gridded, 24, 0, 4), 255, 'Grid line at x=0 is drawn');
  assert.equal(alphaAt(gridded, 24, 8, 4), 255, 'Grid line at x=8 is drawn');
  assert.equal(alphaAt(gridded, 24, 4, 4), 0, 'Interior cell stays transparent');

  // focusLines: clear center stays transparent, outer ring receives rays
  const focused = runPixelFilter(PIXEL_FILTER_RUNNERS.focusLines, new Uint8Array(40 * 40 * 4), 40, 40,
    { density: 48, lineWidth: 3, innerRadius: 40, jitter: 20, color: '#000000', center: { x: 20, y: 20 } });
  assert.equal(alphaAt(focused, 40, 20, 20), 0, 'FocusLines keeps the inner center clear');
  let outerHits = 0;
  for (let x = 0; x < 40; x++) {
    if (alphaAt(focused, 40, x, 1) > 0) outerHits++;
  }
  assert.ok(outerHits > 0, 'FocusLines draws rays toward the outer edge');
}

// 濾鏡 F3 Batch 2: 浮雕、投影、邊緣轉線稿、極座標、鋸齒波紋、捏合、高反差保留
{
  const W = 16, H = 16;
  const run = (id: string, values: FilterValues, pixels: Uint8Array) => runPixelFilter(PIXEL_FILTER_RUNNERS[id], pixels, W, H, values);
  const split = picture(W, H, (x) => (x < 8 ? [40, 40, 40, 255] : [220, 220, 220, 255]));
  const box = picture(W, H, (x, y) => (x >= 5 && x <= 10 && y >= 5 && y <= 10 ? [200, 80, 60, 255] : null));

  // emboss: colorOnly preserves alpha & clear pixels, neutral 128 on flat regions, bevel at step
  const emb = run('emboss', { angle: 0, height: 1, amount: 150, keepColor: false }, split);
  assert.deepEqual([...emb.slice((8 * W + 2) * 4, (8 * W + 2) * 4 + 4)], [128, 128, 128, 255], 'Emboss turns flat area to neutral grey');
  assert.ok(emb[(8 * W + 8) * 4] > 128, 'Emboss highlights lit edge');
  const embClear = run('emboss', { angle: 135, height: 1, amount: 120, keepColor: false }, box);
  assert.equal(alphaAt(embClear, W, 0, 0), 0, 'Emboss leaves clear pixels clear');
  assert.equal(alphaAt(embClear, W, 7, 7), 255, 'Emboss keeps opaque alpha intact');

  // dropShadow: casts coloured shadow into shifted transparent area; shadowOnly hides original
  const sh = run('dropShadow', { offsetX: 3, offsetY: 3, radius: 2, opacity: 80, color: '#000000', shadowOnly: false }, box);
  assert.equal(alphaAt(sh, W, 7, 7), 255, 'DropShadow keeps original object opaque');
  assert.ok(alphaAt(sh, W, 12, 12) > 0, 'DropShadow casts shadow offset down-right');
  assert.equal(alphaAt(sh, W, 1, 1), 0, 'DropShadow leaves far opposite corner clear');
  const shOnly = run('dropShadow', { offsetX: 4, offsetY: 4, radius: 0, opacity: 100, color: '#000000', shadowOnly: true }, box);
  assert.equal(alphaAt(shOnly, W, 5, 5), 0, 'Shadow-only omits unshifted original corner');
  assert.equal(alphaAt(shOnly, W, 12, 12), 255, 'Shadow-only keeps shifted silhouette');

  // edgeToLineart: draws edge pixels at step, transparent elsewhere when whiteBg=false
  const edges = run('edgeToLineart', { sensitivity: 60, thickness: 1, keepColor: false, whiteBg: false }, split);
  assert.ok(alphaAt(edges, W, 7, 8) > 120 && alphaAt(edges, W, 8, 8) > 120, 'EdgeToLineart detects vertical contrast edge');
  assert.equal(alphaAt(edges, W, 1, 8), 0, 'EdgeToLineart keeps flat area transparent');
  const edgesWhite = run('edgeToLineart', { sensitivity: 60, thickness: 1, keepColor: false, whiteBg: true }, split);
  assert.deepEqual([...edgesWhite.slice((8 * W + 1) * 4, (8 * W + 1) * 4 + 4)], [255, 255, 255, 255], 'White background fills flat area with white');

  // polarCoords: both modes run cleanly and alter geometry
  const r2p = run('polarCoords', { mode: 'rectToPolar' }, split);
  assert.equal(alphaAt(r2p, W, 0, 0), 0, 'Rect-to-polar corners outside unit circle turn clear');
  assert.notDeepEqual(r2p, split, 'Rect-to-polar remaps pixels');
  const p2r = run('polarCoords', { mode: 'polarToRect' }, box);
  assert.notDeepEqual(p2r, box, 'Polar-to-rect remaps pixels');

  // zigzagRipple: alters interior, keeps outside circle untouched, amount=0 is identity
  const gridImg = picture(W, H, (x, y) => (x % 3 === 0 || y % 3 === 0 ? [30, 60, 90, 255] : null));
  assert.deepEqual(run('zigzagRipple', { style: 'pond', amount: 0, ridges: 4, center: { x: 8, y: 8 } }, gridImg), gridImg, 'Zero ripple is identity');
  const rip = run('zigzagRipple', { style: 'pond', amount: 60, ridges: 3, center: { x: 8, y: 8 } }, gridImg);
  assert.notDeepEqual(rip, gridImg, 'Pond ripple distorts interior');
  const ripRad = run('zigzagRipple', { style: 'radial', amount: 60, ridges: 3, center: { x: 8, y: 8 } }, gridImg);
  assert.notDeepEqual(ripRad, gridImg, 'Radial ripple distorts interior');

  // pinch: alters pixels within radius, leaves corners outside radius untouched
  const pinched = run('pinch', { strength: 70, radius: 5, center: { x: 8, y: 8 } }, gridImg);
  assert.notDeepEqual(pinched, gridImg, 'Pinch distorts inside radius');
  assert.deepEqual([...pinched.slice(0, 4)], [...gridImg.slice(0, 4)], 'Pinch leaves pixels outside radius intact');
  assert.deepEqual(run('pinch', { strength: 0, radius: 5, center: { x: 8, y: 8 } }, gridImg), gridImg, 'Zero pinch is identity');

  // highPass: colorOnly preserves alpha, turns flat region to neutral 128, highlights edges
  const hp = run('highPass', { radius: 2 }, split);
  assert.deepEqual([...hp.slice((8 * W + 1) * 4, (8 * W + 1) * 4 + 4)], [128, 128, 128, 255], 'HighPass turns flat area to neutral 128 grey');
  assert.ok(hp[(8 * W + 7) * 4] < 128 && hp[(8 * W + 8) * 4] > 128, 'HighPass preserves high-frequency edge contrast');
  const hpBox = run('highPass', { radius: 1 }, box);
  assert.equal(alphaAt(hpBox, W, 0, 0), 0, 'HighPass leaves transparent pixels transparent');

  // Color Adjust preset cards: all presets stay within parameter bounds and round-trip matchColorPreset
  const colorDef = getFilter('colorAdjust')!;
  assert.equal(matchColorPreset(defaultFilterValues(colorDef)), 'original', 'Default colorAdjust matches original preset');
  for (const preset of COLOR_ADJUST_PRESETS) {
    assert.deepEqual(normalizeFilterValues(colorDef, preset.values), preset.values, `Color preset ${preset.id} fits slider bounds`);
    assert.equal(matchColorPreset(preset.values), preset.id, `matchColorPreset identifies ${preset.id}`);
  }
  assert.equal(matchColorPreset({ ...COLOR_ADJUST_PRESETS[1].values, brightness: 99 }), null, 'Tweaked preset becomes custom (null)');

  // Apply-to-new-layer memory guard, sparse tile pruning, and above-active placement
  assert.equal(assessFilterCompositeMemory(2000, 2000, false).tier, 'ok', '2000×2000 desktop composite is ok');
  assert.equal(assessFilterCompositeMemory(5000, 4000, false).tier, 'warn', '20M px desktop composite warns & forces draft');
  assert.equal(assessFilterCompositeMemory(10000, 8000, false).tier, 'confirm', '80M px desktop composite asks confirmation');
  assert.equal(assessFilterCompositeMemory(2000, 2000, true).tier, 'ok', '4M px touch composite is ok');
  assert.equal(assessFilterCompositeMemory(3000, 2000, true).tier, 'warn', '6M px touch composite warns');
  assert.equal(assessFilterCompositeMemory(4000, 3500, true).tier, 'confirm', '14M px touch composite asks confirmation');
  assert.equal(assessFilterCompositeMemory(5000, 4000, true).tier, 'block', '20M px touch composite is blocked to prevent OOM');

  const sparse = new Uint8Array(512 * 256 * 4);
  sparse[(10 * 512 + 300) * 4 + 3] = 200; // only tile (col=1, row=0) has alpha > 0
  const pruned = filterNonEmptyTileCoords(sparse, 512, 256, 256, [{ col: 0, row: 0 }, { col: 1, row: 0 }]);
  assert.deepEqual(pruned, [{ col: 1, row: 0 }], 'Empty tiles are pruned when writing to a new filtered layer');

  const sampleLayers = [
    { id: 'bg', layerType: 'raster', parentId: null, sortOrder: 1 },
    { id: 'grp', layerType: 'group', parentId: null, sortOrder: 2 },
    { id: 'child', layerType: 'raster', parentId: 'grp', sortOrder: 3 },
    { id: 'msk', layerType: 'mask', parentId: 'child', sortOrder: 4 },
    { id: 'top', layerType: 'raster', parentId: null, sortOrder: 5 },
  ];
  const pRaster = filterNewLayerPlacement(sampleLayers[0], sampleLayers);
  assert.equal(pRaster.afterLayerId, 'bg', 'New layer inserts directly above active raster layer');
  assert.equal(pRaster.overlayZIndex, 1.5, 'Preview overlay sits directly above active layer');
  const pMask = filterNewLayerPlacement(sampleLayers[3], sampleLayers);
  assert.equal(pMask.afterLayerId, 'child', 'Active mask places new layer above its host layer');
  assert.equal(pMask.parentId, 'grp', 'and keeps host layer parent');
  const pGroup = filterNewLayerPlacement(sampleLayers[1], sampleLayers);
  assert.equal(pGroup.afterLayerId, 'grp', 'Active group places new layer above the group');
  assert.equal(pGroup.parentId, null, 'as a sibling of the group');
  assert.equal(pGroup.overlayZIndex, 4.5, 'and preview sits above all group descendants');

  // Filter Library cards, thumbnail scaling, and favorite card validation
  assert.equal(new Set(BUILTIN_LIBRARY_CARDS.map((c) => c.id)).size, BUILTIN_LIBRARY_CARDS.length, 'Library card ids are unique');
  for (const card of BUILTIN_LIBRARY_CARDS) {
    const def = getFilter(card.filterId);
    assert.ok(def && PIXEL_FILTER_RUNNERS[card.filterId], `Library card ${card.id} targets a runnable filter`);
    const scaled = scaleFilterValuesForThumbnail(def, card.values, 2000, 2000, 96, 96);
    const sampleThumb = runPixelFilter(PIXEL_FILTER_RUNNERS[card.filterId], box, W, H, scaled);
    assert.equal(sampleThumb.length, box.length, `Library card ${card.id} renders cleanly at thumbnail size`);
  }
  const scaledGlow = scaleFilterValuesForThumbnail(getFilter('glow')!, { radius: 40, strength: 100, threshold: 140 }, 1000, 1000, 100, 100);
  assert.equal(scaledGlow.radius, 4, 'Thumbnail scaling shrinks pixel radii proportionally');
  assert.equal(scaledGlow.strength, 100, 'Thumbnail scaling keeps percentage strength unchanged');
  const createdFav = createFavoriteCard('  我的柔和發光  ', 'glow', { radius: 24, strength: 999, threshold: 140 });
  assert.ok(createdFav && createdFav.name === '我的柔和發光', 'createFavoriteCard trims name');
  assert.equal(createdFav.values.strength, 200, 'createFavoriteCard clamps out-of-range values');
  const parsedFavs = parseFavoriteCards([createdFav, { id: 'bad', name: 'x', filterId: 'unknown', values: {} }, null]);
  assert.equal(parsedFavs.length, 1, 'parseFavoriteCards filters out invalid entries safely');
}

// 對齊 L1: basis, whole-pixel offsets, off-canvas parts, and a pixel-level run of the move
{
  assert.equal(resolveAlignBasis('auto', false), 'canvas', 'Auto without a selection and 1 target uses the canvas');
  assert.equal(resolveAlignBasis('auto', false, 2), 'objects', 'Auto without a selection and >=2 targets uses objects');
  assert.equal(resolveAlignBasis('auto', true, 2), 'selection', 'Auto with a selection prefers selection over objects');
  assert.equal(resolveAlignBasis('objects', false, 1), null, 'Objects basis requires at least 2 targets');
  assert.equal(resolveAlignBasis('objects', true, 2), 'objects');
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

  // resolveAlignTargets: multi-select, nested group dedup, masked layers, group masks, animation folders, cycle safety
  const mkLayer = (
    id: string,
    layerType: string,
    parentId: string | null = null,
    meta: { animation?: unknown } | null = null,
  ): AlignLayerLike => ({ id, layerType, parentId, meta });

  const tree: AlignLayerLike[] = [
    mkLayer('rSolo', 'raster'),
    mkLayer('mSolo', 'mask', 'rSolo'),
    mkLayer('grp', 'group'),
    mkLayer('gm', 'mask', 'grp'),
    mkLayer('rInGrp', 'raster', 'grp'),
    mkLayer('mInGrp', 'mask', 'rInGrp'),
    mkLayer('sub', 'folder', 'grp'),
    mkLayer('subMask', 'mask', 'sub'),
    mkLayer('vInSub', 'vector', 'sub'),
    mkLayer('mInSub', 'mask', 'vInSub'),
    mkLayer('animRoot', 'group', null, { animation: { fps: 12 } }),
    mkLayer('animCel', 'raster', 'animRoot'),
    mkLayer('wrapAnim', 'group'),
    mkLayer('nestedAnim', 'folder', 'wrapAnim', { animation: { fps: 24 } }),
    mkLayer('nestedCel', 'raster', 'nestedAnim'),
    mkLayer('standaloneMask', 'mask'),
  ];

  // Active fallback and missing selection fallback
  assert.deepEqual(resolveAlignTargets(tree, null), []);
  assert.deepEqual(resolveAlignTargets(tree, 'rSolo', new Set(['missing'])).map((t) => t.id), ['rSolo']);
  const soloTargets = resolveAlignTargets(tree, 'rSolo');
  assert.equal(soloTargets.length, 1);
  assert.equal(soloTargets[0].isGroup, false);
  assert.deepEqual(soloTargets[0].members.map((l) => l.id), ['rSolo']);
  assert.deepEqual(soloTargets[0].masks.map((l) => l.id), ['mSolo']);

  // Multi-select preserves layers order & deduplicates descendants / masks under selected ancestors
  const multiTargets = resolveAlignTargets(
    tree,
    'rSolo',
    new Set(['vInSub', 'grp', 'mInGrp', 'rSolo', 'mSolo']),
  );
  assert.deepEqual(multiTargets.map((t) => t.id), ['rSolo', 'grp']);
  const grpUnit = multiTargets[1];
  assert.equal(grpUnit.isGroup, true);
  assert.equal(grpUnit.hasAnimationFolder, false);
  assert.deepEqual(grpUnit.members.map((l) => l.id), ['rInGrp', 'vInSub']);
  assert.deepEqual(grpUnit.masks.map((l) => l.id), ['gm', 'mInGrp', 'subMask', 'mInSub']);

  // Standalone mask & animation folders
  const maskTarget = resolveAlignTargets(tree, 'standaloneMask');
  assert.equal(maskTarget[0].root.layerType, 'mask');
  assert.equal(maskTarget[0].isGroup, false);
  assert.equal(resolveAlignTargets(tree, 'animRoot')[0].hasAnimationFolder, true);
  assert.equal(resolveAlignTargets(tree, 'wrapAnim')[0].hasAnimationFolder, true);

  // Cycle guard on parentId
  const cyclic: AlignLayerLike[] = [
    mkLayer('cycA', 'raster', 'cycB'),
    mkLayer('cycB', 'group', 'cycC'),
    mkLayer('cycC', 'group', 'cycB'),
  ];
  assert.deepEqual(resolveAlignTargets(cyclic, 'cycA').map((t) => t.id), ['cycA']);
  assert.deepEqual(resolveAlignTargets(cyclic, 'cycB').map((t) => t.id), ['cycB']);

  // alignTargetsBlocker: batch validation, group roots exempt from canEdit, priority order
  const editableAll = () => true;
  const noKeys = () => false;
  assert.equal(alignTargetsBlocker([], { busy: false, canEdit: editableAll, movedByKeyframes: noKeys }), 'noLayer');
  assert.equal(alignTargetsBlocker(soloTargets, { busy: true, canEdit: editableAll, movedByKeyframes: noKeys }), 'busy');
  assert.equal(
    alignTargetsBlocker([...soloTargets, ...maskTarget], { busy: false, canEdit: editableAll, movedByKeyframes: noKeys }),
    'mask',
  );
  assert.equal(
    alignTargetsBlocker(
      [...soloTargets, ...resolveAlignTargets(tree, 'wrapAnim')],
      { busy: false, canEdit: () => false, movedByKeyframes: () => true },
    ),
    'animationFolder',
    'animationFolder beats notEditable and keyframes',
  );

  // Group root must NEVER be passed to canEdit (canEditOwnPixels returns false on groups)
  const seenCanEdit = new Set<string>();
  const batchOk = alignTargetsBlocker(multiTargets, {
    busy: false,
    canEdit: (l) => {
      seenCanEdit.add(l.id);
      return l.layerType !== 'group' && l.layerType !== 'folder';
    },
    movedByKeyframes: noKeys,
  });
  assert.equal(batchOk, null);
  assert.ok(!seenCanEdit.has('grp') && !seenCanEdit.has('sub'));
  assert.ok(seenCanEdit.has('rInGrp') && seenCanEdit.has('gm') && seenCanEdit.has('mInSub'));

  // Whole-batch rejection if 1 member or 1 mask in multi-target batch fails canEdit
  assert.equal(
    alignTargetsBlocker(multiTargets, {
      busy: false,
      canEdit: (l) => l.id !== 'mInSub',
      movedByKeyframes: (id) => id === 'rSolo',
    }),
    'notEditable',
    'Locked mask rejects whole batch before keyframes',
  );
  assert.equal(
    alignTargetsBlocker(multiTargets, { busy: false, canEdit: editableAll, movedByKeyframes: (id) => id === 'grp' }),
    'keyframes',
    'Keyframed group root blocks batch',
  );
  assert.equal(
    alignTargetsBlocker(multiTargets, { busy: false, canEdit: editableAll, movedByKeyframes: (id) => id === 'mSolo' }),
    'keyframes',
    'Keyframed mask blocks batch',
  );

  // unionRect & alignManyOffsets
  assert.equal(unionRect([]), null);
  const sampleRects: AlignRect[] = [
    { x: 50, y: 10, w: 12, h: 15 },
    { x: 10, y: 30, w: 20, h: 25 },
    { x: 25, y: 5, w: 15, h: 10 },
  ];
  const uRect = unionRect(sampleRects)!;
  assert.deepEqual(uRect, { x: 10, y: 5, w: 52, h: 50 });
  assert.deepEqual(
    alignManyOffsets(sampleRects, uRect, 'left', 'top'),
    [{ dx: -40, dy: -5 }, { dx: 0, dy: -25 }, { dx: -15, dy: 0 }],
  );

  // distributeOffsets: count guards
  assert.deepEqual(distributeOffsets([], 'hgap', 'objects', canvasFrame), []);
  assert.deepEqual(distributeOffsets([{ x: 10, y: 10, w: 10, h: 10 }, { x: 40, y: 10, w: 10, h: 10 }], 'hgap', 'objects', canvasFrame), [
    { dx: 0, dy: 0 }, { dx: 0, dy: 0 },
  ]);
  assert.deepEqual(distributeOffsets([{ x: 10, y: 10, w: 10, h: 10 }], 'hgap', 'canvas', canvasFrame), [{ dx: 0, dy: 0 }]);

  // 2 rects on canvas / selection snap to frame outer edges
  assert.deepEqual(
    distributeOffsets([{ x: 40, y: 10, w: 12, h: 8 }, { x: 15, y: 20, w: 10, h: 8 }], 'left', 'canvas', canvasFrame),
    [{ dx: 48, dy: 0 }, { dx: -15, dy: 0 }],
    '2 rects on canvas snap first (x=15) to 0 and last (x=40, w=12) to 100-12=88',
  );
  const selDistFrame: AlignRect = { x: 20, y: 10, w: 60, h: 40 };
  assert.deepEqual(
    distributeOffsets([{ x: 25, y: 30, w: 8, h: 10 }, { x: 25, y: 12, w: 8, h: 6 }], 'vgap', 'selection', selDistFrame),
    [{ dx: 0, dy: 10 }, { dx: 0, dy: -2 }],
    '2 rects vertically on selection snap top=10 and bottom=10+40-10=40',
  );

  // All 8 modes across objects, canvas, selection with 4 unsorted rects of varied sizes & fractional spacing
  const applyDist = (rects: AlignRect[], mode: DistributeMode, basis: 'objects' | 'canvas' | 'selection', frame: AlignRect) => {
    const offsets = distributeOffsets(rects, mode, basis, frame);
    return rects.map((r, i) => ({ x: r.x + offsets[i].dx, y: r.y + offsets[i].dy, w: r.w, h: r.h, dx: offsets[i].dx, dy: offsets[i].dy }));
  };
  const fourRects: AlignRect[] = [
    { x: 63, y: 55, w: 11, h: 9 },
    { x: 10, y: 5, w: 10, h: 10 },
    { x: 24, y: 22, w: 7, h: 13 },
    { x: 41, y: 38, w: 9, h: 8 },
  ];
  const allModes: DistributeMode[] = ['left', 'hcenter', 'right', 'hgap', 'top', 'vcenter', 'bottom', 'vgap'];
  for (const basis of ['objects', 'canvas', 'selection'] as const) {
    const frame = basis === 'selection' ? { x: 5, y: 4, w: 85, h: 71 } : canvasFrame;
    for (const mode of allModes) {
      const horiz = mode === 'left' || mode === 'hcenter' || mode === 'right' || mode === 'hgap';
      const moved = applyDist(fourRects, mode, basis, frame);
      for (const m of moved) {
        if (horiz) assert.equal(m.dy, 0, `${basis}/${mode} keeps dy=0`);
        else assert.equal(m.dx, 0, `${basis}/${mode} keeps dx=0`);
      }
      const key = (r: AlignRect) => {
        const p = horiz ? r.x : r.y;
        const s = horiz ? r.w : r.h;
        if (mode === 'hcenter' || mode === 'vcenter') return p + s / 2;
        if (mode === 'right' || mode === 'bottom') return p + s;
        return p;
      };
      const byOriginalOrder = fourRects
        .map((r, idx) => ({ idx, k: key(r), p: horiz ? r.x : r.y }))
        .sort((a, b) => (a.k - b.k) || (a.p - b.p) || (a.idx - b.idx));
      const firstMoved = moved[byOriginalOrder[0].idx];
      const lastMoved = moved[byOriginalOrder[byOriginalOrder.length - 1].idx];
      if (basis === 'objects') {
        assert.equal(firstMoved.dx, 0);
        assert.equal(firstMoved.dy, 0);
        assert.equal(lastMoved.dx, 0);
        assert.equal(lastMoved.dy, 0);
      } else {
        const fPos = horiz ? frame.x : frame.y;
        const fSize = horiz ? frame.w : frame.h;
        assert.equal(horiz ? firstMoved.x : firstMoved.y, fPos, `${basis}/${mode} snaps first to frame start`);
        assert.equal(
          (horiz ? lastMoved.x + lastMoved.w : lastMoved.y + lastMoved.h),
          fPos + fSize,
          `${basis}/${mode} snaps last to frame end`,
        );
      }
      const orderedMoved = byOriginalOrder.map((e) => moved[e.idx]);
      if (mode === 'hgap' || mode === 'vgap') {
        const gaps = orderedMoved.slice(0, -1).map((r, idx) => {
          const next = orderedMoved[idx + 1];
          return (horiz ? next.x - (r.x + r.w) : next.y - (r.y + r.h));
        });
        assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `${basis}/${mode} gaps differ by <= 1 px (got ${gaps.join(',')})`);
      } else {
        const anchors = orderedMoved.map(key);
        const steps = anchors.slice(0, -1).map((v, idx) => anchors[idx + 1] - v);
        assert.ok(Math.max(...steps) - Math.min(...steps) <= 1, `${basis}/${mode} anchors evenly spaced within <= 1 px (got ${steps.join(',')})`);
      }
    }
  }

  // Overlapping rects with hgap on objects produce uniform negative gap
  const overlapping: AlignRect[] = [
    { x: 0, y: 0, w: 20, h: 10 },
    { x: 5, y: 0, w: 20, h: 10 },
    { x: 20, y: 0, w: 20, h: 10 },
  ];
  assert.deepEqual(
    distributeOffsets(overlapping, 'hgap', 'objects', canvasFrame),
    [{ dx: 0, dy: 0 }, { dx: 5, dy: 0 }, { dx: 0, dy: 0 }],
    'Overlapping rects equalize to -10px gap',
  );

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
// Animation Phase B1 & B2: cel marks (○/●), notes, and timeline labels
{
  const entries = celEntriesOf([
    { id: 'f', parentId: null, layerType: 'group', sortOrder: 10, isVisible: true, opacity: 1, meta: { animation: { fps: 24 } } },
    { id: 'c1', parentId: 'f', layerType: 'raster', sortOrder: 1, isVisible: true, opacity: 1, name: '1', meta: { cel: { hold: 2, mark: 'key', note: '  眨眼起點  ' } } },
    { id: 'c2', parentId: 'f', layerType: 'raster', sortOrder: 2, isVisible: true, opacity: 1, name: '2', meta: { cel: { mark: 'inbetween', note: '   ' } } },
    { id: 'c3', parentId: 'f', layerType: 'raster', sortOrder: 3, isVisible: true, opacity: 1, name: '3', meta: { cel: { mark: 'bogus' as unknown as 'key' } } },
  ], 'f');
  assert.equal(entries[0].mark, 'key');
  assert.equal(entries[0].note, '眨眼起點', 'Note is trimmed');
  assert.equal(entries[1].mark, 'inbetween');
  assert.equal(entries[1].note, undefined, 'Whitespace-only note is omitted');
  assert.equal(entries[2].mark, undefined, 'Unknown mark values are ignored');

  let labels = normalizeTimelineLabels([
    { frame: 10, text: '台詞' },
    { frame: 2, text: '  眨眼  ' },
    { frame: 10, text: '改名' },
    { frame: -1, text: '無效' },
    { frame: 5, text: '   ' },
  ]);
  assert.deepEqual(labels, [{ frame: 2, text: '眨眼' }, { frame: 10, text: '改名' }], 'Labels sorted, trimmed, deduplicated');
  labels = upsertTimelineLabel(labels, 6, '轉頭');
  assert.deepEqual(labels.map((l) => l.frame), [2, 6, 10]);
  labels = upsertTimelineLabel(labels, 6, '  ');
  assert.deepEqual(labels.map((l) => l.frame), [2, 10], 'Empty upsert removes label');
  labels = removeTimelineLabel(labels, 2);
  assert.deepEqual(labels, [{ frame: 10, text: '改名' }]);
}

// Animation Phase B3 & B4: repeat cels & sequential cel renaming
{
  const cels = celEntriesOf([
    { id: 'f', parentId: null, layerType: 'group', sortOrder: 10, isVisible: true, opacity: 1, meta: { animation: { fps: 12 } } },
    { id: 'c1', parentId: 'f', layerType: 'raster', sortOrder: 1, isVisible: true, opacity: 1, name: 'A', ownerId: 'u1', meta: { cel: { hold: 1 } } },
    { id: 'c2', parentId: 'f', layerType: 'group', sortOrder: 2, isVisible: true, opacity: 1, name: 'B', ownerId: 'u2', meta: { cel: { hold: 1 } } },
    { id: 'c3', parentId: 'f', layerType: 'raster', sortOrder: 3, isVisible: true, opacity: 1, name: 'C', ownerId: 'u1', meta: { cel: { hold: 1 } } },
    { id: 'c4', parentId: 'f', layerType: 'group', sortOrder: 4, isVisible: true, opacity: 1, name: '×', ownerId: 'u1', meta: { cel: { hold: 1, ref: '' } } },
  ], 'f');
  // 1-4 cels repeated 3 times -> 12 total frames (8 extra ref/blank items)
  const rep3 = planRepeatCels(cels, ['c1', 'c2', 'c3', 'c4'], { mode: 'count', count: 3 });
  assert.equal(rep3.totalFrames, 12);
  assert.equal(rep3.addedFrames, 8);
  assert.equal(rep3.items.length, 8);
  assert.equal(rep3.items[0].ref, 'c1');
  assert.equal(rep3.items[3].ref, '', 'Blank frames repeat as blank frames');
  assert.equal(rep3.items[3].blank, true);

  // Fill to end trims last hold cleanly
  const held = [
    { id: 'h1', label: '1', hold: 3, ownerId: 'u1', isGroup: false },
    { id: 'h2', label: '2', hold: 2, ownerId: 'u1', isGroup: false },
  ];
  const toEnd = planRepeatCels(held, ['h1', 'h2'], { mode: 'toEnd', targetEndFrame: 12 });
  assert.equal(toEnd.totalFrames, 12);
  assert.deepEqual(toEnd.items.map((x) => [x.ref, x.hold]), [['h1', 3], ['h2', 2], ['h1', 2]]);

  // Sequential rename skips other painters' cels and includes folder cels
  const shuffled = celEntriesOf([
    { id: 'f', parentId: null, layerType: 'group', sortOrder: 10, isVisible: true, opacity: 1, meta: { animation: { fps: 12 } } },
    { id: 'c3', parentId: 'f', layerType: 'raster', sortOrder: 1, isVisible: true, opacity: 1, name: '3', ownerId: 'u1' },
    { id: 'c2', parentId: 'f', layerType: 'group', sortOrder: 2, isVisible: true, opacity: 1, name: 'Other', ownerId: 'u2' },
    { id: 'c1', parentId: 'f', layerType: 'group', sortOrder: 3, isVisible: true, opacity: 1, name: 'FolderCel', ownerId: 'u1' },
    { id: 'r1', parentId: 'f', layerType: 'group', sortOrder: 4, isVisible: true, opacity: 1, name: '↻ 3', ownerId: 'u1', meta: { cel: { ref: 'c3' } } },
  ], 'f');
  const ren = planSequentialCelRenames(shuffled, (id) => shuffled.find((x) => x.id === id)?.ownerId === 'u1');
  assert.equal(ren.skippedOthers, 1);
  assert.deepEqual(ren.renames, [
    { id: 'c3', name: '1' },
    { id: 'c1', name: '3' },
    { id: 'r1', name: '↻ 1' },
  ]);
}

// Animation Phase B5, B6 & B7: jump frame/keyframe, flipbook, and shortcut conflict check
{
  const kfs = [
    { frame: 2, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 0, pivotY: 0, easing: 'linear' as const },
    { frame: 10, x: 10, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 0, pivotY: 0, easing: 'linear' as const },
    { frame: 18, x: 20, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 0, pivotY: 0, easing: 'linear' as const },
  ];
  assert.equal(adjacentKeyframeFrame(kfs, 10, -1), 2);
  assert.equal(adjacentKeyframeFrame(kfs, 10, 1), 18);
  assert.equal(adjacentKeyframeFrame(kfs, 2, -1), null);
  assert.equal(adjacentKeyframeFrame(kfs, 18, 1), null);
  assert.equal(adjacentKeyframeFrame(kfs, 7, 1), 10);
  assert.equal(adjacentKeyframeFrame(kfs, 7, -1), 2);
  assert.equal(
    findAdjacentKeyframe([
      { id: 'a', parentId: null, layerType: 'raster', sortOrder: 1, isVisible: true, opacity: 1, meta: {} },
      { id: 'b', parentId: null, layerType: 'raster', sortOrder: 2, isVisible: true, opacity: 1, meta: { keyframes: kfs } },
    ], 'a', 5, 1),
    10,
    'Falls back to other keyed layers when active layer has no keyframes',
  );
  // parseTimecode for B5 ("1+5" at 24fps = frame 28, "29" = frame 28, invalid = null)
  assert.equal(parseTimecode('1+5', 24), 28);
  assert.equal(parseTimecode('29', 24), 28);
  assert.equal(parseTimecode('bad', 24), null);

  // Flipbook: flip peeks nearby frames and endFlip returns to origin
  const eng = new AnimationEngine();
  eng.setLength(20);
  eng.goTo(8);
  eng.flip(-2);
  assert.equal(eng.getTime(), 6);
  assert.equal(eng.isFlipping(), true);
  eng.flip(3);
  assert.equal(eng.getTime(), 11);
  eng.endFlip();
  assert.equal(eng.getTime(), 8, 'endFlip returns playhead to origin');
  assert.equal(eng.isFlipping(), false);
  eng.destroy();

  // B7: every new animation shortcut exists and no defaultCombo collides across all shortcuts
  const mgr = ShortcutManager.getInstance();
  const all = mgr.getShortcuts();
  const required = [
    'action_anim_add_cel',
    'action_anim_add_blank',
    'action_anim_first_frame',
    'action_anim_last_frame',
    'action_anim_prev_keyframe',
    'action_anim_next_keyframe',
    'action_anim_flip',
  ];
  for (const id of required) {
    const item = all.find((s) => s.id === id);
    assert.ok(item && item.defaultCombo.length > 0, `Shortcut ${id} must have a default combo`);
  }
  const seen = new Map<string, string>();
  for (const s of all) {
    if (!s.defaultCombo) continue;
    assert.equal(seen.has(s.defaultCombo), false, `Duplicate defaultCombo ${s.defaultCombo} (${seen.get(s.defaultCombo)} vs ${s.id})`);
    seen.set(s.defaultCombo, s.id);
  }
}

// Plugin API v2.0 Batch 1: Manifest v1/v2 parsing, permissions, limits, and store migration
{
  assert.equal(PLUGIN_PERMISSIONS_V2_CORE.length, 12);
  assert.equal(PLUGIN_LIMITS.maxPackageBytesV1, 128 * 1024);
  assert.equal(PLUGIN_LIMITS.maxPackageBytesV2, 256 * 1024);
  assert.equal(PLUGIN_LIMITS.maxInstalledPlugins, 24);

  // v1 backward compatibility
  const v1Raw = {
    apiVersion: 1,
    id: 'studio.v1-sample',
    name: 'Studio V1',
    version: '1.0.0',
    author: 'Tester',
    description: 'Legacy plugin',
    permissions: ['brush', 'layers', 'artwork'],
    commands: [{ id: 'hello', label: 'Hello' }],
    script: 'function run() { return { kind: "message", text: "hi" }; }',
  };
  const v1 = parsePlugin(v1Raw);
  assert.equal(v1.apiVersion, 1);
  assert.equal(v1.commands.length, 1);
  assert.equal(parsePluginAction({ kind: 'brush', color: '#112233', size: 12 }, v1).kind, 'brush');

  // v1 must reject v2 permissions & oversized >128 KiB scripts
  assert.throws(() => parsePlugin({ ...v1Raw, permissions: ['layers:read'] }));
  assert.throws(() => parsePlugin({ ...v1Raw, script: 'x'.repeat(PLUGIN_LIMITS.maxPackageBytesV1 + 1) }));

  // v2 full manifest parsing
  const v2Raw = {
    apiVersion: 2,
    id: 'lumina.edge-glow-kit',
    name: 'Edge Glow Kit',
    version: '2.0.0',
    author: 'Lumina Drift',
    description: 'Custom filter, command, and panel.',
    i18n: {
      'zh-TW': { name: '邊緣流光套件', description: '自訂濾鏡與面板。' },
    },
    permissions: [
      'layers:read', 'layers:write', 'pixels:read', 'pixels:write',
      'selection', 'filters', 'commands', 'ui:panel', 'brush',
    ],
    commands: [
      {
        id: 'outline-selection',
        label: 'Outline Selection',
        i18nLabel: { 'zh-TW': '選區描邊' },
        group: 'Generate',
        suggestedShortcut: 'Alt+Shift+KeyG',
      },
    ],
    filters: [
      {
        id: 'duotone-glow',
        label: 'Duotone Glow',
        i18nLabel: { 'zh-TW': '雙色流光' },
        group: 'plugin',
        tilePadding: 4,
        draft: true,
        params: [
          { kind: 'color', key: 'shadow', label: 'Shadow', initial: '#1a2240' },
          { kind: 'range', key: 'mix', label: 'Intensity', initial: 80, min: 0, max: 100, step: 1, unit: '%' },
          { kind: 'toggle', key: 'invert', label: 'Invert', initial: false },
          {
            kind: 'select', key: 'mode', label: 'Mode', initial: 'soft',
            when: { key: 'invert', is: [false] },
            options: [{ value: 'soft', label: 'Soft' }, { value: 'hard', label: 'Hard' }],
          },
        ],
      },
    ],
    panels: [
      {
        id: 'glow-panel',
        title: 'Edge Glow',
        i18nTitle: { 'zh-TW': '邊緣流光' },
        icon: 'sparkles',
        defaultWidth: 280,
        fields: [
          { kind: 'section', key: 'sec1', label: 'Options' },
          { kind: 'text', key: 'info', text: 'Ready' },
          { kind: 'layer', key: 'targetLayer', label: 'Target Layer' },
          { kind: 'range', key: 'thickness', label: 'Thickness', initial: 4, min: 1, max: 32, step: 1, unit: 'px', live: true },
          { kind: 'number', key: 'seed', label: 'Seed', initial: 7, min: 0, max: 999 },
          { kind: 'color', key: 'color', label: 'Color', initial: '#62C5DF' },
          { kind: 'toggle', key: 'newLayer', label: 'New Layer', initial: true },
          { kind: 'select', key: 'style', label: 'Style', initial: 'outer', options: [{ value: 'outer', label: 'Outer' }, { value: 'inner', label: 'Inner' }] },
          { kind: 'input', key: 'tag', label: 'Tag', initial: 'glow', maxLength: 40, when: { key: 'newLayer', is: [true] } },
        ],
        actions: [
          { id: 'apply', label: 'Apply', i18nLabel: { 'zh-TW': '套用' }, variant: 'primary' },
          { id: 'reset', label: 'Reset', variant: 'secondary' },
        ],
      },
    ],
    script: 'async function onCommand() { return { notice: "ok" }; }',
  };

  const v2 = parsePlugin(v2Raw) as PluginManifestV2;
  assert.equal(v2.apiVersion, 2);
  assert.equal(v2.commands.length, 1);
  assert.equal(v2.filters.length, 1);
  assert.equal(v2.filters[0].group, 'plugin');
  assert.equal(v2.filters[0].tilePadding, 4);
  assert.equal(v2.panels.length, 1);
  assert.equal(v2.panels[0].fields.length, 9);
  assert.equal(resolvePluginName(v2, 'zh-TW'), '邊緣流光套件');
  assert.equal(resolvePluginName(v2, 'ja-JP'), 'Edge Glow Kit');
  assert.equal(resolvePluginDescription(v2, 'zh-TW'), '自訂濾鏡與面板。');
  assert.equal(resolvePluginText(v2.commands[0].label, v2.commands[0].i18nLabel, 'zh-TW'), '選區描邊');
  assert.equal(resolvePluginText(v2.commands[0].label, v2.commands[0].i18nLabel, 'en-US'), 'Outline Selection');

  // v2 accepts scripts up to 256 KiB and rejects > 256 KiB
  const v2LargeScript = ' '.repeat(PLUGIN_LIMITS.maxPackageBytesV1 + 1024) + 'function onCommand(){}';
  assert.equal(parsePlugin({ ...v2Raw, script: v2LargeScript }).apiVersion, 2);
  assert.throws(() => parsePlugin({ ...v2Raw, script: 'x'.repeat(PLUGIN_LIMITS.maxPackageBytesV2 + 1) }));

  // v2/v3 strict validation edge cases
  assert.equal(parsePlugin({ ...v2Raw, apiVersion: 3 }).apiVersion, 3);
  assert.throws(() => parsePlugin({ ...v2Raw, apiVersion: 4 }));
  assert.throws(() => parsePlugin({ ...v2Raw, permissions: ['layers'] }), 'v2 must reject legacy layers permission');
  assert.throws(() => parsePlugin({ ...v2Raw, permissions: ['artwork'] }), 'v2 must reject legacy artwork permission');
  assert.throws(() => parsePlugin({ ...v2Raw, commands: [], filters: [], panels: [] }), 'v2 requires at least one contribution');
  assert.throws(
    () => parsePlugin({ ...v2Raw, permissions: v2Raw.permissions.filter((p) => p !== 'commands') }),
    'declaring commands without commands permission must fail',
  );
  assert.throws(
    () => parsePlugin({ ...v2Raw, permissions: v2Raw.permissions.filter((p) => p !== 'filters') }),
    'declaring filters without filters permission must fail',
  );
  assert.throws(
    () => parsePlugin({ ...v2Raw, permissions: v2Raw.permissions.filter((p) => p !== 'ui:panel') }),
    'declaring panels without ui:panel permission must fail',
  );
  assert.throws(
    () => parsePlugin({ ...v2Raw, permissions: v2Raw.permissions.filter((p) => p !== 'layers:read') }),
    'panel layer field without layers:read permission must fail',
  );
  assert.throws(
    () => parsePlugin({ ...v2Raw, filters: [{ ...v2Raw.filters[0], tilePadding: 33 }] }),
    'tilePadding > 32 must fail',
  );
  assert.throws(
    () => parsePlugin({ ...v2Raw, commands: [{ ...v2Raw.commands[0], suggestedShortcut: 'BadMod+KeyA' }] }),
    'invalid shortcut modifier must fail',
  );
  assert.throws(
    () => parsePlugin({ ...v2Raw, filters: [{ ...v2Raw.filters[0], params: [{ kind: 'range', key: 'r', label: 'R', initial: 5, min: 10, max: 20 }] }] }),
    'range initial outside min..max must fail',
  );
  assert.throws(
    () => parsePlugin({ ...v2Raw, filters: [{ ...v2Raw.filters[0], params: [{ kind: 'select', key: 's', label: 'S', initial: 'missing', options: [{ value: 'a', label: 'A' }] }] }] }),
    'select initial not in options must fail',
  );
  assert.throws(
    () => parsePlugin({ ...v2Raw, filters: [{ ...v2Raw.filters[0], params: [{ kind: 'toggle', key: 't', label: 'T', initial: true, when: { key: 'ghost', is: [true] } }] }] }),
    'condition referencing unknown key must fail',
  );

  // pluginStore v1 -> v2 migration, damaged record tolerance, replacement disables, and 24-plugin cap
  const mem = new Map<string, string>();
  mem.set(PLUGIN_STORAGE_KEY_V1, JSON.stringify([
    { manifest: v1, enabled: true },
    { manifest: { apiVersion: 99, broken: true }, enabled: true },
  ]));
  const backend: PluginStorageBackend = {
    storageKey: PLUGIN_STORAGE_KEY_V2,
    legacyKeys: [PLUGIN_STORAGE_KEY_V1],
    readRaw: () => mem.get(PLUGIN_STORAGE_KEY_V2) ?? null,
    readLegacyRaw: (k) => mem.get(k) ?? null,
    writeRaw: (s) => { mem.set(PLUGIN_STORAGE_KEY_V2, s); },
  };
  const store = createPluginStore(backend);
  assert.equal(store.getPlugins().length, 1, 'Migrates valid v1 record and skips damaged one');
  assert.equal(store.getPlugins()[0].manifest.id, v1.id);
  assert.equal(store.getPlugins()[0].enabled, true);
  assert.ok(mem.has(PLUGIN_STORAGE_KEY_V2), 'Migration persists to v2 storage key');

  // Install v2, enable, then replace same id -> must reset enabled to false
  store.installPlugin(v2);
  assert.equal(store.getPlugins().find((p) => p.manifest.id === v2.id)?.enabled, false);
  store.setPluginEnabled(v2.id, true);
  assert.equal(store.getPlugins().find((p) => p.manifest.id === v2.id)?.enabled, true);
  store.installPlugin({ ...v2, version: '2.0.1' });
  assert.equal(store.getPlugins().find((p) => p.manifest.id === v2.id)?.enabled, false, 'Replacing plugin must reset enabled to false');
  assert.equal(store.getPlugins().find((p) => p.manifest.id === v2.id)?.manifest.version, '2.0.1');

  // Enforce 24-plugin capacity limit
  for (let i = store.getPlugins().length; i < PLUGIN_LIMITS.maxInstalledPlugins; i++) {
    store.installPlugin(parsePlugin({ ...v2Raw, id: `lumina.cap-test-${i}` }));
  }
  assert.equal(store.getPlugins().length, PLUGIN_LIMITS.maxInstalledPlugins);
  assert.throws(
    () => store.installPlugin(parsePlugin({ ...v2Raw, id: 'lumina.cap-overflow' })),
    'Installing beyond maxInstalledPlugins (24) must throw',
  );
  store.dispose();
}

// Plugin API v2.0 Batch 2: QuickJS async RPC sandbox, CPU interrupt, wall timeout, abort, and quotas
await (async () => {
  // 1. v1 synchronous execution compatibility
  const v1Res = await executePluginV1({
    script: 'function run(cmd, ctx) { return { kind: "brush", color: "#336699", size: Math.min(20, ctx.width) }; }',
    command: 'set-pen',
    context: { width: 1024, height: 768, dpi: 300 },
  });
  assert.deepEqual(v1Res, { kind: 'brush', color: '#336699', size: 20 });

  const makeV2Manifest = (script: string, permissions: PluginManifestV2['permissions']): PluginManifestV2 =>
    parsePlugin({
      apiVersion: 2,
      id: 'lumina.sandbox-test',
      name: 'Sandbox Test',
      version: '1.0.0',
      author: 'Test',
      description: 'Batch 2 test',
      permissions,
      commands: [{ id: 'run-it', label: 'Run' }],
      script,
    }) as PluginManifestV2;

  // 2. v2 async RPC with binary Uint8Array roundtrip & cumulative CPU time excluding async wait
  const writtenBuffers: Uint8Array[] = [];
  const binaryManifest = makeV2Manifest(
    `async function onCommand(cmdId, api) {
      const info = await api.layers.getActive();
      const tile = await api.pixels.read(info.id, { x: 0, y: 0, width: 2, height: 1 });
      const out = new Uint8Array(tile.data.length);
      for (let i = 0; i < tile.data.length; i++) out[i] = 255 - tile.data[i];
      await api.pixels.write(info.id, { x: 0, y: 0, width: 2, height: 1, data: out });
      return { notice: cmdId + ':' + api.canvas.tileSize + ':' + out[0] };
    }`,
    ['commands', 'layers:read', 'pixels:read', 'pixels:write'],
  );
  const binRes = await startPluginV2Direct(
    binaryManifest,
    { kind: 'command', commandId: 'run-it' },
    { width: 512, height: 512, dpi: 300 },
    async (method, _params, buffer) => {
      // Simulate async GPU read delay > cpuLimitMs to prove idle wait is not billed to CPU budget
      await new Promise((r) => setTimeout(r, 45));
      if (method === 'layers.getActive') return { result: { id: 'layer-1' } };
      if (method === 'pixels.read') {
        const src = new Uint8Array([10, 20, 30, 255, 100, 110, 120, 255]);
        return { result: { x: 0, y: 0, width: 2, height: 1 }, buffer: src.buffer };
      }
      if (method === 'pixels.write') {
        assert.ok(buffer instanceof ArrayBuffer);
        writtenBuffers.push(new Uint8Array(buffer));
        return { result: null };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    },
    { cpuLimitMs: 80, wallLimitMs: 3000 },
  ).promise;
  assert.equal(binRes.notice, 'run-it:256:245');
  assert.equal(writtenBuffers.length, 1);
  assert.deepEqual([...writtenBuffers[0]], [245, 235, 225, 0, 155, 145, 135, 0]);

  // 3. CPU interrupt handler stops infinite loops quickly
  const loopManifest = makeV2Manifest(
    'async function onCommand() { while (true) {} }',
    ['commands'],
  );
  await assert.rejects(
    startPluginV2Direct(
      loopManifest,
      { kind: 'command', commandId: 'run-it' },
      { width: 256, height: 256, dpi: 300 },
      async () => ({ result: null }),
      { cpuLimitMs: 60, wallLimitMs: 3000 },
    ).promise,
    /CPU|limit|interrupted|Script failed/i,
  );

  // 4. Wall timeout aborts hanging RPC
  const slowManifest = makeV2Manifest(
    'async function onCommand(_id, api) { await api.layers.list(); }',
    ['commands', 'layers:read'],
  );
  await assert.rejects(
    startPluginV2Direct(
      slowManifest,
      { kind: 'command', commandId: 'run-it' },
      { width: 256, height: 256, dpi: 300 },
      () => new Promise(() => {}),
      { wallLimitMs: 80 },
    ).promise,
    /timed out/i,
  );

  // 5. Manual abort via AbortController
  const ac = new AbortController();
  const abortHandle = startPluginV2Direct(
    slowManifest,
    { kind: 'command', commandId: 'run-it' },
    { width: 256, height: 256, dpi: 300 },
    () => new Promise(() => {}),
    { wallLimitMs: 3000, signal: ac.signal },
  );
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(abortHandle.promise, /aborted/i);

  // 6. Permission enforcement: missing permission & respectSelection: false without selection permission
  const noSelManifest = makeV2Manifest(
    `async function onCommand(_id, api) {
      await api.pixels.write('l1', { x: 0, y: 0, width: 1, height: 1, data: new Uint8Array(4), respectSelection: false });
    }`,
    ['commands', 'pixels:write'],
  );
  await assert.rejects(
    startPluginV2Direct(
      noSelManifest,
      { kind: 'command', commandId: 'run-it' },
      { width: 256, height: 256, dpi: 300 },
      async () => ({ result: null }),
    ).promise,
    /selection.*permission/i,
  );

  // 7. Quotas: RPC count, pixel bytes, layer creation
  const quotaManifest = makeV2Manifest(
    `async function onCommand(_id, api) {
      for (let i = 0; i < 4; i++) await api.layers.list();
    }`,
    ['commands', 'layers:read'],
  );
  await assert.rejects(
    startPluginV2Direct(
      quotaManifest,
      { kind: 'command', commandId: 'run-it' },
      { width: 256, height: 256, dpi: 300 },
      async () => ({ result: [] }),
      { quota: { maxRpcCalls: 3 } },
    ).promise,
    /RPC quota exceeded/i,
  );

  const pixelQuotaManifest = makeV2Manifest(
    `async function onCommand(_id, api) {
      await api.pixels.write('l1', { x: 0, y: 0, width: 4, height: 4, data: new Uint8Array(64) });
    }`,
    ['commands', 'pixels:write'],
  );
  await assert.rejects(
    startPluginV2Direct(
      pixelQuotaManifest,
      { kind: 'command', commandId: 'run-it' },
      { width: 256, height: 256, dpi: 300 },
      async () => ({ result: null }),
      { quota: { maxPixelBytes: 32 } },
    ).promise,
    /Pixel I\/O quota exceeded/i,
  );

  // 8. Never-settling promise fails fast instead of hanging until wall timeout
  const hangPromiseManifest = makeV2Manifest(
    'function onCommand() { return new Promise(() => {}); }',
    ['commands'],
  );
  await assert.rejects(
    startPluginV2Direct(
      hangPromiseManifest,
      { kind: 'command', commandId: 'run-it' },
      { width: 256, height: 256, dpi: 300 },
      async () => ({ result: null }),
      { wallLimitMs: 5000 },
    ).promise,
    /never settled/i,
  );
})();

// Plugin API v2.0 Batch 3: Layer tree, tile pixel I/O, straight<->premul, ACL, groupId undo, and rollback
await (async () => {
  // 1. Straight <-> Premultiplied RGBA conversion accuracy (semi-transparent without dark fringing)
  const straightIn = new Uint8Array([200, 100, 50, 128, 255, 0, 128, 0, 10, 20, 30, 255]);
  const premul = straightToPremultiplied(straightIn);
  assert.deepEqual([...premul], [100, 50, 25, 128, 0, 0, 0, 0, 10, 20, 30, 255]);
  const straightBack = premultipliedToStraight(premul);
  assert.ok(Math.abs(straightBack[0] - 200) <= 1 && Math.abs(straightBack[1] - 100) <= 1 && straightBack[3] === 128);
  assert.deepEqual([...straightBack.subarray(4, 12)], [0, 0, 0, 0, 10, 20, 30, 255]);

  // Helper: in-memory canvas adapter backed by 256x256 premultiplied tiles + ScopedUndoManager
  const makeMockCanvas = (aclOverride?: Partial<PluginCanvasHostAdapter['acl']>) => {
    const W = 512;
    const H = 512;
    const TS = 256;
    const layers: LayerModel[] = [
      {
        id: 'l-own', canvasId: 'c1', ownerId: 'u1', parentId: null, name: 'My Layer',
        layerType: 'raster', blendMode: 'normal', opacity: 1, isVisible: true, isLocked: false,
        alphaLocked: false, clipToBelow: false, isPublic: false, aclMode: 'owner_only',
        sortOrder: 10, createdAt: 1, updatedAt: 1,
      },
      {
        id: 'l-other', canvasId: 'c1', ownerId: 'u2', parentId: null, name: 'Other Layer',
        layerType: 'raster', blendMode: 'normal', opacity: 1, isVisible: true, isLocked: false,
        alphaLocked: false, clipToBelow: false, isPublic: false, aclMode: 'owner_only',
        sortOrder: 20, createdAt: 1, updatedAt: 1,
      },
      {
        id: 'l-locked', canvasId: 'c1', ownerId: 'u1', parentId: null, name: 'Locked Layer',
        layerType: 'raster', blendMode: 'normal', opacity: 1, isVisible: true, isLocked: true,
        alphaLocked: false, clipToBelow: false, isPublic: false, aclMode: 'owner_only',
        sortOrder: 30, createdAt: 1, updatedAt: 1,
      },
      {
        id: 'l-shared', canvasId: 'c1', ownerId: 'u2', parentId: null, name: 'Shared Layer',
        layerType: 'raster', blendMode: 'normal', opacity: 1, isVisible: true, isLocked: false,
        alphaLocked: false, clipToBelow: false, isPublic: false, aclMode: 'shared_all',
        sortOrder: 40, createdAt: 1, updatedAt: 1,
      },
      {
        id: 'l-alpha', canvasId: 'c1', ownerId: 'u1', parentId: null, name: 'Alpha Locked',
        layerType: 'raster', blendMode: 'normal', opacity: 1, isVisible: true, isLocked: false,
        alphaLocked: true, clipToBelow: false, isPublic: false, aclMode: 'owner_only',
        sortOrder: 50, createdAt: 1, updatedAt: 1,
      },
    ];
    let activeId: string | null = 'l-own';
    const tileStore = new Map<string, Map<string, Uint8Array>>();
    const undo = new ScopedUndoManager();
    const committedPatches: Array<{ layerId: string; count: number }> = [];
    let createdSeq = 1;

    const getTile = (layerId: string, col: number, row: number): Uint8Array => {
      const lm = tileStore.get(layerId);
      const t = lm?.get(`${col}_${row}`);
      return t ? t.slice() : new Uint8Array(TS * TS * 4);
    };
    const setTile = (layerId: string, col: number, row: number, data: Uint8Array) => {
      let lm = tileStore.get(layerId);
      if (!lm) {
        lm = new Map();
        tileStore.set(layerId, lm);
      }
      lm.set(`${col}_${row}`, data.slice());
    };

    // Seed 1 pixel on l-alpha at (2, 2) with premultiplied RGBA (50, 50, 50, 128)
    const alphaTile = new Uint8Array(TS * TS * 4);
    const seedIdx = (2 * TS + 2) * 4;
    alphaTile[seedIdx] = 50; alphaTile[seedIdx + 1] = 50; alphaTile[seedIdx + 2] = 50; alphaTile[seedIdx + 3] = 128;
    setTile('l-alpha', 0, 0, alphaTile);

    const adapter: PluginCanvasHostAdapter = {
      canvasWidth: W,
      canvasHeight: H,
      tileSize: TS,
      acl: {
        user: { id: 'u1', username: 'alice', displayName: 'Alice', serverRole: 'user' },
        isGuest: false,
        canvasMember: null,
        ...aclOverride,
      },
      getLayers: () => layers,
      getActiveLayerId: () => activeId,
      setActiveLayer: (id) => { activeId = id; },
      createLayer: async (opts) => {
        const model: LayerModel = {
          id: `l-new-${createdSeq++}`,
          canvasId: 'c1',
          ownerId: aclOverride?.user?.id ?? 'u1',
          parentId: opts.parentId,
          name: opts.name,
          layerType: opts.layerType,
          blendMode: opts.blendMode,
          opacity: opts.opacity,
          isVisible: true,
          isLocked: false,
          alphaLocked: false,
          clipToBelow: false,
          isPublic: false,
          aclMode: 'owner_only',
          sortOrder: (layers.length + 1) * 10,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        layers.push(model);
        if (opts.select) activeId = model.id;
        return model;
      },
      updateLayerProps: async (layerId, patch) => {
        const l = layers.find((x) => x.id === layerId);
        if (l) Object.assign(l, patch);
      },
      reorderLayers: async (layerId, ascendingIds, parentIdPatch) => {
        if (parentIdPatch !== undefined) {
          const l = layers.find((x) => x.id === layerId);
          if (l) l.parentId = parentIdPatch;
        }
        ascendingIds.forEach((id, idx) => {
          const l = layers.find((x) => x.id === id);
          if (l) l.sortOrder = (idx + 1) * 10;
        });
      },
      deleteLayer: async (layerId) => {
        const idx = layers.findIndex((x) => x.id === layerId);
        if (idx < 0) return false;
        layers.splice(idx, 1);
        tileStore.delete(layerId);
        return true;
      },
      restoreDeletedLayer: async (model, tiles) => {
        layers.push({ ...model });
        for (const t of tiles) setTile(model.id, t.col, t.row, t.data as Uint8Array);
        return model;
      },
      getOccupiedTiles: (layerId) => {
        const lm = tileStore.get(layerId);
        if (!lm) return [];
        return [...lm.keys()].map((k) => {
          const [col, row] = k.split('_').map(Number);
          return { col, row };
        });
      },
      readLayerTile: async (layerId, col, row) => getTile(layerId, col, row),
      readLayerRect: async (layerId, rect) => {
        const out = new Uint8Array(rect.width * rect.height * 4);
        for (let y = 0; y < rect.height; y++) {
          for (let x = 0; x < rect.width; x++) {
            const gx = rect.x + x;
            const gy = rect.y + y;
            const t = getTile(layerId, Math.floor(gx / TS), Math.floor(gy / TS));
            const si = ((gy % TS) * TS + (gx % TS)) * 4;
            const di = (y * rect.width + x) * 4;
            out.set(t.subarray(si, si + 4), di);
          }
        }
        return out;
      },
      readCompositeRect: async (rect) => new Uint8Array(rect.width * rect.height * 4),
      applyLayerTiles: (layerId, tiles) => {
        for (const t of tiles) setTile(layerId, t.col, t.row, t.data as Uint8Array);
      },
      commitTilePatch: (layerId, tiles) => {
        committedPatches.push({ layerId, count: tiles.length });
      },
      pushUndoOp: (op) => undo.push(op),
    };
    return { adapter, layers, undo, getTile, committedPatches };
  };

  const makeManifest = (script: string, permissions: PluginManifestV2['permissions']): PluginManifestV2 =>
    parsePlugin({
      apiVersion: 2,
      id: 'lumina.b3-test',
      name: 'B3 Test',
      version: '1.0.0',
      author: 'Tester',
      description: 'Batch 3 bridge tests',
      permissions,
      commands: [{ id: 'go', label: 'Go' }],
      script,
    }) as PluginManifestV2;

  // 2. Multi-layer create + write + read-staged + alphaLock + sparse bounds + single groupId undo
  {
    const mock = makeMockCanvas();
    const tx = new PluginCanvasTransaction(mock.adapter);
    const manifest = makeManifest(
      `async function onCommand(_id, api) {
        const list = await api.layers.list();
        const other = list.find(l => l.id === 'l-other');
        const shared = list.find(l => l.id === 'l-shared');
        const locked = list.find(l => l.id === 'l-locked');
        if (other.canEditPixels !== false || other.canManage !== false) throw new Error('ACL mismatch on other');
        if (locked.canEditPixels !== false || locked.canManage !== false) throw new Error('ACL mismatch on locked');
        if (shared.canEditPixels !== true || shared.canManage !== false) throw new Error('ACL mismatch on shared');

        // Write straight semi-transparent red into l-own at (10, 12)
        const px = new Uint8Array([200, 40, 20, 128]);
        await api.pixels.write('l-own', { x: 10, y: 12, width: 1, height: 1, data: px });
        // Immediately read back staged pixel before commit
        const readBack = await api.pixels.read('l-own', { x: 10, y: 12, width: 1, height: 1 });
        if (Math.abs(readBack.data[0] - 200) > 1 || readBack.data[3] !== 128) throw new Error('Staged read failed');

        // Sparse non-empty bounds should report exact 1x1 box at (10,12)
        const bounds = await api.pixels.getNonEmptyBounds('l-own');
        if (!bounds || bounds.x !== 10 || bounds.y !== 12 || bounds.width !== 1 || bounds.height !== 1) {
          throw new Error('Bounds mismatch: ' + JSON.stringify(bounds));
        }

        // Alpha-locked write: (2,2) keeps alpha=128 with new color; (3,2) stays transparent
        const aPatch = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
        await api.pixels.write('l-alpha', { x: 2, y: 2, width: 2, height: 1, data: aPatch });

        // Create a new layer and draw a pixel into it
        const created = await api.layers.create({ name: 'Generated Glow', blendMode: 'add', opacity: 0.75 });
        await api.pixels.write(created.id, { x: 0, y: 0, width: 1, height: 1, data: new Uint8Array([0, 255, 255, 255]) });

        return { notice: created.id };
      }`,
      ['commands', 'layers:read', 'layers:write', 'pixels:read', 'pixels:write'],
    );
    const res = await startPluginV2Direct(
      manifest,
      { kind: 'command', commandId: 'go' },
      { width: 512, height: 512, dpi: 300 },
      tx.createRpcHandler(),
    ).promise;
    // Before commit, l-own tile in canvas store is still untouched
    assert.equal(mock.getTile('l-own', 0, 0)[(12 * 256 + 10) * 4 + 3], 0, 'Canvas pixels untouched before commit');
    tx.commit('Plugin: B3 Test');

    // After commit, l-own has premultiplied (100, 20, 10, 128)
    const ownTile = mock.getTile('l-own', 0, 0);
    const idx = (12 * 256 + 10) * 4;
    assert.deepEqual([...ownTile.subarray(idx, idx + 4)], [100, 20, 10, 128]);

    // Alpha-locked layer preserved original alpha=128 at (2,2) and kept (3,2) transparent
    const aTile = mock.getTile('l-alpha', 0, 0);
    const aIdx0 = (2 * 256 + 2) * 4;
    const aIdx1 = (2 * 256 + 3) * 4;
    assert.deepEqual([...aTile.subarray(aIdx0, aIdx0 + 4)], [128, 0, 0, 128]);
    assert.deepEqual([...aTile.subarray(aIdx1, aIdx1 + 4)], [0, 0, 0, 0]);

    // Single undoGroup pops ALL ops from this plugin run together (shared groupId)
    const undoneOps = mock.undo.undoGroup('u1');
    assert.equal(undoneOps.length, 3, 'Created layer + 2 modified layers share one undo group');
    assert.equal(new Set(undoneOps.map((o) => o.groupId)).size, 1, 'All ops share identical groupId');
    assert.ok(undoneOps.some((o) => o.layerCreated && o.layerId === res.notice));
  }

  // 3. Failure rollback: discards staged pixels, deletes created layer, restores updated props, pushes 0 undo ops
  {
    const mock = makeMockCanvas();
    const tx = new PluginCanvasTransaction(mock.adapter);
    const failManifest = makeManifest(
      `async function onCommand(_id, api) {
        await api.layers.update('l-own', { name: 'Renamed Before Crash', opacity: 0.25 });
        const created = await api.layers.create({ name: 'Temp Layer' });
        await api.pixels.write('l-own', { x: 1, y: 1, width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) });
        await api.pixels.write(created.id, { x: 0, y: 0, width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) });
        throw new Error('Intentional mid-run failure');
      }`,
      ['commands', 'layers:read', 'layers:write', 'pixels:write'],
    );
    await assert.rejects(
      startPluginV2Direct(
        failManifest,
        { kind: 'command', commandId: 'go' },
        { width: 512, height: 512, dpi: 300 },
        tx.createRpcHandler(),
      ).promise,
      /Intentional mid-run failure/,
    );
    await tx.rollback();
    assert.equal(mock.layers.find((l) => l.name === 'Temp Layer'), undefined, 'Created layer removed on rollback');
    assert.equal(mock.layers.find((l) => l.id === 'l-own')?.name, 'My Layer', 'Layer name restored on rollback');
    assert.equal(mock.layers.find((l) => l.id === 'l-own')?.opacity, 1, 'Layer opacity restored on rollback');
    assert.equal(mock.getTile('l-own', 0, 0)[(1 * 256 + 1) * 4 + 3], 0, 'Staged pixels discarded on rollback');
    assert.equal(mock.undo.canUndo('u1'), false, 'No undo ops pushed on rollback');
  }

  // 4. ACL enforcement & forbidden mutations (guest, viewer, other's layer, locked layer, forbidden props, >512px)
  {
    const mock = makeMockCanvas();
    const tx = new PluginCanvasTransaction(mock.adapter);
    const rpc = tx.createRpcHandler();
    await assert.rejects(rpc('pixels.write', { layerId: 'l-other', patch: { x: 0, y: 0, width: 1, height: 1 } }, new Uint8Array(4).buffer));
    await assert.rejects(rpc('pixels.write', { layerId: 'l-locked', patch: { x: 0, y: 0, width: 1, height: 1 } }, new Uint8Array(4).buffer));
    await assert.rejects(rpc('layers.delete', { layerId: 'l-shared' }));
    await assert.rejects(rpc('layers.update', { layerId: 'l-own', patch: { isLocked: true } }), /Disallowed layer property/);
    await assert.rejects(rpc('layers.update', { layerId: 'l-own', patch: { aclMode: 'shared_all' } }), /Disallowed layer property/);
    await assert.rejects(rpc('layers.update', { layerId: 'l-own', patch: { isPublic: true } }), /Disallowed layer property/);
    await assert.rejects(rpc('pixels.read', { layerId: 'l-own', rect: { x: 0, y: 0, width: 513, height: 1 } }), /512/);
    await tx.rollback();

    const guestMock = makeMockCanvas({ isGuest: true, user: null });
    const guestTx = new PluginCanvasTransaction(guestMock.adapter);
    await assert.rejects(guestTx.createRpcHandler()('layers.create', { name: 'Guest Layer' }), /Guests/);
    await guestTx.rollback();

    const viewerMock = makeMockCanvas({
      canvasMember: {
        canvasId: 'c1', userId: 'u1', role: 'viewer',
        canCreateLayer: false, canDeleteOtherLayer: false, canExport: false, canManageMembers: false, joinedAt: 0,
      },
    });
    const viewerTx = new PluginCanvasTransaction(viewerMock.adapter);
    await assert.rejects(viewerTx.createRpcHandler()('layers.create', { name: 'Viewer Layer' }), /Viewers/);
    await viewerTx.rollback();
  }
})();

// Plugin API v2.0 Batch 4: Selection API (geometry, mask tiles, expand/contract/feather/invert/clear) & respectSelection
await (async () => {
  const W = 64;
  const H = 64;
  const TS = 64;
  const makeSelMock = () => {
    const selection = createHeadlessSelectionBridge(W, H);
    const layer: LayerModel = {
      id: 'l1', canvasId: 'c1', ownerId: 'u1', parentId: null, name: 'Paint',
      layerType: 'raster', blendMode: 'normal', opacity: 1, isVisible: true, isLocked: false,
      alphaLocked: false, clipToBelow: false, isPublic: false, aclMode: 'owner_only',
      sortOrder: 10, createdAt: 1, updatedAt: 1,
    };
    let tile = new Uint8Array(TS * TS * 4);
    const undo = new ScopedUndoManager();

    const adapter: PluginCanvasHostAdapter = {
      canvasWidth: W,
      canvasHeight: H,
      tileSize: TS,
      acl: {
        user: { id: 'u1', username: 'alice', displayName: 'Alice', serverRole: 'user' },
        isGuest: false,
        canvasMember: null,
      },
      getLayers: () => [layer],
      getActiveLayerId: () => 'l1',
      setActiveLayer: () => {},
      createLayer: async () => null,
      updateLayerProps: async () => {},
      reorderLayers: async () => {},
      deleteLayer: async () => false,
      restoreDeletedLayer: async () => null,
      getOccupiedTiles: () => [{ col: 0, row: 0 }],
      readLayerTile: async () => tile.slice(),
      readLayerRect: async (_id, rect) => {
        const out = new Uint8Array(rect.width * rect.height * 4);
        for (let y = 0; y < rect.height; y++) {
          const src = ((rect.y + y) * TS + rect.x) * 4;
          out.set(tile.subarray(src, src + rect.width * 4), y * rect.width * 4);
        }
        return out;
      },
      readCompositeRect: async (rect) => new Uint8Array(rect.width * rect.height * 4),
      applyLayerTiles: (_id, tiles) => {
        if (tiles[0]) tile = (tiles[0].data as Uint8Array).slice();
      },
      commitTilePatch: () => {},
      pushUndoOp: (op) => undo.push(op),
      selection,
    };
    return { adapter, selection, getTile: () => tile, undo };
  };

  const makeManifest = (script: string, permissions: PluginManifestV2['permissions']): PluginManifestV2 =>
    parsePlugin({
      apiVersion: 2,
      id: 'lumina.b4-test',
      name: 'B4 Test',
      version: '1.0.0',
      author: 'Tester',
      description: 'Batch 4 selection tests',
      permissions,
      commands: [{ id: 'sel', label: 'Sel' }],
      script,
    }) as PluginManifestV2;

  // 1. Geometry selections (rect, ellipse, polygon), tiled writeMask/readMask, expand/contract/feather/invert/clear
  {
    const mock = makeSelMock();
    const tx = new PluginCanvasTransaction(mock.adapter);
    const manifest = makeManifest(
      `async function onCommand(_id, api) {
        const init = await api.selection.getInfo();
        if (init.hasSelection !== false || init.bounds !== null) throw new Error('Expected empty selection');

        await api.selection.selectRect({ x: 10, y: 10, width: 10, height: 10 }, 'replace');
        const info1 = await api.selection.getInfo();
        if (!info1.hasSelection || info1.bounds.x !== 10 || info1.bounds.width !== 10) {
          throw new Error('selectRect bounds mismatch');
        }

        // Subtract inner 4x4 hole
        await api.selection.selectRect({ x: 13, y: 13, width: 4, height: 4 }, 'subtract');
        const hole = await api.selection.readMask({ x: 13, y: 13, width: 1, height: 1 });
        const rim = await api.selection.readMask({ x: 10, y: 10, width: 1, height: 1 });
        if (hole.data[0] !== 0 || rim.data[0] !== 255) throw new Error('subtract failed');

        // Expand & contract
        await api.selection.selectRect({ x: 20, y: 20, width: 10, height: 10 }, 'replace');
        await api.selection.expand(2);
        const expInfo = await api.selection.getInfo();
        if (expInfo.bounds.x !== 18 || expInfo.bounds.width !== 14) throw new Error('expand failed');
        await api.selection.contract(2);
        const conInfo = await api.selection.getInfo();
        if (conInfo.bounds.x !== 20 || conInfo.bounds.width !== 10) throw new Error('contract failed');

        // Ellipse & Polygon
        await api.selection.selectEllipse({ x: 4, y: 4, width: 12, height: 12 }, 'replace');
        const center = await api.selection.readMask({ x: 10, y: 10, width: 1, height: 1 });
        const corner = await api.selection.readMask({ x: 4, y: 4, width: 1, height: 1 });
        if (center.data[0] !== 255 || corner.data[0] !== 0) throw new Error('ellipse mask mismatch');

        await api.selection.selectPolygon([{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 15, y: 20 }], 'replace');
        const triCenter = await api.selection.readMask({ x: 15, y: 13, width: 1, height: 1 });
        if (triCenter.data[0] !== 255) throw new Error('polygon mask mismatch');

        // Invert & Clear
        await api.selection.invert();
        const invCorner = await api.selection.readMask({ x: 0, y: 0, width: 1, height: 1 });
        if (invCorner.data[0] !== 255) throw new Error('invert failed');
        await api.selection.clear();
        if ((await api.selection.getInfo()).hasSelection) throw new Error('clear failed');

        // Tiled writeMask + feather
        await api.selection.writeMask({ x: 2, y: 2, width: 4, height: 4, data: new Uint8Array(16).fill(255) }, 'replace');
        await api.selection.writeMask({ x: 6, y: 2, width: 4, height: 4, data: new Uint8Array(16).fill(128) }, 'replace');
        const stitched = await api.selection.readMask({ x: 2, y: 2, width: 8, height: 1 });
        if (stitched.data[0] !== 255 || stitched.data[4] !== 128) throw new Error('tiled writeMask failed');
        await api.selection.feather(2);
        const edge = await api.selection.readMask({ x: 1, y: 3, width: 1, height: 1 });
        if (edge.data[0] <= 0 || edge.data[0] >= 255) throw new Error('feather did not soften edge: ' + edge.data[0]);

        return { notice: 'sel-ok' };
      }`,
      ['commands', 'selection'],
    );
    const res = await startPluginV2Direct(
      manifest,
      { kind: 'command', commandId: 'sel' },
      { width: W, height: H, dpi: 300 },
      tx.createRpcHandler(),
    ).promise;
    assert.equal(res.notice, 'sel-ok');
    tx.commit('Plugin: B4 Test');
    const ops = mock.undo.undoGroup('u1');
    assert.equal(ops.length, 1);
    assert.equal(ops[0].opType, 'PLUGIN_SELECTION');
    assert.equal(ops[0].selectionBefore, null);
    assert.ok(ops[0].selectionAfter && ops[0].selectionAfter.activePixelCount > 0);
  }

  // 2. pixels.write respectSelection default (true) vs explicit false (requires selection permission) & feathered blend
  {
    const mock = makeSelMock();
    // Create a 2x1 mask at (0,0): x=0 is 255, x=1 is 128; x=2 is outside selection (0)
    mock.selection.writeMaskRect({ x: 0, y: 0, width: 2, height: 1 }, new Uint8Array([255, 128]), 'replace');

    // Run A: pixels:write only (default respectSelection = true)
    const txA = new PluginCanvasTransaction(mock.adapter);
    const manifestA = makeManifest(
      `async function onCommand(_id, api) {
        const red = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
        await api.pixels.write('l1', { x: 0, y: 0, width: 3, height: 1, data: red });
      }`,
      ['commands', 'pixels:write'],
    );
    await startPluginV2Direct(
      manifestA,
      { kind: 'command', commandId: 'sel' },
      { width: W, height: H, dpi: 300 },
      txA.createRpcHandler(),
    ).promise;
    txA.commit('Plugin: Respect Selection');
    const tA = mock.getTile();
    assert.deepEqual([...tA.subarray(0, 4)], [255, 0, 0, 255], 'Selected pixel (255) written fully');
    assert.equal(tA[4], 128, 'Feathered selection pixel (128) blended half strength');
    assert.equal(tA[7], 128, 'Feathered selection alpha blended half strength');
    assert.deepEqual([...tA.subarray(8, 12)], [0, 0, 0, 0], 'Unselected pixel (0) left untouched');

    // Run B: pixels:write + selection permission with explicit respectSelection: false overwrites x=2
    const txB = new PluginCanvasTransaction(mock.adapter);
    const manifestB = makeManifest(
      `async function onCommand(_id, api) {
        const blue = new Uint8Array([0, 0, 255, 255]);
        await api.pixels.write('l1', { x: 2, y: 0, width: 1, height: 1, data: blue, respectSelection: false });
      }`,
      ['commands', 'pixels:write', 'selection'],
    );
    await startPluginV2Direct(
      manifestB,
      { kind: 'command', commandId: 'sel' },
      { width: W, height: H, dpi: 300 },
      txB.createRpcHandler(),
    ).promise;
    txB.commit('Plugin: Ignore Selection');
    assert.deepEqual([...mock.getTile().subarray(8, 12)], [0, 0, 255, 255], 'Explicit respectSelection:false writes outside selection');
  }

  // 3. Rollback restores original selection snapshot on plugin failure & rejects invalid radius/polygon
  {
    const mock = makeSelMock();
    mock.selection.selectRect({ x: 5, y: 5, width: 6, height: 6 }, 'replace');
    const tx = new PluginCanvasTransaction(mock.adapter);
    const failManifest = makeManifest(
      `async function onCommand(_id, api) {
        await api.selection.clear();
        throw new Error('Abort after clearing selection');
      }`,
      ['commands', 'selection'],
    );
    await assert.rejects(
      startPluginV2Direct(
        failManifest,
        { kind: 'command', commandId: 'sel' },
        { width: W, height: H, dpi: 300 },
        tx.createRpcHandler(),
      ).promise,
      /Abort after clearing selection/,
    );
    await tx.rollback();
    const restored = mock.selection.getInfo();
    assert.equal(restored.hasSelection, true, 'Rollback restores pre-existing selection');
    assert.deepEqual(restored.bounds, { x: 5, y: 5, width: 6, height: 6 });

    // Validation bounds: radius 0 or 129 rejected, polygon < 3 or > 4096 rejected
    const tx2 = new PluginCanvasTransaction(mock.adapter);
    const rpc = tx2.createRpcHandler();
    await assert.rejects(rpc('selection.expand', { radius: 0 }), /1 and 128/);
    await assert.rejects(rpc('selection.feather', { radius: 129 }), /1 and 128/);
    await assert.rejects(rpc('selection.selectPolygon', { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }), /between 3 and 4096/);
    await tx2.rollback();
  }
})();

// Plugin API v2.0 Batch 5: Plugin filters in F1 filterRegistry & isolated QuickJS tiled filter engine
await (async () => {
  // 1. Dynamic filterRegistry sync: 'plugin' group hidden when empty, visible when enabled, supports existing groups
  syncPluginFilters([]);
  assert.equal(filterGroupsInUse().includes('plugin'), false, 'plugin filter group hidden when no plugin filters active');

  const filterPluginManifest = parsePlugin({
    apiVersion: 2,
    id: 'lumina.test-filter-kit',
    name: 'Test Filter Kit',
    version: '1.0.0',
    author: 'Lumina Drift',
    description: 'Test filter plugin.',
    permissions: ['filters'],
    filters: [
      {
        id: 'prism-tint',
        label: 'Prism Tint',
        i18nLabel: { 'zh-TW': '稜鏡著色' },
        group: 'plugin',
        tilePadding: 2,
        draft: true,
        params: [
          { kind: 'range', key: 'boost', label: 'Boost', i18nLabel: { 'zh-TW': '增幅' }, initial: 40, min: 0, max: 100, step: 1, unit: '%' },
        ],
      },
      {
        id: 'warm-shift',
        label: 'Warm Shift',
        group: 'color',
        tilePadding: 0,
        params: [],
      },
    ],
    script: `function onFilter(id, tile, params) { return tile.rgba; }`,
  }) as PluginManifestV2;

  syncPluginFilters([{ manifest: filterPluginManifest, enabled: true, installedAt: 1 }]);
  assert.equal(filterGroupsInUse().includes('plugin'), true, 'plugin filter group shown when enabled');
  const prismId = makePluginFilterId('lumina.test-filter-kit', 'prism-tint');
  const warmId = makePluginFilterId('lumina.test-filter-kit', 'warm-shift');
  const prismDef = getFilter(prismId);
  const warmDef = getFilter(warmId);
  assert.ok(prismDef && prismDef.source === 'plugin' && prismDef.group === 'plugin');
  assert.ok(warmDef && warmDef.source === 'plugin' && warmDef.group === 'color');
  assert.equal(filtersInGroup('color').some((d) => d.id === warmId), true, 'plugin filter can belong to existing group');
  assert.equal(filterLabel(prismDef!, translations['zh-TW'], 'zh-TW'), '稜鏡著色');
  assert.equal(filterLabel(prismDef!, translations['en-US'], 'en-US'), 'Prism Tint');
  assert.equal(filterParamLabel(prismDef!.params[0], translations['zh-TW'], 'zh-TW'), '增幅');

  // Disabling plugin removes filters and hides 'plugin' group again
  syncPluginFilters([{ manifest: filterPluginManifest, enabled: false, installedAt: 1 }]);
  assert.equal(getFilter(prismId), null);
  assert.equal(filterGroupsInUse().includes('plugin'), false, 'plugin filter group hidden after disable');

  // 2. Multi-tile (300x270 -> 4 tiles) execution with tilePadding clamp + premul<->straight roundtrip
  {
    const W = 300;
    const H = 270;
    const src = new Uint8Array(W * H * 4);
    // Fill with premultiplied 50% alpha red (straight R=200, A=128 -> premul R=100, A=128)
    for (let i = 0; i < src.length; i += 4) {
      src[i] = 100;
      src[i + 1] = 0;
      src[i + 2] = 0;
      src[i + 3] = 128;
    }
    const script = `
      function onFilter(filterId, tile, params) {
        if (filterId !== 'box-check') throw new Error('unexpected filterId');
        // Verify halo padding dimensions match padLeft/padTop/padRight/padBottom
        const expectedLen = tile.width * tile.height * 4;
        if (tile.rgba.byteLength !== expectedLen) throw new Error('length mismatch');
        const out = new Uint8Array(expectedLen);
        const addG = params.addG || 0;
        for (let y = tile.padTop; y < tile.height - tile.padBottom; y++) {
          for (let x = tile.padLeft; x < tile.width - tile.padRight; x++) {
            // Read left neighbor across padding boundary to prove clamped halo is populated
            const leftIdx = (y * tile.width + (x - 1)) * 4;
            const idx = (y * tile.width + x) * 4;
            out[idx] = tile.rgba[leftIdx];
            out[idx + 1] = Math.min(255, tile.rgba[idx + 1] + addG);
            out[idx + 2] = tile.rgba[idx + 2];
            out[idx + 3] = tile.rgba[idx + 3];
          }
        }
        return out;
      }
    `;
    const res = await runPluginFilterTiled({
      script,
      filterId: 'box-check',
      pixels: src,
      width: W,
      height: H,
      params: { addG: 100 },
      tilePadding: 2,
      previewOnly: true,
    });
    assert.equal(res.cancelled, false);
    assert.equal(res.tilesProcessed, 4, '300x270 spans 2x2 tiles of 256x256');
    assert.ok(res.output);
    // Pixel (0,0) and cross-tile pixel (256, 256) should both have premul R~100, G~50 (100*128/255), A=128
    for (const [px, py] of [[0, 0], [256, 256], [299, 269]]) {
      const idx = (py * W + px) * 4;
      assert.ok(Math.abs(res.output![idx] - 100) <= 1, `R preserved at (${px},${py})`);
      assert.ok(Math.abs(res.output![idx + 1] - 50) <= 1, `G premultiplied at (${px},${py})`);
      assert.equal(res.output![idx + 3], 128, `A preserved at (${px},${py})`);
    }
  }

  // 3. Selection mask blending & draft downscale preview
  {
    const W = 16;
    const H = 16;
    const src = new Uint8Array(W * H * 4);
    for (let i = 0; i < src.length; i += 4) {
      src[i] = 20;
      src[i + 1] = 20;
      src[i + 2] = 20;
      src[i + 3] = 255;
    }
    const mask = new Uint8Array(W * H);
    mask[0] = 255; // fully selected
    mask[1] = 128; // half feathered
    mask[2] = 0;   // unselected
    const invertScript = `
      function onFilter(_id, tile) {
        for (let i = 0; i < tile.rgba.length; i += 4) {
          tile.rgba[i] = 220;
          tile.rgba[i + 1] = 220;
          tile.rgba[i + 2] = 220;
        }
      }
    `;
    const maskedRes = await runPluginFilterTiled({
      script: invertScript,
      filterId: 'fill',
      pixels: src,
      width: W,
      height: H,
      params: {},
      mask,
      draft: 2,
      previewOnly: true,
    });
    assert.ok(maskedRes.output);
    assert.equal(maskedRes.output![0], 220, 'Selected pixel receives filtered value even under draft');
    assert.ok(Math.abs(maskedRes.output![4] - 120) <= 2, 'Feathered pixel blends original (20) and filtered (220)');
    assert.equal(maskedRes.output![8], 20, 'Unselected pixel stays untouched');
  }

  // 4. Cancellation & per-tile CPU interrupt timeout
  {
    const src = new Uint8Array(32 * 32 * 4);
    const cancelledRes = await runPluginFilterTiled({
      script: `function onFilter(_id, tile) { return tile.rgba; }`,
      filterId: 'noop',
      pixels: src,
      width: 32,
      height: 32,
      params: {},
      isCancelled: () => true,
    });
    assert.equal(cancelledRes.cancelled, true);
    assert.equal(cancelledRes.output, null);

    await assert.rejects(
      runPluginFilterTiled({
        script: `function onFilter() { while (true) {} }`,
        filterId: 'hang',
        pixels: src,
        width: 32,
        height: 32,
        params: {},
        tileCpuLimitMs: 40,
        totalCpuLimitMs: 120,
      }),
      /CPU limit/,
    );
  }
})();

// Plugin API v2.0 Batch 6: Plugin shortcuts (namespacing + anti-hijack) and declarative panel state helpers
(() => {
  const cmdKey = makePluginCommandShortcutId('lumina.edge-glow', 'outline-sel');
  const panelKey = makePluginPanelShortcutId('lumina.edge-glow', 'glow-panel');
  assert.deepEqual(parsePluginShortcutId(cmdKey), { kind: 'command', pluginId: 'lumina.edge-glow', commandId: 'outline-sel' });
  assert.deepEqual(parsePluginShortcutId(panelKey), { kind: 'panel', pluginId: 'lumina.edge-glow', panelId: 'glow-panel' });
  assert.equal(parsePluginShortcutId('tool_brush'), null);

  const mgr = ShortcutManager.getInstance();
  const pluginA = parsePlugin({
    apiVersion: 2,
    id: 'lumina.shortcut-a',
    name: 'Shortcut A',
    version: '1.0.0',
    author: 'Lumina Drift',
    description: 'Shortcut anti-hijack test A',
    permissions: ['commands', 'ui:panel', 'layers:read'],
    commands: [
      { id: 'hijack-undo', label: 'Hijack Undo', suggestedShortcut: 'Ctrl+KeyZ' },
      { id: 'hijack-browser', label: 'Hijack Close Tab', suggestedShortcut: 'Ctrl+KeyW' },
      { id: 'safe-cmd', label: 'Safe Cmd', suggestedShortcut: 'Shift+Alt+KeyG' },
    ],
    panels: [
      {
        id: 'main-panel',
        title: 'Main Panel',
        fields: [
          { kind: 'section', key: 'sec1', label: 'Setup' },
          { kind: 'text', key: 'info', text: 'Ready' },
          { kind: 'range', key: 'thickness', label: 'Thickness', initial: 4, min: 1, max: 32, step: 1, unit: 'px' },
          { kind: 'number', key: 'seed', label: 'Seed', initial: 7, min: 0, max: 100 },
          { kind: 'toggle', key: 'advanced', label: 'Advanced', initial: false },
          { kind: 'select', key: 'mode', label: 'Mode', initial: 'soft', options: [{ value: 'soft', label: 'Soft' }, { value: 'hard', label: 'Hard' }] },
          { kind: 'color', key: 'tint', label: 'Tint', initial: '#62c5df' },
          { kind: 'layer', key: 'target', label: 'Target Layer' },
          { kind: 'input', key: 'tag', label: 'Tag', initial: 'glow', maxLength: 10, when: { key: 'advanced', is: [true] } },
        ],
        actions: [{ id: 'apply', label: 'Apply', variant: 'primary' }],
      },
    ],
    script: 'async function onCommand() {} async function onPanelAction() {}',
  }) as PluginManifestV2;

  const pluginB = parsePlugin({
    apiVersion: 2,
    id: 'lumina.shortcut-b',
    name: 'Shortcut B',
    version: '1.0.0',
    author: 'Lumina Drift',
    description: 'Shortcut anti-hijack test B',
    permissions: ['commands'],
    commands: [
      { id: 'dup-cmd', label: 'Dup Cmd', suggestedShortcut: 'Alt+Shift+KeyG' },
    ],
    script: 'async function onCommand() {}',
  }) as PluginManifestV2;

  mgr.syncPluginShortcuts(
    [
      { manifest: pluginA, enabled: true, installedAt: 1 },
      { manifest: pluginB, enabled: true, installedAt: 2 },
    ],
    'zh-TW',
  );

  // Built-in undo shortcut stays untouched; conflicting/reserved plugin suggestions degrade to unbound ''
  assert.equal(mgr.getComboForAction('action_undo'), 'Control+KeyZ', 'Built-in undo shortcut must never be hijacked');
  assert.equal(mgr.getComboForAction(makePluginCommandShortcutId('lumina.shortcut-a', 'hijack-undo')), '', 'Conflicting suggestedShortcut degrades to unbound');
  assert.equal(mgr.getComboForAction(makePluginCommandShortcutId('lumina.shortcut-a', 'hijack-browser')), '', 'Browser-reserved suggestedShortcut degrades to unbound');
  assert.equal(mgr.getComboForAction(makePluginCommandShortcutId('lumina.shortcut-a', 'safe-cmd')), 'Alt+Shift+KeyG', 'Non-conflicting suggestedShortcut accepted');
  assert.equal(mgr.getComboForAction(makePluginCommandShortcutId('lumina.shortcut-b', 'dup-cmd')), '', 'Second plugin colliding with first degrades to unbound');

  // User customization & explicit clear persist across disable/re-enable
  const safeId = makePluginCommandShortcutId('lumina.shortcut-a', 'safe-cmd');
  mgr.setShortcut(safeId, 'Alt+Shift+KeyQ');
  assert.equal(mgr.getComboForAction(safeId), 'Alt+Shift+KeyQ');
  mgr.syncPluginShortcuts([{ manifest: pluginA, enabled: false, installedAt: 1 }], 'zh-TW');
  assert.equal(mgr.getPluginShortcuts().length, 0);
  mgr.syncPluginShortcuts([{ manifest: pluginA, enabled: true, installedAt: 1 }], 'zh-TW');
  assert.equal(mgr.getComboForAction(safeId), 'Alt+Shift+KeyQ', 'User custom plugin shortcut persists across re-enable');
  mgr.setShortcut(safeId, '');
  assert.equal(mgr.getComboForAction(safeId), '', 'User can clear a plugin shortcut');

  // Cleanup plugin shortcuts so global singleton stays clean
  mgr.syncPluginShortcuts([], 'zh-TW');

  // Declarative panel values, layer skipping groups, when condition, and patchValues clamping
  const panelDecl = pluginA.panels[0];
  const sampleLayers: LayerModel[] = [
    {
      id: 'g1', canvasId: 'c1', ownerId: 'u1', parentId: null, name: 'Folder',
      layerType: 'group', blendMode: 'normal', opacity: 1, isVisible: true, isLocked: false,
      alphaLocked: false, clipToBelow: false, isPublic: false, aclMode: 'owner_only',
      sortOrder: 0, createdAt: 1, updatedAt: 1,
    },
    {
      id: 'r1', canvasId: 'c1', ownerId: 'u1', parentId: null, name: 'Ink',
      layerType: 'raster', blendMode: 'normal', opacity: 1, isVisible: true, isLocked: false,
      alphaLocked: false, clipToBelow: false, isPublic: false, aclMode: 'owner_only',
      sortOrder: 1, createdAt: 1, updatedAt: 1,
    },
  ];
  const initVals = buildInitialPanelValues(panelDecl, sampleLayers, 'g1');
  assert.equal(initVals.target, 'r1', 'Layer field skips group layers when allowGroup is false');
  assert.equal(initVals.thickness, 4);
  const tagField = panelDecl.fields.find((f) => f.key === 'tag')!;
  assert.equal(isPluginPanelFieldVisible(tagField, initVals), false, 'when condition hides field initially');
  const patched = applyPanelPatchValues(panelDecl, initVals, {
    thickness: 999,
    seed: -5,
    advanced: true,
    mode: 'invalid_option',
    tint: '#AABBCC',
    tag: '0123456789ABCDEF',
    unknownKey: 'ignored',
  });
  assert.equal(patched.thickness, 32, 'range patched value clamped to max');
  assert.equal(patched.seed, 0, 'number patched value clamped to min');
  assert.equal(patched.mode, 'soft', 'invalid select option rejected');
  assert.equal(patched.tint, '#aabbcc', 'color normalized to lowercase');
  assert.equal(patched.tag, '0123456789', 'input clamped to maxLength');
  assert.equal('unknownKey' in patched, false, 'unknown patch key ignored');
  assert.equal(isPluginPanelFieldVisible(tagField, patched), true, 'when condition reveals field after toggle');
})();

// Plugin API v2.0 Batch 7: Validate shipped original v2 sample plugin end-to-end
await (async () => {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const kitPath = resolve(scriptDir, '../public/plugins/lumina-drift-studio-kit.lumina-plugin');
  const rawBytes = readFileSync(kitPath);
  assert.ok(rawBytes.byteLength <= PLUGIN_LIMITS.maxPackageBytesV2, 'v2 sample kit must fit within 256 KiB limit');
  const kit = parsePlugin(JSON.parse(rawBytes.toString('utf8'))) as PluginManifestV2;
  assert.equal(kit.apiVersion, 2);
  assert.equal(kit.id, 'lumina.drift-studio-kit');
  assert.equal(kit.commands.length, 2);
  assert.equal(kit.filters.length, 2);
  assert.equal(kit.panels.length, 1);
  assert.ok(kit.filters.some((f) => f.group === 'plugin'), 'v2 sample includes a dedicated plugin-group filter');
  assert.ok(kit.filters.some((f) => f.group === 'color'), 'v2 sample includes an existing-group filter with puzzle badge');

  // Execute both filters from the shipped kit in QuickJS tiled filter engine
  const W = 64;
  const H = 64;
  const samplePixels = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      samplePixels[i] = (x * 4) & 255;
      samplePixels[i + 1] = (y * 4) & 255;
      samplePixels[i + 2] = 180;
      samplePixels[i + 3] = 255;
    }
  }
  const prismRes = await runPluginFilterTiled({
    script: kit.script,
    filterId: 'drift-prism',
    pixels: samplePixels,
    width: W,
    height: H,
    params: { shift: 2, mix: 80 },
    tilePadding: 4,
    previewOnly: true,
  });
  assert.equal(prismRes.cancelled, false);
  assert.ok(prismRes.output && prismRes.output.some((v, idx) => v !== samplePixels[idx]), 'drift-prism transforms pixels');

  const auroraRes = await runPluginFilterTiled({
    script: kit.script,
    filterId: 'aurora-duotone',
    pixels: samplePixels,
    width: W,
    height: H,
    params: { shadow: '#1a2240', highlight: '#7ef9ff', mix: 80 },
    tilePadding: 0,
    previewOnly: false,
  });
  assert.equal(auroraRes.cancelled, false);
  assert.ok(auroraRes.output && auroraRes.output.some((v, idx) => v !== samplePixels[idx]), 'aurora-duotone transforms pixels');

  // Execute halo-frame command and panel reset/apply actions with single-groupId undo
  const sel = createHeadlessSelectionBridge(W, H);
  const layers: LayerModel[] = [
    {
      id: 'base', canvasId: 'c1', ownerId: 'u1', parentId: null, name: 'Paint',
      layerType: 'raster', blendMode: 'normal', opacity: 1, isVisible: true, isLocked: false,
      alphaLocked: false, clipToBelow: false, isPublic: false, aclMode: 'owner_only',
      sortOrder: 0, createdAt: 1, updatedAt: 1,
    },
  ];
  const tileStore = new Map<string, Uint8Array>([['base', new Uint8Array(W * H * 4)]]);
  const undo = new ScopedUndoManager();
  let seq = 1;
  const adapter: PluginCanvasHostAdapter = {
    canvasWidth: W,
    canvasHeight: H,
    tileSize: W,
    acl: { user: { id: 'u1', username: 'u1', displayName: 'U1', serverRole: 'user' }, isGuest: false, canvasMember: null },
    getLayers: () => [...layers],
    getActiveLayerId: () => 'base',
    setActiveLayer: () => {},
    createLayer: async (opts) => {
      const created: LayerModel = {
        id: `gen-${seq++}`, canvasId: 'c1', ownerId: 'u1', parentId: opts.parentId ?? null,
        name: opts.name, layerType: opts.layerType ?? 'raster', blendMode: opts.blendMode ?? 'normal',
        opacity: opts.opacity ?? 1, isVisible: true, isLocked: false, alphaLocked: false,
        clipToBelow: false, isPublic: false, aclMode: 'owner_only', sortOrder: layers.length,
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      layers.push(created);
      tileStore.set(created.id, new Uint8Array(W * H * 4));
      return created;
    },
    updateLayerProps: async () => {},
    reorderLayers: async () => {},
    deleteLayer: async (id) => {
      const idx = layers.findIndex((l) => l.id === id);
      if (idx === -1) return false;
      layers.splice(idx, 1);
      tileStore.delete(id);
      return true;
    },
    restoreDeletedLayer: async (layer) => {
      layers.push(layer);
      tileStore.set(layer.id, new Uint8Array(W * H * 4));
      return layer;
    },
    getOccupiedTiles: () => [{ col: 0, row: 0 }],
    readLayerTile: async (id) => (tileStore.get(id) ?? new Uint8Array(W * H * 4)).slice(),
    readLayerRect: async (id, rect) => {
      const buf = tileStore.get(id) ?? new Uint8Array(W * H * 4);
      const out = new Uint8Array(rect.width * rect.height * 4);
      for (let y = 0; y < rect.height; y++) {
        const src = ((rect.y + y) * W + rect.x) * 4;
        out.set(buf.subarray(src, src + rect.width * 4), y * rect.width * 4);
      }
      return out;
    },
    readCompositeRect: async (rect) => new Uint8Array(rect.width * rect.height * 4),
    applyLayerTiles: (id, tiles) => {
      if (tiles[0]) tileStore.set(id, (tiles[0].data as Uint8Array).slice());
    },
    commitTilePatch: () => {},
    pushUndoOp: (op) => undo.push(op),
    selection: sel,
  };

  // Run panel reset action
  const txReset = new PluginCanvasTransaction(adapter);
  const resetOut = await startPluginV2Direct(
    kit,
    { kind: 'panel', panelId: 'drift-workshop', actionId: 'reset', values: {} },
    { width: W, height: H, dpi: 300 },
    txReset.createRpcHandler(),
  ).promise;
  assert.equal(resetOut.patchValues?.thickness, 6);
  assert.ok(resetOut.statusText);
  await txReset.rollback();

  // Run panel apply action -> creates new glow layer + writes pixels + sets selection in one groupId
  const txApply = new PluginCanvasTransaction(adapter);
  const applyOut = await startPluginV2Direct(
    kit,
    {
      kind: 'panel',
      panelId: 'drift-workshop',
      actionId: 'apply',
      values: { targetLayer: 'base', thickness: 4, inset: 2, color: '#62c5df', style: 'soft', newLayer: true, layerName: 'My Glow' },
    },
    { width: W, height: H, dpi: 300 },
    txApply.createRpcHandler(),
  ).promise;
  txApply.commit('Drift Glow Lab');
  assert.ok(applyOut.notice);
  assert.equal(layers.length, 2, 'Panel apply created new glow layer');
  const glowBuf = tileStore.get(layers[1].id)!;
  assert.ok(glowBuf.some((v) => v > 0), 'Glow frame pixels written');
  const undoOps = undo.undoGroup('u1');
  assert.ok(undoOps.length >= 2, 'Single undoGroup covers layer creation, pixels, and selection');
  assert.ok(new Set(undoOps.map((o) => o.groupId)).size === 1, 'All ops share one groupId');
})();

// --- Room member role management authorization (canManageCanvasMemberRole) ---
(() => {
  const serverAdmin = { userId: 'u-sadmin', serverRole: 'admin' as const, canvasRole: 'editor' as const };
  const otherServerAdmin = { userId: 'u-sadmin-2', serverRole: 'admin' as const, canvasRole: 'editor' as const };
  const owner = { userId: 'u-owner', serverRole: 'member' as const, canvasRole: 'owner' as const, isCanvasOwner: true };
  const canvasAdmin = { userId: 'u-cadmin', serverRole: 'member' as const, canvasRole: 'admin' as const };
  const otherCanvasAdmin = { userId: 'u-cadmin-2', serverRole: 'member' as const, canvasRole: 'admin' as const };
  const editor = { userId: 'u-editor', serverRole: 'member' as const, canvasRole: 'editor' as const };
  const viewer = { userId: 'u-viewer', serverRole: 'member' as const, canvasRole: 'viewer' as const };
  const publicVisitor = { userId: 'u-visitor', serverRole: 'member' as const, canvasRole: undefined };
  const guest = { userId: 'guest_abc', serverRole: 'guest' as const, isGuest: true };

  // Self cannot be modified
  for (const actor of [serverAdmin, owner, canvasAdmin, editor, viewer]) {
    const res = canManageCanvasMemberRole(actor, actor, 'editor');
    assert.equal(res.allowed, false);
    assert.equal(res.reason, 'cannot_modify_self');
    assert.deepEqual(res.allowedRoles, []);
  }

  // Guests cannot be modified by anyone
  for (const actor of [serverAdmin, owner, canvasAdmin]) {
    assert.equal(canManageCanvasMemberRole(actor, guest).reason, 'cannot_modify_guest');
    assert.equal(
      canManageCanvasMemberRole(actor, { userId: 'u-g', serverRole: 'guest' }, 'viewer').reason,
      'cannot_modify_guest'
    );
    assert.equal(
      canManageCanvasMemberRole(actor, { userId: 'guest_999', serverRole: 'member' }, 'viewer').reason,
      'cannot_modify_guest'
    );
  }

  // Owner cannot be modified even by serverAdmin
  assert.equal(canManageCanvasMemberRole(serverAdmin, owner).reason, 'cannot_modify_owner');
  assert.equal(canManageCanvasMemberRole(serverAdmin, owner, 'admin').reason, 'cannot_modify_owner');
  assert.equal(
    canManageCanvasMemberRole(serverAdmin, { userId: 'u-owner-flag', serverRole: 'member', isCanvasOwner: true }).reason,
    'cannot_modify_owner'
  );
  assert.equal(canManageCanvasMemberRole(canvasAdmin, owner, 'viewer').reason, 'cannot_modify_owner');

  // ServerAdmin cannot be modified even by owner or another serverAdmin
  assert.equal(canManageCanvasMemberRole(owner, serverAdmin).reason, 'cannot_modify_server_admin');
  assert.equal(canManageCanvasMemberRole(otherServerAdmin, serverAdmin, 'viewer').reason, 'cannot_modify_server_admin');
  assert.equal(canManageCanvasMemberRole(canvasAdmin, serverAdmin, 'viewer').reason, 'cannot_modify_server_admin');

  // ServerAdmin & Owner can assign admin / editor / viewer to canvasAdmin, editor, viewer, publicVisitor
  for (const actor of [serverAdmin, owner]) {
    for (const target of [canvasAdmin, editor, viewer, publicVisitor]) {
      const inspect = canManageCanvasMemberRole(actor, target);
      assert.equal(inspect.allowed, true);
      assert.deepEqual(inspect.allowedRoles, ['admin', 'editor', 'viewer']);
      assert.equal(canManageCanvasMemberRole(actor, target, 'admin').allowed, true);
      assert.equal(canManageCanvasMemberRole(actor, target, 'editor').allowed, true);
      assert.equal(canManageCanvasMemberRole(actor, target, 'viewer').allowed, true);
      const toOwner = canManageCanvasMemberRole(actor, target, 'owner');
      assert.equal(toOwner.allowed, false);
      assert.equal(toOwner.reason, 'invalid_target_role');
    }
  }

  // Canvas admin can assign editor / viewer to regular members, but not admin/owner and not other canvas admins
  for (const target of [editor, viewer, publicVisitor]) {
    const inspect = canManageCanvasMemberRole(canvasAdmin, target);
    assert.equal(inspect.allowed, true);
    assert.deepEqual(inspect.allowedRoles, ['editor', 'viewer']);
    assert.equal(canManageCanvasMemberRole(canvasAdmin, target, 'editor').allowed, true);
    assert.equal(canManageCanvasMemberRole(canvasAdmin, target, 'viewer').allowed, true);
    const toAdmin = canManageCanvasMemberRole(canvasAdmin, target, 'admin');
    assert.equal(toAdmin.allowed, false);
    assert.equal(toAdmin.reason, 'insufficient_permission');
    const toOwner = canManageCanvasMemberRole(canvasAdmin, target, 'owner');
    assert.equal(toOwner.allowed, false);
    assert.equal(toOwner.reason, 'invalid_target_role');
  }
  const peerAdminRes = canManageCanvasMemberRole(canvasAdmin, otherCanvasAdmin, 'editor');
  assert.equal(peerAdminRes.allowed, false);
  assert.equal(peerAdminRes.reason, 'cannot_modify_canvas_admin');

  // Editor, viewer, guest cannot manage anyone
  for (const actor of [editor, viewer, guest]) {
    const res = canManageCanvasMemberRole(actor, publicVisitor, 'viewer');
    assert.equal(res.allowed, false);
    assert.equal(res.reason, 'insufficient_permission');
  }

  // isAssignableCanvasRole & capability flags
  assert.equal(isAssignableCanvasRole('admin'), true);
  assert.equal(isAssignableCanvasRole('editor'), true);
  assert.equal(isAssignableCanvasRole('viewer'), true);
  assert.equal(isAssignableCanvasRole('owner'), false);
  assert.equal(isAssignableCanvasRole('superadmin'), false);

  assert.deepEqual(getCanvasRoleCapabilities('owner'), {
    canCreateLayer: true, canDeleteOtherLayer: true, canExport: true, canManageMembers: true,
  });
  assert.deepEqual(getCanvasRoleCapabilities('admin'), {
    canCreateLayer: true, canDeleteOtherLayer: true, canExport: true, canManageMembers: true,
  });
  assert.deepEqual(getCanvasRoleCapabilities('editor'), {
    canCreateLayer: true, canDeleteOtherLayer: false, canExport: true, canManageMembers: false,
  });
  assert.deepEqual(getCanvasRoleCapabilities('viewer'), {
    canCreateLayer: false, canDeleteOtherLayer: false, canExport: true, canManageMembers: false,
  });
})();

// --- Animation Phase D: D1 sequence naming/range, D3 region crop, D4 cel naming/binarize/TGA/BMP ---
(() => {
  // D3: resolveExportRegion (no camera -> full canvas; with camera -> camera rect)
  assert.deepEqual(resolveExportRegion(1920, 1080, null), { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(resolveExportRegion(1920, 1080, { x: 120.4, y: 80.6, width: 1280.2, height: 720.4 }), {
    x: 120, y: 81, width: 1280, height: 720,
  });

  // Scaling with aspect ratio lock
  assert.deepEqual(computeScaledExportDimensions(1920, 1080, { scalePercent: 50 }), { width: 960, height: 540 });
  assert.deepEqual(computeScaledExportDimensions(1920, 1080, { targetWidth: 1280, lockAspect: true }), { width: 1280, height: 720 });
  assert.deepEqual(computeScaledExportDimensions(1920, 1080, { targetHeight: 540, lockAspect: true }), { width: 960, height: 540 });

  // D1: filename formatting and sanitization
  assert.equal(
    formatSequenceFileName(0, { prefix: 'cut01', suffix: 'line', separator: '_', startNumber: 1, zeroPad: 4 }),
    'cut01_0001_line.png'
  );
  assert.equal(
    formatSequenceFileName(11, { prefix: '', suffix: '', separator: '-', startNumber: 0, zeroPad: 3 }),
    '011.png'
  );
  assert.equal(sanitizeFileNameSegment('CON'), '_CON');
  assert.equal(sanitizeFileNameSegment('a/b:c*d?'), 'a_b_c_d_');

  // D1: range resolution using parseTimecode ("s+f" and plain frames)
  const rAll = resolveExportFrameRange(36, { mode: 'all', fps: 12 });
  assert.deepEqual(rAll, { start: 0, end: 35, frameCount: 36, valid: true });
  const rCustom = resolveExportFrameRange(36, { mode: 'custom', customStartText: '1+1', customEndText: '2+6', fps: 12 });
  assert.deepEqual(rCustom, { start: 12, end: 29, frameCount: 18, valid: true });
  const rBad = resolveExportFrameRange(36, { mode: 'custom', customStartText: '2+1', customEndText: '1+1', fps: 12 });
  assert.equal(rBad.valid, false);

  // D1: every-frame vs distinct-frames planning
  const segs = [{ time: 0, hold: 3 }, { time: 3, hold: 2 }];
  const expanded = planSequenceFrames(segs, 'every-frame');
  assert.equal(expanded.length, 5);
  assert.deepEqual(expanded.map((f) => f.sourceTime), [0, 0, 0, 3, 3]);
  assert.deepEqual(expanded.map((f) => f.timelineFrame), [0, 1, 2, 3, 4]);
  const distinct = planSequenceFrames(segs, 'distinct-frames');
  assert.equal(distinct.length, 2);
  assert.deepEqual(distinct.map((f) => f.sourceTime), [0, 3]);

  // D4: per-cel naming and case-insensitive collision deduplication
  const used = new Set<string>();
  assert.equal(
    formatCelFileName('A', '01', { mode: 'folder-cel', prefix: 's01', suffix: '', separator: '_', extension: 'png' }, used),
    's01_A_01.png'
  );
  assert.equal(
    formatCelFileName('a', '01', { mode: 'folder-cel', prefix: 's01', suffix: '', separator: '_', extension: 'png' }, used),
    's01_a_01_2.png'
  );
  assert.equal(
    formatCelFileName('A', '01', { mode: 'cel-only', prefix: '', suffix: 'clean', separator: '-', extension: 'tga' }),
    '01-clean.tga'
  );

  // D4: binarization guarantees zero intermediate colors across anti-aliased black + red + blue pixels
  const srcRgba = new Uint8ClampedArray([
    0, 0, 0, 255,         // solid black
    110, 110, 110, 255,   // anti-aliased gray (should snap to black)
    240, 240, 240, 255,   // faint halo (should become background)
    255, 0, 0, 255,       // solid red
    255, 130, 130, 255,   // anti-aliased red (should snap to red)
    0, 0, 255, 180,       // semi-transparent blue (should snap to blue)
    255, 255, 255, 0,     // fully transparent (should become background)
  ]);
  const rules = DEFAULT_LINE_COLOR_RULES.map((r) =>
    r.id === 'black' || r.id === 'red' || r.id === 'blue' ? { ...r, enabled: true, threshold: 180 } : r
  );
  const binWhite = binarizeLineArt(srcRgba, 7, 1, { enabled: true, rules, background: 'white' });
  const allowedWhite = new Set(['0,0,0,255', '255,0,0,255', '0,0,255,255', '255,255,255,255']);
  const outKeysWhite: string[] = [];
  for (let i = 0; i < 7; i++) {
    const key = `${binWhite[i * 4]},${binWhite[i * 4 + 1]},${binWhite[i * 4 + 2]},${binWhite[i * 4 + 3]}`;
    assert.equal(allowedWhite.has(key), true, `unexpected intermediate pixel ${key}`);
    outKeysWhite.push(key);
  }
  assert.deepEqual(outKeysWhite, [
    '0,0,0,255',
    '0,0,0,255',
    '255,255,255,255',
    '255,0,0,255',
    '255,0,0,255',
    '0,0,255,255',
    '255,255,255,255',
  ]);

  const binTrans = binarizeLineArt(srcRgba, 7, 1, { enabled: true, rules, background: 'transparent' });
  assert.equal(binTrans[2 * 4 + 3], 0);
  assert.equal(binTrans[6 * 4 + 3], 0);
  assert.equal(binTrans[3 * 4], 255);
  assert.equal(binTrans[3 * 4 + 3], 255);

  // D4: TGA (24-bit & 32-bit) and BMP (24-bit) encoders
  const img2x2 = new Uint8ClampedArray([
    255, 0, 0, 255,     0, 255, 0, 255,
    0, 0, 255, 255,     0, 0, 0, 0,
  ]);
  const tga24 = encodeTga(img2x2, 2, 2, 24);
  assert.equal(tga24.length, 18 + 2 * 2 * 3);
  assert.equal(tga24[2], 2);
  assert.equal(tga24[12], 2);
  assert.equal(tga24[14], 2);
  assert.equal(tga24[16], 24);
  assert.equal(tga24[17], 0x20);
  // First pixel red (255,0,0) -> BGR (0,0,255)
  assert.deepEqual(Array.from(tga24.slice(18, 21)), [0, 0, 255]);
  // Transparent pixel composited onto white -> BGR (255,255,255)
  assert.deepEqual(Array.from(tga24.slice(27, 30)), [255, 255, 255]);

  const tga32 = encodeTga(img2x2, 2, 2, 32);
  assert.equal(tga32.length, 18 + 2 * 2 * 4);
  assert.equal(tga32[16], 32);
  assert.equal(tga32[17], 0x28);
  assert.deepEqual(Array.from(tga32.slice(30, 34)), [0, 0, 0, 0]);

  // 2x2 24-bit BMP: rowStride = ceil(6/4)*4 = 8 bytes -> 54 + 16 = 70 bytes
  const bmp24 = encodeBmp24(img2x2, 2, 2);
  assert.equal(bmp24.length, 70);
  assert.equal(bmp24[0], 0x42);
  assert.equal(bmp24[1], 0x4d);
  // Bottom row in BMP is y=1 of source: (0,0,255) blue -> BGR (255,0,0), then transparent -> white (255,255,255)
  assert.deepEqual(Array.from(bmp24.slice(54, 60)), [255, 0, 0, 255, 255, 255]);
  // Top row in BMP is y=0 of source: (255,0,0) red -> BGR (0,0,255), then green -> BGR (0,255,0)
  assert.deepEqual(Array.from(bmp24.slice(62, 68)), [0, 0, 255, 0, 255, 0]);

  // D2: WebCodecs offline candidate selection & zero-drift CFR timestamp math
  const c4k = buildWebCodecsCandidates(3840, 2160, 'mp4', '4k');
  assert.equal(c4k[0].container, 'mp4');
  assert.equal(c4k[0].webCodecsCodec, 'avc1.640033'); // Level 5.1 for 4K
  assert.equal(c4k.some((c) => c.container === 'webm' && c.muxerCodec === 'V_VP9'), true);
  const c1080 = buildWebCodecsCandidates(1920, 1080, 'mp4', '1080p');
  assert.equal(c1080[0].webCodecsCodec, 'avc1.640028'); // Level 4.0 for 1080p
  assert.equal(c1080.every((c) => c.width % 2 === 0 && c.height % 2 === 0), true);
  const cWebm = buildWebCodecsCandidates(1280, 720, 'webm', '1080p');
  assert.equal(cWebm[0].container, 'webm');
  assert.equal(cWebm[0].muxerCodec, 'V_VP9');

  // 144 frames @ 12 FPS = exact 12_000_000 us with zero cumulative drift
  let sumDur = 0;
  for (let f = 0; f < 144; f++) {
    sumDur += computeFrameDurationUs(f, 1, 12);
  }
  assert.equal(sumDur, 12_000_000);
  assert.equal(computeFrameTimestampUs(144, 12), 12_000_000);
})();

// Brush Engine v2: dynamics evaluators, ABR v6 desc/samp parser, and SUT SQLite3 Variant/Effector parser
(() => {
  // 1. Dynamic channel evaluation
  const opDyn = { pressure: true, min: 0.25 };
  assert.ok(Math.abs(evaluateDynamicChannel(opDyn, { pressure: 0, tilt: 0, velocity: 0, rand: 0 }) - 0.25) < 1e-6);
  assert.ok(Math.abs(evaluateDynamicChannel(opDyn, { pressure: 0.5, tilt: 0, velocity: 0, rand: 0 }) - 0.625) < 1e-6);
  assert.ok(Math.abs(evaluateDynamicChannel(opDyn, { pressure: 1, tilt: 0, velocity: 0, rand: 0 }) - 1) < 1e-6);
  // Disabled channel returns fallback 1
  assert.equal(evaluateDynamicChannel({ pressure: false, min: 0.1 }, { pressure: 0.1, tilt: 0, velocity: 0, rand: 0.5 }), 1);
  // Velocity inverted: fast stroke decreases value
  const velDyn = { velocity: true, velocityInvert: true, min: 0.2 };
  assert.ok(evaluateDynamicChannel(velDyn, { pressure: 1, tilt: 0, velocity: 1, rand: 0 }) < 0.25);
  assert.ok(evaluateDynamicChannel(velDyn, { pressure: 1, tilt: 0, velocity: 0, rand: 0 }) > 0.95);
  // Angle jitter & fg/bg mix
  assert.ok(Math.abs(evaluateAngleJitterRadians({ random: 1 }, { pressure: 1, tilt: 0, velocity: 0, rand: 1 }) - Math.PI) < 1e-6);
  assert.ok(Math.abs(evaluateFgBgMixRatio(0.8, { pressure: true }, { pressure: 0.5, tilt: 0, velocity: 0, rand: 0 }) - 0.4) < 1e-6);
  // Default dynamics resolution & normalization
  const penDefaults = resolveDefaultBrushDynamics({ brushType: 'pen', hardness: 1, flow: 1, size: 20, minSize: 4 });
  assert.equal(penDefaults.size?.pressure, true);
  assert.equal(penDefaults.opacity?.pressure, false);
  const paintDefaults = resolveDefaultBrushDynamics({ brushType: 'brush', hardness: 0.6, flow: 0.85, size: 40, minSize: 10 });
  assert.equal(paintDefaults.opacity?.pressure, true);
  const norm = normalizeBrushDynamics({ opacity: { pressure: true, min: 1.5, random: -0.2 } });
  assert.equal(norm?.opacity?.min, 1);
  assert.equal(norm?.opacity?.random, 0);

  // 2. Synthetic ABR v6 binary with `samp` (UUID + 4x4 tip) + `desc` (Action Descriptor preset)
  const chunks: number[] = [];
  const pushU16 = (v: number) => chunks.push((v >> 8) & 0xff, v & 0xff);
  const pushU32 = (v: number) => chunks.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const pushF64 = (v: number) => {
    const b = new ArrayBuffer(8);
    new DataView(b).setFloat64(0, v, false);
    chunks.push(...new Uint8Array(b));
  };
  const pushAscii = (s: string) => { for (let i = 0; i < s.length; i++) chunks.push(s.charCodeAt(i)); };
  const pushUni = (s: string) => {
    pushU32(s.length + 1);
    for (let i = 0; i < s.length; i++) pushU16(s.charCodeAt(i));
    pushU16(0);
  };
  const pushId = (id: string) => {
    if (id.length === 4) { pushU32(0); pushAscii(id); }
    else { pushU32(id.length); pushAscii(id); }
  };

  // Header: version 6, subversion 1
  pushU16(6); pushU16(1);
  // Build `samp` section with 1 sample (UUID + 4x4 raw grayscale)
  const uuid = '11111111-2222-3333-4444-555555555555';
  const sampPayload: number[] = [];
  const recBytes: number[] = [];
  recBytes.push(uuid.length, ...Array.from(uuid, (c) => c.charCodeAt(0))); // 37 bytes
  for (let i = 0; i < 10; i++) recBytes.push(0); // subversion 1 extra header = 10 bytes
  // Rect top=0, left=0, bottom=4, right=4; depth=8, compression=0
  const rectBuf = new ArrayBuffer(19);
  const rv = new DataView(rectBuf);
  rv.setInt32(0, 0, false); rv.setInt32(4, 0, false); rv.setInt32(8, 4, false); rv.setInt32(12, 4, false);
  rv.setUint16(16, 8, false); rv.setUint8(18, 0);
  recBytes.push(...new Uint8Array(rectBuf));
  for (let i = 0; i < 16; i++) recBytes.push(i === 5 || i === 6 || i === 9 || i === 10 ? 255 : 0);
  const recLenBuf = new ArrayBuffer(4);
  new DataView(recLenBuf).setUint32(0, recBytes.length, false);
  sampPayload.push(...new Uint8Array(recLenBuf), ...recBytes);
  while (sampPayload.length % 4 !== 0) sampPayload.push(0);
  pushAscii('8BIMsamp'); pushU32(sampPayload.length); chunks.push(...sampPayload);

  // Build `desc` section (Action Descriptor v16 -> root Objc -> Brsh VlLs -> 1 preset Objc)
  const descStartLen = chunks.length;
  pushAscii('8BIMdesc');
  const descLenPos = chunks.length;
  pushU32(0); // placeholder
  const descBodyStart = chunks.length;
  pushU32(16); // descriptor version
  pushUni(''); pushId('null'); pushU32(1); // root object: 1 key ('Brsh')
  pushId('Brsh'); pushAscii('VlLs'); pushU32(1); // 1 preset
  pushAscii('Objc'); pushUni(''); pushId('Brsh'); pushU32(7); // 7 keys on preset
  // 1. Nm
  pushId('Nm  '); pushAscii('TEXT'); pushUni('Soft Wash ABR');
  // 2. Brsh
  pushId('Brsh'); pushAscii('Objc'); pushUni(''); pushId('sampledBrush'); pushU32(5);
  pushId('Dmtr'); pushAscii('UntF'); pushAscii('#Pxl'); pushF64(48);
  pushId('Hrdn'); pushAscii('UntF'); pushAscii('#Prc'); pushF64(60);
  pushId('Spcn'); pushAscii('UntF'); pushAscii('#Prc'); pushF64(25);
  pushId('Rndn'); pushAscii('UntF'); pushAscii('#Prc'); pushF64(75);
  pushId('sampledData'); pushAscii('TEXT'); pushUni(uuid);
  // 3. useTipDynamics + szVr
  pushId('useTipDynamics'); pushAscii('bool'); chunks.push(1);
  pushId('szVr'); pushAscii('Objc'); pushUni(''); pushId('brVr'); pushU32(3);
  pushId('bVTy'); pushAscii('long'); pushU32(2); // pen pressure
  pushId('jitter'); pushAscii('UntF'); pushAscii('#Prc'); pushF64(15);
  pushId('Mnm '); pushAscii('UntF'); pushAscii('#Prc'); pushF64(20);
  // 4. usePaintDynamics + opVr
  pushId('usePaintDynamics'); pushAscii('bool'); chunks.push(1);
  pushId('opVr'); pushAscii('Objc'); pushUni(''); pushId('brVr'); pushU32(3);
  pushId('bVTy'); pushAscii('long'); pushU32(2); // pen pressure
  pushId('jitter'); pushAscii('UntF'); pushAscii('#Prc'); pushF64(10);
  pushId('Mnm '); pushAscii('UntF'); pushAscii('#Prc'); pushF64(30);
  // 5. wetEdges
  pushId('wetEdges'); pushAscii('bool'); chunks.push(1);
  const descBodyLen = chunks.length - descBodyStart;
  chunks[descLenPos] = (descBodyLen >>> 24) & 0xff;
  chunks[descLenPos + 1] = (descBodyLen >>> 16) & 0xff;
  chunks[descLenPos + 2] = (descBodyLen >>> 8) & 0xff;
  chunks[descLenPos + 3] = descBodyLen & 0xff;
  assert.ok(descStartLen > 0);

  const abrParsed = new AbrParser(new Uint8Array(chunks)).parse();
  assert.equal(abrParsed.length, 1);
  assert.equal(abrParsed[0].name, 'Soft Wash ABR');
  assert.equal(abrParsed[0].size, 48);
  assert.ok(Math.abs((abrParsed[0].hardness ?? 0) - 0.6) < 1e-6);
  assert.ok(Math.abs((abrParsed[0].spacing ?? 0) - 0.25) < 1e-6);
  assert.ok(Math.abs((abrParsed[0].roundness ?? 0) - 0.75) < 1e-6);
  assert.equal(abrParsed[0].dynamics?.size?.pressure, true);
  assert.ok(Math.abs((abrParsed[0].dynamics?.size?.min ?? 0) - 0.2) < 1e-6);
  assert.equal(abrParsed[0].dynamics?.opacity?.pressure, true);
  assert.ok(Math.abs((abrParsed[0].dynamics?.opacity?.min ?? 0) - 0.3) < 1e-6);
  assert.equal(abrParsed[0].wetEdges, true);
  assert.ok(typeof abrParsed[0].dataUrl === 'string' && abrParsed[0].dataUrl.startsWith('data:image/'));

  // 3. Synthetic SQLite 3 SUT database (3 pages: sqlite_master, Node, Variant with Effectors)
  const pageSize = 512;
  const db = new Uint8Array(pageSize * 3);
  const dbView = new DataView(db.buffer);
  const magic = 'SQLite format 3\0';
  for (let i = 0; i < magic.length; i++) db[i] = magic.charCodeAt(i);
  dbView.setUint16(16, pageSize, false);
  db[18] = 1; db[19] = 1; db[21] = 64; db[22] = 32; db[23] = 32;
  dbView.setUint32(56, 1, false); // UTF-8

  const encVarint = (v: number): number[] => {
    if (v < 0x80) return [v];
    if (v < 0x4000) return [0x80 | ((v >> 7) & 0x7f), v & 0x7f];
    return [0x80 | ((v >> 14) & 0x7f), 0x80 | ((v >> 7) & 0x7f), v & 0x7f];
  };
  const encodeSqliteRecord = (vals: Array<null | number | string | Uint8Array>): Uint8Array => {
    const sts: number[] = [];
    const body: number[] = [];
    const utf8 = new TextEncoder();
    for (const v of vals) {
      if (v === null) {
        sts.push(0);
      } else if (typeof v === 'number') {
        if (v === 0) sts.push(8);
        else if (v === 1) sts.push(9);
        else if (Number.isInteger(v) && v >= -128 && v <= 127) { sts.push(1); body.push(v & 0xff); }
        else if (Number.isInteger(v) && v >= -32768 && v <= 32767) { sts.push(2); body.push((v >> 8) & 0xff, v & 0xff); }
        else {
          sts.push(7);
          const f = new ArrayBuffer(8);
          new DataView(f).setFloat64(0, v, false);
          body.push(...new Uint8Array(f));
        }
      } else if (typeof v === 'string') {
        const b = utf8.encode(v);
        sts.push(...encVarint(b.length * 2 + 13));
        body.push(...b);
      } else {
        sts.push(...encVarint(v.length * 2 + 12));
        body.push(...v);
      }
    }
    const hdrSize = sts.length + encVarint(sts.length + 1).length;
    const hdr = [...encVarint(hdrSize), ...sts];
    return new Uint8Array([...hdr, ...body]);
  };
  const writeLeafPage = (pageNum: number, rows: Array<{ rowId: number; values: Array<null | number | string | Uint8Array> }>) => {
    const pageStart = (pageNum - 1) * pageSize;
    const hdrStart = pageNum === 1 ? 100 : pageStart;
    db[hdrStart] = 0x0d; // leaf table B-tree
    dbView.setUint16(hdrStart + 3, rows.length, false);
    let contentEnd = pageSize;
    for (let i = 0; i < rows.length; i++) {
      const rec = encodeSqliteRecord(rows[i].values);
      const cell = new Uint8Array([...encVarint(rec.length), ...encVarint(rows[i].rowId), ...rec]);
      contentEnd -= cell.length;
      db.set(cell, pageStart + contentEnd);
      dbView.setUint16(hdrStart + 8 + i * 2, contentEnd, false);
    }
    dbView.setUint16(hdrStart + 5, contentEnd, false);
  };

  // Page 1: sqlite_master
  writeLeafPage(1, [
    { rowId: 1, values: ['table', 'Node', 'Node', 2, 'CREATE TABLE Node (_PW_ID INTEGER PRIMARY KEY, NodeName TEXT, NodeVariantID INTEGER)'] },
    { rowId: 2, values: ['table', 'Variant', 'Variant', 3, 'CREATE TABLE Variant (VariantID INTEGER PRIMARY KEY, BrushSize REAL, Opacity INTEGER, BrushMixColor INTEGER, BrushAmountOfPaint INTEGER, BrushColorStretch INTEGER, BrushSizeEffector BLOB, OpacityEffector BLOB)'] },
  ]);
  // Page 2: Node
  writeLeafPage(2, [
    { rowId: 1, values: [null, 'CSP Wet Mix Brush', 10] },
  ]);
  // Page 3: Variant with big-endian Effector blobs (pressure=0x01, tilt=0x02, min=25%)
  const mkEff = (flags: number, minPct: number) => {
    const b = new Uint8Array(12);
    const v = new DataView(b.buffer);
    v.setUint32(0, 4, false);
    v.setUint32(4, flags, false);
    v.setInt32(8, minPct, false);
    return b;
  };
  writeLeafPage(3, [
    { rowId: 10, values: [10, 36, 90, 1, 45, 70, mkEff(0x01 | 0x02, 15), mkEff(0x01, 25)] },
  ]);

  const reader = new SqliteReader(db);
  assert.deepEqual(reader.getTableNames().sort(), ['Node', 'Variant']);
  const effDecoded = parseSutEffectorBlob(mkEff(0x01 | 0x04, 20));
  assert.equal(effDecoded?.pressure, true);
  assert.equal(effDecoded?.velocity, true);
  assert.ok(Math.abs((effDecoded?.min ?? 0) - 0.2) < 1e-6);

  const sutParsed = new SutParser(db.buffer).parse();
  assert.equal(sutParsed.length, 1);
  assert.equal(sutParsed[0].name, 'CSP Wet Mix Brush');
  assert.equal(sutParsed[0].size, 36);
  assert.ok(Math.abs((sutParsed[0].opacity ?? 0) - 0.9) < 1e-6);
  assert.ok((sutParsed[0].colorMixing ?? 0) >= 0.7);
  assert.ok(Math.abs((sutParsed[0].paintAmount ?? 0) - 0.45) < 1e-6);
  assert.ok(Math.abs((sutParsed[0].colorStretch ?? 0) - 0.7) < 1e-6);
  assert.equal(sutParsed[0].dynamics?.size?.pressure, true);
  assert.equal(sutParsed[0].dynamics?.size?.tilt, true);
  assert.equal(sutParsed[0].dynamics?.opacity?.pressure, true);
  assert.ok(Math.abs((sutParsed[0].dynamics?.opacity?.min ?? 0) - 0.25) < 1e-6);
})();

// =========================================================================
// Plugin API v2.5 Batch 1 & 2: permissions, tools manifest, timeline/keyframes/easing RPC,
// brush v2 dynamics/mix, ACL batch rejection, single undo groupId, and tool pointer session
// =========================================================================
await (async () => {
  resetPluginEasingsForTests();

  // 1. 4-locale permission labels for all 4 new v2.5 permissions
  const v25Perms = ['timeline:read', 'timeline:write', 'tools', 'input'] as const;
  const locales: Language[] = ['en-US', 'zh-TW', 'zh-CN', 'ja-JP'];
  for (const loc of locales) {
    const lbl = getPluginLabels(loc);
    assert.ok(lbl.toolsBadge.length > 0);
    assert.ok(lbl.sampleV25.length > 0);
    for (const perm of v25Perms) {
      assert.ok(getPluginPermissionLabel(loc, perm).length > 0, `Missing ${perm} label for ${loc}`);
    }
  }

  // 2. Manifest parsing for tools declaration + permission enforcement
  const baseToolManifest = {
    apiVersion: 2,
    id: 'lumina.v25-test',
    name: 'V2.5 Test',
    version: '2.5.0',
    author: 'Lumina',
    description: 'Tests v2.5 tools and timeline APIs.',
    permissions: ['timeline:read', 'timeline:write', 'tools', 'input', 'layers:read', 'pixels:write', 'brush'],
    tools: [
      {
        id: 'spark-pen',
        label: 'Spark Pen',
        i18nLabel: { 'zh-TW': '星芒筆' },
        icon: 'sparkles',
        cursor: 'crosshair',
        suggestedShortcut: 'Alt+Shift+KeyS',
        throttleMs: 24,
        options: [
          { kind: 'range', key: 'radius', label: 'Radius', initial: 4, min: 1, max: 32, step: 1, unit: 'px' },
          { kind: 'color', key: 'glow', label: 'Glow', initial: '#38bdf8' },
        ],
      },
    ],
    script: 'async function onPointerDown() {}',
  };
  const parsedToolPlugin = parsePlugin(baseToolManifest) as PluginManifestV2;
  assert.equal(parsedToolPlugin.apiVersion, 2);
  assert.equal(parsedToolPlugin.tools?.length, 1);
  assert.equal(parsedToolPlugin.tools?.[0].id, 'spark-pen');
  assert.equal(parsedToolPlugin.tools?.[0].throttleMs, 24);

  // Declaring tools without "tools" permission must throw
  assert.throws(() => parsePlugin({
    ...baseToolManifest,
    permissions: ['input'],
  }));
  // Invalid tool icon / cursor / throttleMs must throw
  assert.throws(() => parsePlugin({
    ...baseToolManifest,
    tools: [{ id: 'bad', label: 'Bad', icon: 'invalid-icon' }],
  }));
  assert.throws(() => parsePlugin({
    ...baseToolManifest,
    tools: [{ id: 'bad', label: 'Bad', throttleMs: 5 }],
  }));

  // 3. Build an in-memory multi-user canvas adapter with animation folder + own layer + foreign layer
  const buildV25Host = (role: 'owner' | 'editor' | 'viewer' = 'owner', userId = 'u_owner') => {
    let curFrame = 0;
    let loop = true;
    let range: { start: number; end: number } | null = null;
    let brushState: PluginBrushState = {
      color: '#3b82f6',
      secondaryColor: '#ffffff',
      size: 20,
      opacity: 1,
      flow: 1,
      mixMode: 'blend',
      colorMixing: 0,
      paintAmount: 0.7,
      fgBgMix: 0,
      wetEdges: false,
      textureDensity: 0,
      dualBrush: false,
    };

    const layers: LayerModel[] = [
      {
        id: 'anim_folder',
        canvasId: 'c1',
        parentId: null,
        ownerId: 'u_owner',
        name: 'Anim Track',
        layerType: 'group',
        blendMode: 'normal',
        opacity: 1,
        isVisible: true,
        isLocked: false,
        sortOrder: 10,
        isPublic: false,
        aclMode: 'owner_only',
        createdAt: 1,
        meta: { animation: { fps: 12, length: 24, shared: false } },
      },
      {
        id: 'cel_own',
        canvasId: 'c1',
        parentId: 'anim_folder',
        ownerId: 'u_owner',
        name: '1',
        layerType: 'raster',
        blendMode: 'normal',
        opacity: 1,
        isVisible: true,
        isLocked: false,
        sortOrder: 20,
        isPublic: false,
        aclMode: 'owner_only',
        createdAt: 2,
        meta: { cel: { hold: 2 } },
      },
      {
        id: 'layer_foreign',
        canvasId: 'c1',
        parentId: null,
        ownerId: 'u_other',
        name: 'Other Painter Layer',
        layerType: 'raster',
        blendMode: 'normal',
        opacity: 1,
        isVisible: true,
        isLocked: false,
        sortOrder: 30,
        isPublic: false,
        aclMode: 'owner_only',
        createdAt: 3,
        meta: {},
      },
    ];

    const tileStore = new Map<string, Uint8Array>();
    const appliedHistory: Array<{ layerId: string; tiles: TileData[] }> = [];
    const undoMgr = new ScopedUndoManager(50);
    const caps = getCanvasRoleCapabilities(role);
    const timeline: PluginTimelineBridge = {
      getFps: () => layers[0].meta?.animation?.fps ?? 12,
      getLength: () => layers[0].meta?.animation?.length ?? 24,
      getCurrentFrame: () => curFrame,
      getIsPlaying: () => false,
      getLoop: () => loop,
      getRange: () => range,
      setCurrentFrame: (f) => { curFrame = f; },
      setLoop: (l) => { loop = l; },
      setRange: (r) => { range = r; },
    };

    const adapter: PluginCanvasHostAdapter = {
      canvasWidth: 64,
      canvasHeight: 64,
      tileSize: 64,
      acl: {
        user: { id: userId, username: userId, displayName: userId, role: 'user', serverRole: 'member' } as any,
        isGuest: false,
        canvasMember: { canvasId: 'c1', userId, role, ...caps, joinedAt: 1 },
      },
      getLayers: () => layers,
      getActiveLayerId: () => 'cel_own',
      setActiveLayer: () => {},
      getBrush: () => ({ ...brushState }),
      setBrush: (patch) => { brushState = { ...brushState, ...patch }; },
      createLayer: async () => null,
      updateLayerProps: async (layerId, patch) => {
        const idx = layers.findIndex((l) => l.id === layerId);
        if (idx >= 0) layers[idx] = { ...layers[idx], ...patch };
      },
      reorderLayers: async () => {},
      deleteLayer: async () => false,
      restoreDeletedLayer: async () => null,
      getOccupiedTiles: () => [],
      readLayerTile: async (layerId) => tileStore.get(layerId)?.slice() ?? new Uint8Array(64 * 64 * 4),
      readLayerRect: async (layerId, rect) => {
        const full = tileStore.get(layerId) ?? new Uint8Array(64 * 64 * 4);
        const out = new Uint8Array(rect.width * rect.height * 4);
        for (let y = 0; y < rect.height; y++) {
          const srcOff = ((rect.y + y) * 64 + rect.x) * 4;
          out.set(full.subarray(srcOff, srcOff + rect.width * 4), y * rect.width * 4);
        }
        return out;
      },
      readCompositeRect: async (rect) => new Uint8Array(rect.width * rect.height * 4),
      applyLayerTiles: (layerId, tiles) => {
        appliedHistory.push({ layerId, tiles });
        if (tiles[0]) tileStore.set(layerId, tiles[0].data.slice());
      },
      commitTilePatch: () => {},
      pushUndoOp: (op) => undoMgr.push(op),
      timeline,
    };

    return { adapter, layers, undoMgr, tileStore, appliedHistory, getBrushState: () => brushState };
  };

  // 4. Timeline / Keyframes / Easing / Brush v2 end-to-end via QuickJS + single undo groupId
  {
    const host = buildV25Host('owner', 'u_owner');
    const manifest = parsePlugin({
      apiVersion: 2,
      id: 'lumina.v25-timeline-test',
      name: 'Timeline & Brush v2 Test',
      version: '2.5.0',
      author: 'Lumina',
      description: 'Exercises timeline, keyframes, easing, and brush v2 APIs.',
      permissions: ['commands', 'timeline:read', 'timeline:write', 'brush'],
      commands: [{ id: 'run', label: 'Run' }],
      script: `
        async function onCommand(cmd, api) {
          const state0 = await api.timeline.getState();
          await api.timeline.setFps(24);
          await api.timeline.setLength(48);
          await api.timeline.setFrame(6);
          await api.timeline.setLoop(false);
          await api.timeline.setRange({ start: 2, end: 20 });
          await api.timeline.setLabel(6, 'Peak');
          await api.timeline.updateCel('cel_own', { hold: 4, mark: 'key', note: 'Jump apex' });

          await api.easing.register('lumina-bounce', [0.34, 1.45, 0.64, 1], 'Lumina Bounce');
          const presets = await api.easing.listPresets();
          const evalMid = await api.easing.evaluate(0.5, { presetId: 'lumina-bounce' });

          await api.keyframes.set('cel_own', { frame: 0, x: 0, y: 0, opacity: 1, presetId: 'lumina-bounce' });
          await api.keyframes.set('cel_own', { frame: 10, x: 100, y: -40, opacity: 0.5, easing: 'easeOut' });
          const kfEval = await api.keyframes.evaluate('cel_own', 5);

          await api.brush.set({
            color: '#0ea5e9',
            size: 32,
            mixMode: 'dilute',
            wetEdges: true,
            fgBgMix: 0.45,
            dynamics: { size: { pressure: true, min: 0.25 }, opacity: { velocity: true, min: 0.4 } },
          });
          const brushAfter = await api.brush.get();

          return {
            notice: JSON.stringify({
              fps0: state0.fps,
              hasCustomPreset: presets.some((p) => p.id === 'lumina-bounce'),
              evalMid: Number(evalMid.value.toFixed(3)),
              kfMidX: Math.round(kfEval.x),
              mixMode: brushAfter.mixMode,
              wetEdges: brushAfter.wetEdges,
              sizeMin: brushAfter.dynamics?.size?.min,
            }),
          };
        }
      `,
    }) as PluginManifestV2;

    const tx = new PluginCanvasTransaction(host.adapter, { pluginId: manifest.id });
    const res = await startPluginV2Direct(
      manifest,
      { kind: 'command', commandId: 'run' },
      { width: 64, height: 64, dpi: 300 },
      tx.createRpcHandler(),
    ).promise;
    tx.commit('Plugin: Timeline & Brush v2 Test');

    const parsed = JSON.parse(res.notice!);
    assert.equal(parsed.fps0, 12);
    assert.equal(parsed.hasCustomPreset, true);
    assert.ok(parsed.evalMid > 0.5, 'overshoot bounce curve should exceed 0.5 at t=0.5');
    assert.ok(parsed.kfMidX > 50, 'keyframe evaluation should apply registered custom bezier');
    assert.equal(parsed.mixMode, 'dilute');
    assert.equal(parsed.wetEdges, true);
    assert.ok(Math.abs(parsed.sizeMin - 0.25) < 1e-6);

    assert.equal(host.layers[0].meta?.animation?.fps, 24);
    assert.equal(host.layers[0].meta?.animation?.length, 48);
    assert.equal(host.layers[0].meta?.animation?.labels?.[0]?.text, 'Peak');
    assert.equal(host.layers[1].meta?.cel?.hold, 4);
    assert.equal(host.layers[1].meta?.cel?.mark, 'key');
    assert.equal(host.layers[1].meta?.keyframes?.length, 2);

    // Single undo group must capture both anim_folder and cel_own meta ops in one Ctrl+Z
    const undone = host.undoMgr.undoGroup('u_owner', () => true);
    assert.equal(undone.length, 2);
    assert.equal(undone[0].groupId, tx.groupId);
    assert.equal(undone[1].groupId, tx.groupId);
    assert.equal(host.undoMgr.undoGroup('u_owner', () => true).length, 0);
  }

  // 5. Reject brush stabilizer modification via brush.set
  {
    const host = buildV25Host('owner', 'u_owner');
    const tx = new PluginCanvasTransaction(host.adapter, { pluginId: 'test.stab' });
    const rpc = tx.createRpcHandler();
    await assert.rejects(() => rpc('brush.set', { stabilizerLevel: 50 }), /stabilizer/i);
  }

  // 6. Multiplayer ACL: viewer rejected on all timeline/keyframes/easing writes;
  //    keyframes.setBatch atomically rejects entire batch if ANY target layer is unauthorized
  {
    const viewerHost = buildV25Host('viewer', 'u_viewer');
    const viewerTx = new PluginCanvasTransaction(viewerHost.adapter, { pluginId: 'test.viewer' });
    const vrpc = viewerTx.createRpcHandler();
    // Viewer CAN read timeline state
    const readRes = await vrpc('timeline.getState', {});
    assert.equal((readRes.result as any).fps, 12);
    // Viewer CANNOT write timeline, keyframes, or custom easing
    await assert.rejects(() => vrpc('timeline.setFrame', { frame: 3 }), /viewer/i);
    await assert.rejects(() => vrpc('timeline.setFps', { fps: 24 }), /viewer/i);
    await assert.rejects(() => vrpc('keyframes.set', { layerId: 'cel_own', keyframe: { frame: 0, x: 10 } }), /viewer/i);
    await assert.rejects(() => vrpc('easing.register', { id: 'v-bad', bezier: [0.2, 0, 0.8, 1] }), /viewer/i);

    // Owner tries atomic keyframes.setBatch touching BOTH own layer and foreign painter's layer
    const ownerHost = buildV25Host('owner', 'u_owner');
    const ownerTx = new PluginCanvasTransaction(ownerHost.adapter, { pluginId: 'test.batch' });
    const orpc = ownerTx.createRpcHandler();
    await assert.rejects(
      () =>
        orpc('keyframes.setBatch', {
          items: [
            { layerId: 'cel_own', keyframes: [{ frame: 0, x: 99 }] },
            { layerId: 'layer_foreign', keyframes: [{ frame: 0, x: 50 }] },
          ],
        }),
    );
    // Atomic guarantee: cel_own must remain untouched!
    assert.equal(ownerHost.layers[1].meta?.keyframes, undefined);
  }

  // 7. Custom tool pointer session: state retention across Down -> Move -> Up,
  //    live preview flush, shared single undo groupId, and timeout/cancel rollback
  {
    const host = buildV25Host('owner', 'u_owner');
    const toolPlugin = parsePlugin({
      apiVersion: 2,
      id: 'lumina.v25-dot-tool',
      name: 'Dot Tool',
      version: '2.5.0',
      author: 'Lumina',
      description: 'Draws a 2x2 dot on each pointer event.',
      permissions: ['tools', 'input', 'layers:read', 'pixels:write'],
      tools: [{ id: 'dot', label: 'Dot', icon: 'sparkles', cursor: 'crosshair' }],
      script: `
        let count = 0;
        async function stamp(x, y, api) {
          const active = await api.layers.getActive();
          const px = Math.max(0, Math.min(62, Math.floor(x)));
          const py = Math.max(0, Math.min(62, Math.floor(y)));
          const data = new Uint8Array(2 * 2 * 4);
          for (let i = 0; i < data.length; i += 4) {
            data[i] = 56; data[i + 1] = 189; data[i + 2] = 248; data[i + 3] = 255;
          }
          await api.pixels.write(active.id, { x: px, y: py, width: 2, height: 2, data });
        }
        async function onPointerDown(toolId, ev, api) {
          count = 1;
          await stamp(ev.x, ev.y, api);
        }
        async function onPointerMove(toolId, ev, api) {
          count += 1;
          await stamp(ev.x, ev.y, api);
        }
        async function onPointerUp(toolId, ev, api) {
          count += 1;
          await stamp(ev.x, ev.y, api);
          return { notice: 'dots:' + count };
        }
      `,
    }) as PluginManifestV2;

    // Missing 'input' permission must be rejected
    assert.throws(() =>
      startPluginToolDirect(
        { ...toolPlugin, permissions: ['tools'] },
        'dot',
        { width: 64, height: 64, dpi: 300 },
        async () => ({ result: null }),
      ),
    );

    const tx = new PluginCanvasTransaction(host.adapter, { pluginId: toolPlugin.id });
    const session = startPluginToolDirect(
      toolPlugin,
      'dot',
      { width: 64, height: 64, dpi: 300 },
      tx.createRpcHandler(),
    );
    const mkEv = (phase: 'down' | 'move' | 'up' | 'cancel', x: number, y: number) => ({
      phase,
      x,
      y,
      startX: 4,
      startY: 4,
      deltaX: 0,
      deltaY: 0,
      pressure: 0.8,
      tiltX: 0,
      tiltY: 0,
      pointerType: 'pen' as const,
      buttons: phase === 'up' ? 0 : 1,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      timestamp: 10,
      options: {},
    });

    await session.dispatchEvent('down', mkEv('down', 4, 4));
    tx.flushPreview();
    assert.equal(host.appliedHistory.length, 1, 'live preview should flush to canvas during stroke');
    await session.dispatchEvent('move', mkEv('move', 16, 16));
    tx.flushPreview();
    const upRes = await session.dispatchEvent('up', mkEv('up', 28, 28));
    session.dispose();
    assert.equal(upRes.notice, 'dots:3');
    tx.commit('Plugin Tool: Dot');

    // Entire drag produces a single grouped undo entry
    const strokeUndo = host.undoMgr.undoGroup('u_owner', () => true);
    assert.equal(strokeUndo.length, 1);
    assert.equal(strokeUndo[0].groupId, tx.groupId);

    // Timeout / runaway loop protection + rollback restores previewed pixels
    const badHost = buildV25Host('owner', 'u_owner');
    const badPlugin = parsePlugin({
      apiVersion: 2,
      id: 'lumina.v25-hang-tool',
      name: 'Hang Tool',
      version: '2.5.0',
      author: 'Lumina',
      description: 'Hangs on move',
      permissions: ['tools', 'input', 'layers:read', 'pixels:write'],
      tools: [{ id: 'hang', label: 'Hang' }],
      script: `
        async function onPointerDown(toolId, ev, api) {
          const active = await api.layers.getActive();
          const data = new Uint8Array(4 * 4);
          data.fill(255);
          await api.pixels.write(active.id, { x: 2, y: 2, width: 2, height: 2, data });
        }
        function onPointerMove() {
          while (true) {}
        }
      `,
    }) as PluginManifestV2;
    const badTx = new PluginCanvasTransaction(badHost.adapter, { pluginId: badPlugin.id });
    const badSession = startPluginToolDirect(
      badPlugin,
      'hang',
      { width: 64, height: 64, dpi: 300 },
      badTx.createRpcHandler(),
      { eventCpuLimitMs: 120, eventWallLimitMs: 600 },
    );
    await badSession.dispatchEvent('down', mkEv('down', 2, 2));
    badTx.flushPreview();
    // Verify preview pixel is visible on canvas before move hangs
    assert.equal(badHost.tileStore.get('cel_own')?.[(2 * 64 + 2) * 4 + 3], 255);
    await assert.rejects(() => badSession.dispatchEvent('move', mkEv('move', 10, 10)), /time limit|timed out/i);
    badSession.dispose();
    await badTx.rollback();
    // After rollback, previewed pixel MUST be reverted to 0!
    assert.equal(badHost.tileStore.get('cel_own')?.[(2 * 64 + 2) * 4 + 3], 0);
  }

  // 8. PluginToolPointerController throttling/coalescing + tool shortcut parsing
  {
    const toolShortcutId = makePluginToolShortcutId('lumina.motion', 'starlight-ribbon');
    assert.deepEqual(parsePluginShortcutId(toolShortcutId), {
      kind: 'tool',
      pluginId: 'lumina.motion',
      toolId: 'starlight-ribbon',
    });

    const host = buildV25Host('owner', 'u_owner');
    const throttlePlugin = parsePlugin({
      apiVersion: 2,
      id: 'lumina.v25-throttle-test',
      name: 'Throttle Test',
      version: '2.5.0',
      author: 'Lumina',
      description: 'Verifies move coalescing and single stroke commit.',
      permissions: ['tools', 'input', 'layers:read', 'pixels:write'],
      tools: [
        {
          id: 'ribbon',
          label: 'Ribbon',
          throttleMs: 30,
          options: [{ kind: 'range', key: 'size', label: 'Size', initial: 2, min: 1, max: 8 }],
        },
      ],
      script: `
        let moves = 0;
        async function dot(x, y, api) {
          const active = await api.layers.getActive();
          const px = Math.max(0, Math.min(62, Math.floor(x)));
          const py = Math.max(0, Math.min(62, Math.floor(y)));
          const d = new Uint8Array(4);
          d[0] = 255; d[1] = 200; d[2] = 60; d[3] = 255;
          await api.pixels.write(active.id, { x: px, y: py, width: 1, height: 1, data: d });
        }
        async function onPointerDown(toolId, ev, api) {
          moves = 0;
          await dot(ev.x, ev.y, api);
        }
        async function onPointerMove(toolId, ev, api) {
          moves += 1;
          await dot(ev.x, ev.y, api);
        }
        async function onPointerUp(toolId, ev, api) {
          await dot(ev.x, ev.y, api);
          return { notice: 'moves:' + moves + ':opt:' + ev.options.size };
        }
      `,
    }) as PluginManifestV2;

    const registered = collectEnabledPluginTools([{ manifest: throttlePlugin, enabled: true }]);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].hasInputPermission, true);
    const initialOpts = buildInitialToolOptions(registered[0].tool);
    assert.equal(initialOpts.size, 2);

    const ctrl = new PluginToolPointerController();
    let finalNotice = '';
    const sample = (x: number, y: number) => ({
      x,
      y,
      pressure: 1,
      tiltX: 0,
      tiltY: 0,
      pointerType: 'mouse' as const,
      buttons: 1,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
    assert.equal(
      ctrl.startStroke(1, sample(4, 4), registered[0], initialOpts, {
        createTransaction: (p, gid) => new PluginCanvasTransaction(host.adapter, { pluginId: p.id, groupId: gid }),
        createSession: (p, tid, tx) =>
          startPluginToolDirect(p, tid, { width: 64, height: 64, dpi: 300 }, tx.createRpcHandler()),
        onNotice: (n) => { finalNotice = n; },
        onError: (err) => { throw new Error(err); },
      }),
      true,
    );
    // Rapid burst of 15 moves should coalesce without queueing 15 invocations
    for (let i = 1; i <= 15; i++) {
      ctrl.moveStroke(1, sample(4 + i * 2, 4 + i));
    }
    await new Promise((r) => setTimeout(r, 80));
    ctrl.endStroke(1, sample(40, 24), false);
    // Wait for async finish
    for (let i = 0; i < 40 && ctrl.isStrokeActive(); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(ctrl.isStrokeActive(), false);
    assert.ok(finalNotice.startsWith('moves:'), `Expected notice from onPointerUp, got "${finalNotice}"`);
    assert.ok(finalNotice.endsWith(':opt:2'));
    const moveCount = Number(finalNotice.split(':')[1]);
    assert.ok(moveCount <= 4, `Expected throttled/coalesced moves <= 4, got ${moveCount}`);
    // Single grouped undo entry for entire drag
    assert.equal(host.undoMgr.undoGroup('u_owner', () => true).length, 1);
  }

  // 9. Validate shipped official v2.5 sample plugin (lumina-motion-atelier.lumina-plugin) end-to-end
  {
    const samplePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../public/plugins/lumina-motion-atelier.lumina-plugin',
    );
    const rawSample = JSON.parse(readFileSync(samplePath, 'utf-8'));
    const sample = parsePlugin(rawSample) as PluginManifestV2;
    assert.equal(sample.apiVersion, 2);
    assert.equal(sample.id, 'lumina.motion-atelier');
    assert.equal(sample.tools?.length, 1);
    assert.equal(sample.tools?.[0].id, 'starlight-ribbon');
    assert.equal(sample.commands.length, 2);
    assert.equal(sample.panels.length, 1);

    const host = buildV25Host('owner', 'u_owner');

    // Run command: apply-bounce-keyframes
    const tx1 = new PluginCanvasTransaction(host.adapter, { pluginId: sample.id });
    const res1 = await startPluginV2Direct(
      sample,
      { kind: 'command', commandId: 'apply-bounce-keyframes' },
      { width: 64, height: 64, dpi: 300 },
      tx1.createRpcHandler(),
    ).promise;
    tx1.commit('Plugin: Lumina Motion Atelier');
    assert.ok(res1.notice?.includes('Bounce keyframes'));
    assert.equal(host.layers[1].meta?.keyframes?.length, 3);
    assert.equal(host.layers[0].meta?.animation?.labels?.[0]?.text, 'Apex');

    // Run command: apply-watercolor-v2
    const tx2 = new PluginCanvasTransaction(host.adapter, { pluginId: sample.id });
    const res2 = await startPluginV2Direct(
      sample,
      { kind: 'command', commandId: 'apply-watercolor-v2' },
      { width: 64, height: 64, dpi: 300 },
      tx2.createRpcHandler(),
    ).promise;
    tx2.commit('Plugin: Lumina Motion Atelier');
    assert.ok(res2.notice?.includes('dilute'));
    assert.equal(host.getBrushState().mixMode, 'dilute');
    assert.equal(host.getBrushState().wetEdges, true);

    // Run panel action: inspect-timeline
    const tx3 = new PluginCanvasTransaction(host.adapter, { pluginId: sample.id });
    const res3 = await startPluginV2Direct(
      sample,
      { kind: 'panel', panelId: 'motion-director', actionId: 'inspect-timeline', values: {} },
      { width: 64, height: 64, dpi: 300 },
      tx3.createRpcHandler(),
    ).promise;
    tx3.commit('Plugin: Lumina Motion Atelier');
    assert.ok(res3.statusText?.includes('12 FPS'));

    // Run custom tool: starlight-ribbon Down -> Move -> Up
    const tx4 = new PluginCanvasTransaction(host.adapter, { pluginId: sample.id });
    const session = startPluginToolDirect(
      sample,
      'starlight-ribbon',
      { width: 64, height: 64, dpi: 300 },
      tx4.createRpcHandler(),
    );
    const toolOpts = buildInitialToolOptions(sample.tools![0]);
    const mkSampleEv = (phase: 'down' | 'move' | 'up', x: number, y: number) => ({
      phase,
      x,
      y,
      startX: 12,
      startY: 12,
      deltaX: 0,
      deltaY: 0,
      pressure: 0.9,
      tiltX: 0,
      tiltY: 0,
      pointerType: 'pen' as const,
      buttons: phase === 'up' ? 0 : 1,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      timestamp: 16,
      options: toolOpts,
    });
    await session.dispatchEvent('down', mkSampleEv('down', 12, 12));
    tx4.flushPreview();
    await session.dispatchEvent('move', mkSampleEv('move', 36, 28));
    tx4.flushPreview();
    const upRes = await session.dispatchEvent('up', mkSampleEv('up', 48, 36));
    session.dispose();
    tx4.commit('Plugin Tool: Starlight Ribbon');
    assert.ok(upRes.notice?.includes('Starlight Ribbon'));
    // Verify pixels were actually painted onto cel_own
    const paintedTile = host.tileStore.get('cel_own');
    assert.ok(paintedTile, 'Starlight ribbon should paint pixels onto active layer');
    let nonZeroAlpha = 0;
    for (let i = 3; i < paintedTile.length; i += 4) {
      if (paintedTile[i] > 0) nonZeroAlpha += 1;
    }
    assert.ok(nonZeroAlpha > 50, `Expected >50 painted pixels from starlight ribbon, got ${nonZeroAlpha}`);
  }

  resetPluginEasingsForTests();
})();

// --- Align L3: Guide basis, vector stroke bounds/shift, and RulerManager guides ---
{
  // resolveAlignBasis priority: selection > guide > objects (>=2) > canvas
  assert.equal(resolveAlignBasis('auto', true, 3, true), 'selection');
  assert.equal(resolveAlignBasis('auto', false, 3, true), 'guide');
  assert.equal(resolveAlignBasis('auto', false, 3, false), 'objects');
  assert.equal(resolveAlignBasis('auto', false, 1, false), 'canvas');
  assert.equal(resolveAlignBasis('guide', false, 1, false), null);
  assert.equal(resolveAlignBasis('guide', false, 1, true), 'guide');

  // summarizeGuides & guideAxisAvailability
  const guides = [
    { id: 'gx1', axis: 'x' as const, position: 100 },
    { id: 'gx2', axis: 'x' as const, position: 500 },
    { id: 'gxDup', axis: 'x' as const, position: 100 },
    { id: 'gy1', axis: 'y' as const, position: 240 },
  ];
  const allSummary = summarizeGuides(guides);
  assert.deepEqual(allSummary.xs, [100, 500]);
  assert.deepEqual(allSummary.ys, [240]);
  assert.equal(allSummary.usingSelection, false);
  assert.equal(allSummary.totalCount, 4);
  assert.deepEqual(guideAxisAvailability(allSummary), {
    canAlignX: true,
    canAlignY: true,
    canDistributeX: true,
    canDistributeY: false,
  });

  // Single vertical guide selected: only horizontal align enabled, no vertical align or distribute
  const singleVSummary = summarizeGuides(guides, ['gx1']);
  assert.deepEqual(singleVSummary.xs, [100]);
  assert.deepEqual(singleVSummary.ys, []);
  assert.equal(singleVSummary.usingSelection, true);
  assert.deepEqual(guideAxisAvailability(singleVSummary), {
    canAlignX: true,
    canAlignY: false,
    canDistributeX: false,
    canDistributeY: false,
  });

  // guideAlignOffset: single vertical line aligns left/center/right to line, leaves Y untouched
  const box: AlignRect = { x: 20, y: 50, w: 40, h: 30 };
  assert.deepEqual(guideAlignOffset(box, singleVSummary, 'left', 'top', 'range'), { dx: 80, dy: 0 });
  assert.deepEqual(guideAlignOffset(box, singleVSummary, 'center', null, 'range'), { dx: 60, dy: 0 });
  assert.deepEqual(guideAlignOffset(box, singleVSummary, 'right', null, 'range'), { dx: 40, dy: 0 });

  // Multi-guide span ('range') vs 'nearest'
  const nearLeft: AlignRect = { x: 120, y: 10, w: 20, h: 20 };
  const nearRight: AlignRect = { x: 460, y: 10, w: 20, h: 20 };
  assert.deepEqual(guideAlignManyOffsets([nearLeft, nearRight], allSummary, 'left', null, 'range'), [
    { dx: -20, dy: 0 },
    { dx: -360, dy: 0 },
  ]);
  assert.deepEqual(guideAlignManyOffsets([nearLeft, nearRight], allSummary, 'left', null, 'nearest'), [
    { dx: -20, dy: 0 },
    { dx: 40, dy: 0 },
  ]);
  assert.deepEqual(guideAlignOffset(nearLeft, allSummary, 'center', 'center', 'range'), {
    dx: 100 + Math.floor((400 - 20) / 2) - 120,
    dy: 240 + Math.floor((0 - 20) / 2) - 10,
  });

  // guideDistributeFrame + distributeOffsets along two vertical guides [100, 500]
  assert.equal(guideDistributeFrame(singleVSummary, 'hgap'), null);
  assert.equal(guideDistributeFrame(allSummary, 'vgap'), null);
  const hFrame = guideDistributeFrame(allSummary, 'hgap');
  assert.deepEqual(hFrame, { x: 100, y: 0, w: 400, h: 1 });
  const items3: AlignRect[] = [
    { x: 150, y: 20, w: 40, h: 20 },
    { x: 250, y: 20, w: 40, h: 20 },
    { x: 320, y: 20, w: 40, h: 20 },
  ];
  const distShifts = distributeOffsets(items3, 'hgap', 'guide', hFrame!);
  const movedX = items3.map((r, i) => r.x + distShifts[i].dx);
  assert.equal(movedX[0], 100, 'Leftmost item snaps to first vertical guide');
  assert.equal(movedX[2] + items3[2].w, 500, 'Rightmost item snaps to last vertical guide');
  const gap1 = movedX[1] - (movedX[0] + items3[0].w);
  const gap2 = movedX[2] - (movedX[1] + items3[1].w);
  assert.ok(Math.abs(gap1 - gap2) <= 1, `Equal gaps between guides: ${gap1} vs ${gap2}`);

  // RulerManager guide CRUD, selection toggle, and initDimensions clamp
  const rm = RulerManager.getInstance();
  rm.clearGuides();
  const g1 = rm.addGuide('x', 200);
  const g2 = rm.addGuide('x', 900);
  const g3 = rm.addGuide('y', 150);
  assert.equal(rm.getActiveGuides().length, 3);
  rm.toggleGuideSelected(g1.id, false);
  assert.deepEqual(rm.state.guides.selectedIds, [g1.id]);
  rm.toggleGuideSelected(g2.id, true);
  assert.deepEqual(rm.state.guides.selectedIds, [g1.id, g2.id]);
  rm.setGuidesVisible(false);
  assert.equal(rm.getActiveGuides().length, 0);
  rm.setGuidesVisible(true);
  rm.initDimensions(600, 400);
  assert.equal(rm.state.guides.items.find((g) => g.id === g2.id)?.position, 600);
  rm.removeGuide(g3.id);
  assert.equal(rm.state.guides.items.length, 2);
  rm.clearGuides();
  assert.equal(rm.state.guides.items.length, 0);

  // computeVectorStrokeAlignRect: centerline ('path') vs ink width ('stroke') & Bézier bow
  const curvedStroke = {
    id: 'vs1',
    layerId: 'vec1',
    color: '#000000',
    opacity: 1,
    baseWidth: 20,
    anchors: [
      { x: 100, y: 100, cp2x: 150, cp2y: 20, pressure: 1, width: 20 },
      { x: 200, y: 100, cp1x: 150, cp1y: 20, pressure: 1, width: 20 },
    ],
    bounds: { minX: 88, minY: 8, maxX: 212, maxY: 112 },
    createdAt: 1,
  };
  const pathRect = computeVectorStrokeAlignRect(curvedStroke, 'path')!;
  const strokeRect = computeVectorStrokeAlignRect(curvedStroke, 'stroke')!;
  assert.equal(pathRect.x, 100);
  assert.equal(pathRect.x + pathRect.w, 200);
  assert.ok(pathRect.y < 100 && pathRect.y >= 35 && pathRect.y <= 45, `Bézier apex near y=40, got ${pathRect.y}`);
  assert.equal(strokeRect.x, 90, 'Stroke mode expands left by half width (10px)');
  assert.equal(strokeRect.x + strokeRect.w, 210, 'Stroke mode expands right by half width (10px)');
  assert.equal(strokeRect.y, pathRect.y - 10, 'Stroke mode expands top by half width');
  assert.equal(strokeRect.y + strokeRect.h, pathRect.y + pathRect.h + 10, 'Stroke mode expands bottom by half width');

  // shiftVectorStroke preserves exact anchor + Bézier handle offsets
  const shifted = shiftVectorStroke(curvedStroke, 35, -15);
  assert.equal(shifted.anchors[0].x, 135);
  assert.equal(shifted.anchors[0].y, 85);
  assert.equal(shifted.anchors[0].cp2x, 185);
  assert.equal(shifted.anchors[0].cp2y, 5);
  assert.equal(shifted.anchors[1].x, 235);
  assert.equal(shifted.anchors[1].y, 85);
  assert.equal(shifted.anchors[1].cp1x, 185);
  assert.equal(shifted.anchors[1].cp1y, 5);
  assert.equal(shifted.bounds.minX, curvedStroke.bounds.minX + 35);
  assert.equal(shifted.bounds.minY, curvedStroke.bounds.minY - 15);

  const layerUnion = computeVectorLayerAlignRect([curvedStroke, shifted], 'path')!;
  assert.equal(layerUnion.x, 100);
  assert.equal(layerUnion.x + layerUnion.w, 235);
}

// Animation Phase E1 (2D Camera), E2 (Light Table v2), E3 (Local Audio Track metadata)
{
  // E1: 2D Camera normalization, evaluation, export matrix inverse mapping, preview viewport, and motion path
  const camMeta = normalizeCameraMeta({ width: 1280, height: 720, showSafeArea: true }, 1920, 1080);
  assert.deepEqual(camMeta, { width: 1280, height: 720, showSafeArea: true });
  const camKfs = [
    { frame: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 960, pivotY: 540, opacity: 1, easing: 'linear' as const },
    { frame: 10, x: 200, y: -100, scaleX: 0.5, scaleY: 0.5, rotation: Math.PI / 2, pivotX: 960, pivotY: 540, opacity: 1, easing: 'linear' as const },
  ];
  const camMid = evaluateCameraFrame(camMeta, camKfs, 5, 1920, 1080);
  assert.ok(Math.abs(camMid.centerX - 1060) < 1e-4, `mid centerX expected 1060, got ${camMid.centerX}`);
  assert.ok(Math.abs(camMid.centerY - 490) < 1e-4, `mid centerY expected 490, got ${camMid.centerY}`);
  assert.ok(Math.abs(camMid.scaleX - 0.75) < 1e-4);
  assert.ok(Math.abs(camMid.rotation - Math.PI / 4) < 1e-4);

  // Camera export matrix maps camera center -> output center and top-left corner -> (0, 0)
  const camEnd = evaluateCameraFrame(camMeta, camKfs, 10, 1920, 1080);
  const outMat = computeCameraCanvasToOutputMatrix(camEnd, 1920, 1080, 1280, 720);
  const mappedCenter = applyAffinePoint(outMat, camEnd.centerX, camEnd.centerY);
  assert.ok(Math.abs(mappedCenter.x - 640) < 1e-3 && Math.abs(mappedCenter.y - 360) < 1e-3, 'camera center maps to output center');
  const mappedTL = applyAffinePoint(outMat, camEnd.corners[0].x, camEnd.corners[0].y);
  assert.ok(Math.abs(mappedTL.x) < 1e-3 && Math.abs(mappedTL.y) < 1e-3, 'camera top-left corner maps to (0,0)');
  const mappedBR = applyAffinePoint(outMat, camEnd.corners[2].x, camEnd.corners[2].y);
  assert.ok(Math.abs(mappedBR.x - 1280) < 1e-3 && Math.abs(mappedBR.y - 720) < 1e-3, 'camera bottom-right corner maps to (1280,720)');

  // Preview viewport aligns camera center upright in screen center
  const pv = computeCameraPreviewViewport(camEnd, 1920, 1080, 1000, 600, 20);
  assert.ok(Math.abs(pv.rotation - -camEnd.rotation) < 1e-6);
  const cos = Math.cos(pv.rotation);
  const sin = Math.sin(pv.rotation);
  const dx = camEnd.centerX - 960;
  const dy = camEnd.centerY - 540;
  const screenCenterX = pv.panX + pv.zoom * (dx * cos - dy * sin);
  const screenCenterY = pv.panY + pv.zoom * (dx * sin + dy * cos);
  assert.ok(Math.abs(screenCenterX - 500) < 1e-3 && Math.abs(screenCenterY - 300) < 1e-3);

  const camSamples = sampleCameraMotionPath(camMeta, camKfs, 1920, 1080);
  assert.equal(camSamples.length, 11);
  assert.equal(camSamples.filter((s) => s.isKey).length, 2);

  // Camera keyframes force distinct export segments even when cel stays held
  const camLayers = [
    { id: 'f1', name: 'Anim', layerType: 'group', parentId: null, sortOrder: 0, isVisible: true, opacity: 1, meta: { animation: { fps: 12 } } },
    { id: 'c1', name: '1', layerType: 'raster', parentId: 'f1', sortOrder: 1, isVisible: true, opacity: 1, meta: { cel: { hold: 6 } } },
    { id: 'cam1', name: 'Camera', layerType: 'group', parentId: null, sortOrder: 2, isVisible: true, opacity: 1, meta: { camera: camMeta, keyframes: camKfs } },
  ];
  assert.equal(isCameraLayer(camLayers[2]), true);
  assert.equal(findCameraLayer(camLayers)?.id, 'cam1');
  const camSegs = exportSegments(camLayers, 0, 5, null, 1920, 1080);
  assert.equal(camSegs.length, 6, 'moving camera splits held cel into per-frame export segments');
  assert.equal(nextGroupName(camLayers), '圖層組 1', 'camera group excluded from plain group numbering');

  // E2: Light Table v2 per-reference transforms, tinting, external refs, and pinned edit target lock
  let lt = emptyLightTable();
  lt = toggleLightCel(lt, { kind: 'cel', id: 'c1' }, 'c2');
  lt = updateLightTableTransform(lt, 'c2', {
    x: 40,
    y: -20,
    scale: 1.5,
    rotation: 90,
    flipX: true,
    opacity: 0.6,
    tint: '#38bdf8',
    tintMode: 'shade',
  });
  const trC2 = getLightTableTransform(lt, 'c2');
  assert.equal(trC2.x, 40);
  assert.equal(trC2.flipX, true);
  assert.equal(trC2.tintMode, 'shade');
  const affC2 = lightTableTransformToAffine(trC2, 1000, 800);
  assert.equal(affC2.isIdentity, false);
  const affCenter = applyAffinePoint(affC2, 500, 400);
  assert.ok(Math.abs(affCenter.x - 540) < 1e-4 && Math.abs(affCenter.y - 380) < 1e-4);

  // Pinned edit target keeps c1's light table active when inspecting c3
  lt = setPinnedLightTarget(lt, 'c1');
  assert.equal(resolveLightTableTargetCel(lt, 'c3'), 'c1');
  assert.deepEqual([...lightIdsFor(lt, 'f1', 'c3')], ['c2']);

  // External local reference image scope & visibility
  lt = addExternalLightRef(lt, { id: 'ext1', name: 'ref.png', width: 640, height: 480, scopeKind: 'track', scopeId: 'f1' });
  assert.equal(externalRefsFor(lt, 'f1', 'c3', { visibleOnly: true }).length, 1);
  lt = updateLightTableTransform(lt, 'ext1', { visible: false });
  assert.equal(externalRefsFor(lt, 'f1', 'c3', { visibleOnly: true }).length, 0);
  lt = removeExternalLightRef(lt, 'ext1');
  assert.equal(lt.externalRefs.length, 0);

  // animationDisplay applies per-cel light-table transform, opacity multiplier, and shade tint
  const ltDisplayLayers = [
    { id: 'f1', name: 'Anim', layerType: 'group', parentId: null, sortOrder: 0, isVisible: true, opacity: 1, meta: { animation: { fps: 12 } } },
    { id: 'c1', name: '1', layerType: 'raster', parentId: 'f1', sortOrder: 1, isVisible: true, opacity: 1, meta: null },
    { id: 'c2', name: '2', layerType: 'raster', parentId: 'f1', sortOrder: 2, isVisible: true, opacity: 1, meta: null },
  ];
  const disp = animationDisplay(
    ltDisplayLayers,
    {
      time: 0,
      activeFolderId: 'f1',
      onion: null,
      light: {
        opacity: 0.5,
        ids: new Set(['c2']),
        items: new Map([['c2', { opacity: 0.6, transform: affC2, tint: 0x38bdf8, tintMode: 'shade' }]]),
      },
    },
    1000,
    800
  );
  const c2Out = disp.find((l) => l.id === 'c2')!;
  assert.ok(Math.abs(c2Out.opacity - 0.3) < 1e-6);
  assert.equal(c2Out.onionTint, 0x38bdf8);
  assert.equal(c2Out.onionMode, 'shade');
  assert.ok(c2Out.renderTransform && !c2Out.renderTransform.isIdentity);
  lt = resetLightTableTransform(lt, 'c2');
  assert.equal(getLightTableTransform(lt, 'c2').x, 0);

  // E3: Local Audio Track metadata normalization, frame span, playback scheduling window, and waveform peaks
  const audMeta = normalizeAudioTrackMeta({
    localAssetId: 'aud_01',
    fileName: 'dialogue.wav',
    durationSec: 2.5,
    startFrame: 6,
    volume: 0.8,
    muted: false,
  });
  assert.equal(isAudioLayer({ id: 'a1', layerType: 'group', meta: { audio: audMeta } }), true);
  assert.equal(nextGroupName([{ id: 'a1', name: 'Audio', layerType: 'group', parentId: null, meta: { audio: audMeta } }]), '圖層組 1');

  const audRange = resolveAudioClipFrameRange(audMeta, 12);
  assert.equal(audRange.startFrame, 6);
  assert.equal(audRange.endFrame, 35); // 2.5s * 12fps = 30 frames -> [6..35]
  assert.equal(audRange.frameCount, 30);

  // Before clip start: scheduled with positive delay
  const winBefore = computeAudioPlaybackWindow(audMeta, 0, 12)!;
  assert.ok(Math.abs(winBefore.delaySec - 0.5) < 1e-6);
  assert.equal(winBefore.bufferOffsetSec, 0);
  assert.ok(Math.abs(winBefore.playDurationSec - 2.5) < 1e-6);
  assert.equal(winBefore.gain, 0.8);

  // Inside clip: zero delay with offset into buffer
  const winMid = computeAudioPlaybackWindow(audMeta, 18, 12)!;
  assert.equal(winMid.delaySec, 0);
  assert.ok(Math.abs(winMid.bufferOffsetSec - 1.0) < 1e-6);
  assert.ok(Math.abs(winMid.playDurationSec - 1.5) < 1e-6);

  // Muted or past end returns null
  assert.equal(computeAudioPlaybackWindow({ ...audMeta, muted: true }, 18, 12), null);
  assert.equal(computeAudioPlaybackWindow(audMeta, 40, 12), null);

  // Waveform peak extraction normalizes max peak to 1
  const peaks = computeWaveformPeaks([0, 0.25, -0.5, 0.1, 0, -0.25, 0.25, 0], 8);
  assert.equal(peaks.length, 8);
  assert.equal(peaks[2], 1);
  assert.equal(peaks[1], 0.5);
  assert.equal(peaks[0], 0);
}
// Phase 3: marquee geometry and modifier keys.
{
  const start = { x: 20, y: 30 };
  const forward = { x: 28, y: 35 };
  const backward = { x: 12, y: 25 };
  assert.deepEqual(computeMarqueeRect(start, forward), { x: 20, y: 30, width: 8, height: 5 });
  assert.deepEqual(computeMarqueeRect(start, backward), { x: 12, y: 25, width: 8, height: 5 });
  assert.deepEqual(computeMarqueeRect(start, start), { x: 20, y: 30, width: 0, height: 0 });

  const quadrants = [
    { end: forward, x: 20, y: 30 },
    { end: { x: 15, y: 38 }, x: 12, y: 30 },
    { end: backward, x: 12, y: 22 },
    { end: { x: 25, y: 22 }, x: 20, y: 22 },
  ];
  for (const { end, x, y } of quadrants) {
    assert.deepEqual(computeMarqueeRect(start, end, { square: true }), { x, y, width: 8, height: 8 });
    const centered = computeMarqueeRect(start, end, { fromCenter: true });
    assert.equal(centered.x + centered.width / 2, start.x);
    assert.equal(centered.y + centered.height / 2, start.y);
    assert.equal(centered.width, 2 * Math.abs(end.x - start.x));
    assert.equal(centered.height, 2 * Math.abs(end.y - start.y));
    assert.deepEqual(computeMarqueeRect(start, end, { square: true, fromCenter: true }), {
      x: 12, y: 22, width: 16, height: 16,
    });
  }
}

// Phase 3: mask rasterization, anti-aliasing and feathered edges.
{
  const width = 24;
  const height = 20;
  const at = (x: number, y: number) => y * width + x;
  const isBinary = (value: number) => value === 0 || value === 255;
  const isGray = (value: number) => value > 0 && value < 255;
  const rect = rasterizeRectMask(3, 5, 5, 4, width, height);
  assert.deepEqual(rect.bounds, { minX: 3, minY: 5, maxX: 7, maxY: 8 });
  assert.equal(rect.activePixelCount, 20);
  assert.equal(rect.data.length, width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const expected = x >= 3 && x <= 7 && y >= 5 && y <= 8 ? 255 : 0;
      assert.equal(rect.data[at(x, y)], expected, `Rectangle coverage at (${x}, ${y})`);
    }
  }

  const ellipse = rasterizeEllipseMask(4, 4, 12, 8, width, height, false);
  const smoothEllipse = rasterizeEllipseMask(4, 4, 12, 8, width, height, true);
  assert.ok(ellipse.data.every(isBinary));
  assert.equal(ellipse.data[at(10, 8)], 255);
  assert.equal(smoothEllipse.data[at(10, 8)], 255);
  assert.equal(smoothEllipse.data[at(0, 0)], 0);
  assert.ok(isGray(smoothEllipse.data[at(5, 5)]), 'Ellipse boundary should have partial coverage');

  const triangle = [{ x: 4, y: 4 }, { x: 16, y: 4 }, { x: 4, y: 16 }];
  const lasso = rasterizeLassoMask(triangle, width, height, false);
  const smoothLasso = rasterizeLassoMask(triangle, width, height, true);
  assert.ok(lasso.data.every(isBinary));
  assert.equal(lasso.data[at(6, 6)], 255);
  assert.equal(smoothLasso.data[at(6, 6)], 255);
  assert.equal(smoothLasso.data[at(0, 0)], 0);
  assert.ok(isGray(smoothLasso.data[at(9, 10)]), 'Lasso diagonal should have partial coverage');

  const source = rasterizeRectMask(16, 16, 32, 32, 64, 64);
  assert.equal(applySelectionPostProcess(source, 0), source);
  const feathered = applySelectionPostProcess(source, 4);
  const outside = feathered.data[32 * source.width + 15];
  const edge = feathered.data[32 * source.width + 16];
  assert.equal(source.data[32 * source.width + 15], 0);
  assert.equal(source.data[32 * source.width + 16], 255);
  assert.ok(isGray(outside) && isGray(edge) && outside < edge, 'Feathering should transition across the original edge');
  assert.equal(feathered.data[32 * source.width + 32], 255);
  assert.equal(feathered.data[32 * source.width], 0);
  assert.ok(feathered.activePixelCount > source.activePixelCount);
  for (const { min, max } of [
    { min: feathered.bounds.minX, max: feathered.bounds.maxX },
    { min: feathered.bounds.minY, max: feathered.bounds.maxY },
  ]) {
    assert.ok(min > 0 && min < 16 && max > 47 && max < 63, 'Feathered bounds should expand around the selection');
  }
}

// Phase 3: replacing, adding and subtracting selection masks.
{
  const width = 16;
  const height = 16;
  const at = (x: number, y: number) => y * width + x;
  const a = rasterizeRectMask(2, 3, 6, 5, width, height);
  const b = rasterizeRectMask(5, 5, 6, 5, width, height);
  assert.deepEqual(combineSelectionMasks(a, b, 'replace'), b);

  const union = combineSelectionMasks(a, b, 'add');
  const overlapCount = 3 * 3;
  assert.equal(union.activePixelCount, a.activePixelCount + b.activePixelCount - overlapCount);
  assert.deepEqual(union.bounds, { minX: 2, minY: 3, maxX: 10, maxY: 9 });
  assert.equal(union.data[at(2, 3)], 255);
  assert.equal(union.data[at(5, 5)], 255);
  assert.equal(union.data[at(10, 9)], 255);
  assert.equal(union.data[at(10, 3)], 0);

  const outer = rasterizeRectMask(2, 2, 12, 12, width, height);
  const inner = rasterizeEllipseMask(5, 5, 6, 6, width, height, false);
  const cutout = combineSelectionMasks(outer, inner, 'subtract');
  assert.equal(cutout.data[at(8, 8)], 0);
  assert.equal(cutout.data[at(2, 8)], 255);
  assert.equal(cutout.data[at(13, 8)], 255);
  assert.equal(cutout.activePixelCount, outer.activePixelCount - inner.activePixelCount);
  assert.deepEqual(cutout.bounds, outer.bounds);

  const empty = rasterizeRectMask(0, 0, 0, 0, width, height);
  assert.deepEqual(combineSelectionMasks(null, inner, 'subtract'), empty);
  assert.deepEqual(combineSelectionMasks(empty, inner, 'subtract'), empty);
}

// Phase 3: partial vector erasing splits a cubic stroke without leaving a hit in the gap.
{
  const baseWidth = 2;
  const anchors: VectorStroke['anchors'] = [
    { x: 0, y: 50, cp2x: 100 / 3, cp2y: 50, pressure: 1, width: baseWidth },
    { x: 100, y: 50, cp1x: 200 / 3, cp1y: 50, pressure: 1, width: baseWidth },
  ];
  const stroke: VectorStroke = {
    id: 'phase-3-stroke', layerId: 'vector-layer', color: '#000000', opacity: 1,
    baseWidth, anchors, bounds: computeStrokeBounds(anchors, baseWidth), createdAt: 0,
  };
  assert.equal(hitTestVectorStroke(stroke, 50, 50, 0), true);
  const pieces = eraseStrokePartial(stroke, 50, 50, 10);
  assert.equal(pieces.length, 2);
  assert.equal(new Set(pieces.map(({ id }) => id)).size, 2);
  for (const piece of pieces) {
    assert.notEqual(piece.id, stroke.id);
    assert.equal(hitTestVectorStroke(piece, 50, 50, 0), false);
  }
  const leftHits = pieces.filter((piece) => hitTestVectorStroke(piece, 10, 50, 0));
  const rightHits = pieces.filter((piece) => hitTestVectorStroke(piece, 90, 50, 0));
  assert.equal(leftHits.length, 1);
  assert.equal(rightHits.length, 1);
  assert.notEqual(leftHits[0].id, rightHits[0].id);

  const untouched = eraseStrokePartial(stroke, 50, 200, 10);
  assert.equal(untouched.length, 1);
  assert.equal(untouched[0], stroke);
  assert.deepEqual(eraseStrokePartial(stroke, 50, 50, 60), []);
}

// Phase 3: select shortcut cycling and independently saved sub-tool parameters.
{
  const selectIds = ['select_rect', 'select_ellipse', 'lasso', 'select_polygon', 'magic_wand', 'select_brush', 'select_eraser'];
  const select = TOOL_CATEGORIES.find(({ id }) => id === 'select');
  const vector = TOOL_CATEGORIES.find(({ id }) => id === 'vector');
  assert.ok(select);
  assert.ok(vector);
  assert.deepEqual(select.subTools.map(({ id }) => id), selectIds);
  assert.deepEqual(vector.subTools.map(({ id }) => id), [
    'vector_pen', 'vector_bezier', 'vector_edit', 'vector_reshape', 'vector_width', 'vector_eraser',
  ]);

  const saved = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { saved.set(key, value); },
  };
  const store = createSubToolStore(storage);
  assert.equal(store.selectCategory('select').id, 'select_rect');
  for (const id of [...selectIds.slice(1), 'select_rect']) {
    assert.equal(store.activateCategoryShortcut('select').id, id);
    assert.equal(store.getState().activeSubToolId, id);
  }

  store.updateSubToolParams('vector_eraser', { vectorEraserMode: 'partial' });
  store.updateSubToolParams('vector_eraser', { brushSize: 42 });
  store.updateSubToolParams('vector_width', { vectorWidthMode: 'thin' });
  store.updateSubToolParams('select_rect', { selectionFeather: 6, selectionAntialias: false });
  store.updateSubToolParams('shape', { shapeSubtype: 'star', shapeLineWidth: 10 });
  store.updateSubToolParams('gradient', { gradientType: 'radial' });

  const restored = createSubToolStore(storage);
  assert.deepEqual(restored.getSubToolParams('vector_eraser'), { vectorEraserMode: 'partial', brushSize: 42 });
  assert.deepEqual(restored.getSubToolParams('vector_width'), { vectorWidthMode: 'thin', brushSize: 32 });
  assert.deepEqual(restored.getSubToolParams('select_rect'), {
    selectionMode: 'replace', selectionFeather: 6, selectionAntialias: false,
  });
  assert.deepEqual(restored.getSubToolParams('select_ellipse'), {
    selectionMode: 'replace', selectionFeather: 0, selectionAntialias: true,
  });
  assert.deepEqual(restored.getSubToolParams('shape'), {
    shapeSubtype: 'star', shapeLineWidth: 10, shapeFillMode: 'stroke', shapeCornerRadius: 0,
  });
  assert.deepEqual(restored.getSubToolParams('gradient'), { gradientType: 'radial' });
}

// Phase 3: default shortcuts distinguish categories from individual tools.
{
  const toolbox = new Map(DEFAULT_SHORTCUTS.filter(({ category }) => category === 'toolbox').map((shortcut) => [shortcut.id, shortcut]));
  assert.equal(TOOL_CATEGORIES.length, 14);
  const categoryShortcutIds = new Set<string>();
  for (const { id, shortcutId } of TOOL_CATEGORIES) {
    assert.ok(shortcutId, `Missing shortcut ID for category ${id}`);
    if (toolbox.has(shortcutId)) {
      assert.equal(toolbox.get(shortcutId)?.toolScope, 'category', `Incorrect shortcut scope for category ${id}`);
    }
    categoryShortcutIds.add(shortcutId);
  }
  assert.equal(categoryShortcutIds.size, TOOL_CATEGORIES.length);
  for (const id of ['tool_select_rect', 'tool_select_polygon', 'tool_vector_eraser', 'tool_magic_wand', 'tool_pencil', 'tool_comic_panel']) {
    assert.equal(toolbox.get(id)?.toolScope, 'subtool', `Incorrect shortcut scope for sub-tool ${id}`);
  }
  for (const [id, { toolScope }] of toolbox) {
    assert.equal(toolScope, categoryShortcutIds.has(id) ? 'category' : 'subtool', `Incorrect toolbox shortcut scope for ${id}`);
  }
}

// Phase 4: Sub View transforms, cursor-anchored zoom and pixel sampling.
{
  assert.equal(clampSubViewZoom(0.01), 0.1);
  assert.equal(clampSubViewZoom(20), 16);
  assert.equal(clampSubViewZoom(2.5), 2.5);
  assert.equal(clampSubViewZoom(NaN), 1);
  assert.equal(normalizeSubViewRotation(-35), 325);
  assert.equal(normalizeSubViewRotation(765), 45);
  for (const angle of [360, -360, NaN, Infinity, -Infinity]) {
    assert.equal(normalizeSubViewRotation(angle), 0);
  }
  assert.equal(computeSubViewFitScale(224, 124, 400, 100), 0.5);
  assert.equal(computeSubViewFitScale(224, 124, 100, 400), 0.25);
  assert.equal(computeSubViewFitScale(224, 124, 0, 100), 1);
  assert.equal(computeSubViewFitScale(20, 124, 400, 100), 1);
  assert.equal(computeSubViewFitScale(224, 124, 100, Infinity), 1);

  const imgW = 360;
  const imgH = 200;
  const size = [744, 424, imgW, imgH] as const;
  const transform = { zoom: 2, panX: 24, panY: -16, rotationDeg: 90, flipH: true };
  const projected = subViewImageToScreen(190, 105, ...size, transform);
  assert.ok(Math.hypot(projected.x - 376, projected.y - 156) < 1e-6, 'Sub View flip and rotation projection');
  for (const flipH of [false, true]) {
    for (const { zoom, panX, panY, rotationDeg } of [
      { zoom: 0.1, panX: -70.5, panY: 23.25, rotationDeg: -37 },
      { zoom: 2.75, panX: 32.75, panY: -55.5, rotationDeg: 123.4 },
      { zoom: 16, panX: -14, panY: -25, rotationDeg: 405 },
    ]) {
      const view = { zoom, panX, panY, rotationDeg, flipH };
      for (const [x, y, inside] of [
        [96.5, 81.25, true], [0.25, 0.25, true], [imgW - 0.25, imgH - 0.25, true],
        [-0.25, 50, false], [imgW + 0.25, 50, false], [50, -0.25, false], [50, imgH + 0.25, false],
      ] as const) {
        const screen = subViewImageToScreen(x, y, ...size, view);
        const image = subViewScreenToImage(screen.x, screen.y, ...size, view);
        const context = `Sub View point (${x}, ${y}), transform ${JSON.stringify(view)}`;
        assert.ok(Math.hypot(image.x - x, image.y - y) < 1e-6, context);
        assert.equal(image.inside, inside, context);
      }
    }
  }
  for (const [x, y, inside] of [[0, 0, true], [imgW, 0, false], [0, imgH, false]] as const) {
    const screen = subViewImageToScreen(x, y, ...size, DEFAULT_SUB_VIEW_TRANSFORM);
    assert.deepEqual(subViewScreenToImage(screen.x, screen.y, ...size, DEFAULT_SUB_VIEW_TRANSFORM), { x, y, inside });
  }

  const anchor = { x: 103.25, y: 74.5 };
  const view = { ...transform, rotationDeg: 51.5 };
  const cursor = subViewImageToScreen(anchor.x, anchor.y, ...size, view);
  for (const [requestedZoom, expectedZoom] of [[0.5, 0.5], [4.75, 4.75], [50, 16]]) {
    const zoomed = zoomSubViewAroundPoint(view, ...size, cursor.x, cursor.y, requestedZoom);
    assert.equal(zoomed.zoom, expectedZoom);
    const nextCursor = subViewImageToScreen(anchor.x, anchor.y, ...size, zoomed);
    assert.ok(Math.hypot(nextCursor.x - cursor.x, nextCursor.y - cursor.y) < 1e-6, `Sub View cursor anchor at zoom ${expectedZoom}`);
  }

  const rgba = new Uint8Array([
    255, 255, 255, 255,  255, 0, 0, 255,
    10, 188, 241, 128,   161, 2, 206, 0,
  ]);
  assert.deepEqual(sampleSubViewPixel(rgba, 2, 2, 0.9, 1.3), { hex: '#0ABCF1', r: 10, g: 188, b: 241, a: 128 });
  assert.deepEqual(sampleSubViewPixel(rgba, 2, 2, 1, 1), { hex: '#A102CE', r: 161, g: 2, b: 206, a: 0 });
  for (const [x, y] of [[-0.01, 0], [2, 0], [0, -0.01], [0, 2], [NaN, 0]]) {
    assert.equal(sampleSubViewPixel(rgba, 2, 2, x, y), null);
  }
  assert.equal(sampleSubViewPixel(rgba.subarray(0, 15), 2, 2, 1, 1), null);
}

// Phase 4: recent colors, pinned palettes and storage round-trip.
{
  const saved = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { saved.set(key, value); },
  };
  const store = createColorHistoryStore(storage);
  const defaultSetId = store.getState().activeSetId;
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  assert.equal(store.recordColor('#abc'), '#AABBCC');
  assert.equal(store.recordColor('a1b2c3'), '#A1B2C3');
  assert.equal(store.recordColor('#aabbcc'), '#AABBCC');
  const history = store.getState().history;
  assert.deepEqual(history.slice(0, 2), ['#AABBCC', '#A1B2C3']);
  assert.equal(history.filter((hex) => hex === '#AABBCC').length, 1);
  assert.equal(notifications, 3);
  assert.equal(store.recordColor(' #AbC '), '#AABBCC');
  assert.equal(store.recordColor('invalid'), null);
  assert.equal(notifications, 3);
  assert.deepEqual(store.getState().history, history);
  unsubscribe();

  assert.equal(COLOR_HISTORY_MAX, 32);
  const colors = Array.from({ length: COLOR_HISTORY_MAX + 3 }, (_, index) => `#2300${(index + 1).toString(16).toUpperCase().padStart(2, '0')}`);
  for (const color of colors) store.recordColor(color);
  assert.deepEqual(store.getState().history, colors.slice(-COLOR_HISTORY_MAX).reverse());

  const custom = store.createPinnedSet('  Portrait  ', ['#123']);
  assert.deepEqual(custom, { id: custom.id, name: 'Portrait', colors: [{ hex: '#112233' }] });
  assert.equal(store.getState().activeSetId, custom.id);
  assert.equal(store.pinColorToActiveSet(' #def ', '  Highlight  '), true);
  assert.equal(store.pinColorToActiveSet('#DDEEFF', 'Duplicate'), false);
  assert.deepEqual(store.getState().pinnedSets.find(({ id }) => id === custom.id)?.colors, [
    { hex: '#112233' }, { hex: '#DDEEFF', name: 'Highlight' },
  ]);
  assert.equal(store.unpinColorFromActiveSet('#123'), true);
  assert.equal(store.unpinColorFromActiveSet('#112233'), false);
  assert.deepEqual(store.getState().pinnedSets.find(({ id }) => id === custom.id)?.colors, [{ hex: '#DDEEFF', name: 'Highlight' }]);

  const imported = store.importPaletteSet('  Night sky  ', [{ hex: '#18a', name: '  Night blue  ' }, '#1188AA', 'invalid']);
  assert.deepEqual(imported, { id: imported.id, name: 'Night sky', colors: [{ hex: '#1188AA', name: 'Night blue' }] });
  assert.equal(store.getState().activeSetId, imported.id);
  assert.equal(store.importPaletteSet('Night sky', imported.colors).id, imported.id);
  assert.deepEqual(store.getState().pinnedSets.map(({ id }) => id), [defaultSetId, custom.id, imported.id]);

  const restored = createColorHistoryStore(storage);
  assert.deepEqual(restored.getState(), store.getState());
  assert.equal(restored.deletePinnedSet(imported.id), true);
  assert.equal(restored.getState().activeSetId, defaultSetId);
  assert.equal(restored.deletePinnedSet(custom.id), true);
  const beforeClear = restored.getState();
  assert.equal(restored.deletePinnedSet(defaultSetId), false);
  assert.deepEqual(restored.getState().pinnedSets.map(({ id }) => id), [defaultSetId]);
  restored.clearHistory();
  assert.deepEqual(restored.getState(), { ...beforeClear, history: [] });
  assert.deepEqual(createColorHistoryStore(storage).getState(), restored.getState());
}

// Phase 4: GPL metadata and swatch names, plus ACO version and color-space compatibility.
{
  assert.equal(normalizeHexColor('#abc'), '#AABBCC');
  assert.equal(normalizeHexColor('a1b2c3'), '#A1B2C3');
  assert.equal(normalizeHexColor(' #ff00aa '), '#FF00AA');
  for (const invalid of ['', '#12', '#ggg', '#12345678', 'red']) {
    assert.equal(normalizeHexColor(invalid), null);
  }

  const gpl = [
    'GIMP Palette', 'Name: Studio Palette', 'Columns: 4', '# 255 255 255 Ignored comment', '',
    '255\t0 128   Rose With Spaces', '  10  11  12', 'broken row', '256 0 0 Too bright', '10 20', '-1 0 0 Negative',
  ].join('\r\n');
  const palette = parseGplPalette(gpl);
  assert.deepEqual(palette, { name: 'Studio Palette', colors: [{ hex: '#FF0080', name: 'Rose With Spaces' }, { hex: '#0A0B0C' }] });
  const serializedGpl = serializeGplPalette(palette.name, palette.colors, 4);
  assert.deepEqual(serializedGpl.split('\n').slice(0, 4), ['GIMP Palette', 'Name: Studio Palette', 'Columns: 4', '#']);
  assert.deepEqual(parseGplPalette(serializedGpl), palette);

  const namedSwatches = [{ hex: '#A1B2C3', name: '晨光' }, { hex: '#FF00AA', name: 'Étoile 🎨' }, { hex: '#000000' }];
  const aco = serializeAcoPalette(namedSwatches);
  const acoView = new DataView(aco.buffer, aco.byteOffset, aco.byteLength);
  const version2Offset = 4 + 10 * namedSwatches.length;
  assert.equal(acoView.getUint16(0), 1);
  assert.equal(acoView.getUint16(2), namedSwatches.length);
  assert.equal(acoView.getUint16(version2Offset), 2);
  assert.equal(acoView.getUint16(version2Offset + 2), namedSwatches.length);
  const unnamedSwatches = namedSwatches.map(({ hex }) => ({ hex }));
  assert.deepEqual(parseAcoPalette(aco.subarray(0, version2Offset)), unnamedSwatches);
  assert.deepEqual(parseAcoPalette(aco.subarray(version2Offset)), namedSwatches);
  assert.deepEqual(parseAcoPalette(aco), namedSwatches);
  assert.deepEqual(parseAcoPalette(aco.subarray(0, aco.length - 1)), unnamedSwatches);

  // Big-endian 16-bit words: version, count, then space and four components per swatch.
  const words = [
    1, 4,
    0, 0x1212, 0x3434, 0x5656, 0,
    1, 21845, 65535, 65535, 0,
    2, 65535, 32768, 0, 32768,
    8, 2500, 0, 0, 0,
  ];
  const acoFixture = new ArrayBuffer(words.length * 2);
  const fixtureView = new DataView(acoFixture);
  words.forEach((word, index) => fixtureView.setUint16(index * 2, word));
  const expectedSwatches = [{ hex: '#123456' }, { hex: '#00FF00' }, { hex: '#804000' }, { hex: '#BFBFBF' }];
  assert.deepEqual(parseAcoPalette(acoFixture), expectedSwatches);
  assert.deepEqual(parseAcoPalette(acoFixture.slice(0, 3)), []);
  assert.deepEqual(parseAcoPalette(acoFixture.slice(0, -1)), expectedSwatches.slice(0, -1));
  for (let length = 0; length < aco.length; length++) {
    assert.doesNotThrow(() => parseAcoPalette(aco.subarray(0, length)), `Truncated ACO at byte ${length}`);
  }
}

// Phase 4: opaque pigment blending, paint and smudge on bounded pixel buffers.
{
  const red = { r: 255, g: 0, b: 0, a: 255 };
  const blue = { r: 0, g: 0, b: 255, a: 255 };
  assert.deepEqual(blendPigmentRgba(red, blue, 0.5), { r: 128, g: 0, b: 128, a: 255 });
  assert.deepEqual(blendPigmentRgba(red, blue, 0), red);
  assert.deepEqual(blendPigmentRgba(red, blue, 1), blue);

  const [width, height] = [41, 21];
  const buffer = new Uint8ClampedArray(width * height * 4);
  seedDefaultMixingPad(buffer, width, height);
  const surface = sampleMixingBuffer(buffer, width, height, 0, 0, 0);
  const pigment = sampleMixingBuffer(buffer, width, height, 9, 6, 0);
  assert.ok(surface && pigment);
  assert.equal(surface.a, 255);
  assert.equal(pigment.a, 255);
  assert.notDeepEqual(pigment, surface);

  paintMixingDab(buffer, width, height, 9, 6, 2, blue, 1, 1);
  assert.deepEqual(sampleMixingBuffer(buffer, width, height, 9, 6, 0), blue);
  assert.deepEqual(sampleMixingBuffer(buffer, width, height, 0, 0, 0), surface);

  assert.deepEqual(strokeMixingSegment(buffer, width, height, 4, 12, 12, 12, {
    mode: 'paint', color: red, radius: 1.5, strength: 1, hardness: 1,
  }), red);
  for (const x of [4, 8, 12]) assert.deepEqual(sampleMixingBuffer(buffer, width, height, x, 12, 0), red);
  for (const [x, y] of [[-1, 0], [width, 0], [0, -1], [0, height]]) {
    assert.equal(sampleMixingBuffer(buffer, width, height, x, y), null);
  }

  const smudgeWidth = 12;
  const smudgeHeight = 5;
  const smudge = new Uint8ClampedArray(smudgeWidth * smudgeHeight * 4);
  for (let y = 0; y < smudgeHeight; y++) {
    for (let x = 0; x < smudgeWidth; x++) {
      smudge.set(x < 6 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * smudgeWidth + x) * 4);
    }
  }
  assert.deepEqual(sampleMixingBuffer(smudge, smudgeWidth, smudgeHeight, 6, 2, 0), blue);
  const carryColor = strokeMixingSegment(smudge, smudgeWidth, smudgeHeight, 2, 2, 9, 2, {
    mode: 'smudge', color: { r: 0, g: 255, b: 0, a: 255 }, radius: 1.5, strength: 0.65,
  });
  const mixed = sampleMixingBuffer(smudge, smudgeWidth, smudgeHeight, 6, 2, 0);
  assert.ok(mixed && carryColor, 'Smudging should produce a mixed pixel and a carry color');
  for (const color of [mixed, carryColor]) {
    assert.ok(color.r > 0 && color.r < 255 && color.b > 0 && color.b < 255);
    assert.equal(color.g, 0);
    assert.equal(color.a, 255);
  }
  assert.deepEqual(sampleMixingBuffer(smudge, smudgeWidth, smudgeHeight, 11, 2, 0), blue);
}

// Phase 4: desktop pop-up placement, slot hit testing and input preferences.
{
  const radius = 80;
  const margin = 12;
  const width = 640;
  const height = 480;
  const inset = radius + margin;
  assert.deepEqual(computePopupPalettePosition(320, 240, radius, width, height, margin), {
    cx: 320, cy: 240, clampedX: false, clampedY: false, clamped: false,
  });
  for (const [x, y, cx, cy] of [
    [2, 3, inset, inset], [638, 3, width - inset, inset],
    [2, 477, inset, height - inset], [638, 477, width - inset, height - inset],
  ]) {
    assert.deepEqual(computePopupPalettePosition(x, y, radius, width, height, margin), { cx, cy, clampedX: true, clampedY: true, clamped: true });
  }
  assert.deepEqual(computePopupPalettePosition(5, 8, radius, 100, 60, margin), {
    cx: 50, cy: 30, clampedX: true, clampedY: true, clamped: true,
  });
  for (const [x, y] of [[NaN, 40], [10, Infinity]]) {
    assert.deepEqual(computePopupPalettePosition(x, y, radius, width, height, margin), {
      cx: 320, cy: 240, clampedX: true, clampedY: true, clamped: true,
    });
  }

  const count = 8;
  const ringRadius = 60;
  const [cx, cy] = [320, 240];
  for (const start of [-90, 360]) {
    const slots = computeRadialSlotPositions(cx, cy, ringRadius, count, start);
    assert.equal(slots.length, count);
    slots.forEach(({ x, y, angleDeg }, index) => {
      const expectedAngle = start + index * 45;
      const radians = expectedAngle * Math.PI / 180;
      assert.equal(angleDeg, expectedAngle);
      assert.ok(Math.hypot(x - cx - ringRadius * Math.cos(radians), y - cy - ringRadius * Math.sin(radians)) < 1e-6);
      assert.equal(hitTestPopupRing(x - cx, y - cy, 40, 80, count, start), index, `Slot ${index} at start angle ${start}`);
    });
  }
  for (const angle of [359.9, 0, 0.1]) {
    const radians = angle * Math.PI / 180;
    assert.equal(hitTestPopupRing(ringRadius * Math.cos(radians), ringRadius * Math.sin(radians), 40, 80, count, 360), 0);
  }
  assert.equal(hitTestPopupRing(0, -ringRadius, 40, 80, count), 0);
  assert.equal(hitTestPopupRing(0, -39, 40, 80, count), null);
  assert.equal(hitTestPopupRing(0, -81, 40, 80, count), null);

  for (const [enabled, trigger, pointer, hasRightButton, expected] of [
    [false, 'right-click', 'mouse', true, false],
    [true, 'right-click', 'touch', true, false],
    [true, 'shortcut-only', 'mouse', true, false],
    [true, 'shortcut-only', 'pen', true, false],
    [true, 'pen-side-button', 'mouse', true, false],
    [true, 'pen-side-button', 'pen', false, false],
    [true, 'pen-side-button', 'pen', true, true],
    [true, 'right-click', 'mouse', true, true],
    [true, 'right-click', 'pen', false, false],
    [true, 'right-click', 'pen', true, true],
  ] as const) {
    assert.equal(shouldOpenDesktopPopupOnContextMenu(enabled, trigger, pointer, hasRightButton), expected,
      `Popup context menu: enabled=${enabled}, trigger=${trigger}, pointer=${pointer}, right button=${hasRightButton}`);
  }

  for (const [id, combo] of [
    ['action_studio_subview', 'Control+Shift+KeyR'], ['action_studio_popup_palette', 'Alt+KeyQ'],
  ]) {
    assert.deepEqual(DEFAULT_SHORTCUTS.filter(({ defaultCombo }) => defaultCombo === combo).map((shortcut) => shortcut.id), [id]);
  }
}

// Phase 5.1: QuickShape recognition, pointer adjustment, sampling and preferences.
{
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const distance = (a: QuickShapePoint, b: QuickShapePoint) => Math.hypot(a.x - b.x, a.y - b.y);
  const center = { x: 140, y: 110 };
  const ovalTrace = (rx: number, ry: number, rotation: number, sweep: number) => (
    Array.from({ length: 121 }, (_, i) => {
      const angle = radians(-25 + sweep * i / 120);
      const x = (rx + 0.4 * Math.sin(i * 1.7)) * Math.cos(angle);
      const y = (ry + 0.4 * Math.cos(i * 1.3)) * Math.sin(angle);
      return {
        x: center.x + x * Math.cos(rotation) - y * Math.sin(rotation),
        y: center.y + x * Math.sin(rotation) + y * Math.cos(rotation),
      };
    })
  );
  const closedTrace = (corners: readonly (readonly [number, number])[], rotation = 0) => {
    const vertices = corners.map(([x, y]) => ({
      x: center.x + x * Math.cos(rotation) - y * Math.sin(rotation),
      y: center.y + x * Math.sin(rotation) + y * Math.cos(rotation),
    }));
    const points = vertices.flatMap((start, i) => {
      const end = vertices[(i + 1) % vertices.length];
      return Array.from({ length: 18 }, (_, step) => ({
        x: start.x + (end.x - start.x) * step / 18 + 0.3 * Math.sin(step * 1.7),
        y: start.y + (end.y - start.y) * step / 18 + 0.3 * Math.sin(step * 1.3),
      }));
    });
    return [...points, vertices[0]];
  };

  for (const degrees of [0, 30, -45]) {
    const angle = radians(degrees);
    const trace = Array.from({ length: 41 }, (_, i) => ({
      x: 20 + i * 3 * Math.cos(angle) - 0.6 * Math.sin(i * 1.7) * Math.sin(angle),
      y: 35 + i * 3 * Math.sin(angle) + 0.6 * Math.sin(i * 1.7) * Math.cos(angle),
    }));
    const line = recognizeQuickShape(trace);
    assert.ok(line?.kind === 'line', `Expected line at ${degrees}°, got ${line?.kind}`);
    assert.ok(distance(line.start, trace[0]) < 1 && distance(line.end, trace[40]) < 1, 'Line endpoints should follow the stroke');

    const pointer = { x: line.start.x + 80 * Math.cos(radians(37)), y: line.start.y + 80 * Math.sin(radians(37)) };
    const snapped = adjustQuickShapeByPointer(line, line.end, pointer, true);
    assert.ok(snapped.kind === 'line');
    assert.ok(Math.abs(Math.atan2(snapped.end.y - snapped.start.y, snapped.end.x - snapped.start.x) - radians(30)) < 1e-6);
    assert.ok(Math.abs(distance(snapped.start, snapped.end) - 80) < 1e-6);
  }
  for (const sweep of [90, 150]) {
    const arc = recognizeQuickShape(ovalTrace(55, 55, 0, sweep));
    assert.ok(arc?.kind === 'arc', `Expected an open ${sweep}° arc, got ${arc?.kind}`);
    assert.ok(distance(arc.center, center) < 2 && Math.abs(arc.radius - 55) < 2, `Inaccurate ${sweep}° arc fit`);
    assert.ok(Math.abs(arc.sweep - radians(sweep)) < radians(3));
  }

  const circle = recognizeQuickShape(ovalTrace(48, 48, 0, 370));
  assert.ok(circle?.kind === 'circle', `Expected a circle with overlapping ends, got ${circle?.kind}`);
  assert.ok(distance(circle.center, center) < 1 && Math.abs(circle.radius - 48) < 1, 'Inaccurate circle fit');
  const scaledCircle = adjustQuickShapeByPointer(circle, { x: circle.center.x + circle.radius, y: circle.center.y },
    { x: circle.center.x, y: circle.center.y + 65 });
  assert.ok(scaledCircle.kind === 'circle');
  assert.equal(scaledCircle.radius, 65);
  assert.equal(scaledCircle.rotation, Math.PI / 2);

  const ellipseAngle = radians(25);
  const ellipse = recognizeQuickShape(ovalTrace(60, 30, ellipseAngle, 360));
  assert.ok(ellipse?.kind === 'ellipse', `Expected a rotated ellipse, got ${ellipse?.kind}`);
  assert.ok(distance(ellipse.center, center) < 1 && Math.abs(ellipse.rx - 60) < 1 && Math.abs(ellipse.ry - 30) < 1);
  assert.ok(Math.abs(Math.sin(ellipse.rotation - ellipseAngle)) < 0.03, 'Ellipse axis should follow the rotation');

  const closedShapes: QuickShapeCandidate[] = [scaledCircle, ellipse];
  for (const { label, corners, rotation, kind } of [
    { label: 'horizontal square', corners: [[-40, -40], [40, -40], [40, 40], [-40, 40]], rotation: 0, kind: 'rectangle' },
    { label: 'rotated rectangle', corners: [[-60, -30], [60, -30], [60, 30], [-60, 30]], rotation: 20, kind: 'rectangle' },
    { label: 'trapezoid', corners: [[-32, -35], [32, -35], [63, 35], [-63, 35]], rotation: 0, kind: 'quadrilateral' },
    { label: 'irregular quadrilateral', corners: [[-52, -32], [53, -42], [37, 43], [-30, 23]], rotation: 0, kind: 'quadrilateral' },
    { label: 'isosceles triangle', corners: [[0, -48], [51, 30], [-51, 30]], rotation: 0, kind: 'triangle' },
    { label: 'scalene triangle', corners: [[-21, -48], [59, 27], [-54, 36]], rotation: 0, kind: 'triangle' },
  ] as const) {
    const fitted = recognizeQuickShape(closedTrace(corners, radians(rotation)));
    assert.ok(fitted?.kind === kind, `Expected ${kind} for ${label}, got ${fitted?.kind}`);
    if (fitted.kind === 'rectangle') {
      const anchor = { x: fitted.center.x + 40, y: fitted.center.y };
      const pointer = { x: fitted.center.x, y: fitted.center.y + 60 };
      const adjusted = adjustQuickShapeByPointer(fitted, anchor, pointer);
      assert.ok(adjusted.kind === 'rectangle');
      assert.ok(Math.abs(adjusted.rotation - fitted.rotation - Math.PI / 2) < 1e-6);
      assert.ok(Math.abs(adjusted.width - fitted.width * 1.5) < 1e-6);
      assert.ok(Math.abs(adjusted.height - fitted.height * 1.5) < 1e-6);
      for (const [index, corner] of fitted.corners.entries()) {
        const expected = {
          x: fitted.center.x - (corner.y - fitted.center.y) * 1.5,
          y: fitted.center.y + (corner.x - fitted.center.x) * 1.5,
        };
        assert.ok(distance(adjusted.corners[index], expected) < 1e-6, `Adjusted ${label} corner ${index}`);
      }
    }
    closedShapes.push(fitted);
  }

  assert.equal(recognizeQuickShape(Array.from({ length: 9 }, (_, i) => ({ x: i * 2, y: 0 }))), null,
    'A 16px stroke should not snap');
  for (const cycles of [1, 3]) {
    const scribble = Array.from({ length: 81 }, (_, i) => ({
      x: i * 2, y: 25 * Math.sin(cycles * 2 * Math.PI * i / 80),
    }));
    assert.equal(recognizeQuickShape(scribble), null, `A ${cycles}-cycle wave should not snap`);
  }

  const spacing = 5;
  for (const shape of closedShapes) {
    const points = sampleQuickShapePoints(shape, spacing, 0.6);
    assert.ok(points.length > 4, `Expected samples for ${shape.kind}`);
    assert.deepEqual(points[0], points[points.length - 1], `Expected a closed ${shape.kind} path`);
    for (let i = 1; i < points.length; i++) {
      const step = distance(points[i - 1], points[i]);
      assert.ok(step >= spacing * 0.5 && step <= spacing + 1e-6, `Unexpected ${shape.kind} sample spacing: ${step}`);
    }
    const dabs = buildQuickShapeDabs(points, 8, 0.85);
    assert.equal(dabs.length, points.length * 7, `Expected seven floats per ${shape.kind} dab`);
    assert.ok(dabs.every(Number.isFinite), `Non-finite ${shape.kind} dab`);
  }

  const initialEnabled = getQuickShapeEnabled();
  const initialDelay = getQuickShapeDelayMs();
  try {
    for (const enabled of [false, true]) {
      setQuickShapeEnabled(enabled);
      assert.equal(getQuickShapeEnabled(), enabled);
    }
    for (const [requested, expected] of [[0, 180], [625, 625], [2000, 1500]]) {
      setQuickShapeDelayMs(requested);
      assert.equal(getQuickShapeDelayMs(), expected, `QuickShape delay for ${requested}ms`);
    }
  } finally {
    setQuickShapeEnabled(initialEnabled);
    setQuickShapeDelayMs(initialDelay);
  }
}

// Phase 5.2: Puppet Warp mesh coverage, pin constraints and premultiplied rasterization.
{
  const size = 120;
  const left = 25, top = 35, right = 95, bottom = 85;
  const expansion = 4;
  const whiteOnTransparent = (isForeground: (x: number, y: number) => boolean) => {
    const rgba = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isForeground(x, y)) rgba.fill(255, (y * size + x) * 4, (y * size + x + 1) * 4);
      }
    }
    return rgba;
  };
  const inRectangle = (x: number, y: number) => x >= left && x < right && y >= top && y < bottom;
  const checkMesh = (mesh: PuppetMesh, label: string) => {
    assert.ok(mesh.vertexCount > 0 && mesh.triangleCount > 0, `Empty ${label} mesh`);
    assert.equal(mesh.vertices.length, mesh.vertexCount * 2);
    assert.equal(mesh.triangles.length, mesh.triangleCount * 3);
    assert.ok(mesh.vertices.every(Number.isFinite), `Non-finite ${label} mesh vertex`);
    assert.ok(mesh.triangles.every((index) => index < mesh.vertexCount), `Invalid ${label} triangle index`);
    assert.equal(mesh.neighbors.length, mesh.vertexCount);
    assert.equal(mesh.edgeWeights.length, mesh.vertexCount);
    for (const [index, weights] of mesh.edgeWeights.entries()) {
      assert.ok(weights.length > 0);
      assert.equal(weights.length, mesh.neighbors[index].length);
      assert.ok(weights.every((weight) => Number.isFinite(weight) && weight > 0), `Invalid ${label} edge weight`);
    }
  };

  const inL = (x: number, y: number) => inRectangle(x, y) && (x < 45 || y >= 65);
  const lSource = whiteOnTransparent(inL);
  let lastVertexCount = 0;
  for (const density of ['coarse', 'normal', 'dense'] as const) {
    const mesh = buildPuppetMeshFromAlpha(lSource, size, size, { density, expansionPx: expansion });
    checkMesh(mesh, density);
    assert.ok(mesh.vertexCount > lastVertexCount, `Expected more vertices at ${density} density`);
    lastVertexCount = mesh.vertexCount;
    const xs = mesh.vertices.filter((_, i) => i % 2 === 0);
    const ys = mesh.vertices.filter((_, i) => i % 2 === 1);
    const padding = 5; // Four pixels of dilation and one pixel of bilinear support.
    assert.deepEqual([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      [left - padding, top - padding, right + padding, bottom + padding], `${density} mesh coverage bounds`);
    assert.ok(!xs.some((x, i) => x > 70 && ys[i] < 49), `${density} mesh should leave the L-shaped notch open`);

    const identity = rasterizePuppetWarpToRgba(lSource, size, size, mesh, mesh.vertices, 0);
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const alphaIndex = ((y - identity.minY) * identity.width + x - identity.minX) * 4 + 3;
        assert.equal(identity.rgba[alphaIndex], inL(x, y) ? 255 : 0, `${density} mesh coverage at (${x}, ${y})`);
      }
    }
  }
  const transparent = buildPuppetMeshFromAlpha(new Uint8ClampedArray(size * size * 4), size, size);
  checkMesh(transparent, 'transparent fallback');
  assert.ok(solvePuppetWarp(transparent, []).every(Number.isFinite));

  const source = whiteOnTransparent(inRectangle);
  const mesh = buildPuppetMeshFromAlpha(source, size, size, { density: 'normal' });
  assert.deepEqual(solvePuppetWarp(mesh, []), mesh.vertices, 'Zero pins must preserve the rest mesh');
  const attached = attachPinToMesh(mesh, 60.25, 59.75, 'rigid');
  assert.deepEqual([attached.restX, attached.restY], [60.25, 59.75]);
  const rigidPin = { ...attached, x: attached.x + 7.25, y: attached.y - 3.5, rotation: Math.PI / 4 };
  const rigid = solvePuppetWarp(mesh, [rigidPin]);
  assert.ok(rigid.every(Number.isFinite), 'Single-pin solve produced a non-finite vertex');
  for (let i = 0; i < mesh.vertices.length; i += 2) {
    const x = mesh.vertices[i] - rigidPin.restX;
    const y = mesh.vertices[i + 1] - rigidPin.restY;
    const diagonal = Math.SQRT1_2;
    const movedX = rigid[i] - rigidPin.x;
    const movedY = rigid[i + 1] - rigidPin.y;
    assert.ok(Math.hypot(movedX - (x - y) * diagonal, movedY - (x + y) * diagonal) < 1e-5,
      `Single pin should rigidly transform vertex ${i / 2}`);
    assert.ok(Math.abs(Math.hypot(movedX, movedY) - Math.hypot(x, y)) < 1e-5,
      `Single pin should preserve distance to vertex ${i / 2}`);
  }

  const fixed = attachPinToMesh(mesh, 34.25, 60.5, 'fixed', 2);
  const drag = attachPinToMesh(mesh, 87.75, 60.5, 'dragged', 4);
  const bentPin = { ...drag, x: 80, y: 33, rotation: Math.PI / 6 };
  const bent = solvePuppetWarp(mesh, [fixed, bentPin]);
  assert.ok(bent.every(Number.isFinite), 'Multi-pin solve produced a non-finite vertex');
  const checkPinTarget = (pin: PuppetPin) => {
    let x = 0;
    let y = 0;
    for (const [corner, weight] of pin.barycentric.entries()) {
      const index = mesh.triangles[pin.triangleIndex * 3 + corner] * 2;
      x += bent[index] * weight;
      y += bent[index + 1] * weight;
    }
    assert.ok(Math.hypot(x - pin.x, y - pin.y) < 0.15, `Pin ${pin.id} missed its target: (${x}, ${y})`);
  };
  checkPinTarget(fixed);
  checkPinTarget(bentPin);
  const withoutRotation = solvePuppetWarp(mesh, [fixed, { ...bentPin, rotation: 0 }]);
  const dragFace = mesh.triangles.subarray(bentPin.triangleIndex * 3, bentPin.triangleIndex * 3 + 3);
  assert.ok(dragFace.some((vertex) =>
    Math.hypot(bent[vertex * 2] - withoutRotation[vertex * 2], bent[vertex * 2 + 1] - withoutRotation[vertex * 2 + 1]) > 0.1),
  'The 30° pin rotation should change the deformation around the dragged pin');
  const edgeLength = (vertices: Float32Array, a: number, b: number) =>
    Math.hypot(vertices[a * 2] - vertices[b * 2], vertices[a * 2 + 1] - vertices[b * 2 + 1]);
  for (const [vertex, neighbors] of mesh.neighbors.entries()) {
    for (const neighbor of neighbors) {
      const ratio = edgeLength(bent, vertex, neighbor) / edgeLength(mesh.vertices, vertex, neighbor);
      assert.ok(ratio > 0.55 && ratio < 1.65, `Excessive edge deformation at ${vertex}–${neighbor}: ${ratio}`);
    }
  }

  const islandSource = whiteOnTransparent((x, y) => y >= 38 && y < 80 && ((x >= 12 && x < 42) || (x >= 79 && x < 108)));
  const islands = buildPuppetMeshFromAlpha(islandSource, size, size, { density: 'normal' });
  const leftIsland = new Set([0]);
  for (const vertex of leftIsland) {
    for (const neighbor of islands.neighbors[vertex]) leftIsland.add(neighbor);
  }
  assert.ok(leftIsland.size > 0 && leftIsland.size < islands.vertexCount, 'The island fixture must be disconnected');
  const islandFixed = attachPinToMesh(islands, 19.5, 50.5, 'island-fixed', 2);
  const islandDrag = attachPinToMesh(islands, 34.5, 68.5, 'island-dragged', 3);
  for (const pin of [islandFixed, islandDrag]) {
    assert.ok(leftIsland.has(islands.triangles[pin.triangleIndex * 3]), 'Both pins must attach to the first island');
  }
  const deformedIslands = solvePuppetWarp(islands, [islandFixed, { ...islandDrag, y: islandDrag.y + 8, rotation: 0.2 }]);
  assert.equal(deformedIslands.length, islands.vertices.length);
  assert.ok(deformedIslands.every(Number.isFinite), 'The unpinned island must solve safely');

  const shifted = solvePuppetWarp(mesh, [{ ...attached, x: attached.x + 0.45, y: attached.y - 0.6, rotation: Math.PI / 36 }]);
  assert.ok(shifted.every(Number.isFinite), 'Raster fixture needs finite deformed vertices');
  const raster = rasterizePuppetWarpToRgba(source, size, size, mesh, shifted);
  assert.ok([raster.minX, raster.minY, raster.width, raster.height].every(Number.isFinite));
  assert.equal(raster.rgba.length, raster.width * raster.height * 4);
  assert.ok(raster.rgba.every(Number.isFinite));
  let translucentCount = 0;
  let opaqueCount = 0;
  for (let i = 0; i < raster.rgba.length; i += 4) {
    const alpha = raster.rgba[i + 3];
    if (alpha === 255) opaqueCount++;
    if (alpha <= 0 || alpha >= 255) continue;
    translucentCount++;
    assert.ok(raster.rgba[i] >= 250 && raster.rgba[i + 1] >= 250 && raster.rgba[i + 2] >= 250,
      `Dark fringe at raster pixel ${i / 4}: ${raster.rgba.subarray(i, i + 4).join(',')}`);
  }
  assert.ok(opaqueCount > 0 && translucentCount > 0, 'The warped raster must contain an opaque interior and antialiased edges');
}

// Phase 5.3: Wrap-Around stamps, dirty tiles, flood fill and default shortcuts.
{
  const size = 512;
  const tileSize = 256;
  for (const [input, expected] of [[-1, 511], [-512, 0], [-513, 511], [0, 0], [512, 0], [1025, 1], [-0, 0]]) {
    assert.equal(wrapCoord(input, size), expected, `wrapCoord(${Object.is(input, -0) ? '-0' : input})`);
    assert.deepEqual(wrapPoint(input, input, size, size), { x: expected, y: expected });
  }
  assert.deepEqual(wrapPoint(-513, 1025, size, 256), { x: 511, y: 1 });

  const pointKeys = (points: ReadonlyArray<{ x: number; y: number }>) =>
    points.map(({ x, y }) => `${x},${y}`).sort();
  const radius = 10;
  assert.deepEqual(pointKeys(getWrappedStampPoints(256, 256, radius, size, size)), ['256,256']);
  assert.deepEqual(pointKeys(getWrappedStampPoints(5, 256, radius, size, size)), ['5,256', '517,256']);
  assert.deepEqual(pointKeys(getWrappedStampPoints(5, 6, radius, size, size)), ['5,518', '5,6', '517,518', '517,6']);

  const offsetKeys = (minX: number, minY: number, maxX: number, maxY: number) =>
    getWrapAroundBoundsOffsets(minX, minY, maxX, maxY, size, size).map(({ dx, dy }) => `${dx},${dy}`).sort();
  assert.deepEqual(offsetKeys(-10, 100, 10, 120), ['0,0', '512,0']);
  assert.deepEqual(offsetKeys(100, -10, 120, 10), ['0,0', '0,512']);
  assert.deepEqual(offsetKeys(-10, -10, 10, 10), ['0,0', '0,512', '512,0', '512,512']);
  const tileKeys = (tiles: ReadonlyArray<{ col: number; row: number }>) =>
    tiles.map(({ col, row }) => `${col},${row}`).sort();
  const cornerTiles = ['0,0', '0,1', '1,0', '1,1'];
  assert.deepEqual(tileKeys(getWrappedDirtyTilesForBounds(-10, -10, 10, 10, size, size, tileSize)), cornerTiles);
  assert.deepEqual(tileKeys(getWrappedDirtyTilesForPoints(
    [{ x: 0, y: 0 }, { x: -2, y: -2, radius: 8 }, { x: 2, y: 2, radius: 8 }],
    radius, size, size, tileSize,
  )), cornerTiles, 'Overlapping stamps must return each corner tile only once');

  const fillSize = 32;
  const pixelIndex = (x: number, y: number) => y * fillSize + x;
  for (const axis of ['horizontal', 'vertical'] as const) {
    const pixels = new Uint8ClampedArray(fillSize * fillSize * 4);
    const point = (across: number, along: number) => axis === 'horizontal'
      ? { x: across, y: along } : { x: along, y: across };
    const index = (across: number, along: number) => {
      const { x, y } = point(across, along);
      return pixelIndex(x, y);
    };
    // The full-length wall forces wrapping. The sealed box encloses matching transparent pixels.
    for (let along = 0; along < fillSize; along++) {
      pixels[index(16, along) * 4 + 3] = 255;
    }
    for (let across = 4; across <= 12; across++) {
      pixels[index(across, 10) * 4 + 3] = 255;
      pixels[index(across, 22) * 4 + 3] = 255;
    }
    for (let along = 10; along <= 22; along++) {
      pixels[index(4, along) * 4 + 3] = 255;
      pixels[index(12, along) * 4 + 3] = 255;
    }
    const mask = computeWrappedFloodFillMask(pixels, fillSize, fillSize, [point(1, 16)], 0);
    assert.ok(mask);
    assert.equal(mask.data[index(1, 16)], 255);
    assert.equal(mask.data[index(30, 16)], 255, `Flood fill should cross the ${axis} seam`);
    assert.equal(mask.data[index(16, 16)], 0, `Flood fill should respect the ${axis} barrier`);
    assert.equal(mask.data[index(8, 16)], 0, 'Matching pixels in the sealed pocket must stay clear');
  }

  // The only matching pixel is at the corner, so hits across a seam must come from expansion.
  const expansionSource = new Uint8ClampedArray(fillSize * fillSize * 4).fill(255);
  expansionSource.fill(0, 0, 4);
  const expanded = computeWrappedFloodFillMask(expansionSource, fillSize, fillSize, [{ x: 0, y: 0 }], 0, 2);
  assert.ok(expanded);
  for (const [x, y, expected] of [[0, 0, 255], [30, 0, 255], [0, 30, 255], [31, 31, 255], [30, 30, 0], [3, 0, 0]]) {
    assert.equal(expanded.data[pixelIndex(x, y)], expected, `Wrapped radius-2 expansion at (${x}, ${y})`);
  }

  const seen = new Map<string, string>();
  for (const { id, defaultCombo } of DEFAULT_SHORTCUTS) {
    if (!defaultCombo) continue;
    assert.ok(!seen.has(defaultCombo), `Duplicate default shortcut ${defaultCombo}: ${seen.get(defaultCombo)} and ${id}`);
    seen.set(defaultCombo, id);
  }
  for (const [id, combo] of [
    ['action_filter_puppet_warp', 'Control+Alt+KeyP'],
    ['action_filter_free_transform', ''],
    ['tool_transform', 'Control+KeyT'],
    ['action_view_wrap_around', 'Alt+KeyW'],
    ['tool_magic_wand', 'KeyW'],
  ]) {
    assert.equal(DEFAULT_SHORTCUTS.find((shortcut) => shortcut.id === id)?.defaultCombo, combo, `Default binding for ${id}`);
  }
}

console.log('ui-logic checks passed');

// Phase 6: adjustment layers (shared math)
{
  type Rgb = [number, number, number];
  const checkSamples = (adjustment: LayerAdjustment, samples: [Rgb, Rgb][]) => {
    const compiled = compileAdjustment(adjustment);
    assert.equal(compiled.identity, false);
    for (const [input, expected] of samples) {
      assert.deepStrictEqual(applyCompiledAdjustmentRgb(compiled, ...input), expected);
    }
  };

  const programs = { hsl: 2, levels: 0, curves: 0, color_balance: 1, gradient_map: 3, brightness_contrast: 0 };
  assert.deepStrictEqual(ADJUSTMENT_KINDS, Object.keys(programs));
  for (const kind of ADJUSTMENT_KINDS) {
    const defaults = createDefaultAdjustment(kind);
    const compiled = compileAdjustment(defaults);
    assert.equal(isAdjustmentIdentity(defaults), kind !== 'gradient_map');
    assert.equal(compiled.identity, kind !== 'gradient_map');
    assert.equal(compiled.lut.length, 256 * 4);
    assert.equal(compiled.lut[255 * 4 + 3], 255);
    if (compiled.identity) {
      for (const rgb of [[255, 0, 0], [128, 128, 128], [23, 211, 63]] as const) {
        assert.deepStrictEqual(applyCompiledAdjustmentRgb(compiled, ...rgb), rgb);
      }
    }
    assert.deepStrictEqual(normalizeAdjustment({ kind }), defaults);
    assert.deepStrictEqual(normalizeAdjustment(defaults), defaults);
    assert.deepStrictEqual(normalizeAdjustment(JSON.parse(JSON.stringify(defaults))), defaults);
    const uniforms = compiledAdjustmentUniforms(compiled, 'multiply');
    assert.equal(uniforms.program, programs[kind]);
    assert.equal(uniforms.blendId, ADJUSTMENT_BLEND_MODE_IDS.multiply);
  }

  checkSamples({ kind: 'hsl', params: { hue: 120, saturation: 0, lightness: 0, colorize: false } }, [
    [[255, 0, 0], [0, 255, 0]], [[128, 128, 128], [128, 128, 128]], [[18, 200, 42], [42, 18, 200]],
  ]);
  checkSamples({ kind: 'hsl', params: { hue: 0, saturation: 100, lightness: 0, colorize: true } }, [
    [[255, 0, 0], [152, 0, 0]], [[128, 128, 128], [255, 1, 1]], [[0, 0, 255], [58, 0, 0]],
  ]);

  const levels = createDefaultAdjustment('levels');
  assert.ok(levels.kind === 'levels');
  Object.assign(levels.params.master, { inBlack: 64, inWhite: 192 });
  checkSamples(levels, [
    [[128, 64, 192], [128, 0, 255]], [[96, 160, 0], [64, 191, 0]], [[240, 32, 128], [255, 0, 128]],
  ]);
  Object.assign(levels.params.master, { gamma: 2 });
  checkSamples(levels, [
    [[128, 64, 192], [180, 0, 255]], [[96, 160, 0], [128, 221, 0]], [[240, 32, 128], [255, 0, 180]],
  ]);
  Object.assign(levels.params.red, { outBlack: 16, outWhite: 144 });
  checkSamples(levels, [
    [[96, 64, 192], [80, 0, 255]], [[64, 160, 0], [16, 221, 0]], [[240, 32, 128], [144, 0, 180]],
  ]);

  const curves = createDefaultAdjustment('curves');
  assert.ok(curves.kind === 'curves');
  const inverted = [{ x: 0, y: 255 }, { x: 255, y: 0 }];
  curves.params.master = inverted;
  checkSamples(curves, [
    [[255, 0, 0], [0, 255, 255]], [[128, 128, 128], [127, 127, 127]], [[18, 200, 42], [237, 55, 213]],
  ]);
  const invert = compileAdjustment(curves);
  curves.params.red = inverted;
  assert.deepStrictEqual(applyCompiledAdjustmentRgb(compileAdjustment(curves), 18, 200, 42), [18, 55, 213]);
  curves.params.master = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
  checkSamples(curves, [
    [[255, 0, 0], [0, 0, 0]], [[128, 128, 128], [127, 128, 128]], [[18, 200, 42], [237, 200, 42]],
  ]);
  curves.params.red = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  checkSamples(curves, [
    [[0, 3, 4], [0, 3, 4]], [[1, 3, 4], [1, 3, 4]], [[255, 3, 4], [1, 3, 4]],
  ]);

  const balance = createDefaultAdjustment('color_balance');
  assert.ok(balance.kind === 'color_balance');
  balance.params.shadows.cyanRed = 50;
  balance.params.highlights.yellowBlue = -50;
  balance.params.preserveLuminosity = false;
  // Both outer tones are at full weight (0.7), which shifts their channels by 89.25 bytes.
  checkSamples(balance, [
    [[32, 32, 32], [121, 32, 32]], [[128, 128, 128], [128, 128, 128]], [[224, 224, 224], [224, 224, 135]],
  ]);
  balance.params.preserveLuminosity = true;
  checkSamples(balance, [
    [[32, 32, 32], [51, 13, 13]], [[128, 128, 128], [128, 128, 128]], [[224, 224, 224], [242, 242, 206]],
  ]);
  for (const lightness of [32, 128, 224]) {
    const rgb = applyCompiledAdjustmentRgb(compileAdjustment(balance), lightness, lightness, lightness);
    assert.ok(Math.abs((Math.min(...rgb) + Math.max(...rgb)) / 2 - lightness) <= 1);
  }

  const gradient = createDefaultAdjustment('gradient_map');
  assert.ok(gradient.kind === 'gradient_map');
  gradient.params.stops[1].color = '#ff0000';
  checkSamples(gradient, [
    [[0, 0, 0], [0, 0, 0]], [[255, 255, 255], [255, 0, 0]], [[255, 0, 0], [76, 0, 0]],
  ]);
  gradient.params.reverse = true;
  checkSamples(gradient, [
    [[0, 0, 0], [255, 0, 0]], [[255, 255, 255], [0, 0, 0]], [[255, 0, 0], [179, 0, 0]],
  ]);

  checkSamples({ kind: 'brightness_contrast', params: { brightness: 150, contrast: 0 } }, [
    [[0, 128, 255], [128, 192, 255]], [[22, 64, 192], [139, 160, 224]], [[100, 151, 230], [178, 203, 243]],
  ]);
  checkSamples({ kind: 'brightness_contrast', params: { brightness: 0, contrast: 100 } }, [
    [[0, 128, 255], [0, 129, 255]], [[22, 64, 192], [0, 0, 255]], [[100, 151, 230], [61, 184, 255]],
  ]);
  checkSamples({ kind: 'brightness_contrast', params: { brightness: -150, contrast: -50 } }, [
    [[0, 128, 255], [42, 85, 128]], [[22, 64, 192], [50, 64, 106]], [[100, 151, 230], [76, 93, 119]],
  ]);

  assert.equal(normalizeAdjustment(null), null);
  assert.equal(normalizeAdjustment('hsl'), null);
  assert.equal(normalizeAdjustment({ kind: 'unknown' }), null);
  const hslRaw = { kind: 'hsl', params: { hue: 450, saturation: -150, lightness: NaN, colorize: 'true' } };
  assert.deepStrictEqual(normalizeAdjustment(hslRaw), {
    kind: 'hsl', params: { hue: 180, saturation: -100, lightness: 0, colorize: false },
  });
  assert.deepStrictEqual(normalizeAdjustment({ ...hslRaw, params: { ...hslRaw.params, colorize: true } }), {
    kind: 'hsl', params: { hue: 360, saturation: 0, lightness: 0, colorize: true },
  });
  const messyLevels = normalizeAdjustment({ kind: 'levels', params: {
    master: { inBlack: 254, inWhite: 40, gamma: Infinity, outBlack: 250.7, outWhite: -4 },
    red: { inBlack: 100, inWhite: 101, gamma: 2.116 },
  } });
  assert.ok(messyLevels?.kind === 'levels');
  assert.deepStrictEqual(messyLevels.params.master, { inBlack: 253, inWhite: 255, gamma: 1, outBlack: 251, outWhite: 0 });
  assert.deepStrictEqual(messyLevels.params.red, { inBlack: 100, inWhite: 102, gamma: 2.12, outBlack: 0, outWhite: 255 });
  const manyPoints = Array.from({ length: 20 }, (_, x) => ({ x, y: x * 2 })).reverse();
  const messyCurves = normalizeAdjustment({ kind: 'curves', params: {
    master: [...manyPoints, { x: 2.2, y: 400 }], green: [{ x: 3, y: 4 }, { x: 3, y: 5 }],
  } });
  assert.ok(messyCurves?.kind === 'curves');
  assert.deepStrictEqual(messyCurves.params.master, Array.from({ length: 16 }, (_, x) => ({ x, y: x === 2 ? 255 : x * 2 })));
  assert.deepStrictEqual(messyCurves.params.green, [{ x: 0, y: 0 }, { x: 255, y: 255 }]);
  const messyGradient = normalizeAdjustment({ kind: 'gradient_map', params: {
    stops: [
      { offset: 0.7384, color: '#09F' }, { offset: 2, color: 'invalid' },
      { offset: -2, color: '#cde' }, { offset: 0, color: '#ABC' },
      { offset: 0.73849, color: '#01aFc0' },
    ],
    reverse: 'true',
  } });
  assert.deepStrictEqual(messyGradient, { kind: 'gradient_map', params: {
    stops: [{ offset: 0, color: '#aabbcc' }, { offset: 0.738, color: '#01afc0' }, { offset: 1, color: '#ffffff' }],
    reverse: false,
  } });
  const manyStops = Array.from({ length: 20 }, (_, i) => ({ offset: i / 20, color: '#000000' }));
  const limitedGradient = normalizeAdjustment({ kind: 'gradient_map', params: { stops: [...manyStops].reverse() } });
  assert.ok(limitedGradient?.kind === 'gradient_map');
  assert.deepStrictEqual(limitedGradient.params.stops, manyStops.slice(0, 16));
  const messyBrightness = normalizeAdjustment({ kind: 'brightness_contrast', params: { brightness: -0.1, contrast: -51 } });
  assert.deepStrictEqual(messyBrightness, { kind: 'brightness_contrast', params: { brightness: 0, contrast: -50 } });
  for (const messy of [normalizeAdjustment(hslRaw), messyLevels, messyCurves, messyGradient, messyBrightness]) {
    assert.ok(messy);
    assert.deepStrictEqual(normalizeAdjustment(messy), messy);
    assert.deepStrictEqual(normalizeAdjustment(JSON.parse(JSON.stringify(messy))), messy);
  }

  const src: Rgb = [0.25, 0.5, 0.75];
  const dst: Rgb = [0.5, 0.75, 0.25];
  assert.deepStrictEqual(blendAdjustmentRgb(src, dst, 'normal'), src);
  assert.deepStrictEqual(blendAdjustmentRgb(src, dst, 'multiply'), [0.125, 0.375, 0.1875]);
  assert.deepStrictEqual(blendAdjustmentRgb(src, dst, 'screen'), [0.625, 0.875, 0.8125]);
  assert.deepStrictEqual(blendAdjustmentRgb(src, dst, 'darker_color'), src);
  assert.deepStrictEqual(blendAdjustmentRgb(src, dst, 'lighter_color'), dst);
  assert.equal(adjustmentBlendModeId('unknown'), 0);
  assert.equal(adjustmentBlendModeId('constructor'), 0);
  assert.equal(adjustmentBlendModeId('Linear-Dodge'), ADJUSTMENT_BLEND_MODE_IDS.add);
  const lum = ([r, g, b]: Rgb) => 0.3 * r + 0.59 * g + 0.11 * b;
  const luminosity = blendAdjustmentRgb(src, dst, 'luminosity');
  const shift = lum(src) - lum(dst);
  assert.ok(luminosity.every((value, i) => Math.abs(value - (dst[i] + shift)) < 1e-6));
  assert.ok(Math.abs(lum(luminosity) - lum(src)) < 1e-6);
  assert.ok(Math.abs(lum(blendAdjustmentRgb(src, dst, 'color')) - lum(dst)) < 1e-6);
  assert.ok(Math.abs(lum(blendAdjustmentRgb([1, 0, 0], [0.9, 0.9, 0.9], 'color')) - 0.9) < 1e-6);

  const step = { width: 1, height: 1, compiled: invert, blendMode: 'normal', coverage: null, opacity: 1, scope: null };
  const straight = new Uint8ClampedArray([40, 100, 200, 128]);
  applyAdjustmentStep({ ...step, target: straight });
  assert.deepStrictEqual([...straight], [215, 155, 55, 128]);
  applyAdjustmentStep({ ...step, target: straight, opacity: 0.5 });
  assert.ok(straight.slice(0, 3).every((value) => Math.abs(value - 127.5) <= 1));
  assert.equal(straight[3], 128);
  const masked = new Uint8Array([40, 100, 200, 255, 50, 100, 150, 255, 0, 255, 51, 255]);
  applyAdjustmentStep({ ...step, width: 3, target: masked, coverage: new Uint8Array([255, 0, 85]) });
  assert.deepStrictEqual([...masked], [215, 155, 55, 255, 50, 100, 150, 255, 85, 170, 102, 255]);

  const premultipliedRoot = new Uint8Array([128, 0, 0, 128]);
  applyAdjustmentStep({ ...step, target: premultipliedRoot, premultiplied: true });
  assert.deepStrictEqual([...premultipliedRoot], [0, 128, 128, 128]);
  applyAdjustmentStep({ ...step, target: premultipliedRoot, premultiplied: true, opacity: 0.5 });
  assert.deepStrictEqual([...premultipliedRoot], [64, 64, 64, 128]);

  for (const premultiplied of [false, true]) {
    const target = new Uint8Array([26, 75, 110, 255, 64, 128, 192, 255, 128, 0, 127, 255]);
    const scope = new Uint8Array([0, 0, 0, 0, 64, 128, 192, 255, premultiplied ? 128 : 255, 0, 0, 128]);
    applyAdjustmentStep({ ...step, width: 3, target, scope, premultiplied });
    // Red (128/255 alpha) over blue: [128, 0, 127] + [0, 128, 128] - [128, 0, 0].
    assert.deepStrictEqual([...target], [26, 75, 110, 255, 191, 127, 63, 255, 0, 128, 255, 255]);
  }

  const layer = (id: string, sortOrder: number, layerType: LayerModel['layerType'] = 'raster',
    parentId: string | null = null, clipToBelow = false, createdAt = 0) =>
    ({ id, sortOrder, layerType, parentId, clipToBelow, createdAt });
  const layers = [
    layer('above', 8, 'raster', 'group'), layer('group', 9, 'group'), layer('nested', 4, 'group', 'group'),
    layer('root', 10, 'adjustment'), layer('base', 1, 'adjustment', 'nested'), layer('outside', 0),
    layer('clipped-y', 2, 'raster', 'nested', true, 4), layer('clipped-z', 2, 'adjustment', 'nested', true, 3),
    layer('clipped-a', 2, 'raster', 'nested', true, 4), layer('mask', 2, 'mask', 'base'),
    layer('clip-adjust', 3, 'adjustment', 'nested', true), layer('group-adjust', 5, 'adjustment', 'group'),
    layer('own', 4, 'raster', 'group'),
  ];
  assert.deepStrictEqual(resolveAdjustmentScope(layers, 'root'), { kind: 'root' });
  assert.deepStrictEqual(resolveAdjustmentScope(layers, 'clip-adjust'), {
    kind: 'clip', baseId: 'base', memberIds: ['base', 'clipped-z', 'clipped-a', 'clipped-y'],
  });
  assert.equal(adjustmentClipBaseId(layers, 'clipped-y'), 'base');
  assert.deepStrictEqual(resolveAdjustmentScope(layers, 'group-adjust'), {
    kind: 'group', groupId: 'group', memberIds: ['base', 'clipped-z', 'clipped-a', 'clipped-y', 'clip-adjust', 'own'],
  });
  const baseline = [layer('mask', 0, 'mask'), layer('first-clip', 1, 'raster', null, true)];
  assert.deepStrictEqual(resolveAdjustmentScope([...baseline, layer('bottom', 2, 'adjustment', null, true)], 'bottom'), { kind: 'root' });
  assert.deepStrictEqual(resolveAdjustmentScope([
    ...baseline, layer('empty-below', 2, 'adjustment', 'group', true), layer('group', 3, 'group'),
  ], 'empty-below'), { kind: 'group', groupId: 'group', memberIds: [] });
  assert.deepStrictEqual(resolveAdjustmentScope(layers, 'own'), { kind: 'none' });
  assert.deepStrictEqual(resolveAdjustmentScope(layers, 'missing'), { kind: 'none' });

  assert.ok(ADJUSTMENT_GLSL.includes('lumAdjApply('));
  assert.ok(ADJUSTMENT_GLSL.includes('lumAdjBlend('));
  console.log('Phase 6 adjustment layer checks passed');
}

// Phase 6: adjustment layers (persistence)
{
  const adjustment: LayerAdjustment = {
    kind: 'hsl',
    params: { hue: 400, saturation: -140, lightness: 0, colorize: false },
  };
  const meta = { adjustment, keyframes: [], originalAuthor: 'Artist' };
  const normalized = { ...meta, adjustment: { ...adjustment, params: { ...adjustment.params, hue: 180, saturation: -100 } } };
  const error = { ok: false, error: '調整圖層參數無效' };
  assert.deepStrictEqual(sanitizeLayerMetaForType('adjustment', meta, { requireAdjustment: true }), { ok: true, meta: normalized });
  assert.deepStrictEqual(sanitizeLayerMetaForType('adjustment', undefined, { requireAdjustment: true }), error);
  assert.deepStrictEqual(sanitizeLayerMetaForType('adjustment', { keyframes: [] }), error);
  assert.deepStrictEqual(sanitizeLayerMetaForType('adjustment', null), error);
  assert.deepStrictEqual(sanitizeLayerMetaForType('adjustment', { adjustment: { kind: 'unknown' } } as unknown as typeof meta), error);
  assert.deepStrictEqual(sanitizeLayerMetaForType('raster', meta), { ok: true, meta: { keyframes: [], originalAuthor: 'Artist' } });
  assert.deepStrictEqual(sanitizeLayerMetaForType(undefined, undefined), { ok: true, meta: undefined });
  assert.deepStrictEqual(sanitizeLayerMetaForType('raster', null), { ok: true, meta: null });
  assert.strictEqual(meta.adjustment.params.hue, 400);

  const hierarchy = [
    { id: 'adjustment', layerType: 'adjustment', meta: normalized },
    { id: 'mask', parentId: 'adjustment', layerType: 'mask', meta: { maskInverted: true } },
    { id: 'invalid-mask', parentId: 'invalid', layerType: 'mask' },
    { id: 'invalid', layerType: 'adjustment', meta: { adjustment: { kind: 'unknown' } } },
    { id: 'raster', layerType: 'raster' },
  ];
  assert.deepStrictEqual(normalizeLuminaLayers(JSON.parse(JSON.stringify(hierarchy))), [
    hierarchy[0], hierarchy[1], hierarchy[4],
  ]);
  console.log('Phase 6 adjustment layer persistence checks passed');
}

// v1.5.0: palette inheritance and non-destructive layer colour
{
  const config = { enabled: true, mainColor: '#123456' };
  const layers = new Map([
    ['root', { id: 'root', parentId: null, ownerId: 'alice', layerType: 'group', meta: { paletteColor: '#abc', layerColor: config } }],
    ['group', { id: 'group', parentId: 'root', ownerId: 'alice', layerType: 'group', meta: { layerColor: { ...config, mainColor: '#000' } } }],
    ['raster', { id: 'raster', parentId: 'group', ownerId: 'bob', layerType: 'raster', meta: { paletteColor: '#def' } }],
    ['mask', { id: 'mask', parentId: 'group', ownerId: 'bob', layerType: 'mask' }],
    ['adjustment', { id: 'adjustment', parentId: 'group', ownerId: 'bob', layerType: 'adjustment' }],
    ['untagged', { id: 'untagged', parentId: 'group', ownerId: 'bob', layerType: 'raster' }],
  ] as const);
  assert.deepEqual(resolveEffectivePaletteColor('raster', layers, { displayMode: 'personal' }),
    { color: '#DDEEFF', inherited: false, source: 'shared' });
  assert.deepEqual(resolveEffectivePaletteColor('raster', layers, { displayMode: 'personal', localOverrides: { group: '#456' } }),
    { color: '#445566', inherited: true, source: 'personal' });
  assert.deepEqual(resolveEffectivePaletteColor('raster', layers, { displayMode: 'personal', localOverrides: { group: null } }),
    { color: null, inherited: false, source: 'none' });
  assert.deepEqual(resolveEffectivePaletteColor('raster', layers, { displayMode: 'owner', ownerColorOf: (layer) => layer.ownerId === 'bob' ? '#000000' : null }),
    { color: '#000000', inherited: false, source: 'owner' });
  assert.deepEqual(resolveEffectivePaletteColor('untagged', layers, { displayMode: 'shared', localOverrides: { root: null } }),
    { color: '#AABBCC', inherited: true, source: 'shared' });
  const cleared = updateColorOverrides({ group: '#456' }, ['raster', 'untagged'], null);
  assert.deepEqual(cleared, { group: '#456', raster: null, untagged: null });
  assert.equal(resolveEffectivePaletteColor('raster', layers, { displayMode: 'personal', localOverrides: cleared }).color, null);
  const reset = updateColorOverrides(cleared, ['raster', 'untagged'], undefined);
  assert.deepEqual(reset, { group: '#456' });
  assert.equal(resolveEffectivePaletteColor('raster', layers, { displayMode: 'personal', localOverrides: reset }).color, '#445566');

  const disabled = { ...config, enabled: false };
  const none = { config: null, inherited: false, source: 'none' };
  assert.deepEqual(resolveEffectiveLayerColor('raster', layers, { group: disabled }), { config, inherited: true, source: 'shared' });
  assert.deepEqual(resolveEffectiveLayerColor('raster', layers, { raster: disabled }), none);
  assert.deepEqual(resolveEffectiveLayerColor('mask', layers, { mask: config }), none);
  assert.deepEqual(resolveEffectiveLayerColor('adjustment', layers, { adjustment: config }), none);
  assert.deepEqual(resolveEffectiveLayerColor('missing', layers), none);
  assert.deepEqual(resolveEffectiveLayerColor('raster', layers, { group: config }), { config, inherited: true, source: 'local' });
  const resetTint = updateColorOverrides({ raster: disabled }, ['raster'], undefined);
  assert.deepEqual(resolveEffectiveLayerColor('raster', layers, resetTint),
    { config: { ...config, mainColor: '#000000' }, inherited: true, source: 'shared' });
  assert.deepEqual(resolveEffectiveLayerColor('raster', layers, { group: null }), resolveEffectiveLayerColor('raster', layers));

  for (const hex of ['#F472B6', '#BEF264', '#fff', '#787878']) assert.equal(getPaletteContrastColor(hex), '#171717');
  for (const hex of ['#3B0764', '#000', '#777777']) assert.equal(getPaletteContrastColor(hex), '#F5F5F5');
  const solo = readLayerColorPreferences(true, '{bad json');
  assert.equal(solo.paletteColorMode, 'shared');
  assert.equal(solo.paperVisible, true);
  assert.equal(readLayerColorPreferences(false).paletteColorMode, 'personal');
  const restored = readLayerColorPreferences(false, JSON.stringify({
    paletteColorMode: 'owner', paperVisible: false, localPaperColor: '#abc',
    localPaletteColors: { root: '#def', group: null, bad: 'red' },
    localLayerColors: { root: disabled, group: null, bad: { enabled: true } },
  }));
  assert.deepEqual(restored, {
    paletteColorMode: 'owner', paperVisible: false, localPaperColor: '#AABBCC',
    localPaletteColors: { root: '#DDEEFF', group: null }, localLayerColors: { root: disabled, group: null },
  });
  assert.equal(getEffectivePaperColor('#FAF6EE', restored.localPaperColor, true), '#FAF6EE');
  assert.equal(getEffectivePaperColor('#FAF6EE', restored.localPaperColor, false), '#AABBCC');
  assert.equal(getEffectivePaperColor('#FAF6EE', null, false), '#FAF6EE');
  assert.equal(getEffectivePaperColor(undefined, null, false), '#FFFFFF');

  const rgba = Uint8ClampedArray.of(0, 0, 0, 255, 255, 255, 255, 128, 255, 0, 0, 64, 3, 5, 7, 0);
  applyLayerColorToImageData(rgba, '#0000FF');
  assert.deepEqual([...rgba], [0, 0, 255, 255, 255, 255, 255, 128, 76, 76, 255, 64, 3, 5, 7, 0]);
}

// Phase 6: adjustment layers (export compositing)
{
  // Own mask × group masks: masked-out pixels get no adjustment
  assert.equal(combineMaskCoverages([], 4), null);
  const own = Uint8ClampedArray.from([255, 0, 128, 255]);
  const group = Uint8ClampedArray.from([255, 255, 255, 0]);
  assert.deepStrictEqual(Array.from(combineMaskCoverages([own, group], 4)!), [255, 0, 128, 0]);
  assert.deepStrictEqual(Array.from(combineMaskCoverages([own], 4)!), [255, 0, 128, 255]);

  const model = (id: string, layerType: LayerModel['layerType'], sortOrder: number, extra: Partial<LayerModel> = {}) =>
    ({ id, layerType, sortOrder, parentId: null, clipToBelow: false, createdAt: sortOrder, ...extra }) as LayerModel;
  const item = (layer: LayerModel) => ({ layer, canvas: {} as HTMLCanvasElement });
  assert.equal(isAdjustmentItem(item(model('a', 'adjustment', 1))), true);
  assert.equal(isAdjustmentItem(item(model('r', 'raster', 1))), false);

  // compositeLayers resolves scopes against every item incl. groups (a group scope needs the group row)
  const stack = [
    model('outside', 'raster', 10),
    model('inner', 'raster', 20, { parentId: 'g' }),
    model('adj', 'adjustment', 30, { parentId: 'g' }),
    model('g', 'group', 40),
  ];
  assert.deepStrictEqual(resolveAdjustmentScope(stack, 'adj'), { kind: 'group', groupId: 'g', memberIds: ['inner'] });
  assert.deepStrictEqual(resolveAdjustmentScope(stack.filter((l) => l.layerType !== 'group'), 'adj'), { kind: 'root' });
  console.log('Phase 6 adjustment layer export compositing checks passed');
}

// Phase 6: adjustment layers (PSD compatibility)
{
  const samples: LayerAdjustment[] = [
    { kind: 'brightness_contrast', params: { brightness: -40, contrast: 35 } },
    { kind: 'levels', params: {
      master: { inBlack: 10, inWhite: 240, gamma: 1.25, outBlack: 5, outWhite: 250 },
      red: { inBlack: 0, inWhite: 200, gamma: 0.8, outBlack: 0, outWhite: 255 },
      green: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 },
      blue: { inBlack: 30, inWhite: 255, gamma: 1, outBlack: 20, outWhite: 230 },
    } },
    { kind: 'curves', params: {
      master: [{ x: 0, y: 0 }, { x: 128, y: 160 }, { x: 255, y: 255 }],
      red: [{ x: 0, y: 20 }, { x: 255, y: 235 }], green: [{ x: 0, y: 0 }, { x: 255, y: 255 }], blue: [{ x: 0, y: 255 }, { x: 255, y: 0 }],
    } },
    { kind: 'hsl', params: { hue: 45, saturation: -20, lightness: 10, colorize: false } },
    { kind: 'hsl', params: { hue: 210, saturation: 60, lightness: -15, colorize: true } },
    { kind: 'color_balance', params: {
      shadows: { cyanRed: 20, magentaGreen: 0, yellowBlue: -30 }, midtones: { cyanRed: 0, magentaGreen: 15, yellowBlue: 0 },
      highlights: { cyanRed: -10, magentaGreen: 0, yellowBlue: 40 }, preserveLuminosity: false,
    } },
    { kind: 'gradient_map', params: { stops: [{ offset: 0, color: '#102030' }, { offset: 0.4, color: '#ff8000' }, { offset: 1, color: '#ffffff' }], reverse: true } },
  ];
  for (const sample of samples) {
    const normalized = normalizeAdjustment(sample)!;
    const out = luminaToPsdAdjustment(normalized);
    assert.equal(out.lossy, false, sample.kind);
    const back = psdToLuminaAdjustment(JSON.parse(JSON.stringify(out.adjustment)));
    assert.equal(back.partial, false, sample.kind);
    assert.deepStrictEqual(back.adjustment, normalized, sample.kind);
  }
  // Through real PSD bytes (ag-psd writePsd → readPsd, no pixel data needed for adjustment layers)
  {
    const { createRequire } = await import('node:module');
    const agPsd = createRequire(import.meta.url)('ag-psd') as typeof import('ag-psd');
    const written = agPsd.writePsd({
      width: 4, height: 4,
      children: samples.map((sample, i) => ({ name: `adj ${i}`, adjustment: luminaToPsdAdjustment(normalizeAdjustment(sample)!).adjustment })),
    }, { generateThumbnail: false });
    const read = agPsd.readPsd(written, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
    assert.equal(read.children?.length, samples.length);
    read.children!.forEach((layer, i) => {
      assert.equal(layer.name, `adj ${i}`);
      assert.deepStrictEqual(psdToLuminaAdjustment(layer.adjustment!).adjustment, normalizeAdjustment(samples[i]), `psd bytes ${samples[i].kind}`);
    });
  }

  // Lossy / partial / unsupported
  assert.equal(luminaToPsdAdjustment(normalizeAdjustment({ kind: 'hsl', params: { hue: 12.5 } })!).lossy, true);
  assert.equal(psdToLuminaAdjustment({ type: 'brightness/contrast', brightness: 10, contrast: 5, useLegacy: true }).partial, true);
  const ranged = psdToLuminaAdjustment({
    type: 'hue/saturation', master: { hue: 10, saturation: 0, lightness: 0 },
    reds: { a: 315, b: 345, c: 15, d: 45, hue: 30, saturation: 0, lightness: 0 },
  });
  assert.equal(ranged.partial, true);
  assert.equal(ranged.adjustment?.kind, 'hsl');
  const noise = psdToLuminaAdjustment({ type: 'gradient map', gradientType: 'noise', colorStops: [] });
  assert.equal(noise.partial, true);
  assert.deepStrictEqual(noise.adjustment, createDefaultAdjustment('gradient_map'));
  const pencil = psdToLuminaAdjustment({ type: 'curves', values: [Array.from({ length: 256 }, (_, v) => 255 - v)] });
  assert.equal(pencil.partial, true);
  assert.ok(pencil.adjustment?.kind === 'curves' && pencil.adjustment.params.master.length === 16);
  for (const type of ['exposure', 'vibrance', 'black & white', 'photo filter', 'channel mixer', 'invert', 'posterize', 'threshold', 'selective color'] as const) {
    const r = psdToLuminaAdjustment({ type } as never);
    assert.equal(r.adjustment, null, type);
    assert.ok(r.kindLabel.length > 0);
  }

  // Groups whose adjustment layers act on them alone are written isolated, others stay pass through
  const L = (id: string, layerType: LayerModel['layerType'], sortOrder: number, extra: Partial<LayerModel> = {}) =>
    ({ id, layerType, sortOrder, parentId: null, clipToBelow: false, createdAt: sortOrder, ...extra }) as LayerModel;
  const stack = [
    L('base', 'raster', 10),
    L('in1', 'raster', 20, { parentId: 'g1' }),
    L('adjInG1', 'adjustment', 30, { parentId: 'g1' }),
    L('g1', 'group', 40),
    L('in2', 'raster', 50, { parentId: 'g2' }),
    L('clipAdj', 'adjustment', 60, { parentId: 'g2', clipToBelow: true }),
    L('g2', 'group', 70),
    L('rootAdj', 'adjustment', 80),
  ];
  assert.deepStrictEqual([...psdIsolatedGroupIds(stack)], ['g1']);
  console.log('Phase 6 adjustment layer PSD compatibility checks passed');
}

// Phase 6: adjustment layers (live view bookkeeping)
{
  assert.equal(adjustmentScopeRenderResolution(4000, 3000), 1);
  const big = adjustmentScopeRenderResolution(10000, 8000);
  assert.ok(big < 1 && 10000 * 8000 * big * big <= MAX_SCOPE_PIXELS);
  assert.ok(Math.ceil(10000 * big) <= 4096 && Math.ceil(8000 * big) <= 4096);
  // A composite for the whole canvas also serves the view; a view composite only that same view
  assert.equal(adjustmentScopeIsFresh('k', 'full', 'k', 'view:1'), true);
  assert.equal(adjustmentScopeIsFresh('k', 'view:1', 'k', 'view:1'), true);
  assert.equal(adjustmentScopeIsFresh('k', 'view:1', 'k', 'view:2'), false);
  assert.equal(adjustmentScopeIsFresh('k', 'view:1', 'k', 'full'), false);
  assert.equal(adjustmentScopeIsFresh('k', 'full', 'k2', 'full'), false);
  assert.equal(adjustmentScopeIsFresh('', 'full', '', 'full'), false);
  const dep = { id: 'a', version: 3, visible: true, renderable: true, alpha: 1, blendMode: 'normal', clipToBelow: false, sortOrder: 10, updatedAt: 5, transform: [0, 0, 1, 1, 0, 0, 0] };
  const base = adjustmentScopeKey('group', [dep]);
  assert.equal(adjustmentScopeKey('group', [dep]), base);
  // Any pixel, visibility, opacity, blend, order, transform or nested change makes a new key
  for (const change of [{ version: 4 }, { visible: false }, { alpha: 0.5 }, { blendMode: 'multiply' }, { sortOrder: 20 }, { transform: [1, 0, 1, 1, 0, 0, 0] }, { extra: 'x' }, { updatedAt: 6 }]) {
    assert.notEqual(adjustmentScopeKey('group', [{ ...dep, ...change }]), base, JSON.stringify(change));
  }
  assert.notEqual(adjustmentScopeKey('clip', [dep]), base);
  console.log('Phase 6 adjustment layer live view bookkeeping checks passed');
}

// Phase 6: adjustment layers (workspace editing)
import {
  adjustmentParamsKey, buildAdjustmentEditUndo, editCurvePoint, editGradientStop, nextAdjustmentLayerName,
} from '../src/components/workspace/adjustmentEditing';

{
  assert.equal(nextAdjustmentLayerName('色相／飽和度', []), '色相／飽和度 1');
  assert.equal(nextAdjustmentLayerName('色相／飽和度', [
    { name: '色相／飽和度 2' }, { name: '色相／飽和度 5' }, { name: '色相／飽和度 5 複製' }, { name: '色階 9' },
  ]), '色相／飽和度 6');

  const start = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
  const extra = editCurvePoint(start, -1, { x: 90.3, y: 160.6 });
  assert.deepEqual(extra, [start[0], { x: 90, y: 161 }, start[1]]);
  assert.equal(editCurvePoint(extra, -1, { x: 90, y: 50 }), extra);
  assert.deepEqual(editCurvePoint(extra, 0, { x: 99, y: 33 })[0], { x: 0, y: 33 });
  assert.deepEqual(editCurvePoint(extra, 1, { x: 255, y: 300 })[1], { x: 254, y: 255 });
  assert.deepEqual(editCurvePoint(extra, 1, null), start);
  assert.equal(editCurvePoint(extra, 0, null), extra);
  const fullCurve = Array.from({ length: 16 }, (_, x) => ({ x, y: x }));
  assert.equal(editCurvePoint(fullCurve, -1, { x: 100, y: 100 }), fullCurve);

  const stops = [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }];
  const withMidpoint = editGradientStop(stops, -1, 0.5001);
  assert.deepEqual(withMidpoint[1], { offset: 0.5, color: '#808080' });
  assert.deepEqual(editGradientStop(withMidpoint, 1, 1)[1], { offset: 0.999, color: '#808080' });
  assert.deepEqual(editGradientStop(withMidpoint, 1, null), stops);
  assert.equal(editGradientStop(stops, 0, null), stops);
  assert.equal(editGradientStop(withMidpoint, -1, 0.4999), withMidpoint);
  const fullGradient = Array.from({ length: 16 }, (_, i) => ({ offset: i / 16, color: '#000000' }));
  assert.equal(editGradientStop(fullGradient, -1, 1), fullGradient);

  const before = createDefaultAdjustment('brightness_contrast');
  const after = { kind: 'brightness_contrast', params: { brightness: 40, contrast: 5 } } as const;
  const layer = { id: 'edit-adj', meta: { adjustment: before, maskInverted: true } };
  assert.notEqual(adjustmentParamsKey(before), adjustmentParamsKey(after));
  assert.equal(buildAdjustmentEditUndo(layer, before, 'owner', 'param edit', 'op', 10), null);
  assert.deepEqual(buildAdjustmentEditUndo(layer, after, 'owner', 'param edit', 'op', 10), {
    opId: 'op', timestamp: 10, userId: 'owner', layerId: layer.id, opType: 'ADJUSTMENT', desc: 'param edit',
    beforeTiles: [], afterTiles: [], metaBefore: layer.meta, metaAfter: { ...layer.meta, adjustment: after },
  });
  assert.equal(buildAdjustmentEditUndo({ id: layer.id }, after, 'owner', 'param edit', 'op', 10)?.metaBefore, null);
  console.log('Phase 6 adjustment layer workspace editing checks passed');
}

// Phase 6: adjustment layers
import { ADJUSTMENT_KIND_ICONS, mergeIncludesAdjustment } from '../src/components/adjustmentLayerMenu';
import { getAdjustmentHelpTopic, queryTerms, scoreTopic } from '../src/components/help/helpContent';
import { runPhase7AutoActionChecks } from './phase7-auto-actions.checks';
import { runPhase7AutoActionHostChecks } from './phase7-auto-action-host.checks';
import { runPhase7AutoActionUiChecks } from './phase7-auto-actions-ui.checks';
import { runPhase7TextLayoutChecks } from './phase7-text-layout.checks';
import { runPhase7TextEditorChecks } from './phase7-text-editor.checks';
import { runPhase8ColorProofChecks } from './phase8-color-proof.checks';
import { runPhase8SoftProofRuntimeChecks } from './phase8-soft-proof-runtime.checks';
import { runPhase8IccEmbedChecks } from './phase8-icc-embed.checks';
import { runPhase8KraRoundTripChecks } from './phase8-kra-roundtrip.checks';
import { runPhase8UiChecks } from './phase8-ui.checks';
import { runV15Phase2RulerChecks } from './v15-phase2-rulers.checks';
import { runDockPillChecks } from './dock-pill.checks';
import { runV15Phase3BrushV3Checks } from './v15-phase3-brush-v3.checks';
import { runV15Phase4EffectsSelectionChecks } from './v15-phase4-effects-selection.checks';
import { runV15Phase5CollabV2Checks } from './v15-phase5-collab-v2.checks';
import { runV15Phase6ProPerfChecks } from './v15-phase6-pro-perf.checks';

{
  assert.deepEqual(Object.keys(ADJUSTMENT_KIND_ICONS), ADJUSTMENT_KINDS);
  assert.equal(new Set(Object.values(ADJUSTMENT_KIND_ICONS)).size, ADJUSTMENT_KINDS.length);
  assert.equal(mergeIncludesAdjustment('adjustment', 'raster'), true);
  assert.equal(mergeIncludesAdjustment('raster', 'adjustment'), true);
  assert.equal(mergeIncludesAdjustment('adjustment'), true);
  assert.equal(mergeIncludesAdjustment('raster', 'raster'), false);
  assert.equal(mergeIncludesAdjustment('raster'), false);

  for (const t of Object.values(translations)) {
    const topic = getAdjustmentHelpTopic(t);
    assert.equal(topic.category, 'layers');
    assert.ok(!topic.steps?.[0].includes('{kinds}'));
    for (const kind of ADJUSTMENT_KINDS) {
      const label = t.layers.adjustment.kinds[kind];
      assert.ok(topic.steps?.[0].includes(label));
      assert.ok(scoreTopic(topic, queryTerms(label), '') > 0);
    }
  }
  console.log('Phase 6 adjustment layer menu and help checks passed');
}

await runPhase7AutoActionChecks();
console.log('Phase 7 auto-action checks passed');
await runPhase7AutoActionHostChecks();
console.log('Phase 7 auto-action host checks passed');
await runPhase7AutoActionUiChecks();
console.log('Phase 7 auto-action UI checks passed');
await runPhase7TextLayoutChecks();
console.log('Phase 7 text layout checks passed');
await runPhase7TextEditorChecks();
console.log('Phase 7 text editor checks passed');

await runPhase8ColorProofChecks();
console.log('Phase 8 ICC, CMYK model and soft proof LUT checks passed');
await runPhase8SoftProofRuntimeChecks();
console.log('Phase 8 soft proof store, atlas and controller checks passed');
await runPhase8IccEmbedChecks();
console.log('Phase 8 ICC embedding (PNG / JPEG / PSD) checks passed');
await runPhase8KraRoundTripChecks();
console.log('Phase 8 .kra encoder round-trip checks passed');
await runPhase8UiChecks();
console.log('Phase 8 export / proof UI and locale checks passed');

await runV15Phase2RulerChecks();
console.log('v1.5 Phase 2 ruler engine checks passed');

runDockPillChecks();
console.log('Dock floating pill checks passed');

await runV15Phase3BrushV3Checks();
console.log('v1.5 Phase 3 brush engine v3 checks passed');

await runV15Phase4EffectsSelectionChecks();
console.log('v1.5 Phase 4 layer effects, quick mask & color range checks passed');

await runV15Phase5CollabV2Checks();
console.log('v1.5 Phase 5 collab 2.0 (follow camera, grid slots, room swatches & reference board) checks passed');

await runV15Phase6ProPerfChecks();
console.log('v1.5 Phase 6 pro production & performance (audio waveform/mix, CMYK TIFF/PSD + TAC, 4K-8K tile LRU) checks passed');

// Lumina Glow low-saturation white-light verification
for (const mode of ['rainbow', 'mono', 'dual'] as const) {
  const whiteVars = resolveLuminaGlowVars({ mode, primaryColor: '#1d4ed8', secondaryColor: '#db2777', saturation: 0 });
  for (let i = 1; i <= 6; i += 1) {
    const channels = whiteVars[`--glow-c${i}`].split(' ').map(Number);
    assert.ok(channels.every((c) => c >= 225), `Expected luminous white light at 0% sat for ${mode} c${i}, got ${whiteVars[`--glow-c${i}`]}`);
  }
  assert.ok(Number(whiteVars['--glow-halo-alpha']) >= 0.4, `Expected bright halo at 0% sat, got ${whiteVars['--glow-halo-alpha']}`);
}
const lowSatRainbow = resolveLuminaGlowVars({ mode: 'rainbow', primaryColor: '#38bdf8', secondaryColor: '#f472b6', saturation: 17 });
for (let i = 1; i <= 6; i += 1) {
  const channels = lowSatRainbow[`--glow-c${i}`].split(' ').map(Number);
  assert.ok(channels.every((c) => c >= 195), `Expected bright pearl-white glow at 17% sat for c${i}, got ${lowSatRainbow[`--glow-c${i}`]}`);
}
console.log('Lumina Glow white-light saturation checks passed');
