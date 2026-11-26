import assert from 'node:assert';
import type { FastifyInstance } from 'fastify';
import {
  computeSymmetryPoints,
  snapPerspectivePoint,
  snapParallelPoint,
  snapConcentricPoint,
  applyHalftoneDot,
  computePerspectiveGridLines,
  createDefaultCurveRuler,
  evaluateCurveSegment,
  isLayerRulerEffectiveForLayer,
  normalizeLayerRulerMeta,
  resolveActiveLayerRuler,
  sampleCurveRulerPoints,
  sanitizeLayerMetaForType,
  snapCurveRulerPoint,
  snapRadialLinePoint,
  type CurveRulerConfig,
  type LayerMeta,
  type LayerModel,
  type LayerRulerMeta,
  type LayerRulerNode,
  type PerspectiveGridLine,
  type Point2D,
  SymmetryConfig,
  PerspectiveConfig,
} from '@atelier/shared';

function assertPointNear(actual: Point2D, expected: Point2D, tolerance = 0.05) {
  const error = Math.hypot(actual.x - expected.x, actual.y - expected.y);
  assert(error < tolerance, `Point (${actual.x}, ${actual.y}) is ${error}px from (${expected.x}, ${expected.y})`);
}

function testRadialLineRuler() {
  const center = { x: 10, y: 20 };
  const config = { centerX: center.x, centerY: center.y };
  const cases = [
    { anchor: { x: 40, y: 20 }, input: { x: 25, y: 33 }, point: { x: 25, y: 20 }, angle: 0 },
    { anchor: { x: 10, y: 50 }, input: { x: 15, y: 30 }, point: { x: 10, y: 30 }, angle: 90 },
    { anchor: { x: 0, y: 20 }, input: { x: 5, y: 25 }, point: { x: 5, y: 20 }, angle: 180 },
    { anchor: { x: 20, y: 10 }, input: { x: 22, y: 16 }, point: { x: 18, y: 12 }, angle: 315 },
    { anchor: { x: 40, y: 20 }, input: { x: 0, y: 25 }, point: center, angle: 0 },
    { anchor: { x: 10.0005, y: 20 }, input: { x: 10, y: 10 }, point: { x: 10, y: 10 }, angle: 270 },
  ];
  for (const { anchor, input, point, angle } of cases) {
    const result = snapRadialLinePoint(input, anchor, config);
    assert.equal(result.snapped, true);
    assert.equal(result.angleDeg, angle);
    assertPointNear(result.point, point, 1e-6);
  }
  const nearCenter = { x: 10, y: 20.0005 };
  assert.deepEqual(snapRadialLinePoint(nearCenter, center, config), { point: nearCenter, snapped: false });
  assert.deepEqual(snapRadialLinePoint(center, { x: 0, y: 20 }, config), { point: center, snapped: true, angleDeg: 180 });
}

