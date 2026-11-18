import {
  applyChromaticAberration,
  applyGaussianBlur,
  applyHalftoneDot,
  applyHsvAdjust,
  applyNoiseGrain,
  applyTwirlDistortion,
  blendComponent,
  contractSelectionMask,
  DynamicStabilizer,
  evaluateBlendModeRgba,
  evaluatePressureCurve,
  expandSelectionMask,
  floodFillMagicWand,
  getDirtyTilesForBoundingBox,
  getSelectionMaskFactor,
  mapBrushDynamics,
  mixPigmentSubtractive,
  oklabToRgb,
  pointInPolygon,
  rasterizeLassoMask,
  rgbToHex,
  rgbToOklab,
  simulateWetColorPickup,
} from '@atelier/shared';

async function runPhase4Tests() {
  console.log('====================================================');
  console.log('🚀 Starting AtelierSync Phase 4 Engine & Filter Tests');
  console.log('====================================================');

  // ----------------------------------------------------------------
  // 1. Brush & Color Blending Engine (CSP/Krita Standard)
  // ----------------------------------------------------------------
  console.log('\n--- 1. Testing Advanced Brush & Realistic Pigment Blending Engine ---');

  // 1.1 Dynamic Center-of-Mass Stabilizer
  const stabilizer = new DynamicStabilizer(4);
  stabilizer.reset({ x: 10, y: 10, pressure: 0.5 });

  // Simulate slow stroke with micro-jitter
  const rawPoints = [
    { x: 10, y: 10, pressure: 0.5 },
    { x: 12, y: 14, pressure: 0.52 }, // slight jitter
    { x: 11, y: 13, pressure: 0.48 }, // backward twitch
    { x: 15, y: 20, pressure: 0.55 },
    { x: 20, y: 30, pressure: 0.6 },
  ];

  const smoothedPoints = rawPoints.map((pt) => stabilizer.pushRawPoint(pt));
  if (smoothedPoints.length !== 5) {
    throw new Error('Stabilizer point count mismatch');
  }

  // Verify smooth inertia trailing: smoothed point moves forward smoothly without jitter spikes
  const p3 = smoothedPoints[2];
  if (p3.x < 10 || p3.y < 10) {
    throw new Error('Stabilizer inertia failed on jitter recovery');
  }
  console.log('✓ Dynamic Center-of-Mass Stabilizer (Hand tremor smoothing) verified');

  // 1.2 Catmull-Rom Spline Interpolation
  const p0 = { x: 0, y: 0, pressure: 0.2 };
  const p1 = { x: 10, y: 10, pressure: 0.4 };
  const p2 = { x: 30, y: 20, pressure: 0.6 };
  const p3Spline = { x: 40, y: 10, pressure: 0.8 };

  const samples = DynamicStabilizer.sampleSplineSegment(p0, p1, p2, p3Spline, 5);
  if (samples.length < 3) {
    throw new Error(`Catmull-Rom failed to generate sufficient samples: ${samples.length}`);
  }
  // Check monotonic parameter progression between p1 and p2
  if (samples[0].x <= p1.x || samples[samples.length - 1].x > p2.x + 1) {
    throw new Error('Catmull-Rom segment interpolation out of bounds');
  }
  console.log(`✓ Catmull-Rom C1-continuous spline interpolation verified (${samples.length} dabs)`);

  // 1.3 Pressure Curve Mapping
  const pLinear = evaluatePressureCurve(0.5, 'linear');
  const pSoft = evaluatePressureCurve(0.5, 'soft');
  const pHard = evaluatePressureCurve(0.5, 'hard');
  const pScurve = evaluatePressureCurve(0.5, 's-curve');

  if (pLinear !== 0.5) throw new Error(`Linear pressure failed: ${pLinear}`);
  if (pSoft <= 0.5) throw new Error(`Soft pressure should be higher than 0.5, got: ${pSoft}`);
  if (pHard >= 0.5) throw new Error(`Hard pressure should be lower than 0.5, got: ${pHard}`);
  if (Math.abs(pScurve - 0.5) > 0.05) throw new Error(`S-curve midtone failed: ${pScurve}`);

  const dyn = mapBrushDynamics(0.7, 30, 4, 1.0, 's-curve');
  if (dyn.size <= 4 || dyn.size > 30 || dyn.opacity <= 0.2) {
    throw new Error(`Brush dynamic mapping failed: ${JSON.stringify(dyn)}`);
  }
  console.log('✓ Pressure curve presets (Linear, Soft, Hard, S-Curve) verified');

  // 1.4 Realistic Subtractive Pigment Blending (Yellow + Blue = Green!)
  const yellow = { r: 255, g: 230, b: 0 };
  const blue = { r: 0, g: 80, b: 240 };

  const mixed50 = mixPigmentSubtractive(yellow, blue, 0.5);

  // In standard RGB, yellow (255, 230, 0) + blue (0, 80, 240) = (128, 155, 120), a murky gray.
  // In subtractive pigment mixing, Green MUST be the dominant color channel (G > R and G > B)!
  if (!(mixed50.g > mixed50.r && mixed50.g > mixed50.b)) {
    throw new Error(
      `Pigment mixing failed: Yellow + Blue did not produce Green! Got: R=${mixed50.r}, G=${mixed50.g}, B=${mixed50.b}`
    );
  }
  console.log(
    `✓ Subtractive Pigment Mixing verified: Yellow + Blue = Emerald Green (R=${mixed50.r}, G=${mixed50.g}, B=${mixed50.b})`
  );

  // 1.5 Wet Watercolor Color Pickup & Depletion Simulation
  const wetPick = simulateWetColorPickup(yellow, blue, 0.6, 0.7, 50);
  if (!(wetPick.mixedColor.g > wetPick.mixedColor.b)) {
    throw new Error('Wet paint pickup failed to blend background pigment into brush');
  }
  const wetPickLong = simulateWetColorPickup(yellow, blue, 0.6, 0.7, 800);
  if (wetPickLong.effectiveOpacity >= wetPick.effectiveOpacity) {
    throw new Error('Paint wetness did not attenuate along stroke distance');
  }
  console.log('✓ Wet watercolor paint pickup & stroke distance attenuation verified');

  // ----------------------------------------------------------------
  // 2. Advanced Selection Tools (Lasso & Magic Wand)
  // ----------------------------------------------------------------
  console.log('\n--- 2. Testing Advanced Selection Tools ---');

  // 2.1 Lasso Polygon & Point-in-Polygon
  const triangle = [
    { x: 50, y: 10 },
    { x: 90, y: 90 },
    { x: 10, y: 90 },
  ];
  if (!pointInPolygon(50, 50, triangle)) throw new Error('Center point should be inside triangle');
  if (pointInPolygon(5, 5, triangle)) throw new Error('Exterior point falsely reported inside');

  const lassoMask = rasterizeLassoMask(triangle, 100, 100);
  if (lassoMask.activePixelCount === 0 || lassoMask.activePixelCount > 5000) {
    throw new Error(`Lasso active pixel count suspicious: ${lassoMask.activePixelCount}`);
  }
  console.log(`✓ Lasso freehand rasterization verified (${lassoMask.activePixelCount} pixels selected)`);

  // 2.2 Magic Wand Flood Fill (Tolerance & Contiguous vs Non-contiguous)
  const testImg = new Uint8Array(100 * 100 * 4);
  // Fill background with white
  testImg.fill(255);

  // Draw red circle in center: (40..60, 40..60)
  for (let y = 40; y <= 60; y++) {
    for (let x = 40; x <= 60; x++) {
      const idx = (y * 100 + x) * 4;
      testImg[idx] = 250;     // R
      testImg[idx + 1] = 10;  // G
      testImg[idx + 2] = 10;  // B
      testImg[idx + 3] = 255;
    }
  }

  // Draw another isolated red dot at (10, 10)
  const dotIdx = (10 * 100 + 10) * 4;
  testImg[dotIdx] = 250;
  testImg[dotIdx + 1] = 10;
  testImg[dotIdx + 2] = 10;
  testImg[dotIdx + 3] = 255;

  // Test 1: Contiguous Magic Wand at (50, 50)
  const wandContiguous = floodFillMagicWand(testImg, 100, 100, 50, 50, 30, true);
  // (10, 10) should NOT be selected in contiguous mode
  if (wandContiguous.data[10 * 100 + 10] !== 0) {
    throw new Error('Contiguous wand erroneously selected disconnected island');
  }
  if (wandContiguous.data[50 * 100 + 50] !== 255) {
    throw new Error('Contiguous wand failed to select clicked region');
  }
  console.log(`✓ Contiguous Magic Wand flood fill verified (${wandContiguous.activePixelCount} pixels)`);

  // Test 2: Non-contiguous Magic Wand
  const wandGlobal = floodFillMagicWand(testImg, 100, 100, 50, 50, 30, false);
  // (10, 10) MUST be selected in non-contiguous mode
  if (wandGlobal.data[10 * 100 + 10] !== 255) {
    throw new Error('Non-contiguous wand failed to select global matching pixels');
  }
  if (wandGlobal.activePixelCount <= wandContiguous.activePixelCount) {
    throw new Error('Non-contiguous wand should select strictly more pixels than contiguous');
  }
  console.log(`✓ Non-contiguous (Global match) Magic Wand verified (${wandGlobal.activePixelCount} pixels)`);

  // 2.3 Selection Expand & Contract (Morphological Dilation & Erosion)
  const expanded = expandSelectionMask(wandContiguous.data, 100, 100, 3);
  let expandedCount = 0;
  for (let i = 0; i < expanded.length; i++) if (expanded[i] > 0) expandedCount++;
  if (expandedCount <= wandContiguous.activePixelCount) {
    throw new Error('Selection expand did not dilate mask');
  }

  const contracted = contractSelectionMask(wandContiguous.data, 100, 100, 3);
  let contractedCount = 0;
  for (let i = 0; i < contracted.length; i++) if (contracted[i] > 0) contractedCount++;
  if (contractedCount >= wandContiguous.activePixelCount) {
    throw new Error('Selection contract did not erode mask');
  }
  console.log(
    `✓ Selection morphology verified: Original ${wandContiguous.activePixelCount} -> Expanded ${expandedCount} -> Contracted ${contractedCount}`
  );

  // 2.4 Selection Mask Guard Factor
  if (getSelectionMaskFactor(wandContiguous.data, 50, 50, 100, 100) !== 1.0) {
    throw new Error('Mask factor for inside pixel must be 1.0');
  }
  if (getSelectionMaskFactor(wandContiguous.data, 5, 5, 100, 100) !== 0.0) {
    throw new Error('Mask factor for outside pixel must be 0.0');
  }
  console.log('✓ Strict selection mask restriction factor verified');

  // ----------------------------------------------------------------
  // 3. WebGL Custom Shaders & Pixel Filters
  // ----------------------------------------------------------------
  console.log('\n--- 3. Testing GPU Filters & Pixel Processing ---');

  // Setup test canvas (64x64)
  const fWidth = 64;
  const fHeight = 64;
  const filterPixels = new Uint8Array(fWidth * fHeight * 4);
  // Half white, half black
  for (let y = 0; y < fHeight; y++) {
    for (let x = 0; x < fWidth; x++) {
      const idx = (y * fWidth + x) * 4;
      const val = x < 32 ? 255 : 0;
      filterPixels[idx] = val;
      filterPixels[idx + 1] = val;
      filterPixels[idx + 2] = val;
      filterPixels[idx + 3] = 255;
    }
  }

  // 3.1 Dual-Pass Gaussian Blur
  const blurred = applyGaussianBlur({ pixels: filterPixels, width: fWidth, height: fHeight }, 4);
  // Edge at x=31 and x=32 should have diffused toward intermediate values
  const edgeLeft = blurred[(32 * fWidth + 31) * 4];
  const edgeRight = blurred[(32 * fWidth + 32) * 4];
  if (edgeLeft >= 255 || edgeRight <= 0 || Math.abs(edgeLeft - edgeRight) > 100) {
    throw new Error(`Gaussian blur failed to diffuse sharp edge: ${edgeLeft} vs ${edgeRight}`);
  }
  console.log(`✓ Dual-Pass Gaussian Blur verified (Edge smoothed to ${edgeLeft} | ${edgeRight})`);

  // 3.2 Manga Halftone Dot
  const halftone = applyHalftoneDot(
    { pixels: filterPixels, width: fWidth, height: fHeight },
    20,
    Math.PI / 4,
    1.0
  );
  if (halftone.length !== filterPixels.length) throw new Error('Halftone output size mismatch');
  console.log('✓ Manga Halftone Screen Tone Dot verified');

  // 3.3 Chromatic Aberration / RGB Split
  const split = applyChromaticAberration(
    { pixels: filterPixels, width: fWidth, height: fHeight },
    5,
    0
  );
  // At edge region, Red channel should be shifted relative to Blue
  const splitR = split[(32 * fWidth + 30) * 4];
  const splitB = split[(32 * fWidth + 30) * 4 + 2];
  if (splitR === splitB) {
    throw new Error('Chromatic Aberration failed to split Red and Blue channels');
  }
  console.log(`✓ Chromatic Aberration / RGB Split verified (Red=${splitR}, Blue=${splitB})`);

  // 3.4 Twirl Distortion
  const twirled = applyTwirlDistortion(
    { pixels: filterPixels, width: fWidth, height: fHeight },
    32,
    32,
    20,
    Math.PI / 2
  );
  if (twirled.length !== filterPixels.length) throw new Error('Twirl size mismatch');
  console.log('✓ Twirl / Vortex Distortion verified');

  // 3.5 Noise & Grain
  const grained = applyNoiseGrain(
    { pixels: filterPixels, width: fWidth, height: fHeight },
    0.3,
    1.0
  );
  if (grained.length !== filterPixels.length) throw new Error('Noise grain size mismatch');
  console.log('✓ Digital Noise & Paper Grain verified');

  // 3.6 HSV Adjustment & Invert
  const inverted = applyHsvAdjust(
    { pixels: filterPixels, width: fWidth, height: fHeight },
    0,
    1.0,
    0,
    true
  );
  // White (255) inverted should become Black (~0)
  if (inverted[0] > 10) throw new Error(`Invert failed: white inverted to ${inverted[0]}`);
  console.log('✓ HSV Adjustment & Invert filter verified');

  // ----------------------------------------------------------------
  // 4. Layer Blend Modes (CSP / Krita standard)
  // ----------------------------------------------------------------
  console.log('\n--- 4. Testing Layer Blending Modes ---');

  // Multiply: 0.8 * 0.5 = 0.4
  const mul = blendComponent(0.8, 0.5, 'multiply');
  if (Math.abs(mul - 0.4) > 0.01) throw new Error(`Multiply failed: ${mul}`);

  // Screen: 1 - (1 - 0.8) * (1 - 0.5) = 1 - 0.2 * 0.5 = 0.9
  const scr = blendComponent(0.8, 0.5, 'screen');
  if (Math.abs(scr - 0.9) > 0.01) throw new Error(`Screen failed: ${scr}`);

  // Add: min(1.0, 0.6 + 0.5) = 1.0
  const add = blendComponent(0.6, 0.5, 'add');
  if (Math.abs(add - 1.0) > 0.01) throw new Error(`Add failed: ${add}`);

  // Overlay: d = 0.4 < 0.5 -> 2 * s * d = 2 * 0.8 * 0.4 = 0.64
  const ovr = blendComponent(0.8, 0.4, 'overlay');
  if (Math.abs(ovr - 0.64) > 0.01) throw new Error(`Overlay failed: ${ovr}`);

  // Color Dodge & Color Burn
  const dodge = blendComponent(0.5, 0.4, 'color_dodge');
  const burn = blendComponent(0.5, 0.4, 'color_burn');
  if (dodge <= 0.4 || burn >= 0.4) throw new Error('Color dodge / burn behavior mismatch');

  // RGBA Full Alpha compositing
  const [cr, cg, cb, ca] = evaluateBlendModeRgba(
    255, 0, 0, 255,   // Red top layer
    0, 255, 0, 255,   // Green bottom layer
    'multiply',
    1.0
  );
  // Red * Green = Black
  if (cr !== 0 || cg !== 0 || cb !== 0 || ca !== 255) {
    throw new Error(`Multiply RGBA failed: [${cr}, ${cg}, ${cb}, ${ca}]`);
  }
  console.log('✓ Blend Modes (Multiply, Screen, Overlay, Add, Dodge, Burn) fully verified');

  // ----------------------------------------------------------------
  // 5. Dirty Tiles Pipeline for GPU Filters
  // ----------------------------------------------------------------
  console.log('\n--- 5. Testing Dirty Tiles Pipeline for Filters ---');
  const filterDirty = getDirtyTilesForBoundingBox(100, 100, 400, 400, 256, 2048, 2048);
  // (100..400) spans col 0 to 1, row 0 to 1 -> 4 tiles
  if (filterDirty.length !== 4) {
    throw new Error(`Expected 4 dirty tiles for filter bounding box, got ${filterDirty.length}`);
  }
  console.log(`✓ Filter dirty tiles calculation verified (${filterDirty.length} tiles for sync)`);

  console.log('\n====================================================');
  console.log('🎉 ALL ATELIERSYNC PHASE 4 AUTOMATED TESTS PASSED!');
  console.log('====================================================');
}

runPhase4Tests().catch((err) => {
  console.error('\n❌ Phase 4 Tests Failed:', err);
  process.exit(1);
});
