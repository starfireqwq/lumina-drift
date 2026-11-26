import assert from 'node:assert/strict';
import {
  addColorRangeSample,
  applyLayerEffectsToRgba,
  computeColorRangeMask,
  computeLayerEffectsPadding,
  createDefaultLayerEffects,
  hasActiveLayerEffects,
  layerEffectsKey,
  normalizeLayerEffectsMeta,
  perceptualColorDistance,
  removeMatchingColorRangeSample,
  sampleRgbaAt,
  sanitizeLayerMetaForType,
  type LayerEffectsMeta,
} from '@atelier/shared';
import { DEFAULT_SHORTCUTS } from '../src/engine/ShortcutManager';
import { translations } from '../src/locales';

function makeSolidSquare(size: number, x0: number, y0: number, x1: number, y1: number, rgba: [number, number, number, number]): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(size * size * 4);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * size + x) * 4;
      buf[i] = rgba[0];
      buf[i + 1] = rgba[1];
      buf[i + 2] = rgba[2];
      buf[i + 3] = rgba[3];
    }
  }
  return buf;
}

function pixelAt(buf: Uint8ClampedArray, size: number, x: number, y: number): [number, number, number, number] {
  const i = (y * size + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

export async function runV15Phase4EffectsSelectionChecks() {
  // 1. Layer Effects normalization, padding, cache key, and sanitization
  {
    const def = createDefaultLayerEffects();
    assert.equal(def.enabled, true);
    assert.equal(hasActiveLayerEffects(def), false);
    assert.equal(layerEffectsKey(def), '');
    assert.equal(computeLayerEffectsPadding(def), 0);

    const norm = normalizeLayerEffectsMeta({
      enabled: true,
      border: { enabled: true, mode: 'edge', width: 5, color: ' #f00 ', opacity: 1 },
      dropShadow: { enabled: true, color: '#000', opacity: 0.5, offsetX: 8, offsetY: -4, blur: 6, spread: 2 },
      outerGlow: { enabled: true, color: '#0af', opacity: 0.8, radius: 10, spread: 1 },
      colorOverlay: { enabled: true, color: '#abc', opacity: 0.5, blendMode: 'multiply' },
    });
    assert.ok(norm);
    assert.equal(norm.border?.color, '#FF0000');
    assert.equal(norm.dropShadow?.color, '#000000');
    assert.equal(norm.outerGlow?.color, '#00AAFF');
    assert.equal(norm.colorOverlay?.color, '#AABBCC');
    assert.equal(hasActiveLayerEffects(norm), true);
    assert.ok(layerEffectsKey(norm).length > 10);
    assert.ok(computeLayerEffectsPadding(norm) >= 17);

    // sanitizeLayerMetaForType: raster & group keep effects; mask strips; invalid rejects
    const rasterOk = sanitizeLayerMetaForType('raster', { effects: norm });
    assert.equal(rasterOk.ok, true);
    if (rasterOk.ok) assert.ok(rasterOk.meta?.effects?.border?.enabled);

    const groupOk = sanitizeLayerMetaForType('group', { effects: norm });
    assert.equal(groupOk.ok, true);
    if (groupOk.ok) assert.ok(groupOk.meta?.effects?.border?.enabled);

    const maskStripped = sanitizeLayerMetaForType('mask', { effects: norm });
    assert.equal(maskStripped.ok, true);
    if (maskStripped.ok) assert.equal(maskStripped.meta?.effects, undefined);

    const invalid = sanitizeLayerMetaForType('raster', {
      effects: { enabled: true, border: { enabled: true, mode: 'bad' as any, width: 4, color: '#000', opacity: 1 } },
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error, '圖層樣式參數無效');
  }

  // 2. CPU Layer Effects pixel rendering (edge border, watercolor border, drop shadow, outer glow, color overlay)
  {
    const S = 48;
    const base = makeSolidSquare(S, 18, 18, 30, 30, [40, 120, 240, 255]);

    // 2a. Edge border
    const edgeFx: LayerEffectsMeta = {
      enabled: true,
      border: { enabled: true, mode: 'edge', width: 3, color: '#FF0000', opacity: 1, antiAlias: true },
    };
    const edgeOut = applyLayerEffectsToRgba(base, S, S, edgeFx);
    const center = pixelAt(edgeOut, S, 24, 24);
    assert.deepEqual(center, [40, 120, 240, 255], 'edge border keeps interior pixels intact');
    const rim = pixelAt(edgeOut, S, 16, 24); // 2px outside left edge
    assert.ok(rim[0] > 230 && rim[2] < 20 && rim[3] > 230, `expected solid red border at (16,24), got ${rim}`);
    const far = pixelAt(edgeOut, S, 2, 2);
    assert.equal(far[3], 0, 'pixels far outside border remain transparent');

    // 2b. Watercolor border
    const wcFx: LayerEffectsMeta = {
      enabled: true,
      border: {
        enabled: true,
        mode: 'watercolor',
        width: 4,
        color: '#000000',
        opacity: 1,
        watercolorDarkness: 0.75,
        watercolorBlur: 3,
      },
    };
    const wcOut = applyLayerEffectsToRgba(base, S, S, wcFx);
    const wcCenter = pixelAt(wcOut, S, 24, 24);
    const wcRimInside = pixelAt(wcOut, S, 18, 24);
    const wcCenterLum = wcCenter[0] + wcCenter[1] + wcCenter[2];
    const wcRimLum = wcRimInside[0] + wcRimInside[1] + wcRimInside[2];
    assert.ok(wcRimLum < wcCenterLum, `watercolor interior edge (${wcRimLum}) should be darker than center (${wcCenterLum})`);
    const wcBleed = pixelAt(wcOut, S, 17, 24); // 1px outside
    assert.ok(wcBleed[3] > 0 && wcBleed[3] < 200, `watercolor outer bleed should be translucent, got alpha=${wcBleed[3]}`);

    // 2c. Drop shadow
    const shadowFx: LayerEffectsMeta = {
      enabled: true,
      dropShadow: { enabled: true, color: '#000000', opacity: 0.8, offsetX: 6, offsetY: 6, blur: 2, spread: 0 },
    };
    const shadowOut = applyLayerEffectsToRgba(base, S, S, shadowFx);
    const shHit = pixelAt(shadowOut, S, 33, 33); // shifted bottom-right outside original square
    const shMiss = pixelAt(shadowOut, S, 12, 12); // opposite top-left
    assert.ok(shHit[3] > 80 && shHit[0] < 30, `drop shadow should render at (33,33), got ${shHit}`);
    assert.equal(shMiss[3], 0, 'opposite side of drop shadow should stay transparent');

    // 2d. Outer glow
    const glowFx: LayerEffectsMeta = {
      enabled: true,
      outerGlow: { enabled: true, color: '#00FF00', opacity: 0.9, radius: 5, spread: 1 },
    };
    const glowOut = applyLayerEffectsToRgba(base, S, S, glowFx);
    const glowLeft = pixelAt(glowOut, S, 16, 24);
    const glowRight = pixelAt(glowOut, S, 31, 24);
    assert.ok(glowLeft[1] > 200 && glowLeft[3] > 50, `expected green outer glow left, got ${glowLeft}`);
    assert.ok(glowRight[1] > 200 && glowRight[3] > 50, `expected green outer glow right, got ${glowRight}`);

    // 2e. Color overlay
    const overlayFx: LayerEffectsMeta = {
      enabled: true,
      colorOverlay: { enabled: true, color: '#FF0000', opacity: 1, blendMode: 'normal' },
    };
    const overlayOut = applyLayerEffectsToRgba(base, S, S, overlayFx);
    assert.deepEqual(pixelAt(overlayOut, S, 24, 24), [255, 0, 0, 255], '100% normal color overlay replaces interior RGB');
    assert.equal(pixelAt(overlayOut, S, 4, 4)[3], 0, 'color overlay never fills transparent background');
  }

  // 3. Color Range Selection core algorithm
  {
    const W = 24;
    const H = 24;
    const img = new Uint8ClampedArray(W * H * 4);
    // Top-left: red (0..11, 0..11); Top-right: green (12..23, 0..11); Bottom-left: blue (0..11, 12..23); Bottom-right: transparent
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (x < 12 && y < 12) { img[i] = 230; img[i + 1] = 30; img[i + 2] = 30; img[i + 3] = 255; }
        else if (x >= 12 && y < 12) { img[i] = 30; img[i + 1] = 210; img[i + 2] = 40; img[i + 3] = 255; }
        else if (x < 12 && y >= 12) { img[i] = 30; img[i + 1] = 70; img[i + 2] = 230; img[i + 3] = 255; }
      }
    }

    const redSample = sampleRgbaAt(img, W, H, 4, 4, false);
    const greenSample = sampleRgbaAt(img, W, H, 16, 4, false);
    const blueSample = sampleRgbaAt(img, W, H, 4, 16, false);
    const emptySample = sampleRgbaAt(img, W, H, 18, 18, false);
    assert.ok(redSample && greenSample && blueSample);
    assert.equal(emptySample, null);
    assert.ok(perceptualColorDistance(redSample.r, redSample.g, redSample.b, blueSample.r, blueSample.g, blueSample.b) > 80);

    // Single color selection
    const mRed = computeColorRangeMask(img, W, H, { samples: [redSample], fuzziness: 35, feather: 0, invert: false });
    assert.equal(mRed[4 * W + 4], 255);
    assert.equal(mRed[4 * W + 16], 0);
    assert.equal(mRed[16 * W + 4], 0);
    assert.equal(mRed[18 * W + 18], 0);

    // Add second sample (red + green)
    const twoSamples = addColorRangeSample([redSample], greenSample);
    assert.equal(twoSamples.length, 2);
    const mRedGreen = computeColorRangeMask(img, W, H, { samples: twoSamples, fuzziness: 35, feather: 0, invert: false });
    assert.equal(mRedGreen[4 * W + 4], 255);
    assert.equal(mRedGreen[4 * W + 16], 255);
    assert.equal(mRedGreen[16 * W + 4], 0);

    // Exclude sample removes green
    const mExcluded = computeColorRangeMask(img, W, H, {
      samples: twoSamples,
      excludeSamples: [greenSample],
      fuzziness: 35,
      feather: 0,
      invert: false,
    });
    assert.equal(mExcluded[4 * W + 4], 255);
    assert.equal(mExcluded[4 * W + 16], 0);

    // Remove matching sample helper
    const removed = removeMatchingColorRangeSample(twoSamples, greenSample);
    assert.equal(removed.removed, true);
    assert.equal(removed.next.length, 1);

    // Invert & Feather
    const mInv = computeColorRangeMask(img, W, H, { samples: [redSample], fuzziness: 35, feather: 0, invert: true });
    assert.equal(mInv[4 * W + 4], 0);
    assert.equal(mInv[16 * W + 4], 255);

    const mFeather = computeColorRangeMask(img, W, H, { samples: [redSample], fuzziness: 35, feather: 4, invert: false });
    const edgeVal = mFeather[4 * W + 12]; // right across red/green seam
    assert.ok(edgeVal > 0 && edgeVal < 255, `feathered seam should be soft (0..255), got ${edgeVal}`);
  }

  // 4. Shortcut registration & 4-locale completeness for Phase 4 keys
  {
    const qmShortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'action_toggle_quick_mask');
    assert.ok(qmShortcut, 'action_toggle_quick_mask must be registered in DEFAULT_SHORTCUTS');
    assert.equal(qmShortcut.defaultCombo, 'KeyQ');
    const keyQCount = DEFAULT_SHORTCUTS.filter((s) => s.defaultCombo === 'KeyQ').length;
    assert.equal(keyQCount, 1, 'KeyQ shortcut must not conflict with any other default shortcut');

    for (const [lang, t] of Object.entries(translations)) {
      assert.ok(t.layers.effects.title, `${lang}: layers.effects.title missing`);
      assert.ok(t.layers.effects.borderWatercolor, `${lang}: layers.effects.borderWatercolor missing`);
      assert.ok(t.layers.effects.dropShadow, `${lang}: layers.effects.dropShadow missing`);
      assert.ok(t.layers.effects.outerGlow, `${lang}: layers.effects.outerGlow missing`);
      assert.ok(t.layers.effects.colorOverlay, `${lang}: layers.effects.colorOverlay missing`);
      assert.ok(t.toolOptions.quickMask, `${lang}: toolOptions.quickMask missing`);
      assert.ok(t.colorRange.title, `${lang}: colorRange.title missing`);
      assert.ok(t.export.webp, `${lang}: export.webp missing`);
    }
  }
}