function testCurveRuler() {
  const defaultCurve = createDefaultCurveRuler(800, 600);
  assert.equal(defaultCurve.curveType, 'bezier');
  assert.deepEqual(defaultCurve.anchors.map(({ id }) => id), ['c1', 'c2', 'c3']);
  assert(defaultCurve.anchors.every(({ handleIn, handleOut }) => handleIn && handleOut));
  assert.deepEqual(evaluateCurveSegment(defaultCurve, 0, 1), { x: 400, y: 300 });
  assert.deepEqual(evaluateCurveSegment(defaultCurve, 1, 0), { x: 400, y: 300 });
  assert.equal(sampleCurveRulerPoints(defaultCurve).length, 65);

  const cubic: CurveRulerConfig = {
    curveType: 'bezier', closed: false, anchors: [
      { id: 'start', x: 0, y: 0, handleOut: { x: 0, y: 120 } },
      { id: 'end', x: 120, y: 0, handleIn: { x: 120, y: 120 } },
    ],
  };
  assert.deepEqual(sampleCurveRulerPoints(cubic, 1), [{ x: 0, y: 0 }, { x: 120, y: 0 }]);
  assert.deepEqual(sampleCurveRulerPoints(cubic, 2), [{ x: 0, y: 0 }, { x: 60, y: 90 }, { x: 120, y: 0 }]);
  const t = 0.372137;
  const curvePoint = { x: 120 * t * t * (3 - 2 * t), y: 360 * t * (1 - t) };
  const dx = 720 * t * (1 - t);
  const dy = 360 * (1 - 2 * t);
  const offset = 10 / Math.hypot(dx, dy);
  const query = { x: curvePoint.x - dy * offset, y: curvePoint.y + dx * offset };
  const snapped = snapCurveRulerPoint(query, cubic);
  assert(snapped.snapped);
  assert.equal(snapped.segmentIndex, 0);
  assert(Math.abs(snapped.distance - 10) < 0.05);
  assertPointNear(snapped.point, curvePoint);
  assertPointNear(snapped.point, evaluateCurveSegment(cubic, snapped.segmentIndex, snapped.t), 1e-9);

  const closed: CurveRulerConfig = {
    curveType: 'bezier', closed: true, anchors: [
      { id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }, { id: 'c', x: 100, y: 100 },
    ],
  };
  const loop = sampleCurveRulerPoints(closed, 4);
  assert.equal(loop.length, 13);
  assert.deepEqual(loop[0], loop[loop.length - 1]);
  const closingSnap = snapCurveRulerPoint({ x: 20, y: 30 }, closed);
  assert.equal(closingSnap.segmentIndex, 2);
  assertPointNear(closingSnap.point, { x: 25, y: 25 });

  const quadratic: CurveRulerConfig = {
    curveType: 'quadratic', closed: false, anchors: [
      { id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0, handleIn: { x: 50, y: 100 } },
    ],
  };
  assertPointNear(sampleCurveRulerPoints(quadratic, 2)[1], { x: 50, y: 50 }, 1e-9);
  assertPointNear(snapCurveRulerPoint({ x: 50, y: 60 }, quadratic).point, { x: 50, y: 50 });
  quadratic.anchors[0].handleOut = { x: 50, y: 80 };
  assertPointNear(evaluateCurveSegment(quadratic, 0, 0.5), { x: 50, y: 40 }, 1e-9);
  delete quadratic.anchors[0].handleOut;
  delete quadratic.anchors[1].handleIn;
  assertPointNear(evaluateCurveSegment(quadratic, 0, 0.5), { x: 50, y: 0 }, 1e-9);

  const spline: CurveRulerConfig = {
    curveType: 'spline', closed: false, anchors: [
      { id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 },
      { id: 'c', x: 200, y: 100 }, { id: 'd', x: 300, y: 0 },
    ],
  };
  assertPointNear(sampleCurveRulerPoints(spline, 2)[3], { x: 150, y: 56.25 }, 1e-9);
  const splineQuery = evaluateCurveSegment(spline, 1, 0.377);
  const splineSnap = snapCurveRulerPoint(splineQuery, spline, { samplesPerSegment: 8 });
  assert.equal(splineSnap.segmentIndex, 1);
  assertPointNear(splineSnap.point, splineQuery);
  const splineLoop = sampleCurveRulerPoints({ ...spline, closed: true }, 4);
  assert.equal(splineLoop.length, 17);
  assert.deepEqual(splineLoop[0], splineLoop[splineLoop.length - 1]);

  const longLine: CurveRulerConfig = {
    curveType: 'bezier', closed: false, anchors: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 16384, y: 0 }],
  };
  assertPointNear(snapCurveRulerPoint({ x: 9123.47, y: 40 }, longLine).point, { x: 9123.47, y: 0 });
  assertPointNear(snapCurveRulerPoint({ x: 0.21, y: 40 }, longLine).point, { x: 0.21, y: 0 });
  assertPointNear(snapCurveRulerPoint({ x: -1, y: 40 }, longLine).point, { x: 0, y: 0 });

  // Both early minima lie within the first 1/32 of this curve.
  const tightTurn: CurveRulerConfig = {
    curveType: 'bezier', closed: false, anchors: [
      { id: 'a', x: -0.36, y: 0, handleOut: { x: -0.36 + 375.48 / 3, y: 100 / 3 } },
      { id: 'b', x: 4875.12, y: 100, handleIn: { x: -0.36 + (2 * 375.48 - 15500) / 3, y: 200 / 3 } },
    ],
  };
  const earlyPoint = { x: 0, y: 0.1 };
  assertPointNear(evaluateCurveSegment(tightTurn, 0, 0.001), earlyPoint, 1e-6);
  assertPointNear(snapCurveRulerPoint(earlyPoint, tightTurn).point, earlyPoint);

  for (const anchors of [[], cubic.anchors.slice(0, 1)]) {
    assert.deepEqual(snapCurveRulerPoint(query, { ...cubic, anchors }), {
      point: query, snapped: false, segmentIndex: -1, t: 0, distance: Infinity,
    });
  }
}

