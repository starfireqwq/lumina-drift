import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildVideoRecorderCandidates,
  computeVideoExportDimensions,
  computeVideoExportDimensionsForResolution,
  getVideoBitrateForResolution,
  getVideoExtensionFromBlob,
  MP4_4K_LIMITS,
  unwrapMediaRecorderError,
  VIDEO_1080P_LIMITS,
  VIDEO_2K_LIMITS,
  VIDEO_4K_LIMITS,
  WEBM_4K_LIMITS,
} from '../src/engine/videoExport.ts';

test('computeVideoExportDimensions preserves aspect ratio, enforces even dimensions, and caps all video formats at 4K (3840x2160)', () => {
  assert.deepEqual(computeVideoExportDimensions(1920, 1080, MP4_4K_LIMITS), { width: 1920, height: 1080 });
  assert.deepEqual(computeVideoExportDimensions(3840, 2160, MP4_4K_LIMITS), { width: 3840, height: 2160 });
  assert.deepEqual(computeVideoExportDimensions(2160, 3840, MP4_4K_LIMITS), { width: 2160, height: 3840 });

  assert.deepEqual(computeVideoExportDimensions(4000, 4000, MP4_4K_LIMITS), { width: 2160, height: 2160 });
  assert.deepEqual(computeVideoExportDimensions(8000, 8000, MP4_4K_LIMITS), { width: 2160, height: 2160 });
  assert.deepEqual(computeVideoExportDimensions(8000, 4000, MP4_4K_LIMITS), { width: 3840, height: 1920 });

  assert.deepEqual(computeVideoExportDimensions(1001, 1001, MP4_4K_LIMITS), { width: 1000, height: 1000 });

  // WebM also respects the 4K (3840x2160) ceiling regardless of canvas size
  assert.deepEqual(WEBM_4K_LIMITS, VIDEO_4K_LIMITS);
  assert.deepEqual(computeVideoExportDimensions(4000, 4000, WEBM_4K_LIMITS), { width: 2160, height: 2160 });
  assert.deepEqual(computeVideoExportDimensions(8000, 8000, WEBM_4K_LIMITS), { width: 2160, height: 2160 });
  assert.deepEqual(computeVideoExportDimensions(7680, 4320, WEBM_4K_LIMITS), { width: 3840, height: 2160 });
});

test('computeVideoExportDimensionsForResolution converts 1080p, 2K, and 4K cleanly for non-standard aspect ratios', () => {
  // Standard 16:9 from oversized 8K canvas
  assert.deepEqual(computeVideoExportDimensionsForResolution(7680, 4320, '1080p'), { width: 1920, height: 1080 });
  assert.deepEqual(computeVideoExportDimensionsForResolution(7680, 4320, '2k'), { width: 2560, height: 1440 });
  assert.deepEqual(computeVideoExportDimensionsForResolution(7680, 4320, '4k'), { width: 3840, height: 2160 });

  // Portrait 9:16
  assert.deepEqual(computeVideoExportDimensionsForResolution(4500, 8000, '1080p'), { width: 1080, height: 1920 });
  assert.deepEqual(computeVideoExportDimensionsForResolution(4500, 8000, '2k'), { width: 1440, height: 2560 });
  assert.deepEqual(computeVideoExportDimensionsForResolution(4500, 8000, '4k'), { width: 2160, height: 3840 });

  // Square 1:1 (4000x4000 & 8000x8000)
  assert.deepEqual(computeVideoExportDimensionsForResolution(4000, 4000, '1080p'), { width: 1080, height: 1080 });
  assert.deepEqual(computeVideoExportDimensionsForResolution(4000, 4000, '2k'), { width: 1440, height: 1440 });
  assert.deepEqual(computeVideoExportDimensionsForResolution(4000, 4000, '4k'), { width: 2160, height: 2160 });

  // 4:3 illustration
  assert.deepEqual(computeVideoExportDimensionsForResolution(4000, 3000, '1080p'), { width: 1440, height: 1080 });
  assert.deepEqual(computeVideoExportDimensionsForResolution(4000, 3000, '2k'), { width: 1920, height: 1440 });
  assert.deepEqual(computeVideoExportDimensionsForResolution(4000, 3000, '4k'), { width: 2880, height: 2160 });

  // 21:9 ultrawide
  assert.deepEqual(computeVideoExportDimensionsForResolution(7680, 3200, '1080p'), { width: 1920, height: 800 });
  assert.deepEqual(computeVideoExportDimensionsForResolution(7680, 3200, '2k'), { width: 2560, height: 1066 });
  assert.deepEqual(computeVideoExportDimensionsForResolution(7680, 3200, '4k'), { width: 3840, height: 1600 });

  // Floating-point exact boundary (e.g. 1070 -> 1080/1070) must not lose 2 pixels
  assert.deepEqual(computeVideoExportDimensions(1070, 1070, VIDEO_1080P_LIMITS), { width: 1070, height: 1070 });
  assert.deepEqual(computeVideoExportDimensions(2970, 2970, VIDEO_2K_LIMITS), { width: 1440, height: 1440 });

  // Smaller canvases never upscale
  assert.deepEqual(computeVideoExportDimensionsForResolution(1000, 1000, '4k'), { width: 1000, height: 1000 });
  assert.deepEqual(computeVideoExportDimensionsForResolution(2048, 2048, '4k'), { width: 2048, height: 2048 });
});

