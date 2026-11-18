export type VideoExportFormat = 'mp4' | 'webm' | 'mov';
export type VideoExportResolution = '1080p' | '2k' | '4k';

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
  dispose: () => void;
}

export const VIDEO_1080P_LIMITS: VideoSizeLimits = {
  maxLongSide: 1920,
  maxShortSide: 1080,
  maxPixels: 1920 * 1080,
};

export const VIDEO_2K_LIMITS: VideoSizeLimits = {
  maxLongSide: 2560,
  maxShortSide: 1440,
  maxPixels: 2560 * 1440,
};

export const VIDEO_4K_LIMITS: VideoSizeLimits = {
  maxLongSide: 3840,
  maxShortSide: 2160,
  maxPixels: 3840 * 2160,
};

export const MP4_4K_LIMITS: VideoSizeLimits = VIDEO_4K_LIMITS;
export const MP4_1080_LIMITS: VideoSizeLimits = VIDEO_1080P_LIMITS;
export const WEBM_4K_LIMITS: VideoSizeLimits = VIDEO_4K_LIMITS;

export function getVideoLimitsForResolution(
  resolution: VideoExportResolution = '4k'
): VideoSizeLimits {
  switch (resolution) {
    case '1080p':
      return VIDEO_1080P_LIMITS;
    case '2k':
      return VIDEO_2K_LIMITS;
    case '4k':
    default:
      return VIDEO_4K_LIMITS;
  }
}

export function getVideoBitrateForResolution(
  resolution: VideoExportResolution = '4k'
): number {
  switch (resolution) {
    case '1080p':
      return 4_500_000;
    case '2k':
      return 7_000_000;
    case '4k':
    default:
      return 10_000_000;
  }
}

function toEvenDimension(value: number): number {
  return Math.max(2, Math.floor((value + 1e-6) / 2) * 2);
}

/**
 * Computes aspect-ratio-preserving even pixel dimensions within encoder bounds.
 * Caps oversized or non-standard aspect ratios proportionally inside the selected
 * 1080p / 2K / 4K (3840x2160) envelope without upscaling smaller canvases.
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

export function computeVideoExportDimensionsForResolution(
  srcWidth: number,
  srcHeight: number,
  resolution: VideoExportResolution = '4k'
): { width: number; height: number } {
  return computeVideoExportDimensions(srcWidth, srcHeight, getVideoLimitsForResolution(resolution));
}

/**
 * Returns an ordered list of MIME + dimension candidates supported by `MediaRecorder`.
 * Caps all exports at the requested tier (at most 4K 3840x2160) and steps down
 * gracefully if the encoder rejects the highest tier.
 */
export function buildVideoRecorderCandidates(
  srcWidth: number,
  srcHeight: number,
  format: VideoExportFormat,
  resolutionOrSupport?: VideoExportResolution | ((mimeType: string) => boolean),
  isTypeSupported?: (mimeType: string) => boolean
): VideoRecorderCandidate[] {
  const resolution: VideoExportResolution =
    typeof resolutionOrSupport === 'string' ? resolutionOrSupport : '4k';
  const supportFn =
    typeof resolutionOrSupport === 'function' ? resolutionOrSupport : isTypeSupported;
  const supports =
    supportFn ??
    ((mimeType: string) =>
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType));

  const primaryDims = computeVideoExportDimensionsForResolution(srcWidth, srcHeight, resolution);
  const tierChain: Array<{ width: number; height: number }> = [primaryDims];
  if (resolution === '4k') {
    tierChain.push(computeVideoExportDimensions(srcWidth, srcHeight, VIDEO_2K_LIMITS));
    tierChain.push(computeVideoExportDimensions(srcWidth, srcHeight, VIDEO_1080P_LIMITS));
  } else if (resolution === '2k') {
    tierChain.push(computeVideoExportDimensions(srcWidth, srcHeight, VIDEO_1080P_LIMITS));
  }

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

  if (format === 'mov') {
    for (const dims of tierChain) {
      for (const mime of [
        'video/quicktime;codecs=avc1',
        'video/quicktime',
        'video/mp4;codecs=avc1',
        'video/mp4;codecs=avc1.42E01E',
      ]) {
        addIfSupported(mime, 'mov', dims);
      }
    }
    addIfSupported('video/mp4;codecs=vp9', 'mov', primaryDims);
    addIfSupported('video/mp4', 'mov', primaryDims);
    for (const mime of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
      addIfSupported(mime, 'webm', primaryDims);
    }
  } else if (format === 'mp4') {
    for (const dims of tierChain) {
      for (const mime of ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.42E01E']) {
        addIfSupported(mime, 'mp4', dims);
      }
    }
    addIfSupported('video/mp4;codecs=vp9', 'mp4', primaryDims);
    addIfSupported('video/mp4', 'mp4', primaryDims);
    for (const mime of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
      addIfSupported(mime, 'webm', primaryDims);
    }
  } else {
    for (const mime of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
      addIfSupported(mime, 'webm', primaryDims);
    }
    for (const mime of ['video/mp4;codecs=avc1', 'video/mp4']) {
      addIfSupported(mime, 'mp4', primaryDims);
    }
  }

  if (candidates.length === 0) {
    addIfSupported('', 'webm', primaryDims, false);
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
  if (mime.includes('quicktime')) return 'mov';
  if (fallback === 'mov' && mime.includes('mp4')) return 'mov';
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
      dispose: () => {},
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
    dispose: () => {
      recordCanvas.width = 0;
      recordCanvas.height = 0;
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