function testPerspectiveGrid() {
  const width = 900;
  const height = 700;
  const horizonY = 250;
  const planes = { xy: true, xz: true, yz: true };
  const grid = { enabled: true, planes, spacing: 80, gridOrigin: { x: 430, y: 490 } };
  const vp1 = { x: -120, y: horizonY };
  const vp2 = { x: 1080, y: horizonY };
  const vp3 = { x: 450, y: -620 };
  const onePoint = { x: 450, y: horizonY };
  const base = { horizonY, vp1, vp2, vp3 };
  const through = ({ x1, y1, x2, y2 }: PerspectiveGridLine, { x, y }: Point2D) =>
    Math.abs((x - x1) * (y2 - y1) - (y - y1) * (x2 - x1)) < 1e-6;
  const aligned = (value: number, origin: number) => Math.abs((value - origin) % grid.spacing) < 1e-8;

  for (const mode of ['1-point', '2-point', '3-point'] as const) {
    const config: PerspectiveConfig = { ...base, mode, vp1: mode === '1-point' ? onePoint : vp1, grid };
    const lines = computePerspectiveGridLines(config, width, height);
    const xy = lines.filter((line) => line.plane === 'xy');
    const xz = lines.filter((line) => line.plane === 'xz');
    const yz = lines.filter((line) => line.plane === 'yz');
    for (const plane of ['xy', 'xz', 'yz'] as const) {
      const singlePlane = computePerspectiveGridLines({
        ...config, grid: { ...grid, planes: { xy: false, xz: false, yz: false, [plane]: true } },
      }, width, height);
      assert(singlePlane.length > 0 && singlePlane.length <= 120);
      assert.deepEqual(singlePlane, lines.filter((line) => line.plane === plane));
    }
    for (const { plane, x1, x2, y1, y2 } of lines) {
      assert([x1, x2, y1, y2].every(Number.isFinite));
      assert(x1 >= 0 && x1 <= width && x2 >= 0 && x2 <= width);
      const minY = plane === 'xz' ? horizonY : 0;
      assert(y1 >= minY && y1 <= height && y2 >= minY && y2 <= height);
      assert(x1 !== x2 || y1 !== y2);
    }
    if (mode === '1-point') {
      assert(xy.every(({ x1, x2, y1, y2 }) => x1 === x2 ? aligned(x1, grid.gridOrigin.x) : y1 === y2 && aligned(y1, grid.gridOrigin.y)));
      assert(yz.some((line) => through(line, onePoint) && line.x2 === 0));
      assert(yz.some((line) => through(line, onePoint) && line.x2 === width));
      const depthLines = xz.filter((line) => line.y1 !== line.y2);
      assert(depthLines.length > 2 && depthLines.every((line) =>
        through(line, onePoint) && Math.abs(line.y2 - height) < 1e-9 && aligned(line.x2, grid.gridOrigin.x)));
      const rows = xz.filter(({ y1, y2 }) => y1 === y2).map(({ y1 }) => y1);
      assert(rows.length > 3);
      assert(rows[0] - rows[1] > rows[1] - rows[2]);
    } else {
      assert(xz.every((line) => through(line, vp1) || through(line, vp2)));
      assert(xz.filter((line) => through(line, vp1)).length > 2);
      assert(xz.filter((line) => through(line, vp2)).length > 2);
      for (const [wall, vp] of [[xy, vp1], [yz, vp2]] as const) {
        const vertical = (line: PerspectiveGridLine) => mode === '3-point' ? through(line, vp3) : line.x1 === line.x2;
        assert(wall.every((line) => through(line, vp) || vertical(line)));
        assert(wall.some((line) => through(line, vp)));
        assert(wall.some(vertical));
      }
    }
  }

  const config: PerspectiveConfig = { ...base, mode: '3-point', grid };
  assert.deepEqual(computePerspectiveGridLines({ ...config, grid: undefined }, width, height), []);
  assert.deepEqual(computePerspectiveGridLines({ ...config, grid: { ...grid, enabled: false } }, width, height), []);
  assert.deepEqual(computePerspectiveGridLines(config, Infinity, height), []);
  for (const [input, expected] of [[0, 20], [1000, 300], [NaN, 80]]) {
    assert.deepEqual(
      computePerspectiveGridLines({ ...config, grid: { ...grid, spacing: input } }, width, height),
      computePerspectiveGridLines({ ...config, grid: { ...grid, spacing: expected } }, width, height),
    );
  }
  assert(computePerspectiveGridLines(config, 16384, 16384).length <= 360);
  assert(computePerspectiveGridLines({ ...config, horizonY: height + 1 }, width, height).every(({ plane }) => plane !== 'xz'));
}

