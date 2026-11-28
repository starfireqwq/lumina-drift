import {
  LayerModel,
  BlendMode,
  encodeCmykPsd,
  encodeCmykTiff,
  hasActiveLayerEffects,
  hexToRgb01,
  normalizeAdjustment,
  separateRgbaToCmykBuffer,
  type CmykPsdLayerInput,
  type CmykSeparationOptions,
  type CmykSeparationResult,
  type CmykTacStats,
  type LayerEffectsMeta,
} from '@atelier/shared';
import JSZip from 'jszip';
import { writePsd, Psd, Layer as PsdLayer, type LayerEffectsInfo } from 'ag-psd';

import { canEmbedIccInRgbImage, embedIccInJpeg, embedIccInPng, type IccEmbedChoice } from './color/iccEmbed';
import { applyLayerEffectsToCanvas, LayerCanvasItem, LayerTree, compositeLayers, isAdjustmentItem, maskCoverage } from './layerComposite';
import { encodeKraDocument, KRA_MIMETYPE, type KraNodeInput } from './kraEncoder';
import { luminaToPsdAdjustment, psdIsolatedGroupIds } from './psdAdjustmentMapping';
import {
  binarizeLineArt,
  cropAndScaleCanvas,
  encodeBmp24,
  encodeTga,
  formatCelFileName,
  formatSequenceFileName,
  planSequenceFrames,
  resolveExportRegion,
  type BinarizeLineArtOptions,
  type CelExportFormat,
  type CelNamingOptions,
  type ExportCropRect,
  type SequenceFrameMode,
  type SequenceNamingOptions,
} from './animationExport';
import {
  buildVideoRecorderCandidates,
  buildWebCodecsCandidates,
  computeFrameDurationUs,
  computeFrameTimestampUs,
  createMediaRecorderForStream,
  getVideoBitrateForResolution,
  isWebCodecsVideoEncoderAvailable,
  probeWebCodecsAudioCandidate,
  resampleStereoPcm,
  stopMediaStream,
  unwrapMediaRecorderError,
  type AudioMuxFallbackReason,
  type MixedAudioPcm,
  type VideoExportResolution,
  type VideoRecorderCandidate,
  type WebCodecsVideoCandidate,
} from './videoExport';
export type { LayerCanvasItem } from './layerComposite';

export interface AnimationVideoExportOptions {
  signal?: AbortSignal;
  cropRegion?: ExportCropRect | null;
  onProgress?: (info: {
    currentFrame: number;
    totalFrames: number;
    backend: 'webcodecs' | 'mediarecorder';
  }) => void;
  forceBackend?: 'auto' | 'mediarecorder';
  /** Phase 6.1: Pre-mixed stereo PCM audio track for MP4/WebM muxing */
  audioMix?: MixedAudioPcm | null;
  /** Phase 6.1: Set false to export video-only even if audioMix is provided */
  includeAudio?: boolean;
  /** Phase 6.1: Called when audio track muxing degrades to video-only */
  onAudioFallback?: (reason: AudioMuxFallbackReason) => void;
  /** Phase 6.1: Called when audio track is successfully muxed */
  onAudioMuxed?: (info: { codec: string; sampleRate: number; channels: number; tracks: number }) => void;
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

function createAbortError(): Error {
  try {
    return new DOMException('Export cancelled', 'AbortError');
  } catch {
    const e = new Error('Export cancelled');
    e.name = 'AbortError';
    return e;
  }
}

function drawCroppedToContext(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  region: ExportCropRect,
  targetWidth: number,
  targetHeight: number,
  bgColor: string | null = null
): void {
  if (bgColor) {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, targetWidth, targetHeight);
  } else {
    ctx.clearRect(0, 0, targetWidth, targetHeight);
  }
  const sx = region.x;
  const sy = region.y;
  const sw = region.width;
  const sh = region.height;
  const scaleX = targetWidth / sw;
  const scaleY = targetHeight / sh;
  const clipLeft = Math.max(0, sx);
  const clipTop = Math.max(0, sy);
  const clipRight = Math.min(source.width, sx + sw);
  const clipBottom = Math.min(source.height, sy + sh);
  const clipW = clipRight - clipLeft;
  const clipH = clipBottom - clipTop;
  if (clipW > 0 && clipH > 0) {
    ctx.drawImage(
      source,
      clipLeft,
      clipTop,
      clipW,
      clipH,
      (clipLeft - sx) * scaleX,
      (clipTop - sy) * scaleY,
      clipW * scaleX,
      clipH * scaleY
    );
  }
}