test('buildVideoRecorderCandidates orders MP4 H.264 4K -> 2K -> 1080p -> MP4 VP9 -> WebM fallbacks without duplicates', () => {
  const supported = new Set([
    'video/mp4;codecs=avc1',
    'video/mp4;codecs=vp9',
    'video/webm;codecs=vp9',
  ]);
  const candidates = buildVideoRecorderCandidates(4000, 4000, 'mp4', (m) => supported.has(m));
  assert.deepEqual(
    candidates.map((c) => `${c.mimeType}@${c.width}x${c.height}`),
    [
      'video/mp4;codecs=avc1@2160x2160',
      'video/mp4;codecs=avc1@1440x1440',
      'video/mp4;codecs=avc1@1080x1080',
      'video/mp4;codecs=vp9@2160x2160',
      'video/webm;codecs=vp9@2160x2160',
    ]
  );

  const webm1080 = buildVideoRecorderCandidates(8000, 8000, 'webm', '1080p', (m) => supported.has(m));
  assert.equal(webm1080[0].mimeType, 'video/webm;codecs=vp9');
  assert.equal(webm1080[0].width, 1080);
  assert.equal(webm1080[0].height, 1080);

  const webm2k = buildVideoRecorderCandidates(8000, 8000, 'webm', '2k', (m) => supported.has(m));
  assert.equal(webm2k[0].width, 1440);
  assert.equal(webm2k[0].height, 1440);

  const webm4k = buildVideoRecorderCandidates(8000, 8000, 'webm', '4k', (m) => supported.has(m));
  assert.equal(webm4k[0].width, 2160);
  assert.equal(webm4k[0].height, 2160);

  const emptyFallback = buildVideoRecorderCandidates(1920, 1080, 'mp4', () => false);
  assert.deepEqual(emptyFallback, [
    { mimeType: '', extension: 'webm', width: 1920, height: 1080 },
  ]);

  assert.ok(getVideoBitrateForResolution('1080p') < getVideoBitrateForResolution('2k'));
  assert.ok(getVideoBitrateForResolution('2k') < getVideoBitrateForResolution('4k'));
});

test('unwrapMediaRecorderError extracts DOM ErrorEvent/DOMException details cleanly', () => {
  const domErrorEvent = {
    type: 'error',
    message: '',
    error: {
      name: 'EncodingError',
      message: 'The given encoder configuration is not supported by the encoder.',
    },
  };
  assert.equal(
    unwrapMediaRecorderError(domErrorEvent).message,
    'EncodingError: The given encoder configuration is not supported by the encoder.'
  );

  const nativeErr = new Error('boom');
  assert.equal(unwrapMediaRecorderError(nativeErr), nativeErr);
  assert.equal(unwrapMediaRecorderError({ type: 'error' }).message, 'MediaRecorder error (error)');
  assert.equal(unwrapMediaRecorderError(undefined).message, 'MediaRecorder encoding failed');
});

test('getVideoExtensionFromBlob infers extension from Blob MIME type', () => {
  assert.equal(getVideoExtensionFromBlob(new Blob([], { type: 'video/mp4;codecs=avc1' }), 'webm'), 'mp4');
  assert.equal(getVideoExtensionFromBlob(new Blob([], { type: 'video/webm;codecs=vp9' }), 'mp4'), 'webm');
  assert.equal(getVideoExtensionFromBlob(new Blob([], { type: '' }), 'mp4'), 'mp4');
});