function testLayerRulerMetadata() {
  const radialInput = { mode: 'radial_line', radialLine: { centerX: 20, centerY: 30, rayCount: 100, innerRadius: -5 } };
  const radial = normalizeLayerRulerMeta(radialInput);
  assert.deepEqual(radial, {
    mode: 'radial_line', enabled: true, scope: 'same_folder',
    radialLine: { centerX: 20, centerY: 30, rayCount: 72, innerRadius: 0 },
  });
  const symmetry = normalizeLayerRulerMeta({
    mode: 'symmetry', enabled: false, scope: 'target_layer',
    symmetry: { mode: 'radial', axesCount: 1, centerX: 50, centerY: 40, angleDeg: -20, kaleidoscope: true },
  });
  assert.deepEqual(symmetry, {
    mode: 'symmetry', enabled: false, scope: 'target_layer',
    symmetry: { mode: 'radial', axesCount: 2, centerX: 50, centerY: 40, angleDeg: 340, kaleidoscope: true },
  });
  const perspective: PerspectiveConfig = {
    mode: '3-point', horizonY: 32, vp1: { x: 0, y: 32 }, vp2: { x: 100, y: 32 }, vp3: { x: 50, y: 200 },
    grid: { enabled: true, planes: { xy: true, xz: false, yz: true }, spacing: 500, opacity: 0.01 },
  };
  assert.deepEqual(normalizeLayerRulerMeta({ mode: 'perspective', perspective })?.perspective?.grid, {
    ...perspective.grid, spacing: 300, opacity: 0.1,
  });
  const curve = createDefaultCurveRuler(400, 400);
  assert.deepEqual(normalizeLayerRulerMeta({ mode: 'curve', curve })?.curve, curve);
  assert.deepEqual(normalizeLayerRulerMeta({ mode: 'parallel', parallel: { angleDeg: 420 } })?.parallel, { angleDeg: 60 });
  assert.deepEqual(normalizeLayerRulerMeta({ mode: 'concentric', concentric: { centerX: 1, centerY: 2 } })?.concentric,
    { centerX: 1, centerY: 2 });

  const anchor = { id: 'x', x: 0, y: 0 };
  for (const invalid of [
    null, [], { mode: 'off' }, { ...radialInput, scope: 'unknown' }, { ...radialInput, enabled: 1 },
    { mode: 'radial_line', radialLine: { ...radialInput.radialLine, centerX: Infinity } },
    { mode: 'concentric', concentric: { centerX: 0, centerY: 0, stepRadius: NaN } },
    { mode: 'parallel' },
    { mode: 'perspective', perspective: { ...perspective, grid: { ...perspective.grid, opacity: '0.2' } } },
    { mode: 'curve', curve: { curveType: 'bezier', closed: false, anchors: [anchor] } },
    { mode: 'curve', curve: { curveType: 'bezier', closed: false, anchors: Array(65).fill(anchor) } },
    { mode: 'curve', curve: { curveType: 'bezier', closed: false, anchors: [anchor, { ...anchor, handleIn: { x: NaN, y: 0 } }] } },
  ]) {
    assert.equal(normalizeLayerRulerMeta(invalid), null);
  }

  assert(radial);
  for (const type of ['raster', 'vector', 'group', 'text'] as const) {
    assert.deepEqual(sanitizeLayerMetaForType(type, { ruler: radial, paletteColor: '#abc' }),
      { ok: true, meta: { ruler: radial, paletteColor: '#AABBCC' } });
  }
  assert.deepEqual(sanitizeLayerMetaForType('raster', { ruler: null, originalAuthor: 'Artist' }),
    { ok: true, meta: { originalAuthor: 'Artist' } });
  assert.deepEqual(sanitizeLayerMetaForType('mask', { ruler: radial }), { ok: true, meta: {} });
  const adjustment = { kind: 'brightness_contrast', params: { brightness: 1, contrast: 2 } } as const;
  assert.deepEqual(sanitizeLayerMetaForType('adjustment', { ruler: radial, adjustment }), { ok: true, meta: { adjustment } });
  assert.deepEqual(sanitizeLayerMetaForType('raster', { ruler: { ...radial, radialLine: undefined } }),
    { ok: false, error: '圖層尺規參數無效' });
}

