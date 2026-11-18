import assert from 'node:assert';
import {
  adjustVectorStrokeWidth,
  applyColorCurves,
  applyGradientMap,
  buildCurveLUT,
  buildGradientLUT,
  compressTileBuffer,
  computeStrokeBounds,
  decompressTileBuffer,
  distancePointToStroke,
  eraseStrokeToIntersection,
  findIntersectionsBetweenStrokes,
  fitPointsToBezier,
  GRADIENT_PRESETS,
  hitTestVectorStroke,
  pinchVectorStroke,
  sampleVectorStroke,
  VectorAnchor,
  VectorStroke,
} from '@atelier/shared';
import { buildApp } from '../src/app';

async function runPhase10Tests() {
  console.log('================================================================');
  console.log('🚀 Starting Phase 10 Tests: Vector Lineart, Reshape & Color Grading');
  console.log('================================================================');

  // ==========================================================================
  // Test 1: Vector Lineart Bézier Anchor Fitting & Bounding Box
  // ==========================================================================
  console.log('\n--- 1. Testing Bézier Anchor Fitting & Spline Math ---');

  const rawStrokePoints = [
    { x: 100, y: 100, pressure: 0.4 },
    { x: 130, y: 120, pressure: 0.6 },
    { x: 170, y: 160, pressure: 0.8 },
    { x: 220, y: 210, pressure: 1.0 },
    { x: 280, y: 250, pressure: 0.5 },
  ];

  const anchors = fitPointsToBezier(rawStrokePoints, 8);
  assert(anchors.length >= 4, `Expected at least 4 anchors, got ${anchors.length}`);

  // First anchor should not have cp1, but should have cp2
  assert.strictEqual(anchors[0].cp1x, undefined, 'First anchor has no incoming tangent');
  assert.notStrictEqual(anchors[0].cp2x, undefined, 'First anchor must have outgoing tangent');

  // Middle anchors must have both incoming and outgoing tangents
  const mid = anchors[1];
  assert.notStrictEqual(mid.cp1x, undefined, 'Interior anchor has cp1');
  assert.notStrictEqual(mid.cp2x, undefined, 'Interior anchor has cp2');

  // Width is proportional to pressure: baseWidth * pressure
  assert(mid.width > 0 && mid.width <= 8, `Anchor width valid: ${mid.width}`);

  // Test stroke sampling
  const bounds = computeStrokeBounds(anchors, 8);
  assert(bounds.minX <= 100 && bounds.maxX >= 280, `Bounds X valid: ${bounds.minX}..${bounds.maxX}`);
  assert(bounds.minY <= 100 && bounds.maxY >= 250, `Bounds Y valid: ${bounds.minY}..${bounds.maxY}`);

  const testStroke: VectorStroke = {
    id: 'stroke_test_1',
    layerId: 'layer_vec_1',
    color: '#000000',
    opacity: 1.0,
    baseWidth: 8,
    anchors,
    bounds,
    createdAt: Date.now(),
  };

  const polySamples = sampleVectorStroke(testStroke, 8);
  assert(polySamples.length > 20, `Sampled stroke should generate dense polyline, got ${polySamples.length}`);
  console.log(`✓ Bézier fitting & tangent control points verified (${anchors.length} anchors, ${polySamples.length} sampled points)`);

  // Dense freehand input (one point per pixel) must collapse to a handful of anchors
  // that still follow the drawn path, instead of one anchor every 2.5px
  const densePoints = Array.from({ length: 400 }, (_, i) => ({
    x: 100 + i,
    y: 300 + Math.sin(i / 40) * 60,
    pressure: 0.6,
  }));
  const denseAnchors = fitPointsToBezier(densePoints, 6);
  assert(denseAnchors.length < 40, `Dense stroke should simplify to a few anchors, got ${denseAnchors.length}`);
  // 64 samples per segment: coarser sampling measures the gaps between samples, not the fit
  const denseSamples = sampleVectorStroke({ ...testStroke, anchors: denseAnchors }, 64);
  const maxDeviation = Math.max(
    ...densePoints.map((p) => Math.min(...denseSamples.map((s) => Math.hypot(s.x - p.x, s.y - p.y))))
  );
  assert(maxDeviation < 1, `Simplified curve must stay within 1px of the path, got ${maxDeviation.toFixed(2)}px`);
  console.log(
    `✓ Dense stroke simplified: ${densePoints.length} points -> ${denseAnchors.length} anchors, max deviation ${maxDeviation.toFixed(2)}px`
  );

  // ==========================================================================
  // Test 2: Vector Eraser (Entire Stroke & Intersection Point Elimination)
  // ==========================================================================
  console.log('\n--- 2. Testing Vector Eraser (Entire Stroke vs. 交點消除) ---');

  // 2.1 Entire Stroke Erase
  const hitNear = hitTestVectorStroke(testStroke, 132, 122, 10);
  assert.strictEqual(hitNear, true, 'Eraser should hit near stroke');
  const hitFar = hitTestVectorStroke(testStroke, 50, 50, 10);
  assert.strictEqual(hitFar, false, 'Eraser should not hit distant point');
  console.log('✓ Vector eraser entire stroke hit-testing verified');

  // 2.2 Intersection Elimination (交點消除 - CSP signature feature)
  // Horizontal line: (100, 200) -> (300, 200)
  const strokeH: VectorStroke = {
    id: 'stroke_H',
    layerId: 'layer_vec_1',
    color: '#000000',
    opacity: 1.0,
    baseWidth: 4,
    anchors: [
      { x: 100, y: 200, cp2x: 133, cp2y: 200, pressure: 0.8, width: 4 },
      { x: 200, y: 200, cp1x: 167, cp1y: 200, cp2x: 233, cp2y: 200, pressure: 0.8, width: 4 },
      { x: 300, y: 200, cp1x: 267, cp1y: 200, pressure: 0.8, width: 4 },
    ],
    bounds: { minX: 98, minY: 198, maxX: 302, maxY: 202 },
    createdAt: Date.now(),
  };

  // Vertical line: (200, 100) -> (200, 300)
  const strokeV: VectorStroke = {
    id: 'stroke_V',
    layerId: 'layer_vec_1',
    color: '#000000',
    opacity: 1.0,
    baseWidth: 4,
    anchors: [
      { x: 200, y: 100, cp2x: 200, cp2y: 133, pressure: 0.8, width: 4 },
      { x: 200, y: 200, cp1x: 200, cp1y: 167, cp2x: 200, cp2y: 233, pressure: 0.8, width: 4 },
      { x: 200, y: 300, cp1x: 200, cp1y: 267, pressure: 0.8, width: 4 },
    ],
    bounds: { minX: 198, minY: 98, maxX: 202, maxY: 302 },
    createdAt: Date.now(),
  };

  const intersections = findIntersectionsBetweenStrokes(strokeH, strokeV);
  assert(intersections.length > 0, 'Stroke H and Stroke V must intersect at (200, 200)');
  const interPt = intersections[0];
  assert(Math.abs(interPt.x - 200) < 5 && Math.abs(interPt.y - 200) < 5, `Intersection point around (200, 200): (${interPt.x}, ${interPt.y})`);

  // Erase the right overhang of Stroke H at (280, 200)
  const splitResult = eraseStrokeToIntersection(strokeH, [strokeV], 280, 200, 15);
  assert(splitResult.length === 1, `Expected 1 remaining segment up to intersection, got ${splitResult.length}`);
  const remainingSeg = splitResult[0];
  // Remaining segment should be the left half up to around x=200
  assert(remainingSeg.bounds.maxX <= 215, `Remaining segment should end at intersection (x~200): got maxX=${remainingSeg.bounds.maxX}`);
  console.log(`✓ Vector eraser交點消除 verified: erased overhang past intersection, preserved segment up to (x=${Math.round(remainingSeg.bounds.maxX)})`);

  // ==========================================================================
  // Test 3: Vector Reshape (Pinch & Line Width Adjustment)
  // ==========================================================================
  console.log('\n--- 3. Testing Vector Reshape (Pinch) & Line Width Adjustment ---');

  // Pinch center at (200, 210) dragging down by +30px with radius 50
  const pinched = pinchVectorStroke(testStroke, { x: 220, y: 210 }, { x: 0, y: 30 }, 50);
  assert.notStrictEqual(pinched, testStroke);
  // Target anchor near (220, 210) should have moved downwards
  const targetAnchor = pinched.anchors.find((a) => Math.hypot(a.x - 220, a.y - (210 + 30)) < 15);
  assert(targetAnchor !== undefined, 'Anchor within pinch radius must deform along drag vector');
  console.log('✓ Vector pinch curve deformation verified');

  // Line width adjustment: Thicken by +4px
  const thickened = adjustVectorStrokeWidth(testStroke, { x: 220, y: 210 }, 40, 4.0);
  const thickAnchor = thickened.anchors.find((a) => Math.hypot(a.x - 220, a.y - 210) < 15);
  assert(thickAnchor && thickAnchor.width > 8, `Thickened width must exceed base width: ${thickAnchor?.width}`);

  // Line width adjustment: Thin by -6px
  const thinned = adjustVectorStrokeWidth(testStroke, { x: 220, y: 210 }, 40, -6.0);
  const thinAnchor = thinned.anchors.find((a) => Math.hypot(a.x - 220, a.y - 210) < 15);
  assert(thinAnchor && thinAnchor.width < 5, `Thinned width must be reduced: ${thinAnchor?.width}`);
  console.log(`✓ Vector line width adjustment verified: thicken=${thickAnchor?.width.toFixed(1)}px, thin=${thinAnchor?.width.toFixed(1)}px`);

  // ==========================================================================
  // Test 4: Color Curves (Bézier Tone Curves & Channel Spline LUT)
  // ==========================================================================
  console.log('\n--- 4. Testing Color Curves (Bézier LUT & Channel Mapping) ---');

  // 4.1 Linear LUT identity
  const linearLut = buildCurveLUT([{ x: 0, y: 0 }, { x: 255, y: 255 }]);
  assert.strictEqual(linearLut[0], 0);
  assert.strictEqual(linearLut[128], 128);
  assert.strictEqual(linearLut[255], 255);

  // 4.2 S-Curve Contrast LUT
  const sCurveLut = buildCurveLUT([
    { x: 0, y: 0 },
    { x: 64, y: 32 },  // Deepen shadows
    { x: 192, y: 224 }, // Boost highlights
    { x: 255, y: 255 },
  ]);
  assert(sCurveLut[64] < 64, `S-Curve shadows deepened: ${sCurveLut[64]} < 64`);
  assert(sCurveLut[192] > 192, `S-Curve highlights boosted: ${sCurveLut[192]} > 192`);
  console.log(`✓ Color Curve S-Curve LUT verified (shadow 64 -> ${sCurveLut[64]}, highlight 192 -> ${sCurveLut[192]})`);

  // 4.3 Pixel Filter application
  const testImg = new Uint8Array([
    100, 100, 100, 255, // Middle gray pixel
    200, 50, 50, 255,   // Reddish pixel
  ]);
  const curvedImg = applyColorCurves(
    { pixels: testImg, width: 2, height: 1 },
    { masterCurve: [{ x: 0, y: 0 }, { x: 100, y: 150 }, { x: 255, y: 255 }] }
  );
  assert(curvedImg[0] > 100, `Middle gray brightened: ${curvedImg[0]} > 100`);
  assert.strictEqual(curvedImg[3], 255, 'Alpha must be preserved');
  console.log('✓ Color Curves pixel tone mapping filter verified');

  // ==========================================================================
  // Test 5: Gradient Map (Luminance to Sunset, Cyberpunk, Ink Ramps)
  // ==========================================================================
  console.log('\n--- 5. Testing Gradient Map (Sunset, Cyberpunk, Monochrome Ink) ---');

  const sunsetLut = buildGradientLUT(GRADIENT_PRESETS.sunset);
  assert.strictEqual(sunsetLut.length, 1024, '256x4 RGBA LUT expected');

  const cyberpunkLut = buildGradientLUT(GRADIENT_PRESETS.cyberpunk);
  const inkLut = buildGradientLUT(GRADIENT_PRESETS.ink);

  // Deep shadow (0) in sunset should be twilight navy/violet
  assert(sunsetLut[0] < 50 && sunsetLut[2] > 20, 'Sunset shadow is dark violet');
  // Bright highlight (255) in sunset should be warm cream white
  assert(sunsetLut[255 * 4] > 240 && sunsetLut[255 * 4 + 1] > 230, 'Sunset highlight is warm cream white');

  // Test applyGradientMap on grayscale gradient
  const grayPixels = new Uint8Array([
    0, 0, 0, 255,         // 0% Black
    128, 128, 128, 255,   // 50% Gray
    255, 255, 255, 255,   // 100% White
  ]);

  const mappedSunset = applyGradientMap({ pixels: grayPixels, width: 3, height: 1 }, 'sunset');
  // Middle gray mapped to warm crimson / amber
  assert(mappedSunset[4] > 150, `Sunset 50% gray maps to warm red/orange: ${mappedSunset[4]}`);

  const mappedCyberpunk = applyGradientMap({ pixels: grayPixels, width: 3, height: 1 }, 'cyberpunk');
  // Middle gray mapped to electric magenta / neon
  assert(mappedCyberpunk[4] > 180, `Cyberpunk 50% gray maps to neon magenta: ${mappedCyberpunk[4]}`);

  const mappedInk = applyGradientMap({ pixels: grayPixels, width: 3, height: 1 }, 'ink');
  // Middle gray mapped to washed sumi-e ink grey
  assert(mappedInk[4] >= 100 && mappedInk[4] <= 180, `Monochrome sumi-e gray maps cleanly: ${mappedInk[4]}`);
  console.log('✓ Gradient Map presets (Sunset, Cyberpunk, Monochrome Ink) verified');

  // ==========================================================================
  // Test 6: LZ4 Tile Delta Sync Integrity
  // ==========================================================================
  console.log('\n--- 6. Testing LZ4 Tile Compression for Vector & Grading Patches ---');

  const testTileData = new Uint8Array(256 * 256 * 4);
  // Fill with test gradient
  for (let i = 0; i < 256 * 256; i++) {
    testTileData[i * 4] = i % 256;
    testTileData[i * 4 + 1] = (i * 2) % 256;
    testTileData[i * 4 + 2] = (i * 3) % 256;
    testTileData[i * 4 + 3] = 255;
  }

  const { data: compressedLZ4 } = compressTileBuffer(testTileData, 'lz4');
  assert(compressedLZ4.byteLength < testTileData.byteLength, 'LZ4 should compress tile buffer');

  const decompressed = decompressTileBuffer(compressedLZ4, 'lz4', testTileData.byteLength);
  assert.deepStrictEqual(decompressed, testTileData, 'Decompressed LZ4 tile must be bit-for-bit identical');
  console.log(`✓ LZ4 delta compression verified (${testTileData.byteLength} bytes -> ${compressedLZ4.byteLength} bytes, 100% losslessly recovered)`);

  // ==========================================================================
  // Test 7: SQLite Database Layer Persistence for Vector Layers
  // ==========================================================================
  console.log('\n--- 7. Testing Vector Layer API & SQLite Persistence ---');

  const app = await buildApp();
  await app.ready();

  const authRes = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      username: `vector_artist_${Date.now()}`,
      password: 'password123!',
      displayName: '向量線稿畫師',
    },
  });
  const { token, user } = authRes.json();

  const canvasRes = await app.inject({
    method: 'POST',
    url: '/api/canvases',
    headers: { Authorization: `Bearer ${token}` },
    payload: {
      title: '向量漫畫線稿測試畫布',
      width: 2048,
      height: 2048,
    },
  });
  const { canvas } = canvasRes.json();

  // Create Vector Layer
  const layerRes = await app.inject({
    method: 'POST',
    url: `/api/canvases/${canvas.id}/layers`,
    headers: { Authorization: `Bearer ${token}` },
    payload: {
      name: '主角向量墨線層 (Vector Lineart)',
      layerType: 'vector',
      blendMode: 'multiply',
    },
  });
  const { layer: createdLayer } = layerRes.json();
  assert.strictEqual(createdLayer.layerType, 'vector', 'Layer type must be persisted as vector');
  assert.strictEqual(createdLayer.blendMode, 'multiply');
  console.log(`✓ Vector Layer successfully persisted and verified via API: id=${createdLayer.id}, type=${createdLayer.layerType}`);

  await app.close();

  console.log('\n================================================================');
  console.log('🎉 All Phase 10 Tests Passed Successfully!');
  console.log('================================================================\n');
}

runPhase10Tests().catch((err) => {
  console.error('❌ Phase 10 Tests Failed:', err);
  process.exit(1);
});
