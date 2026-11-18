import assert from 'node:assert';
import {
  computeSymmetryPoints,
  snapPerspectivePoint,
  snapParallelPoint,
  snapConcentricPoint,
  applyHalftoneDot,
  SymmetryConfig,
  PerspectiveConfig,
} from '@atelier/shared';
import { buildApp } from '../src/app';

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

  await app.close();

  console.log('\n================================================================');
  console.log('🎉 All Phase 9 Tests Passed Successfully!');
  console.log('================================================================\n');
}

runPhase9Tests().catch((err) => {
  console.error('Phase 9 Test Error:', err);
  process.exit(1);
});