function testLayerRulerResolution() {
  const ruler: LayerRulerMeta = { enabled: true, scope: 'same_folder', mode: 'parallel', parallel: { angleDeg: 30 } };
  const global: LayerMeta = { ruler: { ...ruler, scope: 'all_layers' } };
  const local: LayerMeta = { ruler };
  const target: LayerMeta = { ruler: { ...ruler, scope: 'target_layer' } };
  const outer: LayerRulerNode = { id: 'outer', layerType: 'group', meta: local };
  const inner: LayerRulerNode = { id: 'inner', layerType: 'group', parentId: outer.id, meta: local };
  const active: LayerRulerNode = { id: 'active', parentId: inner.id, meta: target };
  const siblingHigh: LayerRulerNode = { id: 'siblingHigh', parentId: inner.id, orderIndex: 30, meta: local };
  const siblingLow: LayerRulerNode = { id: 'siblingLow', parentId: inner.id, orderIndex: 20, meta: local };
  const root: LayerRulerNode = { id: 'root', meta: local };
  const rootActive: LayerRulerNode = { id: 'rootActive' };
  const branch: LayerRulerNode = { id: 'branch', parentId: outer.id, meta: local };
  const globalHigh: LayerRulerNode = { id: 'globalHigh', orderIndex: 100, meta: global };
  const globalLow: LayerRulerNode = { id: 'globalLow', orderIndex: 80, meta: global };
  const layers = [outer, inner, active, siblingHigh, siblingLow, root, rootActive, branch, globalHigh, globalLow];
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  assert(isLayerRulerEffectiveForLayer(globalHigh, active.id, byId));
  assert(!isLayerRulerEffectiveForLayer(globalHigh, null, byId));
  assert(isLayerRulerEffectiveForLayer(active, active.id, byId));
  assert(!isLayerRulerEffectiveForLayer(active, siblingHigh.id, byId));
  assert(isLayerRulerEffectiveForLayer(inner, inner.id, byId));
  assert(isLayerRulerEffectiveForLayer(inner, active.id, byId));
  assert(!isLayerRulerEffectiveForLayer(inner, outer.id, byId));
  assert(isLayerRulerEffectiveForLayer(branch, outer.id, byId));
  assert(isLayerRulerEffectiveForLayer(branch, active.id, byId));
  assert(isLayerRulerEffectiveForLayer(root, rootActive.id, byId));
  assert(!isLayerRulerEffectiveForLayer(root, active.id, byId));
  assert.deepEqual(resolveActiveLayerRuler(active.id, layers), { ownerLayerId: active.id, ownerLayer: active, ruler: target.ruler });

  const withoutBindings = (...ids: string[]) => layers.map((layer) => ids.includes(layer.id) ? { ...layer, meta: null } : layer);
  assert.equal(resolveActiveLayerRuler(active.id, withoutBindings(active.id))?.ownerLayerId, inner.id);
  assert.equal(resolveActiveLayerRuler(active.id, withoutBindings(active.id, inner.id))?.ownerLayerId, outer.id);
  const peers = withoutBindings(active.id, inner.id, outer.id);
  assert.equal(resolveActiveLayerRuler(active.id, peers)?.ownerLayerId, siblingHigh.id);
  assert.equal(resolveActiveLayerRuler(active.id, peers.map((layer) => ({ ...layer, orderIndex: undefined })))?.ownerLayerId, siblingLow.id);
  assert.equal(resolveActiveLayerRuler(rootActive.id, layers)?.ownerLayerId, root.id);
  assert.equal(resolveActiveLayerRuler(active.id, withoutBindings(active.id, inner.id, outer.id, siblingHigh.id, siblingLow.id))?.ownerLayerId,
    globalHigh.id);

  const hiddenOwner = peers.map((layer) => layer.id === siblingHigh.id ? { ...layer, isVisible: false } : layer);
  assert.equal(resolveActiveLayerRuler(active.id, hiddenOwner)?.ownerLayerId, siblingLow.id);
  assert.equal(resolveActiveLayerRuler(active.id, hiddenOwner, { includeHiddenOwner: true })?.ownerLayerId, siblingHigh.id);
  const hiddenAncestor = layers.map((layer) => layer.id === outer.id ? { ...layer, isVisible: false } : layer);
  assert.equal(resolveActiveLayerRuler(active.id, hiddenAncestor)?.ownerLayerId, globalHigh.id);
  assert.equal(resolveActiveLayerRuler(active.id, hiddenAncestor, { includeHiddenOwner: true })?.ownerLayerId, active.id);
  const disabled = { ...active, meta: { ruler: { ...ruler, enabled: false } } };
  assert.equal(resolveActiveLayerRuler(active.id, [disabled]), null);
  assert.equal(resolveActiveLayerRuler(null, layers), null);
}

