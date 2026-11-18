export type VideoExportFormat = 'mp4' | 'webm';

export interface VideoSizeLimits {
  maxLongSide: number;
  maxShortSide: number;
  maxPixels: number;
}

export interface VideoRecorderCandidate {
  mimeType: string;
  extension: VideoExportFormat;
  width: number;
  height: number;
}

export interface ScaledRecordingSurface {
  canvas: HTMLCanvasElement;
  syncFrame: () => void;
}

export const MP4_4K_LIMITS: VideoSizeLimits = {
  maxLongSide: 3840,
  maxShortSide: 2160,
  maxPixels: 3840 * 2160,
};

export const MP4_1080_LIMITS: VideoSizeLimits = {
  maxLongSide: 1920,
  maxShortSide: 1080,
  maxPixels: 1920 * 1080,
};

export const WEBM_4K_LIMITS: VideoSizeLimits = {
  maxLongSide: 4096,
  maxShortSide: 4096,
  maxPixels: 4096 * 4096,
};

function toEvenDimension(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * Computes aspect-ratio-preserving even pixel dimensions within encoder bounds.
 * H.264 (`avc1`) requires even width/height and fails with `EncodingError` on canvases
 * exceeding ~8.29M pixels (e.g., 4000x4000 or 8000x8000).
 */
export function computeVideoExportDimensions(
  srcWidth: number,
  srcHeight: number,
  limits: VideoSizeLimits
): { width: number; height: number } {
  const safeW = Math.max(2, Math.floor(srcWidth));
  const safeH = Math.max(2, Math.floor(srcHeight));
  const longSide = Math.max(safeW, safeH);
  const shortSide = Math.min(safeW, safeH);
  const pixels = safeW * safeH;

  let scale = 1;
  if (longSide > limits.maxLongSide) {
    scale = Math.min(scale, limits.maxLongSide / longSide);
  }
  if (shortSide > limits.maxShortSide) {
    scale = Math.min(scale, limits.maxShortSide / shortSide);
  }
  if (pixels > limits.maxPixels) {
    scale = Math.min(scale, Math.sqrt(limits.maxPixels / pixels));
  }

  return {
    width: toEvenDimension(safeW * scale),
    height: toEvenDimension(safeH * scale),
  };
}

/**
 * Returns an ordered list of MIME + dimension candidates supported by `MediaRecorder`.
 * Falls back gracefully from 2160p/4K H.264 -> 1080p H.264 -> MP4 VP9 -> WebM VP9/VP8.
 */
export function buildVideoRecorderCandidates(
  srcWidth: number,
  srcHeight: number,
  format: VideoExportFormat,
  isTypeSupported?: (mimeType: string) => boolean
): VideoRecorderCandidate[] {
  const supports =
    isTypeSupported ??
    ((mimeType: string) =>
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType));

  const mp4Primary = computeVideoExportDimensions(srcWidth, srcHeight, MP4_4K_LIMITS);
  const mp4Fallback1080 = computeVideoExportDimensions(srcWidth, srcHeight, MP4_1080_LIMITS);
  const webmDims = computeVideoExportDimensions(srcWidth, srcHeight, WEBM_4K_LIMITS);

  const candidates: VideoRecorderCandidate[] = [];
  const seen = new Set<string>();
  const addIfSupported = (
    mimeType: string,
    extension: VideoExportFormat,
    dims: { width: number; height: number },
    requireSupportCheck = true
  ) => {
    if (requireSupportCheck && !supports(mimeType)) return;
    const key = `${mimeType}@${dims.width}x${dims.height}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ mimeType, extension, width: dims.width, height: dims.height });
  };

  if (format === 'mp4') {
    for (const mime of ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.42E01E']) {
      addIfSupported(mime, 'mp4', mp4Primary);
    }
    if (mp4Fallback1080.width < mp4Primary.width || mp4Fallback1080.height < mp4Primary.height) {
      for (const mime of ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.42E01E']) {
        addIfSupported(mime, 'mp4', mp4Fallback1080);
      }
    }
    addIfSupported('video/mp4;codecs=vp9', 'mp4', mp4Primary);
    addIfSupported('video/mp4', 'mp4', mp4Primary);
    for (const mime of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
      addIfSupported(mime, 'webm', webmDims);
    }
  } else {
    for (const mime of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
      addIfSupported(mime, 'webm', webmDims);
    }
    for (const mime of ['video/mp4;codecs=avc1', 'video/mp4']) {
      addIfSupported(mime, 'mp4', mp4Primary);
    }
  }

  if (candidates.length === 0) {
    addIfSupported('', 'webm', webmDims, false);
  }

  return candidates;
}

/**
 * Unwraps DOM `ErrorEvent` / `MediaRecorderErrorEvent` / `DOMException` objects into a
 * descriptive `Error` instead of letting UI alerts print `[object ErrorEvent]`.
 */
export function unwrapMediaRecorderError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string' && err.trim()) return new Error(err);

  if (err && typeof err === 'object') {
    const obj = err as {
      error?: unknown;
      message?: unknown;
      name?: unknown;
      type?: unknown;
    };
    const inner = obj.error;
    if (inner instanceof Error) return inner;

    if (inner && typeof inner === 'object') {
      const innerObj = inner as { name?: unknown; message?: unknown };
      const innerName = typeof innerObj.name === 'string' ? innerObj.name : '';
      const innerMsg = typeof innerObj.message === 'string' ? innerObj.message : '';
      const combined = [innerName, innerMsg].filter(Boolean).join(': ');
      if (combined) return new Error(combined);
    }

    const msg = typeof obj.message === 'string' ? obj.message.trim() : '';
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const combined = [name, msg].filter(Boolean).join(': ');
    if (combined) return new Error(combined);

    if (typeof obj.type === 'string' && obj.type) {
      return new Error(`MediaRecorder error (${obj.type})`);
    }
  }

  return new Error('MediaRecorder encoding failed');
}

export function getVideoExtensionFromBlob(
  blob: Blob,
  fallback: VideoExportFormat
): VideoExportFormat {
  const mime = (blob.type || '').toLowerCase();
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  return fallback;
}

export function createScaledRecordingSurface(
  sourceCanvas: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number
): ScaledRecordingSurface {
  if (sourceCanvas.width === targetWidth && sourceCanvas.height === targetHeight) {
    return {
      canvas: sourceCanvas,
      syncFrame: () => {},
    };
  }

  const recordCanvas = document.createElement('canvas');
  recordCanvas.width = targetWidth;
  recordCanvas.height = targetHeight;
  const ctx = recordCanvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
  }

  return {
    canvas: recordCanvas,
    syncFrame: () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, targetWidth, targetHeight);
      ctx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
    },
  };
}

export function createMediaRecorderForStream(
  stream: MediaStream,
  mimeType: string,
  videoBitsPerSecond: number
): MediaRecorder {
  if (!mimeType) {
    return new MediaRecorder(stream);
  }
  try {
    return new MediaRecorder(stream, { mimeType, videoBitsPerSecond });
  } catch {
    return new MediaRecorder(stream, { mimeType });
  }
}

export function stopMediaStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Ignore already-stopped track errors
    }
  }
}
