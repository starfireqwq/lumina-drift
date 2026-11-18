import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildVideoRecorderCandidates,
  computeVideoExportDimensions,
  getVideoExtensionFromBlob,
  MP4_4K_LIMITS,
  unwrapMediaRecorderError,
  WEBM_4K_LIMITS,
} from '../src/engine/videoExport.ts';

test('computeVideoExportDimensions preserves aspect ratio, enforces even dimensions, and caps oversized MP4 canvases', () => {
  assert.deepEqual(computeVideoExportDimensions(1920, 1080, MP4_4K_LIMITS), { width: 1920, height: 1080 });
  assert.deepEqual(computeVideoExportDimensions(3840, 2160, MP4_4K_LIMITS), { width: 3840, height: 2160 });
  assert.deepEqual(computeVideoExportDimensions(2160, 3840, MP4_4K_LIMITS), { width: 2160, height: 3840 });

  assert.deepEqual(computeVideoExportDimensions(4000, 4000, MP4_4K_LIMITS), { width: 2160, height: 2160 });
  assert.deepEqual(computeVideoExportDimensions(8000, 8000, MP4_4K_LIMITS), { width: 2160, height: 2160 });
  assert.deepEqual(computeVideoExportDimensions(8000, 4000, MP4_4K_LIMITS), { width: 3840, height: 1920 });

  assert.deepEqual(computeVideoExportDimensions(1001, 1001, MP4_4K_LIMITS), { width: 1000, height: 1000 });

  assert.deepEqual(computeVideoExportDimensions(4000, 4000, WEBM_4K_LIMITS), { width: 4000, height: 4000 });
  assert.deepEqual(computeVideoExportDimensions(8000, 8000, WEBM_4K_LIMITS), { width: 4096, height: 4096 });
});

test('buildVideoRecorderCandidates orders MP4 H.264 2160p -> 1080p -> MP4 VP9 -> WebM fallbacks without duplicates', () => {
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
      'video/mp4;codecs=avc1@1080x1080',
      'video/mp4;codecs=vp9@2160x2160',
      'video/webm;codecs=vp9@4000x4000',
    ]
  );

  const webmFirst = buildVideoRecorderCandidates(4000, 4000, 'webm', (m) => supported.has(m));
  assert.equal(webmFirst[0].mimeType, 'video/webm;codecs=vp9');
  assert.equal(webmFirst[0].width, 4000);

  const emptyFallback = buildVideoRecorderCandidates(1920, 1080, 'mp4', () => false);
  assert.deepEqual(emptyFallback, [
    { mimeType: '', extension: 'webm', width: 1920, height: 1080 },
  ]);
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