async function testLayerRulerApi(app: FastifyInstance, canvasId: string, token: string) {
  const url = `/api/canvases/${canvasId}/layers`;
  const headers = { authorization: `Bearer ${token}` };
  const ruler = { mode: 'radial_line', radialLine: { centerX: 160, centerY: 180, rayCount: 90 } };
  const created = await app.inject({
    method: 'POST', url, headers, payload: { name: 'Radial ruler', layerType: 'vector', meta: { ruler, paletteColor: '#abc' } },
  });
  assert.equal(created.statusCode, 201);
  const { layer } = created.json<{ layer: LayerModel }>();
  const normalized = layer.meta?.ruler;
  assert.deepEqual(normalized, {
    mode: 'radial_line', enabled: true, scope: 'same_folder', radialLine: { centerX: 160, centerY: 180, rayCount: 72 },
  });
  assert.equal(layer.meta?.paletteColor, '#AABBCC');

  const layerUrl = `${url}/${layer.id}`;
  const readLayer = async () => {
    const response = await app.inject({ method: 'GET', url, headers });
    assert.equal(response.statusCode, 200);
    return response.json<{ layers: LayerModel[] }>().layers.find(({ id }) => id === layer.id);
  };
  assert.deepEqual((await readLayer())?.meta?.ruler, normalized);

  const updated = await app.inject({
    method: 'PATCH', url: layerUrl, headers,
    payload: { meta: { ...layer.meta, ruler: { ...ruler, scope: 'all_layers' } } },
  });
  assert.equal(updated.statusCode, 200);
  const updatedRuler = { ...normalized, scope: 'all_layers' };
  assert.deepEqual(updated.json<{ layer: LayerModel }>().layer.meta?.ruler, updatedRuler);
  assert.deepEqual((await readLayer())?.meta?.ruler, updatedRuler);

  const rejectedCreate = await app.inject({
    method: 'POST', url, headers, payload: { name: 'Invalid ruler', meta: { ruler: { mode: 'off' } } },
  });
  const rejectedUpdate = await app.inject({
    method: 'PATCH', url: layerUrl, headers,
    payload: { name: 'Invalid rename', meta: { ruler: { ...ruler, scope: 'invalid' } } },
  });
  for (const rejected of [rejectedCreate, rejectedUpdate]) {
    assert.equal(rejected.statusCode, 400);
    assert.deepEqual(rejected.json(), { error: '圖層尺規參數無效' });
  }
  assert.equal((await readLayer())?.name, 'Radial ruler');
  assert.deepEqual((await readLayer())?.meta?.ruler, updatedRuler);

  const cleared = await app.inject({
    method: 'PATCH', url: layerUrl, headers, payload: { meta: { ...layer.meta, ruler: null } },
  });
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(cleared.json<{ layer: LayerModel }>().layer.meta, { paletteColor: '#AABBCC' });
  assert.deepEqual((await readLayer())?.meta, { paletteColor: '#AABBCC' });
}

