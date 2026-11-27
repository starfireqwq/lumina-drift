import assert from 'node:assert/strict';
import { readPsd } from 'ag-psd';
import {
  computeRecommendedGpuTileBudget,
  computeWaveformPeaks,
  encodeCmykPsd,
  encodeCmykTiff,
  getPresetSeparationOptions,
  inspectCmykPsd,
  inspectCmykTiff,
  mixPcmChannels,
  normalizeCmykSeparationOptions,
  packBitsDecode,
  packBitsEncode,
  planExportAudioMix,
  separateRgbaToCmykBuffer,
  separateRgbPixelToCmyk,
  sliceWaveformPeaksForClip,
  TileGpuLruPool,
  type AudioTrackMeta,
} from '@atelier/shared';
import {
  buildWebCodecsAudioCandidates,
  resampleStereoPcm,
} from '../src/engine/videoExport';

export async function runV15Phase6ProPerfChecks(): Promise<void> {
  // ── 6.1: Audio Waveform Slicing, Export Mix Planning, PCM Mixing & Codec Candidates ──
  const tone = new Float32Array(48000); // 1 second at 48kHz
  for (let i = 0; i < tone.length; i++) {
    // First half quiet (0.25), second half loud (1.0)
    const amp = i < 24000 ? 0.25 : 1.0;
    tone[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * amp;
  }
  const fullPeaks = computeWaveformPeaks(tone, 160);
  assert.equal(fullPeaks.length, 160);

  const audioMeta: AudioTrackMeta = {
    localAssetId: 'aud_test_1',
    fileName: 'voice.wav',
    durationSec: 1.0,
    startFrame: 4,
    endFrame: 9, // 6 frames at 12fps = 0.5s
    trimStartSec: 0.5, // starts in the loud second half
    volume: 0.5,
    muted: false,
  };
  const slicedLoud = sliceWaveformPeaksForClip(fullPeaks, audioMeta, 12, 24);
  assert.equal(slicedLoud.rawBars.length, 24);
  assert.equal(slicedLoud.scaledBars.length, 24);
  assert.ok(slicedLoud.trimStartRatio >= 0.49 && slicedLoud.trimStartRatio <= 0.51, 'trimStartRatio should be ~0.5');
  assert.ok(slicedLoud.rawBars[12] > 0.85, `trimmed second half should be loud, got ${slicedLoud.rawBars[12]}`);
  assert.ok(
    Math.abs(slicedLoud.scaledBars[12] - slicedLoud.rawBars[12] * 0.5) < 0.02,
    'volume=0.5 should halve scaled waveform bar amplitude'
  );

  const slicedMuted = sliceWaveformPeaksForClip(fullPeaks, { ...audioMeta, muted: true }, 12, 16);
  assert.equal(slicedMuted.effectiveGain, 0);
  assert.ok(slicedMuted.scaledBars.every((v) => v === 0), 'muted clip scaledBars must be zero');
  assert.ok(slicedMuted.rawBars.some((v) => v > 0.5), 'muted clip rawBars should preserve ghost waveform');

  // Plan export audio mix across 2 active + 1 muted + 1 out-of-range track
  const mixPlan = planExportAudioMix(
    [
      { layerId: 'a1', meta: audioMeta }, // frames 4..9 at 12fps
      {
        layerId: 'a2',
        meta: {
          localAssetId: 'aud_test_2',
          fileName: 'bgm.wav',
          durationSec: 2.0,
          startFrame: 0,
          volume: 0.8,
          muted: false,
        },
      },
      {
        layerId: 'a3_muted',
        meta: { ...audioMeta, localAssetId: 'aud_muted', muted: true },
      },
      {
        layerId: 'a4_after',
        meta: { ...audioMeta, localAssetId: 'aud_after', startFrame: 30 },
      },
    ],
    2,
    11, // 10 frames = 10/12 sec
    12
  );
  assert.equal(mixPlan.hasActiveAudio, true);
  assert.equal(mixPlan.clips.length, 2, 'only 2 unmuted overlapping clips should be scheduled');
  const clipA1 = mixPlan.clips.find((c) => c.layerId === 'a1')!;
  const clipA2 = mixPlan.clips.find((c) => c.layerId === 'a2')!;
  assert.ok(Math.abs(clipA1.timelineStartSec - 2 / 12) < 1e-4, 'a1 should start 2 frames after exportStartFrame=2');
  assert.ok(Math.abs(clipA1.sourceOffsetSec - 0.5) < 1e-4, 'a1 should honor trimStartSec=0.5');
  assert.equal(clipA2.timelineStartSec, 0, 'a2 already active at frame 2 -> timelineStartSec=0');
  assert.ok(Math.abs(clipA2.sourceOffsetSec - 2 / 12) < 1e-4, 'a2 sourceOffsetSec should skip first 2 frames');

  // Deterministic stereo PCM mixing with sample-rate conversion (44.1kHz + 48kHz -> 48kHz) + soft-clip
  const src44k = new Float32Array(44100).fill(0.75);
  const src48kL = new Float32Array(48000).fill(0.8);
  const src48kR = new Float32Array(48000).fill(-0.8);
  const mixed = mixPcmChannels(48000, 0.5, [
    {
      left: src44k,
      sampleRate: 44100,
      sourceOffsetSec: 0,
      timelineStartSec: 0,
      playDurationSec: 0.5,
      gain: 1.0,
    },
    {
      left: src48kL,
      right: src48kR,
      sampleRate: 48000,
      sourceOffsetSec: 0,
      timelineStartSec: 0.1,
      playDurationSec: 0.4,
      gain: 1.0,
    },
  ]);
  assert.equal(mixed.mixedClipCount, 2);
  assert.equal(mixed.frameCount, 24000);
  assert.ok(Math.abs(mixed.left[100] - 0.75) < 0.01, 'before t=0.1s only clip1 plays');
  assert.ok(mixed.clippedSamples > 0, 'overlapping 0.75 + 0.8 should trigger soft-clipper');
  assert.ok(mixed.left[10000] <= 1.0 && mixed.left[10000] > 0.85, 'soft-clipped output must remain <= 1.0');
  assert.ok(Math.abs(mixed.right[10000] - -0.05) < 0.02, 'right channel 0.75 + (-0.8) should sum to ~-0.05');

  // WebCodecs Audio candidates & resampling
  const mp4AudioCands = buildWebCodecsAudioCandidates('mp4', 48000, 2);
  assert.equal(mp4AudioCands[0].muxerCodec, 'aac');
  assert.equal(mp4AudioCands[0].webCodecsCodec, 'mp4a.40.2');
  assert.ok(mp4AudioCands.some((c) => c.muxerCodec === 'opus'), 'mp4 should include opus fallback');
  const webmAudioCands = buildWebCodecsAudioCandidates('webm', 48000, 2);
  assert.equal(webmAudioCands[0].muxerCodec, 'A_OPUS');
  const resampled = resampleStereoPcm(new Float32Array(4800).fill(0.5), new Float32Array(4800).fill(-0.25), 48000, 44100);
  assert.equal(resampled.sampleRate, 44100);
  assert.equal(resampled.left.length, 4410);
  assert.ok(Math.abs(resampled.left[100] - 0.5) < 0.001);

  // ── 6.2: True CMYK 4-Channel Separation (GCR/UCR + TAC Warning) & TIFF / PSD Encoders ──
  const gcrOpts = normalizeCmykSeparationOptions({
    ...getPresetSeparationOptions('japan-color-2001-coated'),
    blackGeneration: 'gcr',
    blackStrength: 0.8,
    blackStart: 0.05,
    tacLimit: 260,
    enforceTacLimit: true,
  });
  const ucrOpts = normalizeCmykSeparationOptions({
    ...gcrOpts,
    blackGeneration: 'ucr',
    blackStart: 0.3,
  });

  const whitePx = separateRgbPixelToCmyk(255, 255, 255, gcrOpts);
  assert.equal(whitePx.c + whitePx.m + whitePx.y + whitePx.k, 0);
  assert.equal(whitePx.tacExceeded, false);

  // Chromatic dark blue-teal: GCR replaces gray component with more K than UCR
  const gcrChroma = separateRgbPixelToCmyk(20, 95, 140, gcrOpts);
  const ucrChroma = separateRgbPixelToCmyk(20, 95, 140, ucrOpts);
  assert.ok(
    gcrChroma.k > ucrChroma.k + 0.15,
    `GCR K (${gcrChroma.k.toFixed(3)}) should exceed UCR K (${ucrChroma.k.toFixed(3)}) on chromatic shadow`
  );

  // Rich black with low K strength exceeds 240% TAC limit and gets clamped when enforceTacLimit=true
  const lowKGcr = normalizeCmykSeparationOptions({
    presetId: 'custom',
    blackGeneration: 'gcr',
    blackStrength: 0.1,
    blackStart: 0.0,
    tacLimit: 240,
    enforceTacLimit: true,
  });
  const richBlack = separateRgbPixelToCmyk(0, 0, 0, lowKGcr);
  assert.equal(richBlack.tacExceeded, true, 'rich black should flag TAC exceedance over 240%');
  assert.ok(richBlack.rawTacPct > 240, `rawTacPct=${richBlack.rawTacPct} should exceed 240%`);
  assert.ok(richBlack.finalTacPct <= 240.1, `finalTacPct=${richBlack.finalTacPct} must be clamped to <= 240%`);

  // Buffer separation + TAC heatmap overlay verification
  const w = 16;
  const h = 12;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (x < 8) {
        // Left half: deep rich black (exceeds 240% TAC with lowK)
        rgba[p] = 5;
        rgba[p + 1] = 5;
        rgba[p + 2] = 5;
        rgba[p + 3] = 255;
      } else {
        // Right half: light warm paper tint (safe TAC)
        rgba[p] = 245;
        rgba[p + 1] = 235;
        rgba[p + 2] = 220;
        rgba[p + 3] = 255;
      }
    }
  }
  const sepRes = separateRgbaToCmykBuffer(rgba, w, h, lowKGcr, true);
  assert.equal(sepRes.cmyk.length, w * h * 4);
  assert.equal(sepRes.stats.overLimit, true);
  assert.equal(sepRes.stats.exceededPixelCount, (w / 2) * h);
  assert.ok(Math.abs(sepRes.stats.exceededRatio - 0.5) < 1e-6);
  assert.ok(sepRes.warningOverlayRgba, 'warning overlay RGBA should be generated');
  assert.equal(sepRes.warningOverlayRgba![0], 244, 'over-TAC pixel should have crimson/amber warning R=244');
  const safeOffset = 8 * 4;
  assert.equal(
    sepRes.warningOverlayRgba![safeOffset],
    sepRes.warningOverlayRgba![safeOffset + 1],
    'safe pixel in warning overlay should be desaturated neutral'
  );

  // PackBits RLE round-trip
  const samplePattern = new Uint8Array(512);
  samplePattern.fill(42, 0, 120);
  for (let i = 120; i < 300; i++) samplePattern[i] = (i * 37) & 0xff;
  samplePattern.fill(255, 300, 512);
  const packed = packBitsEncode(samplePattern);
  const unpacked = packBitsDecode(packed, samplePattern.length);
  assert.deepEqual(unpacked, samplePattern, 'PackBits RLE round-trip must be bit-exact');

  // True 4-channel CMYK TIFF 6.0 encoding + header & pixel round-trip verification
  const fakeIcc = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x61, 0x64, 0x62, 0x65, 1, 2, 3, 4, 5, 6, 7, 8]);
  const tiffBytes = encodeCmykTiff(sepRes.cmyk, w, h, {
    dpi: 350,
    compression: 'packbits',
    iccProfile: fakeIcc,
  });
  const tiffInfo = inspectCmykTiff(tiffBytes);
  assert.equal(tiffInfo.littleEndian, true);
  assert.equal(tiffInfo.width, w);
  assert.equal(tiffInfo.height, h);
  assert.equal(tiffInfo.samplesPerPixel, 4, 'TIFF must have 4 samples per pixel (CMYK)');
  assert.equal(tiffInfo.photometric, 5, 'TIFF PhotometricInterpretation must be 5 (Separated/CMYK)');
  assert.equal(tiffInfo.inkSet, 1, 'TIFF InkSet must be 1 (CMYK)');
  assert.deepEqual(tiffInfo.bitsPerSample, [8, 8, 8, 8]);
  assert.equal(tiffInfo.compression, 32773, 'TIFF compression should be PackBits (32773)');
  assert.equal(tiffInfo.dpiX, 350);
  assert.equal(tiffInfo.dpiY, 350);
  assert.equal(tiffInfo.hasIccProfile, true);
  assert.equal(tiffInfo.iccProfileBytes, fakeIcc.byteLength);
  assert.deepEqual(tiffInfo.decodePixels(), sepRes.cmyk, 'TIFF CMYK pixel round-trip must be bit-exact');

  // True 4-channel CMYK PSD encoding + header verification + ag-psd cross-parse
  const alphaLayer = new Uint8Array(w * h).fill(255);
  const psdBytes = encodeCmykPsd(sepRes.cmyk, w, h, {
    dpi: 300,
    compression: 'rle',
    iccProfile: fakeIcc,
    layers: [
      { name: 'Base Ink', cmyk: sepRes.cmyk, alpha: alphaLayer, width: w, height: h, opacity: 1, visible: true, blendModeKey: 'norm' },
      { name: 'Shadow', cmyk: sepRes.cmyk, alpha: alphaLayer, width: w, height: h, opacity: 0.75, visible: true, blendModeKey: 'mul ' },
    ],
  });
  const psdInfo = inspectCmykPsd(psdBytes);
  assert.equal(psdInfo.signature, '8BPS');
  assert.equal(psdInfo.version, 1);
  assert.equal(psdInfo.channels, 4, 'PSD must declare 4 CMYK channels');
  assert.equal(psdInfo.width, w);
  assert.equal(psdInfo.height, h);
  assert.equal(psdInfo.depth, 8);
  assert.equal(psdInfo.colorMode, 4, 'PSD ColorMode must be 4 (CMYK)');
  assert.equal(psdInfo.hasIccProfile, true);
  assert.equal(psdInfo.layerCount, 2);
  assert.equal(psdInfo.compression, 1);

  // Cross-verify CMYK PSD structure with third-party ag-psd parser
  const parsedByAgPsd = readPsd(psdBytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  assert.equal(parsedByAgPsd.width, w);
  assert.equal(parsedByAgPsd.height, h);
  assert.equal(parsedByAgPsd.colorMode, 4, 'ag-psd readPsd must recognize ColorMode=4 (CMYK)');
  assert.equal(parsedByAgPsd.children?.length, 2, 'ag-psd readPsd must decode both CMYK layers');
  assert.equal(parsedByAgPsd.children?.[0]?.name, 'Base Ink');
  assert.equal(parsedByAgPsd.children?.[1]?.blendMode, 'multiply');

  // ── 6.3: Large Canvas (4K–8K+) Tile GPU Texture LRU Pool & Stress Regression ──
  const budget4K = computeRecommendedGpuTileBudget(4096, 4096, 16, false);
  const budget8K = computeRecommendedGpuTileBudget(8192, 8192, 16, false);
  const budgetMobile = computeRecommendedGpuTileBudget(8192, 8192, 4, true);
  assert.ok(budget8K.maxTiles <= budget4K.maxTiles, '8K budget should cap GPU tile count tightly');
  assert.ok(budget8K.maxBytes <= 320 * 1024 * 1024, '8K GPU byte budget must stay <= 320 MB');
  assert.ok(budgetMobile.maxTiles < budget8K.maxTiles, 'low-memory mobile budget must be tighter than desktop');

  const pool = new TileGpuLruPool({
    maxTiles: 256,
    maxBytes: 64 * 1024 * 1024, // 64 MB ceiling
    lowWaterRatio: 0.85,
    maxDirtyEvictBatch: 16,
  });

  const TILE_BYTES = 256 * 256 * 4; // 256 KB
  const t0 = performance.now();
  let prevViewportIds: string[] = [];
  // Simulate 5-layer 8K canvas pan/zoom + brush commit pressure (2,000 tile touches across 50 viewport waves)
  for (let wave = 0; wave < 50; wave++) {
    // Tiles from previous wave scroll offscreen as viewport pans
    for (const oldId of prevViewportIds) {
      pool.setInViewport(oldId, false);
    }
    const nextViewportIds: string[] = [];
    const viewRowStart = (wave * 2) % 24;
    for (let layerIdx = 0; layerIdx < 5; layerIdx++) {
      for (let t = 0; t < 8; t++) {
        const col = (wave + t) % 32;
        const row = (viewRowStart + (t % 4)) % 32;
        const id = `L${layerIdx}:${col}_${row}`;
        const inView = t < 2;
        if (inView) nextViewportIds.push(id);
        pool.touch(
          id,
          {
            layerId: `L${layerIdx}`,
            tileKey: `${col}_${row}`,
            bytes: TILE_BYTES,
            clean: (layerIdx + t) % 2 === 0,
            inViewport: inView,
            pinned: layerIdx === 0 && col === 0 && row === 0,
          },
          wave * 100 + t
        );
      }
    }
    prevViewportIds = nextViewportIds;
    if (pool.isOverBudget()) {
      const plan = pool.planEviction();
      for (const id of plan.cleanIds) {
        assert.notEqual(id, 'L0:0_0', 'pinned tile must never be evicted');
        pool.recordEviction(id, 'clean');
      }
      for (const id of plan.dirtyIds) {
        assert.notEqual(id, 'L0:0_0', 'pinned tile must never be evicted');
        pool.recordEviction(id, 'dirty');
      }
    }
  }
  // Post-burst housekeeping ticks converge dirty backlog cleanly down to <= low-water target
  for (let drain = 0; drain < 4 && pool.isOverBudget(); drain++) {
    const plan = pool.planEviction();
    for (const id of plan.cleanIds) pool.recordEviction(id, 'clean');
    for (const id of plan.dirtyIds) pool.recordEviction(id, 'dirty');
  }
  const elapsedMs = performance.now() - t0;
  const stats = pool.getStats();
  assert.ok(stats.totalEvictions > 100, `expected >100 LRU evictions under 8K pressure, got ${stats.totalEvictions}`);
  assert.ok(stats.cleanEvictions >= stats.dirtyEvictions, 'clean tiles must be evicted ahead of dirty tiles');
  assert.ok(stats.activeTiles <= 256, `active tiles (${stats.activeTiles}) must remain bounded by maxTiles=256`);
  assert.ok(stats.activeBytes <= 64 * 1024 * 1024, `active bytes (${stats.activeBytes}) must stay <= 64MB`);
  assert.ok(elapsedMs < 250, `8K LRU stress simulation should finish quickly (<250ms), took ${elapsedMs.toFixed(1)}ms`);

  // Verify clean-first ordering explicitly on deterministic small pool
  const detPool = new TileGpuLruPool({ maxTiles: 16, maxBytes: 16 * TILE_BYTES, lowWaterRatio: 0.75 });
  for (let i = 0; i < 20; i++) {
    detPool.touch(
      `t_${i}`,
      {
        layerId: 'L1',
        tileKey: `${i}_0`,
        bytes: TILE_BYTES,
        clean: i >= 10, // newer tiles are clean, older tiles are dirty
        inViewport: i === 19,
        pinned: i === 0,
      },
      i * 10
    );
  }
  const detPlan = detPool.planEviction();
  assert.ok(detPlan.cleanIds.length > 0, 'should select clean tiles first even if newer than dirty tiles');
  assert.ok(!detPlan.cleanIds.includes('t_19') && !detPlan.dirtyIds.includes('t_19'), 'in-viewport tile protected');
  assert.ok(!detPlan.cleanIds.includes('t_0') && !detPlan.dirtyIds.includes('t_0'), 'pinned tile protected');
}