/** PSD layer masks are greyscale; an inverted mask is written as its negative (PSD has no invert flag) */
function greyMaskCanvas(mask: HTMLCanvasElement, inverted = false): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = mask.width;
  out.height = mask.height;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(mask.width, mask.height);
  const cov = maskCoverage(mask, inverted);
  for (let i = 0; i < cov.length; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = cov[i];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

export type ExportFormat =
  | 'lumina'
  | 'merged_png'
  | 'transparent_png'
  | 'jpeg'
  | 'webp'
  | 'psd'
  | 'cmyk_tiff'
  | 'cmyk_psd'
  | 'ora'
  | 'kra'
  | 'layers_zip';

export class ExportEngine {
  /**
   * Helper to convert an HTMLCanvasElement to a Blob
   */
  public static canvasToBlob(canvas: HTMLCanvasElement, type: string = 'image/png'): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob conversion failed'));
      }, type);
    });
  }

  /**
   * Helper to trigger a browser file download for a given Blob
   */
  public static downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /** Merges the layers into one picture the way the editor draws them (see layerComposite) */
  public static compositeLayers(layerItems: LayerCanvasItem[], width: number, height: number, bgColor: string | null = '#FFFFFF'): HTMLCanvasElement {
    return compositeLayers(layerItems, width, height, bgColor);
  }

  /**
   * 1. Export Merged PNG (with or without background color)
   */
  public static async exportPng(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string | null,
    filename: string = 'canvas.png',
    options: { icc?: IccEmbedChoice | null } = {}
  ): Promise<Blob> {
    const { icc } = options;
    if (icc && !canEmbedIccInRgbImage(icc.bytes)) throw new Error('icc_not_rgb');
    const mergedCanvas = this.compositeLayers(layerItems, width, height, bgColor);
    const blob = await this.canvasToBlob(mergedCanvas, 'image/png');
    if (!icc) return blob;
    const bytes = await embedIccInPng(new Uint8Array(await blob.arrayBuffer()), icc.bytes, icc.name);
    return new Blob([bytes], { type: blob.type });
  }

  /**
   * 1.1 Export Merged JPEG (.jpg) with background color and high quality
   */
  public static async exportJpeg(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string = '#FFFFFF',
    quality: number = 0.92,
    options: { icc?: IccEmbedChoice | null } = {}
  ): Promise<Blob> {
    const { icc } = options;
    if (icc && !canEmbedIccInRgbImage(icc.bytes)) throw new Error('icc_not_rgb');
    const mergedCanvas = this.compositeLayers(layerItems, width, height, bgColor || '#FFFFFF');
    const blob = await new Promise<Blob>((resolve, reject) => {
      mergedCanvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('JPEG conversion failed'));
        },
        'image/jpeg',
        quality
      );
    });
    if (!icc) return blob;
    const bytes = embedIccInJpeg(new Uint8Array(await blob.arrayBuffer()), icc.bytes);
    return new Blob([bytes], { type: blob.type });
  }

  /**
   * 1.2 Export Merged WebP (.webp) with optional transparency and high quality
   */
  public static async exportWebp(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string | null = '#FFFFFF',
    quality: number = 0.92,
  ): Promise<Blob> {
    const mergedCanvas = this.compositeLayers(layerItems, width, height, bgColor);
    return await new Promise<Blob>((resolve, reject) => {
      mergedCanvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('WebP conversion failed'));
        },
        'image/webp',
        quality,
      );
    });
  }

  /**
   * Export Animated GIF (.gif) using gifenc
   */
  public static async exportGifAnimation(
    /** Renders frame i when the encoder is ready for it (frames are never all held at once) */
    nextFrame: (i: number) => Promise<{ canvas: HTMLCanvasElement; hold: number }>,
    frameCount: number,
    width: number,
    height: number,
    fps: number = 12,
    options?: { signal?: AbortSignal; cropRegion?: ExportCropRect | null }
  ): Promise<Blob> {
    const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
    const gif = GIFEncoder();
    const region = resolveExportRegion(width, height, options?.cropRegion);
    const outW = region.width;
    const outH = region.height;
    const needsCrop = region.x !== 0 || region.y !== 0 || outW !== width || outH !== height;

    for (let i = 0; i < frameCount; i++) {
      if (options?.signal?.aborted) throw createAbortError();
      const { canvas, hold } = await nextFrame(i);
      const frameCanvas = needsCrop ? cropAndScaleCanvas(canvas, region, outW, outH, '#FFFFFF') : canvas;
      const ctx = frameCanvas.getContext('2d');
      if (!ctx) continue;
      const data = ctx.getImageData(0, 0, outW, outH).data;
      const palette = quantize(data, 256);
      const index = applyPalette(data, palette);
      // A held cel is one GIF frame with a longer delay
      gif.writeFrame(index, outW, outH, { palette, delay: Math.round((1000 / fps) * Math.max(1, hold)) });
      if (needsCrop) {
        frameCanvas.width = 0;
        frameCanvas.height = 0;
      }
    }

    gif.finish();
    const bytes = gif.bytes();
    return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/gif' });
  }

  /**
   * Export Animated Video (.mp4 or .webm).
   * Phase D2: Uses offline WebCodecs VideoEncoder (constant frame rate, faster than real-time)
   * with MIT mp4-muxer / webm-muxer, falling back to MediaRecorder when unavailable.
   */
  public static async exportVideoAnimation(
    nextFrame: (i: number) => Promise<{ canvas: HTMLCanvasElement; hold: number }>,
    frameCount: number,
    width: number,
    height: number,
    fps: number = 12,
    format: 'mp4' | 'webm' = 'mp4',
    resolution: VideoExportResolution = '4k',
    options?: AnimationVideoExportOptions
  ): Promise<Blob> {
    if (frameCount <= 0) throw new Error('No animation frames to export');
    if (options?.signal?.aborted) throw createAbortError();
    const region = resolveExportRegion(width, height, options?.cropRegion);

    if (options?.forceBackend !== 'mediarecorder' && isWebCodecsVideoEncoderAvailable()) {
      const webCodecsCandidates = buildWebCodecsCandidates(region.width, region.height, format, resolution);
      for (const candidate of webCodecsCandidates) {
        if (options?.signal?.aborted) throw createAbortError();
        try {
          const blob = await this.encodeVideoOfflineWebCodecs(candidate, nextFrame, frameCount, region, fps, options);
          if (blob) return blob;
        } catch (err) {
          if (isAbortError(err)) throw err;
          console.warn(
            `[ExportEngine] Offline VideoEncoder candidate failed (${candidate.container}/${candidate.webCodecsCodec} ${candidate.width}x${candidate.height}), trying next:`,
            unwrapMediaRecorderError(err).message
          );
        }
      }
    }

    const candidates = buildVideoRecorderCandidates(region.width, region.height, format, resolution);
    let lastError: Error | null = null;

    for (let i = 0; i < candidates.length; i++) {
      if (options?.signal?.aborted) throw createAbortError();
      try {
        return await this.recordVideoAnimationAttempt(candidates[i], nextFrame, frameCount, region, fps, resolution, options);
      } catch (err) {
        if (isAbortError(err)) throw err;
        lastError = unwrapMediaRecorderError(err);
        if (i === candidates.length - 1) throw lastError;
        console.warn(
          `[ExportEngine] Video candidate failed (${candidates[i].mimeType || 'default'} ${candidates[i].width}x${candidates[i].height}), trying fallback:`,
          lastError.message
        );
      }
    }

    throw lastError ?? new Error('Unable to initialize video recorder');
  }

  private static async encodeVideoOfflineWebCodecs(
    candidate: WebCodecsVideoCandidate,
    nextFrame: (i: number) => Promise<{ canvas: HTMLCanvasElement; hold: number }>,
    frameCount: number,
    region: ExportCropRect,
    fps: number,
    options?: AnimationVideoExportOptions
  ): Promise<Blob | null> {
    const safeFps = Math.max(1, fps || 12);
    const baseConfig: VideoEncoderConfig = {
      codec: candidate.webCodecsCodec,
      width: candidate.width,
      height: candidate.height,
      bitrate: candidate.bitrate,
      framerate: safeFps,
      ...(candidate.muxerCodec === 'avc' ? { avc: { format: 'avc' as const } } : {}),
    };

    let selectedConfig: VideoEncoderConfig | null = null;
    for (const hw of ['no-preference', 'prefer-software'] as const) {
      const probe: VideoEncoderConfig = { ...baseConfig, hardwareAcceleration: hw };
      try {
        const res = await VideoEncoder.isConfigSupported(probe);
        if (res.supported) {
          selectedConfig = res.config ?? probe;
          break;
        }
      } catch {
        // Ignore unsupported acceleration hint
      }
    }
    if (!selectedConfig) return null;

    let addVideoChunk: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void;
    let addAudioChunk: ((chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void) | null = null;
    let finalizeMuxer: () => ArrayBuffer;

    const wantsAudio = options?.includeAudio !== false;
    const rawAudioMix = wantsAudio ? (options?.audioMix ?? null) : null;
    const hasMixedAudio = Boolean(rawAudioMix && rawAudioMix.mixedTrackCount > 0 && rawAudioMix.frameCount > 0);
    let probedAudio: Awaited<ReturnType<typeof probeWebCodecsAudioCandidate>> = null;
    let audioFallbackReason: AudioMuxFallbackReason = 'none';

    if (!wantsAudio) {
      audioFallbackReason = 'disabled';
    } else if (!rawAudioMix) {
      audioFallbackReason = 'no-tracks';
    } else if (!hasMixedAudio) {
      audioFallbackReason = rawAudioMix.missingAssetIds.length > 0 ? 'unlinked' : 'no-tracks';
    } else {
      probedAudio = await probeWebCodecsAudioCandidate(candidate.container, rawAudioMix.sampleRate, 2);
      if (!probedAudio) {
        audioFallbackReason = 'encoder-unsupported';
      }
    }

    if (candidate.container === 'mp4') {
      const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({
        target,
        video: {
          codec: candidate.muxerCodec === 'vp9' ? 'vp9' : 'avc',
          width: candidate.width,
          height: candidate.height,
          frameRate: safeFps,
        },
        ...(probedAudio
          ? {
              audio: {
                codec: probedAudio.candidate.muxerCodec === 'opus' ? 'opus' : 'aac',
                numberOfChannels: probedAudio.candidate.numberOfChannels,
                sampleRate: probedAudio.candidate.sampleRate,
              },
            }
          : {}),
        fastStart: 'in-memory',
        firstTimestampBehavior: 'offset',
      });
      addVideoChunk = (chunk, meta) => muxer.addVideoChunk(chunk, meta);
      if (probedAudio) {
        addAudioChunk = (chunk, meta) => muxer.addAudioChunk(chunk, meta);
      }
      finalizeMuxer = () => {
        muxer.finalize();
        return target.buffer;
      };
    } else {
      const { Muxer, ArrayBufferTarget } = await import('webm-muxer');
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({
        target,
        video: {
          codec: candidate.muxerCodec === 'V_VP8' ? 'V_VP8' : 'V_VP9',
          width: candidate.width,
          height: candidate.height,
          frameRate: safeFps,
        },
        ...(probedAudio
          ? {
              audio: {
                codec: 'A_OPUS',
                numberOfChannels: probedAudio.candidate.numberOfChannels,
                sampleRate: probedAudio.candidate.sampleRate,
              },
            }
          : {}),
        firstTimestampBehavior: 'offset',
      });
      addVideoChunk = (chunk, meta) => muxer.addVideoChunk(chunk, meta);
      if (probedAudio) {
        addAudioChunk = (chunk, meta) => muxer.addAudioChunk(chunk, meta);
      }
      finalizeMuxer = () => {
        muxer.finalize();
        return target.buffer;
      };
    }

    let encoderError: Error | null = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          addVideoChunk(chunk, meta);
        } catch (err) {
          encoderError = unwrapMediaRecorderError(err);
        }
      },
      error: (err) => {
        encoderError = unwrapMediaRecorderError(err);
      },
    });

    const animCanvas = document.createElement('canvas');
    animCanvas.width = candidate.width;
    animCanvas.height = candidate.height;
    const ctx = animCanvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const waitForQueueDrain = async () => {
      if (encoder.encodeQueueSize <= 8) return;
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          encoder.removeEventListener('dequeue', onDequeue);
          resolve();
        };
        const onDequeue = () => {
          if (encoder.encodeQueueSize <= 4) finish();
        };
        const timer = setTimeout(finish, 30);
        encoder.addEventListener('dequeue', onDequeue);
      });
    };

    try {
      encoder.configure(selectedConfig);
      const keyInterval = Math.max(1, Math.round(safeFps * 2));
      let logicalFrame = 0;

      for (let i = 0; i < frameCount; i++) {
        if (options?.signal?.aborted) throw createAbortError();
        if (encoderError) throw encoderError;

        const { canvas, hold } = await nextFrame(i);
        if (options?.signal?.aborted) throw createAbortError();
        if (encoderError) throw encoderError;

        drawCroppedToContext(ctx, canvas, region, candidate.width, candidate.height, '#FFFFFF');
        const repeatCount = Math.max(1, Math.floor(hold) || 1);

        for (let k = 0; k < repeatCount; k++) {
          if (options?.signal?.aborted) throw createAbortError();
          if (encoderError) throw encoderError;
          await waitForQueueDrain();

          const timestamp = computeFrameTimestampUs(logicalFrame, safeFps);
          const duration = computeFrameDurationUs(logicalFrame, 1, safeFps);
          const vf = new VideoFrame(animCanvas, { timestamp, duration });
          try {
            encoder.encode(vf, { keyFrame: logicalFrame === 0 || logicalFrame % keyInterval === 0 });
          } finally {
            vf.close();
          }
          logicalFrame++;
        }

        options?.onProgress?.({
          currentFrame: i + 1,
          totalFrames: frameCount,
          backend: 'webcodecs',
        });
      }

      if (options?.signal?.aborted) throw createAbortError();
      await encoder.flush();
      if (encoderError) throw encoderError;

      // Phase 6.1: Encode and mux stereo audio track when supported; degrade gracefully on error
      if (probedAudio && addAudioChunk && rawAudioMix && hasMixedAudio) {
        let audioEncoder: AudioEncoder | null = null;
        let audioError: Error | null = null;
        let encodedAudioChunks = 0;
        try {
          const pcm = resampleStereoPcm(
            rawAudioMix.left,
            rawAudioMix.right,
            rawAudioMix.sampleRate,
            probedAudio.candidate.sampleRate
          );
          const totalVideoDurationSec = logicalFrame / safeFps;
          const targetFrames = Math.min(
            pcm.left.length,
            Math.max(1, Math.round(totalVideoDurationSec * pcm.sampleRate))
          );

          audioEncoder = new AudioEncoder({
            output: (chunk, meta) => {
              try {
                addAudioChunk!(chunk, meta);
                encodedAudioChunks++;
              } catch (err) {
                audioError = unwrapMediaRecorderError(err);
              }
            },
            error: (err) => {
              audioError = unwrapMediaRecorderError(err);
            },
          });
          audioEncoder.configure(probedAudio.config);

          const chunkSize = 1024;
          const channels = probedAudio.candidate.numberOfChannels;
          for (let offset = 0; offset < targetFrames; offset += chunkSize) {
            if (options?.signal?.aborted) throw createAbortError();
            if (audioError) throw audioError;
            const len = Math.min(chunkSize, targetFrames - offset);
            const planar = new Float32Array(len * channels);
            planar.set(pcm.left.subarray(offset, offset + len), 0);
            if (channels > 1) {
              planar.set(pcm.right.subarray(offset, offset + len), len);
            }
            const timestamp = Math.round((offset * 1_000_000) / pcm.sampleRate);
            const audioData = new AudioData({
              format: 'f32-planar',
              sampleRate: pcm.sampleRate,
              numberOfFrames: len,
              numberOfChannels: channels,
              timestamp,
              data: planar,
            });
            try {
              audioEncoder.encode(audioData);
            } finally {
              audioData.close();
            }
          }
          await audioEncoder.flush();
          if (audioError) throw audioError;
          if (encodedAudioChunks > 0) {
            options?.onAudioMuxed?.({
              codec: probedAudio.candidate.webCodecsCodec,
              sampleRate: pcm.sampleRate,
              channels,
              tracks: rawAudioMix.mixedTrackCount,
            });
          } else {
            options?.onAudioFallback?.('encode-failed');
          }
        } catch (err) {
          if (isAbortError(err)) throw err;
          console.warn('[ExportEngine] Audio track encoding failed, retrying video-only:', unwrapMediaRecorderError(err).message);
          options?.onAudioFallback?.('encode-failed');
          // Re-run current candidate cleanly without audio so muxer header doesn't declare an empty audio track
          return this.encodeVideoOfflineWebCodecs(candidate, nextFrame, frameCount, region, fps, {
            ...options,
            includeAudio: false,
            audioMix: null,
          });
        } finally {
          try {
            if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
          } catch {
            // ignore
          }
        }
      } else if (audioFallbackReason !== 'none' && options?.includeAudio !== false && rawAudioMix !== undefined) {
        options?.onAudioFallback?.(audioFallbackReason);
      }

      const buffer = finalizeMuxer();
      if (buffer.byteLength === 0) {
        throw new Error(`Offline encoder produced empty output (${candidate.mimeType})`);
      }
      return new Blob([buffer], { type: candidate.mimeType });
    } finally {
      try {
        if (encoder.state !== 'closed') encoder.close();
      } catch {
        // Ignore close errors
      }
      animCanvas.width = 0;
      animCanvas.height = 0;
    }
  }

  private static async recordVideoAnimationAttempt(
    candidate: VideoRecorderCandidate,
    nextFrame: (i: number) => Promise<{ canvas: HTMLCanvasElement; hold: number }>,
    frameCount: number,
    region: ExportCropRect,
    fps: number,
    resolution: VideoExportResolution = '4k',
    options?: AnimationVideoExportOptions
  ): Promise<Blob> {
    const animCanvas = document.createElement('canvas');
    animCanvas.width = candidate.width;
    animCanvas.height = candidate.height;
    const ctx = animCanvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const stream = animCanvas.captureStream(fps);
    let audioCtxForRecord: AudioContext | null = null;
    let audioSourceForRecord: AudioBufferSourceNode | null = null;
    const wantsAudio = options?.includeAudio !== false;
    const rawAudioMix = wantsAudio ? (options?.audioMix ?? null) : null;
    const hasMixedAudio = Boolean(rawAudioMix && rawAudioMix.mixedTrackCount > 0 && rawAudioMix.frameCount > 0);
    if (hasMixedAudio && rawAudioMix) {
      try {
        const AudioCtxCtor =
          typeof window !== 'undefined'
            ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
            : undefined;
        if (AudioCtxCtor) {
          audioCtxForRecord = new AudioCtxCtor({ sampleRate: rawAudioMix.sampleRate });
          const dest = audioCtxForRecord.createMediaStreamDestination();
          const audioBuf = audioCtxForRecord.createBuffer(2, rawAudioMix.frameCount, rawAudioMix.sampleRate);
          audioBuf.copyToChannel(new Float32Array(rawAudioMix.left), 0);
          audioBuf.copyToChannel(new Float32Array(rawAudioMix.right), 1);
          const src = audioCtxForRecord.createBufferSource();
          src.buffer = audioBuf;
          src.connect(dest);
          audioSourceForRecord = src;
          for (const track of dest.stream.getAudioTracks()) {
            stream.addTrack(track);
          }
          options?.onAudioMuxed?.({
            codec: 'mediarecorder-audio',
            sampleRate: rawAudioMix.sampleRate,
            channels: 2,
            tracks: rawAudioMix.mixedTrackCount,
          });
        } else {
          options?.onAudioFallback?.('encoder-unsupported');
        }
      } catch {
        options?.onAudioFallback?.('encode-failed');
      }
    } else if (wantsAudio && rawAudioMix !== undefined) {
      options?.onAudioFallback?.(rawAudioMix && rawAudioMix.missingAssetIds.length > 0 ? 'unlinked' : 'no-tracks');
    }

    const recordedChunks: Blob[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = createMediaRecorderForStream(
        stream,
        candidate.mimeType,
        getVideoBitrateForResolution(resolution)
      );
    } catch (err) {
      animCanvas.width = 0;
      animCanvas.height = 0;
      try { audioSourceForRecord?.stop(); } catch {}
      try { void audioCtxForRecord?.close(); } catch {}
      stopMediaStream(stream);
      throw unwrapMediaRecorderError(err);
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    return new Promise<Blob>((resolve, reject) => {
      let aborted = false;
      let settled = false;
      const cleanupSurface = () => {
        try { audioSourceForRecord?.stop(); } catch {}
        try { void audioCtxForRecord?.close(); } catch {}
        stopMediaStream(stream);
        animCanvas.width = 0;
        animCanvas.height = 0;
      };
      const onAbort = () => {
        if (settled) return;
        aborted = true;
        settled = true;
        try { if (recorder.state === 'recording') recorder.stop(); } catch {}
        cleanupSurface();
        reject(createAbortError());
      };
      options?.signal?.addEventListener('abort', onAbort, { once: true });

      recorder.onstop = () => {
        options?.signal?.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        cleanupSurface();
        const blobType = recorder.mimeType || candidate.mimeType || 'video/webm';
        const blob = new Blob(recordedChunks, { type: blobType });
        if (blob.size === 0) {
          reject(new Error(`Video recorder produced empty output (${blobType})`));
          return;
        }
        resolve(blob);
      };
      recorder.onerror = (err) => {
        options?.signal?.removeEventListener('abort', onAbort);
        if (settled) return;
        aborted = true;
        settled = true;
        cleanupSurface();
        reject(unwrapMediaRecorderError(err));
      };

      const frameDelay = 1000 / Math.max(1, fps);
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

      void (async () => {
        try {
          if (options?.signal?.aborted) {
            onAbort();
            return;
          }
          // Paint first frame before starting recorder so frame 0 isn't blank
          const first = await nextFrame(0);
          if (aborted) return;
          drawCroppedToContext(ctx, first.canvas, region, candidate.width, candidate.height, '#FFFFFF');
          options?.onProgress?.({ currentFrame: 1, totalFrames: frameCount, backend: 'mediarecorder' });
          recorder.start(200);
          if (audioSourceForRecord && audioCtxForRecord) {
            try {
              if (audioCtxForRecord.state === 'suspended') await audioCtxForRecord.resume();
              audioSourceForRecord.start(0);
            } catch {
              // ignore live audio playback start errors
            }
          }
          const startTime = performance.now();
          let logicalFrames = Math.max(1, first.hold);
          const firstDeadline = startTime + logicalFrames * frameDelay;
          if (firstDeadline > performance.now()) await sleep(firstDeadline - performance.now());

          for (let i = 1; i < frameCount && !aborted; i++) {
            const { canvas, hold } = await nextFrame(i);
            if (aborted) break;
            drawCroppedToContext(ctx, canvas, region, candidate.width, candidate.height, '#FFFFFF');
            options?.onProgress?.({ currentFrame: i + 1, totalFrames: frameCount, backend: 'mediarecorder' });
            logicalFrames += Math.max(1, hold);
            const targetTime = startTime + logicalFrames * frameDelay;
            const remaining = targetTime - performance.now();
            if (remaining > 0) await sleep(remaining);
          }

          await sleep(Math.min(250, frameDelay + 60));
          if (!aborted && recorder.state === 'recording') {
            try { recorder.requestData(); } catch {}
            recorder.stop();
          }
        } catch (err) {
          aborted = true;
          options?.signal?.removeEventListener('abort', onAbort);
          stopMediaStream(stream);
          try { if (recorder.state === 'recording') recorder.stop(); } catch {}
          if (!settled) {
            settled = true;
            reject(unwrapMediaRecorderError(err));
          }
        }
      })();
    });
  }

  /**
   * D1: Export timeline as numbered PNG image sequence (ZIP blob on Web, or streamed via onWriteFile for Electron folder export).
   */
  public static async exportImageSequence(opts: {
    segments: ReadonlyArray<{ time: number; hold: number }>;
    renderFrame: (time: number) => Promise<HTMLCanvasElement> | HTMLCanvasElement;
    srcWidth: number;
    srcHeight: number;
    targetWidth: number;
    targetHeight: number;
    cropRegion?: ExportCropRect | null;
    transparent: boolean;
    bgColor?: string;
    frameMode: SequenceFrameMode;
    naming: SequenceNamingOptions;
    signal?: AbortSignal;
    onProgress?: (current: number, total: number, fileName: string) => void;
    /** When provided (e.g. Electron folder export), streams each file directly instead of buffering a ZIP */
    onWriteFile?: (fileName: string, data: Uint8Array) => Promise<void>;
  }): Promise<{ blob?: Blob; fileCount: number; fileNames: string[] }> {
    const planned = planSequenceFrames(opts.segments, opts.frameMode);
    if (planned.length === 0) throw new Error('No animation frames to export');
    const region = resolveExportRegion(opts.srcWidth, opts.srcHeight, opts.cropRegion);
    const outW = Math.max(1, Math.round(opts.targetWidth) || region.width);
    const outH = Math.max(1, Math.round(opts.targetHeight) || region.height);
    const bgFill = opts.transparent ? null : (opts.bgColor || '#FFFFFF');
    const needsTransform =
      region.x !== 0 ||
      region.y !== 0 ||
      region.width !== opts.srcWidth ||
      region.height !== opts.srcHeight ||
      outW !== opts.srcWidth ||
      outH !== opts.srcHeight;

    const zip = opts.onWriteFile ? null : new JSZip();
    const fileNames: string[] = [];
    let cachedTime = -1;
    let cachedBytes: Uint8Array | null = null;

    for (let i = 0; i < planned.length; i++) {
      if (opts.signal?.aborted) throw createAbortError();
      const entry = planned[i];
      const fileName = formatSequenceFileName(entry.outputIndex, opts.naming);

      let bytes: Uint8Array;
      if (entry.sourceTime === cachedTime && cachedBytes) {
        bytes = cachedBytes;
      } else {
        const rendered = await opts.renderFrame(entry.sourceTime);
        if (opts.signal?.aborted) throw createAbortError();
        const finalCanvas = needsTransform
          ? cropAndScaleCanvas(rendered, region, outW, outH, bgFill)
          : rendered;
        const blob = await this.canvasToBlob(finalCanvas, 'image/png');
        bytes = new Uint8Array(await blob.arrayBuffer());
        if (finalCanvas !== rendered) {
          finalCanvas.width = 0;
          finalCanvas.height = 0;
        }
        cachedTime = entry.sourceTime;
        cachedBytes = bytes;
      }

      if (opts.onWriteFile) {
        await opts.onWriteFile(fileName, bytes);
      } else {
        zip!.file(fileName, bytes);
      }
      fileNames.push(fileName);
      opts.onProgress?.(i + 1, planned.length, fileName);
      // Yield briefly to keep UI/abort button responsive
      if (i % 4 === 3) await new Promise<void>((r) => setTimeout(r, 0));
    }

    if (zip) {
      if (opts.signal?.aborted) throw createAbortError();
      const blob = await zip.generateAsync({ type: 'blob' });
      return { blob, fileCount: fileNames.length, fileNames };
    }
    return { fileCount: fileNames.length, fileNames };
  }

  /**
   * D4: Export each animation cel once (independent of timeline repeats/holds),
   * with optional anti-alias removal / multi-color line binarization and PNG / TGA / BMP encoding.
   */
  public static async exportAnimationCels(opts: {
    items: ReadonlyArray<{ folderName: string; celId: string; celName: string }>;
    renderCel: (celId: string) => Promise<HTMLCanvasElement> | HTMLCanvasElement;
    srcWidth: number;
    srcHeight: number;
    targetWidth: number;
    targetHeight: number;
    cropRegion?: ExportCropRect | null;
    format: CelExportFormat;
    tgaBitsPerPixel?: 24 | 32;
    transparentBackground: boolean;
    binarize: BinarizeLineArtOptions;
    naming: CelNamingOptions;
    signal?: AbortSignal;
    onProgress?: (current: number, total: number, fileName: string) => void;
    onWriteFile?: (fileName: string, data: Uint8Array) => Promise<void>;
  }): Promise<{ blob?: Blob; fileCount: number; fileNames: string[] }> {
    if (opts.items.length === 0) throw new Error('No animation cels to export');
    const region = resolveExportRegion(opts.srcWidth, opts.srcHeight, opts.cropRegion);
    const outW = Math.max(1, Math.round(opts.targetWidth) || region.width);
    const outH = Math.max(1, Math.round(opts.targetHeight) || region.height);
    const forceOpaqueBg = opts.format === 'bmp' || (opts.format === 'tga' && (opts.tgaBitsPerPixel ?? 24) === 24);
    const bgMode: 'white' | 'transparent' = forceOpaqueBg
      ? 'white'
      : opts.binarize.enabled
        ? opts.binarize.background
        : opts.transparentBackground
          ? 'transparent'
          : 'white';

    const zip = opts.onWriteFile ? null : new JSZip();
    const usedLowerNames = new Set<string>();
    const fileNames: string[] = [];

    for (let i = 0; i < opts.items.length; i++) {
      if (opts.signal?.aborted) throw createAbortError();
      const item = opts.items[i];
      const fileName = formatCelFileName(item.folderName, item.celName, opts.naming, usedLowerNames);
      const rendered = await opts.renderCel(item.celId);
      if (opts.signal?.aborted) throw createAbortError();

      const workCanvas = cropAndScaleCanvas(
        rendered,
        region,
        outW,
        outH,
        opts.binarize.enabled ? null : bgMode === 'white' ? '#FFFFFF' : null
      );
      const ctx = workCanvas.getContext('2d')!;
      const imgData = ctx.getImageData(0, 0, outW, outH);
      let rgba: Uint8ClampedArray = imgData.data;

      if (opts.binarize.enabled) {
        rgba = binarizeLineArt(rgba, outW, outH, {
          ...opts.binarize,
          background: bgMode,
        });
      }

      let bytes: Uint8Array;
      if (opts.format === 'tga') {
        bytes = encodeTga(rgba, outW, outH, opts.tgaBitsPerPixel ?? (bgMode === 'transparent' ? 32 : 24));
      } else if (opts.format === 'bmp') {
        bytes = encodeBmp24(rgba, outW, outH);
      } else {
        if (opts.binarize.enabled) {
          const outData = new ImageData(new Uint8ClampedArray(rgba), outW, outH);
          ctx.putImageData(outData, 0, 0);
        }
        const blob = await this.canvasToBlob(workCanvas, 'image/png');
        bytes = new Uint8Array(await blob.arrayBuffer());
      }

      workCanvas.width = 0;
      workCanvas.height = 0;

      if (opts.onWriteFile) {
        await opts.onWriteFile(fileName, bytes);
      } else {
        zip!.file(fileName, bytes);
      }
      fileNames.push(fileName);
      opts.onProgress?.(i + 1, opts.items.length, fileName);
      if (i % 4 === 3) await new Promise<void>((r) => setTimeout(r, 0));
    }

    if (zip) {
      if (opts.signal?.aborted) throw createAbortError();
      const blob = await zip.generateAsync({ type: 'blob' });
      return { blob, fileCount: fileNames.length, fileNames };
    }
    return { fileCount: fileNames.length, fileNames };
  }

  /**
   * 2. Export Multi-Layer PNG Zip bundle (.zip): every layer as it finally looks (masks and
   * clipping applied), plus the merged picture and a manifest
   */
  public static async exportLayersZip(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string = '#FFFFFF',
    canvasTitle: string = 'artwork'
  ): Promise<Blob> {
    const zip = new JSZip();
    const tree = new LayerTree(layerItems);
    const drawables = tree.drawables();

    for (let i = 0; i < drawables.length; i++) {
      const { item, clipBase } = drawables[i];
      // Adjustment layers own no pixels: their effect is in composite.png
      if (isAdjustmentItem(item)) continue;
      const blob = await this.canvasToBlob(tree.flattened(item, clipBase), 'image/png');
      const safeName = item.layer.name.replace(/[\\/:*?"<>|]/g, '_');
      zip.file(`layer_${String(i).padStart(2, '0')}_${safeName}.png`, blob);
    }

    const compositeBlob = await this.canvasToBlob(this.compositeLayers(layerItems, width, height, bgColor), 'image/png');
    zip.file('composite.png', compositeBlob);

    const meta = {
      title: canvasTitle,
      width,
      height,
      bgColor,
      exportTime: new Date().toISOString(),
      layers: drawables.map(({ item }, idx) => ({
        index: idx,
        id: item.layer.id,
        name: item.layer.name,
        parent: item.layer.parentId ? tree.byId.get(item.layer.parentId)?.layer.name ?? null : null,
        opacity: tree.opacity(item),
        blendMode: item.layer.blendMode,
        isVisible: tree.visible(item),
        isLocked: item.layer.isLocked,
        ...(isAdjustmentItem(item) ? { type: 'adjustment', kind: item.layer.meta?.adjustment?.kind ?? null } : {}),
      })),
    };
    zip.file('layers_manifest.json', JSON.stringify(meta, null, 2));

    return await zip.generateAsync({ type: 'blob' });
  }

  /**
   * 3. Export OpenRaster (.ora) package (Krita, GIMP, MyPaint). Groups become nested stacks;
   * OpenRaster has no masks or clipping, so those are applied to the layer pixels.
   */
  public static async exportOpenRasterOra(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string = '#FFFFFF'
  ): Promise<Blob> {
    const zip = new JSZip();

    // 1. mimetype MUST be first and stored uncompressed
    zip.file('mimetype', 'image/openraster', { compression: 'STORE' });

    // 2. composite and thumbnail images
    const compositeCanvas = this.compositeLayers(layerItems, width, height, bgColor);
    zip.file('mergedimage.png', await this.canvasToBlob(compositeCanvas, 'image/png'));

    const thumbCanvas = document.createElement('canvas');
    const thumbSize = 256;
    const aspect = width / height;
    thumbCanvas.width = aspect >= 1 ? thumbSize : Math.round(thumbSize * aspect);
    thumbCanvas.height = aspect >= 1 ? Math.round(thumbSize / aspect) : thumbSize;
    const thumbCtx = thumbCanvas.getContext('2d');
    if (thumbCtx) {
      thumbCtx.drawImage(compositeCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
      zip.file('Thumbnails/thumbnail.png', await this.canvasToBlob(thumbCanvas, 'image/png'));
    }

    // 3. Layer images & stack.xml (top of the stack first)
    const tree = new LayerTree(layerItems);
    const clipBaseOf = new Map(tree.drawables().map((d) => [d.item.layer.id, d.clipBase]));
    const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    let fileIndex = 0;
    const stackXml = async (parentId: string | null, indent: string): Promise<string> => {
      let xml = '';
      for (const item of [...tree.childrenOf(parentId)].reverse()) {
        const common = `name="${attr(item.layer.name)}" opacity="${item.layer.opacity}" visibility="${item.layer.isVisible ? 'visible' : 'hidden'}" composite-op="${this.mapToOraCompositeOp(item.layer.blendMode)}"`;
        if (tree.isGroup(item)) {
          xml += `${indent}<stack ${common} isolation="auto">\n${await stackXml(item.layer.id, indent + '  ')}${indent}</stack>\n`;
          continue;
        }
        // OpenRaster has no adjustment layers: their effect is in mergedimage.png only
        if (isAdjustmentItem(item)) continue;
        // Group opacity / visibility live on the stacks; masks and clipping go into the pixels
        const pngPath = `data/layer_${fileIndex++}.png`;
        zip.file(pngPath, await this.canvasToBlob(tree.flattened(item, clipBaseOf.get(item.layer.id) ?? null), 'image/png'));
        xml += `${indent}<layer ${common} src="${pngPath}" x="0" y="0"/>\n`;
      }
      return xml;
    };

    zip.file('stack.xml', `<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.3" w="${width}" h="${height}">
  <stack>
${await stackXml(null, '    ')}  </stack>
</image>`);

    return await zip.generateAsync({
      type: 'blob',
      mimeType: 'image/openraster',
    });
  }

  public static async exportKrita(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string | null,
    opts: { title: string; dpi: number }
  ): Promise<Blob> {
    const tree = new LayerTree(layerItems);
    const readSized = <T>(source: HTMLCanvasElement, read: (canvas: HTMLCanvasElement) => T, scale: boolean): T => {
      if (source.width === width && source.height === height) return read(source);
      const sized = document.createElement('canvas');
      sized.width = width;
      sized.height = height;
      try {
        if (source.width && source.height) {
          sized.getContext('2d')!.drawImage(source, 0, 0, scale ? width : source.width, scale ? height : source.height);
        }
        return read(sized);
      } finally {
        sized.width = 0;
        sized.height = 0;
      }
    };
    const nodesOf = (parentId: string | null): KraNodeInput[] =>
      tree.childrenOf(parentId).flatMap((item): KraNodeInput[] => {
        if (isAdjustmentItem(item)) return [];
        const { layer, mask } = item;
        const properties = {
          name: layer.name,
          opacity: layer.opacity,
          visible: layer.isVisible,
          locked: layer.isLocked,
          blendMode: layer.blendMode,
          mask: mask && {
            coverage: readSized(mask.canvas, (source) => Uint8Array.from(maskCoverage(source, false)), true),
            inverted: Boolean(mask.inverted),
            enabled: mask.enabled,
          },
        };
        if (tree.isGroup(item)) {
          return [{ ...properties, kind: 'group', children: nodesOf(layer.id) }];
        }
        const paintCanvas = hasActiveLayerEffects(layer.meta?.effects)
          ? applyLayerEffectsToCanvas(item.canvas, layer.meta!.effects)
          : item.canvas;
        return [{
          ...properties,
          kind: 'paint',
          alphaLocked: layer.alphaLocked,
          clipToBelow: layer.clipToBelow,
          rgba: readSized(paintCanvas, (source) => source.getContext('2d')!.getImageData(0, 0, width, height).data, false),
        }];
      });

    const merged = this.compositeLayers(layerItems, width, height, bgColor);
    const thumb = document.createElement('canvas');
    const scale = 256 / Math.max(width, height);
    thumb.width = Math.max(1, Math.round(width * scale));
    thumb.height = Math.max(1, Math.round(height * scale));
    thumb.getContext('2d')!.drawImage(merged, 0, 0, thumb.width, thumb.height);
    const [mergedBlob, previewBlob] = await Promise.all([this.canvasToBlob(merged), this.canvasToBlob(thumb)]);
    const bytes = await encodeKraDocument({
      width, height, bgColor, ...opts,
      roots: nodesOf(null),
      mergedPng: new Uint8Array(await mergedBlob.arrayBuffer()),
      previewPng: new Uint8Array(await previewBlob.arrayBuffer()),
    });
    return new Blob([bytes.buffer as ArrayBuffer], { type: KRA_MIMETYPE });
  }

  /**
   * 4. Export Adobe Photoshop (.psd): groups as folders, layer and group masks (greyscale,
   * disabled kept), clipping, names, opacity, blend modes and visibility
   */
  public static async exportPhotoshopPsd(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string = '#FFFFFF',
    options: { icc?: IccEmbedChoice | null } = {}
  ): Promise<Blob> {
    const { icc } = options;
    if (icc && !canEmbedIccInRgbImage(icc.bytes)) throw new Error('icc_not_rgb');
    const compositeCanvas = this.compositeLayers(layerItems, width, height, bgColor);
    const tree = new LayerTree(layerItems);
    const isolatedGroups = psdIsolatedGroupIds(layerItems.map((i) => i.layer));

    const toPsdColor = (hex: string) => {
      const [r, g, b] = hexToRgb01(hex);
      return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
    };
    const mapPsdEffects = (fx: LayerEffectsMeta | null | undefined): LayerEffectsInfo | undefined => {
      if (!hasActiveLayerEffects(fx) || !fx) return undefined;
      const out: LayerEffectsInfo = { scale: 1 };
      if (fx.border?.enabled && fx.border.mode === 'edge' && fx.border.width > 0 && fx.border.opacity > 0) {
        out.stroke = [{
          enabled: true,
          present: true,
          position: 'outside',
          fillType: 'color',
          blendMode: 'normal',
          size: { value: fx.border.width, units: 'Pixels' },
          opacity: fx.border.opacity,
          color: toPsdColor(fx.border.color),
        }];
      }
      if (fx.dropShadow?.enabled && fx.dropShadow.opacity > 0) {
        const dist = Math.hypot(fx.dropShadow.offsetX, fx.dropShadow.offsetY);
        const angle = dist > 0 ? Math.round((Math.atan2(-fx.dropShadow.offsetY, -fx.dropShadow.offsetX) * 180) / Math.PI) : 120;
        out.dropShadow = [{
          enabled: true,
          present: true,
          blendMode: 'multiply',
          color: toPsdColor(fx.dropShadow.color),
          opacity: fx.dropShadow.opacity,
          distance: { value: Math.round(dist), units: 'Pixels' },
          angle,
          size: { value: Math.max(0, fx.dropShadow.blur), units: 'Pixels' },
          choke: { value: Math.max(0, fx.dropShadow.spread ?? 0), units: 'Pixels' },
          useGlobalLight: false,
          antialiased: true,
        }];
      }
      if (fx.outerGlow?.enabled && fx.outerGlow.opacity > 0) {
        out.outerGlow = {
          enabled: true,
          present: true,
          blendMode: 'screen',
          color: toPsdColor(fx.outerGlow.color),
          opacity: fx.outerGlow.opacity,
          size: { value: Math.max(0, fx.outerGlow.radius), units: 'Pixels' },
          choke: { value: Math.max(0, fx.outerGlow.spread ?? 0), units: 'Pixels' },
          antialiased: true,
        };
      }
      if (fx.colorOverlay?.enabled && fx.colorOverlay.opacity > 0) {
        out.solidFill = [{
          enabled: true,
          present: true,
          blendMode: this.mapToPsdBlendMode(fx.colorOverlay.blendMode ?? 'normal') as any,
          color: toPsdColor(fx.colorOverlay.color),
          opacity: fx.colorOverlay.opacity,
        }];
      }
      return (out.stroke || out.dropShadow || out.outerGlow || out.solidFill) ? out : undefined;
    };

    const toPsd = (item: LayerCanvasItem): PsdLayer | null => {
      const isGroup = tree.isGroup(item);
      const blend = this.mapToPsdBlendMode(item.layer.blendMode);
      const psdEffects = mapPsdEffects(item.layer.meta?.effects);
      const layer: PsdLayer = {
        name: item.layer.name,
        opacity: item.layer.opacity,
        blendMode: (isGroup && blend === 'normal' &&
          !isolatedGroups.has(item.layer.id) && !tree.isolatedGroups.has(item.layer.id) ? 'pass through' : blend) as any,
        hidden: !item.layer.isVisible,
        clipping: Boolean(item.layer.clipToBelow),
        ...(psdEffects ? { effects: psdEffects } : {}),
        ...(item.mask ? {
          mask: { canvas: greyMaskCanvas(item.mask.canvas, item.mask.inverted), top: 0, left: 0, bottom: height, right: width, defaultColor: 0, disabled: !item.mask.enabled },
        } : {}),
      };
      if (isGroup) return { ...layer, opened: true, children: childrenOf(item.layer.id) };
      if (isAdjustmentItem(item)) {
        // A real Photoshop adjustment layer: no pixels, its parameters only
        const adjustment = normalizeAdjustment(item.layer.meta?.adjustment);
        return adjustment ? { ...layer, adjustment: luminaToPsdAdjustment(adjustment).adjustment } : null;
      }
      const fx = item.layer.meta?.effects;
      // Photoshop has no native watercolor border effect, so bake watercolor border into layer pixels while keeping other PSD effects live
      const layerCanvas = fx?.enabled && fx.border?.enabled && fx.border.mode === 'watercolor'
        ? applyLayerEffectsToCanvas(item.canvas, { enabled: true, border: fx.border })
        : item.canvas;
      return { ...layer, canvas: layerCanvas, top: 0, left: 0, bottom: height, right: width };
    };
    const childrenOf = (parentId: string | null): PsdLayer[] =>
      tree.childrenOf(parentId).map(toPsd).filter((l): l is PsdLayer => l !== null);

    const psdDoc: Psd = {
      width,
      height,
      canvas: compositeCanvas,
      children: childrenOf(null),
      ...(icc ? { imageResources: { iccProfile: icc.bytes } } : {}),
    };

    const psdBuffer = writePsd(psdDoc);
    return new Blob([psdBuffer], { type: 'image/vnd.adobe.photoshop' });
  }

  /**
   * Phase 6.2: Fast downsampled CMYK TAC preview analysis for the Export dialog.
   */
  public static analyzeCmykTacPreview(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string | null = '#FFFFFF',
    separation?: Partial<CmykSeparationOptions>,
    maxPreviewDim: number = 320
  ): { result: CmykSeparationResult; previewWidth: number; previewHeight: number } {
    const compositeCanvas = this.compositeLayers(layerItems, width, height, bgColor || '#FFFFFF');
    const scale = Math.min(1, maxPreviewDim / Math.max(1, width, height));
    const previewWidth = Math.max(1, Math.round(width * scale));
    const previewHeight = Math.max(1, Math.round(height * scale));
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = previewWidth;
    previewCanvas.height = previewHeight;
    const ctx = previewCanvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = bgColor || '#FFFFFF';
    ctx.fillRect(0, 0, previewWidth, previewHeight);
    ctx.drawImage(compositeCanvas, 0, 0, previewWidth, previewHeight);
    const imgData = ctx.getImageData(0, 0, previewWidth, previewHeight);
    const result = separateRgbaToCmykBuffer(
      imgData.data,
      previewWidth,
      previewHeight,
      separation,
      true
    );
    previewCanvas.width = 0;
    previewCanvas.height = 0;
    return { result, previewWidth, previewHeight };
  }

  /**
   * Phase 6.2: Export true 4-channel CMYK Baseline TIFF 6.0 (.tif) with GCR/UCR + TAC control.
   */
  public static async exportCmykTiff(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string | null = '#FFFFFF',
    options: {
      separation?: Partial<CmykSeparationOptions>;
      dpi?: number;
      compression?: 'packbits' | 'none';
      iccProfile?: Uint8Array | null;
    } = {}
  ): Promise<{ blob: Blob; stats: CmykTacStats }> {
    const compositeCanvas = this.compositeLayers(layerItems, width, height, bgColor || '#FFFFFF');
    const ctx = compositeCanvas.getContext('2d', { willReadFrequently: true })!;
    const imgData = ctx.getImageData(0, 0, width, height);
    const separated = separateRgbaToCmykBuffer(
      imgData.data,
      width,
      height,
      options.separation,
      false
    );
    const tiffBytes = encodeCmykTiff(separated.cmyk, width, height, {
      dpi: options.dpi ?? 300,
      compression: options.compression ?? 'packbits',
      iccProfile: options.iccProfile ?? null,
    });
    return {
      blob: new Blob([tiffBytes.buffer as ArrayBuffer], { type: 'image/tiff' }),
      stats: separated.stats,
    };
  }

  /**
   * Phase 6.2: Export true 4-channel CMYK Adobe Photoshop PSD (.psd, ColorMode=4)
   * preserving exact GCR/UCR separation, TAC clamping, and raster layers.
   */
  public static async exportCmykPsd(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string | null = '#FFFFFF',
    options: {
      separation?: Partial<CmykSeparationOptions>;
      dpi?: number;
      compression?: 'rle' | 'raw';
      iccProfile?: Uint8Array | null;
      includeLayers?: boolean;
    } = {}
  ): Promise<{ blob: Blob; stats: CmykTacStats }> {
    const compositeCanvas = this.compositeLayers(layerItems, width, height, bgColor || '#FFFFFF');
    const compCtx = compositeCanvas.getContext('2d', { willReadFrequently: true })!;
    const compData = compCtx.getImageData(0, 0, width, height);
    const separatedComposite = separateRgbaToCmykBuffer(
      compData.data,
      width,
      height,
      options.separation,
      false
    );

    const psdLayers: CmykPsdLayerInput[] = [];
    if (options.includeLayers !== false) {
      for (const item of layerItems) {
        if (item.layer.layerType === 'group' || isAdjustmentItem(item) || !item.canvas) continue;
        const lCanvas = document.createElement('canvas');
        lCanvas.width = width;
        lCanvas.height = height;
        const lCtx = lCanvas.getContext('2d', { willReadFrequently: true })!;
        lCtx.drawImage(item.canvas, 0, 0, width, height);
        const lData = lCtx.getImageData(0, 0, width, height).data;
        const sepLayer = separateRgbaToCmykBuffer(lData, width, height, options.separation, false);
        const alpha = new Uint8Array(width * height);
        for (let i = 0; i < alpha.length; i++) alpha[i] = lData[i * 4 + 3];
        psdLayers.push({
          name: item.layer.name || 'Layer',
          cmyk: sepLayer.cmyk,
          alpha,
          width,
          height,
          opacity: item.layer.opacity,
          visible: item.layer.isVisible,
          blendModeKey: this.mapToPsdBlendModeKey(item.layer.blendMode),
        });
        lCanvas.width = 0;
        lCanvas.height = 0;
      }
    }

    const psdBytes = encodeCmykPsd(separatedComposite.cmyk, width, height, {
      dpi: options.dpi ?? 300,
      compression: options.compression ?? 'rle',
      iccProfile: options.iccProfile ?? null,
      layers: psdLayers,
    });
    return {
      blob: new Blob([psdBytes.buffer as ArrayBuffer], { type: 'image/vnd.adobe.photoshop' }),
      stats: separatedComposite.stats,
    };
  }

  private static mapToPsdBlendModeKey(mode: BlendMode): string {
    const map: Record<string, string> = {
      normal: 'norm',
      multiply: 'mul ',
      screen: 'scrn',
      overlay: 'over',
      darken: 'dark',
      lighten: 'lite',
      'color-dodge': 'div ',
      'color-burn': 'idiv',
      'hard-light': 'hLit',
      'soft-light': 'sLit',
      difference: 'diff',
      exclusion: 'smud',
      hue: 'hue ',
      saturation: 'sat ',
      color: 'colr',
      luminosity: 'lum ',
    };
    return map[mode] || 'norm';
  }

  private static mapToOraCompositeOp(mode: BlendMode): string {
    switch (mode) {
      case 'multiply':
      case 'linear_burn':
        return 'svg:multiply';
      case 'screen':
      case 'divide':
        return 'svg:screen';
      case 'overlay':
        return 'svg:overlay';
      case 'darken':
        return 'svg:darken';
      case 'lighten':
        return 'svg:lighten';
      case 'color_dodge':
        return 'svg:color-dodge';
      case 'color_burn':
        return 'svg:color-burn';
      case 'hard_light':
      case 'linear_light':
        return 'svg:hard-light';
      case 'soft_light':
        return 'svg:soft-light';
      case 'difference':
      case 'subtract':
        return 'svg:difference';
      case 'add':
      case 'glow':
        return 'svg:plus';
      default:
        return 'svg:src-over';
    }
  }

  private static mapToPsdBlendMode(mode: BlendMode): string {
    switch (mode) {
      case 'multiply':
        return 'multiply';
      case 'linear_burn':
        return 'linear burn';
      case 'screen':
        return 'screen';
      case 'overlay':
        return 'overlay';
      case 'darken':
        return 'darken';
      case 'darker_color':
        return 'darker color';
      case 'lighten':
        return 'lighten';
      case 'lighter_color':
        return 'lighter color';
      case 'color_dodge':
        return 'color dodge';
      case 'color_burn':
        return 'color burn';
      case 'hard_light':
        return 'hard light';
      case 'soft_light':
        return 'soft light';
      case 'vivid_light':
        return 'vivid light';
      case 'linear_light':
        return 'linear light';
      case 'pin_light':
        return 'pin light';
      case 'hard_mix':
        return 'hard mix';
      case 'difference':
        return 'difference';
      case 'exclusion':
        return 'exclusion';
      case 'subtract':
        return 'subtract';
      case 'divide':
        return 'divide';
      case 'add':
      case 'glow':
        return 'linear dodge';
      case 'hue':
        return 'hue';
      case 'saturation':
        return 'saturation';
      case 'color':
        return 'color';
      case 'luminosity':
        return 'luminosity';
      default:
        return 'normal';
    }
  }
}