async function runPhase9Tests() {
  console.log('\n================================================================');
  console.log('🚀 Starting Phase 9 Tests: Rulers, Screentone, Liquify & Mesh Warp');
  console.log('================================================================\n');

  // ==========================================================================
  // Test 1: 尺規輔助系統 - 對稱尺 (Symmetry Ruler)
  // ==========================================================================
  console.log('--- 1. Testing Symmetry Ruler (2-Axis & Radial) ---');

  // 1.1 2-axis (4 quadrants mirror)
  const sym2AxisConfig: SymmetryConfig = {
    mode: '2-axis',
    axesCount: 4,
    centerX: 500,
    centerY: 500,
  };

  const pt1 = { x: 550, y: 520 };
  const sym2Points = computeSymmetryPoints(pt1, sym2AxisConfig);
  assert.strictEqual(sym2Points.length, 4, '2-axis symmetry must generate 4 quadrant points');
  assert.deepStrictEqual(sym2Points[0], { x: 550, y: 520 }); // Original
  assert.deepStrictEqual(sym2Points[1], { x: 450, y: 520 }); // Horizontal mirror: 2*500 - 550 = 450
  assert.deepStrictEqual(sym2Points[2], { x: 550, y: 480 }); // Vertical mirror: 2*500 - 520 = 480
  assert.deepStrictEqual(sym2Points[3], { x: 450, y: 480 }); // Quadrant mirror
  console.log('✓ 2-Axis symmetry mirroring verified successfully');

  // 1.2 Radial 6-axis symmetry
  const symRadialConfig: SymmetryConfig = {
    mode: 'radial',
    axesCount: 6,
    centerX: 0,
    centerY: 0,
  };
  const ptOrigin = { x: 100, y: 0 };
  const radialPoints = computeSymmetryPoints(ptOrigin, symRadialConfig);
  assert.strictEqual(radialPoints.length, 6, '6-axis radial symmetry must generate 6 points');
  for (const p of radialPoints) {
    const dist = Math.hypot(p.x, p.y);
    assert(Math.abs(dist - 100) < 0.1, `Radial point must maintain exact radius: ${dist}`);
  }
  console.log('✓ Radial 6-axis symmetry verified successfully');

  // ==========================================================================
  // Test 2: 尺規輔助系統 - 透視尺、平行線與同心圓筆觸吸附
  // ==========================================================================
  console.log('\n--- 2. Testing Perspective, Parallel & Concentric Snapping ---');

  // 2.1 Perspective Snapping (2-point perspective)
  const perspConfig: PerspectiveConfig = {
    mode: '2-point',
    horizonY: 500,
    vp1: { x: 0, y: 500 },
    vp2: { x: 1000, y: 500 },
    vp3: { x: 500, y: 1500 },
  };

  const anchor = { x: 500, y: 600 };
  // Movement towards VP1: (-50, 0) relative direction towards VP1 (0, 500)
  const curPt = { x: 460, y: 592 };
  const snapResult = snapPerspectivePoint(curPt, anchor, perspConfig);
  assert.strictEqual(snapResult.snapped, true, 'Stroke should be snapped along perspective guide');
  assert(snapResult.axisLabel != null, 'Axis label should indicate vanishing ray');
  console.log(`✓ Perspective snapping verified (snapped along ${snapResult.axisLabel})`);

  // 2.2 Parallel Line Snapping (30 degrees)
  const parAnchor = { x: 200, y: 200 };
  const parCur = { x: 280, y: 245 }; // moving roughly at 30 deg
  const parSnapped = snapParallelPoint(parCur, parAnchor, 30);
  const parAngle = (Math.atan2(parSnapped.y - parAnchor.y, parSnapped.x - parAnchor.x) * 180) / Math.PI;
  assert(Math.abs(parAngle - 30) < 0.01, `Parallel snapped angle must be 30°: ${parAngle}`);
  console.log('✓ Parallel line snapping verified at exact 30° constraint');

  // 2.3 Concentric Circle Snapping
  const center = { x: 300, y: 300 };
  const concCur = { x: 420, y: 390 };
  const concSnapped = snapConcentricPoint(concCur, center, 150);
  const calcRadius = Math.hypot(concSnapped.point.x - center.x, concSnapped.point.y - center.y);
  assert(Math.abs(calcRadius - 150) < 0.01, `Concentric radius must be locked to 150: ${calcRadius}`);
  console.log('✓ Concentric circle radial lock verified at exact radius');

  // ==========================================================================
  // Test 3: 網點化與黑白漫畫濾鏡 (Halftone & Screentone)
  // ==========================================================================
  console.log('\n--- 3. Testing Halftone & Comic Screentone Generation ---');

  const htWidth = 64;
  const htHeight = 64;
  const testPixels = new Uint8Array(htWidth * htHeight * 4);

  // Fill with 50% middle gray (RGB 128, 128, 128)
  for (let i = 0; i < htWidth * htHeight; i++) {
    testPixels[i * 4] = 128;
    testPixels[i * 4 + 1] = 128;
    testPixels[i * 4 + 2] = 128;
    testPixels[i * 4 + 3] = 255;
  }

  const halftonePixels = applyHalftoneDot(
    {
      pixels: testPixels,
      width: htWidth,
      height: htHeight,
    },
    20, // 20 LPI
    Math.PI / 4, // 45 degrees
    1.0
  );

  assert.strictEqual(halftonePixels.length, htWidth * htHeight * 4);

  // Halftone output should contain high-contrast ink dots (black ink and paper highlights)
  let darkCount = 0;
  let brightCount = 0;
  for (let i = 0; i < htWidth * htHeight; i++) {
    const r = halftonePixels[i * 4];
    if (r < 60) darkCount++;
    if (r > 200) brightCount++;
  }
  assert(darkCount > 50, 'Halftone should generate dark dot ink centers');
  assert(brightCount > 50, 'Halftone should preserve bright paper backgrounds');
  console.log(`✓ Halftone dot conversion verified (dark pixels: ${darkCount}, bright pixels: ${brightCount})`);

  // ==========================================================================
  // Test 4: Database Layer Screentone Persistence via Fastify API
  // ==========================================================================
  console.log('\n--- 4. Testing Layer Screentone API Persistence ---');

  testRadialLineRuler();
  testCurveRuler();
  testPerspectiveGrid();
  testLayerRulerMetadata();
  testLayerRulerResolution();

  assert(process.env.DATA_DIR && process.env.PORT === '0', 'Run with the isolated test runner');
  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  await app.ready();

  // Create a user and canvas
  const authRes = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      username: `mangaka_${Date.now()}`,
      password: 'testPassword123!',
      displayName: '繪師漫畫家',
    },
  });
  assert.strictEqual(authRes.statusCode, 201);
  const token = JSON.parse(authRes.payload).token;

  // Create canvas
  const canvasRes = await app.inject({
    method: 'POST',
    url: '/api/canvases',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      title: '漫畫連載原稿合繪室',
      width: 2048,
      height: 2048,
    },
  });
  assert.strictEqual(canvasRes.statusCode, 201);
  const canvasData = JSON.parse(canvasRes.payload);
  const layer1 = canvasData.layers[0];

  // Update layer properties with Screentone enabled, 55 LPI, 45 degree angle
  const updateRes = await app.inject({
    method: 'PATCH',
    url: `/api/canvases/${canvasData.canvas.id}/layers/${layer1.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      screentoneEnabled: true,
      screentoneLpi: 55,
      screentoneAngle: 45,
      screentoneDotScale: 1.2,
    },
  });
  assert.strictEqual(updateRes.statusCode, 200);
  const updatedLayer = JSON.parse(updateRes.payload).layer;
  assert.strictEqual(updatedLayer.screentoneEnabled, true);
  assert.strictEqual(updatedLayer.screentoneLpi, 55);
  assert.strictEqual(updatedLayer.screentoneAngle, 45);
  assert.strictEqual(updatedLayer.screentoneDotScale, 1.2);
  console.log('✓ Layer Screentone properties successfully persisted & verified via SQLite API');

  await testLayerRulerApi(app, canvasData.canvas.id, token).finally(() => app.close());

  console.log('\n================================================================');
  console.log('🎉 All Phase 9 Tests Passed Successfully!');
  console.log('================================================================\n');
}

runPhase9Tests().catch((err) => {
  console.error('Phase 9 Test Error:', err);
  process.exit(1);
});
