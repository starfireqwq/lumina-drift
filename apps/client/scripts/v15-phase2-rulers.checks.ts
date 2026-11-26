import assert from 'node:assert/strict';
import {
  computePerspectiveGridLines,
  evaluateCurveSegment,
  isLayerRulerEffectiveForLayer,
  type LayerModel,
  type LayerRulerMeta,
} from '@atelier/shared';
import { RulerManager } from '../src/engine/RulerManager';

function makeLayer(
  id: string,
  name: string,
  opts: Partial<LayerModel> = {},
): LayerModel {
  return {
    id,
    canvasId: 'canvas-1',
    name,
    ownerId: 'u1',
    isPublic: true,
    aclMode: 'shared_all',
    isLocked: false,
    isVisible: true,
    opacity: 1,
    blendMode: 'normal',
    orderIndex: 0,
    layerType: 'raster',
    parentId: null,
    meta: null,
    ...opts,
  };
}

export async function runV15Phase2RulerChecks(): Promise<void> {
  const mgr = RulerManager.getInstance();
  mgr.resetState(1600, 1200);

  // 1. Radial line snapping locks ray passing through center and stroke anchor
  mgr.setMode('radial_line');
  mgr.updateRadialLine({ centerX: 800, centerY: 600, rayCount: 24, innerRadius: 120 });
  assert.equal(mgr.state.radialLine.rayCount, 24);
  assert.equal(mgr.state.radialLine.innerRadius, 120);
  mgr.onStrokeStart({ x: 900, y: 700 }); // 45 deg ray from (800, 600)
  const radSnap = mgr.snapPoint({ x: 1020, y: 760 });
  assert.equal(radSnap.snapped, true);
  const dx = radSnap.point.x - 800;
  const dy = radSnap.point.y - 600;
  assert.ok(Math.abs(dx - dy) < 0.05, `radial snapped point must lie on 45° ray, got (${dx}, ${dy})`);
  mgr.onStrokeEnd();

  // 2. Curve / Bezier ruler snapping & anchor editing
  mgr.setMode('curve');
  mgr.resetCurveToCanvas(1600, 1200);
  const initialCount = mgr.state.curve.anchors.length;
  assert.ok(initialCount >= 3);
  const added = mgr.addCurveAnchor({ x: 800, y: 400 }, 1);
  assert.ok(added, 'addCurveAnchor should return new anchor');
  assert.equal(mgr.state.curve.anchors.length, initialCount + 1);
  mgr.updateCurveAnchor(added.id, { x: 810, y: 420 });
  assert.equal(mgr.state.curve.anchors.find((a) => a.id === added.id)?.x, 810);

  const sampleOnCurve = evaluateCurveSegment(mgr.state.curve, 0, 0.35);
  const offsetPt = { x: sampleOnCurve.x + 12, y: sampleOnCurve.y - 16 };
  const curveSnap = mgr.snapPoint(offsetPt);
  assert.equal(curveSnap.snapped, true);
  assert.equal(curveSnap.axisLabel, 'Curve');
  // Snapped point should be close to curve (closer than offset distance 20)
  const distToSample = Math.hypot(curveSnap.point.x - sampleOnCurve.x, curveSnap.point.y - sampleOnCurve.y);
  assert.ok(distToSample < 20, `expected curve snap close to sample, got dist=${distToSample}`);

  assert.equal(mgr.removeCurveAnchor(added.id), true);
  assert.equal(mgr.state.curve.anchors.length, initialCount);

  // 3. 2D Perspective spatial grid (XY / XZ / YZ)
  mgr.setMode('perspective');
  mgr.updatePerspective({ mode: '2-point', horizonY: 500, vp1: { x: 120, y: 500 }, vp2: { x: 1480, y: 500 } });
  mgr.updatePerspectiveGrid({ enabled: true, planes: { xy: true, xz: true, yz: true }, spacing: 90, opacity: 0.45 });
  assert.equal(mgr.state.perspective.grid?.enabled, true);
  assert.equal(mgr.state.perspective.grid?.spacing, 90);
  const gridLines = computePerspectiveGridLines(mgr.state.perspective, 1600, 1200);
  assert.ok(gridLines.some((l) => l.plane === 'xy'), 'expected XY grid lines');
  assert.ok(gridLines.some((l) => l.plane === 'xz'), 'expected XZ grid lines');
  assert.ok(gridLines.some((l) => l.plane === 'yz'), 'expected YZ grid lines');

  // 4. CSP-style Ruler-on-Layer sync, scope, folder inheritance, detached preservation, and readonly protection
  mgr.setMode('parallel');
  mgr.updateParallel({ angleDeg: 15 });

  const targetRadialMeta: LayerRulerMeta = {
    enabled: true,
    scope: 'target_layer',
    mode: 'radial_line',
    radialLine: { centerX: 400, centerY: 300, rayCount: 16, innerRadius: 50 },
  };
  const folderCurveMeta: LayerRulerMeta = {
    enabled: true,
    scope: 'same_folder',
    mode: 'curve',
    curve: mgr.state.curve,
  };
  const allPerspectiveMeta: LayerRulerMeta = {
    enabled: true,
    scope: 'all_layers',
    mode: 'perspective',
    perspective: mgr.state.perspective,
  };

  const layerA = makeLayer('layer-a', 'Action Lines', { orderIndex: 4, meta: { ruler: targetRadialMeta } });
  const layerB = makeLayer('layer-b', 'Plain Layer', { orderIndex: 3 });
  const folderG = makeLayer('folder-g', 'BG Folder', { orderIndex: 2, layerType: 'group', meta: { ruler: folderCurveMeta } });
  const childG1 = makeLayer('child-g1', 'BG Ink', { orderIndex: 1, parentId: 'folder-g' });
  const globalLayer = makeLayer('layer-global', 'Global Persp', { orderIndex: 0, meta: { ruler: allPerspectiveMeta } });
  const layersWithoutGlobal = [layerA, layerB, folderG, childG1];
  const layersWithGlobal = [...layersWithoutGlobal, globalLayer];

  let notifyCount = 0;
  const unsub = mgr.subscribe(() => { notifyCount += 1; });

  const commits: Array<{ layerId: string; ruler: LayerRulerMeta | null }> = [];
  const onCommitLayerRuler = (layerId: string, ruler: LayerRulerMeta | null) => {
    commits.push({ layerId, ruler });
  };

  // Select layerA -> target_layer radial_line activates
  mgr.syncLayerContext('layer-a', layersWithoutGlobal, { onCommitLayerRuler });
  assert.equal(mgr.state.mode, 'radial_line');
  assert.equal(mgr.state.boundSource?.ownerLayerId, 'layer-a');
  assert.equal(mgr.state.boundSource?.scope, 'target_layer');

  // Re-syncing identical layer context should not spam listeners
  const beforeNoop = notifyCount;
  mgr.syncLayerContext('layer-a', layersWithoutGlobal, { onCommitLayerRuler });
  assert.equal(notifyCount, beforeNoop, 'identical syncLayerContext should not notify');

  // Switch to layerB (no applicable bound ruler) -> restores detached parallel 15°
  mgr.syncLayerContext('layer-b', layersWithoutGlobal, { onCommitLayerRuler });
  assert.equal(mgr.state.boundSource, null);
  assert.equal(mgr.state.mode, 'parallel');
  assert.equal(mgr.state.parallel.angleDeg, 15);

  // Switch to childG1 inside folderG -> inherits same_folder curve ruler
  mgr.syncLayerContext('child-g1', layersWithoutGlobal, { onCommitLayerRuler });
  assert.equal(mgr.state.mode, 'curve');
  assert.equal(mgr.state.boundSource?.ownerLayerId, 'folder-g');
  assert.equal(mgr.state.boundSource?.scope, 'same_folder');

  // With global all_layers ruler present: layerB picks global perspective, layerA still prefers own radial_line
  mgr.syncLayerContext('layer-b', layersWithGlobal, { onCommitLayerRuler });
  assert.equal(mgr.state.mode, 'perspective');
  assert.equal(mgr.state.boundSource?.ownerLayerId, 'layer-global');

  mgr.syncLayerContext('layer-a', layersWithGlobal, { onCommitLayerRuler });
  assert.equal(mgr.state.mode, 'radial_line');
  assert.equal(mgr.state.boundSource?.ownerLayerId, 'layer-a');

  // Verify badge helper consistency
  const byId = new Map(layersWithGlobal.map((l) => [l.id, l]));
  assert.equal(isLayerRulerEffectiveForLayer(folderG, 'child-g1', byId), true);
  assert.equal(isLayerRulerEffectiveForLayer(folderG, 'layer-b', byId), false);
  assert.equal(isLayerRulerEffectiveForLayer(globalLayer, 'layer-b', byId), true);

  // Readonly collaborator cannot edit or commit another painter's bound ruler, but can still snap
  mgr.syncLayerContext('layer-a', layersWithGlobal, {
    canEditLayer: () => false,
    onCommitLayerRuler,
  });
  assert.equal(mgr.state.boundSource?.editable, false);
  mgr.updateRadialLine({ centerX: 999 });
  assert.equal(mgr.state.radialLine.centerX, 400, 'readonly bound ruler must not be mutated');
  assert.equal(mgr.commitBoundLayerRuler(), false);
  assert.equal(commits.length, 0);
  mgr.onStrokeStart({ x: 500, y: 300 });
  assert.equal(mgr.snapPoint({ x: 550, y: 340 }).snapped, true);
  mgr.onStrokeEnd();

  // Editable owner can modify & commit bound ruler updates
  mgr.syncLayerContext('layer-a', layersWithGlobal, {
    canEditLayer: () => true,
    onCommitLayerRuler,
  });
  mgr.updateRadialLine({ centerX: 512, rayCount: 36 });
  assert.equal(mgr.commitBoundLayerRuler({ scope: 'all_layers' }), true);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].layerId, 'layer-a');
  assert.equal(commits[0].ruler?.scope, 'all_layers');
  assert.equal(commits[0].ruler?.radialLine?.centerX, 512);
  assert.equal(commits[0].ruler?.radialLine?.rayCount, 36);

  // Transferring a detached ruler onto a layer via clearDetachedMode ensures disabling/switching turns off canvas overlay
  mgr.resetState(1600, 1200);
  mgr.setMode('perspective');
  const transferred = mgr.exportCurrentAsLayerRuler('target_layer', true);
  assert.ok(transferred);
  mgr.clearDetachedMode();
  const lBound = makeLayer('lb-1', 'Bound', { meta: { ruler: transferred } });
  const lOther = makeLayer('lb-2', 'Other');
  mgr.syncLayerContext('lb-1', [lBound, lOther]);
  assert.equal(mgr.state.mode, 'perspective');
  mgr.syncLayerContext('lb-2', [lBound, lOther]);
  assert.equal(mgr.state.mode, 'off');
  const lDisabled = makeLayer('lb-1', 'Bound', { meta: { ruler: { ...transferred, enabled: false } } });
  mgr.syncLayerContext('lb-1', [lDisabled, lOther]);
  assert.equal(mgr.state.mode, 'off');

  unsub();
  mgr.resetState();
}
