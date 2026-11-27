/**
 * Audio track timeline metadata stored on a special group layer (`layerType === 'group'` + `meta.audio`).
 * The actual audio file binary stays local in IndexedDB (never uploaded automatically to the server);
 * only lightweight timeline metadata syncs in multiplayer rooms under existing layer ACL.
 */
export interface AudioTrackMeta {
  /** Local asset identifier in IndexedDB used to link the audio file on this device */
  localAssetId: string;
  /** Display file name (e.g. "voice_take1.wav") */
  fileName: string;
  /** Total source audio duration in seconds */
  durationSec: number;
  /** Zero-based start frame on the timeline */
  startFrame: number;
  /** Optional inclusive end frame on the timeline (if omitted, computed from durationSec & fps) */
  endFrame?: number;
  /** Optional offset into the source audio in seconds (default 0) */
  trimStartSec?: number;
  /** Linear gain 0..1 */
  volume: number;
  /** Mute switch */
  muted: boolean;
}

export interface AudioLikeLayer {
  id: string;
  layerType: string;
  name?: string;
  isVisible?: boolean;
  meta?: {
    audio?: AudioTrackMeta;
  } | null;
}

export interface ResolvedAudioFrameRange {
  startFrame: number;
  endFrame: number;
  frameCount: number;
  playableDurationSec: number;
}

export interface AudioPlaybackWindow {
  /** Offset into the source AudioBuffer in seconds */
  bufferOffsetSec: number;
  /** Delay from "now" before starting playback in seconds (0 if playhead is already inside the clip) */
  delaySec: number;
  /** Maximum duration to play in seconds */
  playDurationSec: number;
  /** Effective volume (0 when muted) */
  gain: number;
}

export const MAX_AUDIO_START_FRAME = 6000;
export const MAX_AUDIO_DURATION_SEC = 3600;
export const DEFAULT_WAVEFORM_PEAKS = 160;

export function isAudioLayer(layer: AudioLikeLayer | null | undefined): boolean {
  return Boolean(layer && layer.layerType === 'group' && layer.meta?.audio);
}

export function normalizeAudioTrackMeta(meta: Partial<AudioTrackMeta> | null | undefined): AudioTrackMeta {
  const localAssetId =
    typeof meta?.localAssetId === 'string' && meta.localAssetId.trim().length > 0
      ? meta.localAssetId.trim().slice(0, 128)
      : '';
  const fileName =
    typeof meta?.fileName === 'string' && meta.fileName.trim().length > 0
      ? meta.fileName.trim().slice(0, 160)
      : 'Audio';
  const rawDur = Number(meta?.durationSec);
  const durationSec = Number.isFinite(rawDur) && rawDur > 0 ? Math.min(MAX_AUDIO_DURATION_SEC, rawDur) : 0;
  const rawStart = Number(meta?.startFrame);
  const startFrame = Number.isFinite(rawStart)
    ? Math.max(0, Math.min(MAX_AUDIO_START_FRAME, Math.round(rawStart)))
    : 0;
  const rawTrim = Number(meta?.trimStartSec);
  const trimStartSec = Number.isFinite(rawTrim) && rawTrim > 0
    ? Math.min(Math.max(0, durationSec - 0.01), rawTrim)
    : 0;
  const rawVol = Number(meta?.volume);
  const volume = Number.isFinite(rawVol) ? Math.max(0, Math.min(1, rawVol)) : 1;
  const muted = Boolean(meta?.muted);
  const rawEnd = meta?.endFrame !== undefined ? Number(meta.endFrame) : NaN;
  const endFrame = Number.isFinite(rawEnd)
    ? Math.max(startFrame, Math.min(MAX_AUDIO_START_FRAME, Math.round(rawEnd)))
    : undefined;

  return {
    localAssetId,
    fileName,
    durationSec,
    startFrame,
    ...(endFrame !== undefined ? { endFrame } : {}),
    ...(trimStartSec > 0 ? { trimStartSec } : {}),
    volume,
    muted,
  };
}

/** Resolves the inclusive timeline frame span `[startFrame, endFrame]` for an audio clip at `fps`. */
export function resolveAudioClipFrameRange(
  meta: AudioTrackMeta,
  fps: number
): ResolvedAudioFrameRange {
  const safeFps = Math.max(1, Math.min(60, fps || 12));
  const norm = normalizeAudioTrackMeta(meta);
  const remainingSec = Math.max(0, norm.durationSec - (norm.trimStartSec ?? 0));
  const naturalFrames = Math.max(1, Math.ceil(remainingSec * safeFps));
  const naturalEnd = Math.min(MAX_AUDIO_START_FRAME, norm.startFrame + naturalFrames - 1);
  const endFrame = norm.endFrame !== undefined ? Math.min(naturalEnd, Math.max(norm.startFrame, norm.endFrame)) : naturalEnd;
  const frameCount = Math.max(1, endFrame - norm.startFrame + 1);
  const playableDurationSec = Math.min(remainingSec, frameCount / safeFps);
  return {
    startFrame: norm.startFrame,
    endFrame,
    frameCount,
    playableDurationSec,
  };
}

/**
 * Computes Web Audio scheduling parameters for a clip given the current playhead frame, fps,
 * and optional timeline end boundary (e.g. playback range end).
 * Returns null if the clip is muted, silent, or completely before the playhead.
 */
export function computeAudioPlaybackWindow(
  meta: AudioTrackMeta,
  currentFrame: number,
  fps: number,
  playbackEndFrame?: number
): AudioPlaybackWindow | null {
  const safeFps = Math.max(1, Math.min(60, fps || 12));
  const norm = normalizeAudioTrackMeta(meta);
  if (norm.muted || norm.volume <= 0 || norm.durationSec <= 0) return null;

  const range = resolveAudioClipFrameRange(norm, safeFps);
  const effectiveEnd =
    playbackEndFrame !== undefined ? Math.min(range.endFrame, Math.max(currentFrame, playbackEndFrame)) : range.endFrame;

  if (currentFrame > effectiveEnd) return null;

  const trimStart = norm.trimStartSec ?? 0;
  const clipStartSec = range.startFrame / safeFps;
  const playheadSec = Math.max(0, currentFrame) / safeFps;
  const clipEndSec = (effectiveEnd + 1) / safeFps;
  const maxSourceEndSec = Math.min(norm.durationSec, trimStart + (clipEndSec - clipStartSec));

  if (playheadSec >= clipStartSec) {
    const elapsedInClip = playheadSec - clipStartSec;
    const bufferOffsetSec = trimStart + elapsedInClip;
    const playDurationSec = Math.max(0, maxSourceEndSec - bufferOffsetSec);
    if (playDurationSec <= 0.005) return null;
    return {
      bufferOffsetSec,
      delaySec: 0,
      playDurationSec,
      gain: norm.volume,
    };
  }

  const delaySec = clipStartSec - playheadSec;
  const playDurationSec = Math.max(0, maxSourceEndSec - trimStart);
  if (playDurationSec <= 0.005) return null;
  return {
    bufferOffsetSec: trimStart,
    delaySec,
    playDurationSec,
    gain: norm.volume,
  };
}

/**
 * Extracts normalized peak amplitudes (0..1) from raw mono/interleaved channel samples
 * for compact timeline waveform rendering.
 */
export function computeWaveformPeaks(
  samples: ArrayLike<number>,
  bucketCount = DEFAULT_WAVEFORM_PEAKS
): number[] {
  const count = Math.max(8, Math.min(512, Math.round(bucketCount) || DEFAULT_WAVEFORM_PEAKS));
  const total = samples.length;
  if (total === 0) return new Array<number>(count).fill(0);

  const peaks = new Array<number>(count).fill(0);
  let maxPeak = 0;
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * total) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * total) / count));
    const stride = Math.max(1, Math.floor((end - start) / 64));
    let peak = 0;
    for (let j = start; j < end; j += stride) {
      const abs = Math.abs(samples[j] || 0);
      if (abs > peak) peak = abs;
    }
    peaks[i] = peak;
    if (peak > maxPeak) maxPeak = peak;
  }

  if (maxPeak > 1e-6) {
    for (let i = 0; i < count; i++) {
      peaks[i] = Math.round((peaks[i] / maxPeak) * 1000) / 1000;
    }
  }
  return peaks;
}

export interface WaveformSliceResult {
  /** Unscaled peak amplitudes (0..1) for the active trimmed clip range */
  rawBars: number[];
  /** Volume & mute scaled peak amplitudes (0..1) */
  scaledBars: number[];
  /** Effective linear gain applied (0 when muted) */
  effectiveGain: number;
  /** Fraction [0..1] of source audio where the visible slice starts */
  trimStartRatio: number;
  /** Fraction [0..1] of source audio where the visible slice ends */
  trimEndRatio: number;
}

/**
 * Slices and resamples normalized waveform peaks to match the clip's trim offset (`trimStartSec`),
 * resolved playable duration (`endFrame` / `durationSec`), volume, and mute state.
 */
export function sliceWaveformPeaksForClip(
  peaks: ArrayLike<number>,
  meta: AudioTrackMeta,
  fps: number,
  bucketCount: number
): WaveformSliceResult {
  const norm = normalizeAudioTrackMeta(meta);
  const count = Math.max(4, Math.min(512, Math.round(bucketCount) || 32));
  const effectiveGain = norm.muted ? 0 : norm.volume;
  const totalPeaks = peaks?.length ?? 0;

  if (totalPeaks === 0 || norm.durationSec <= 0) {
    return {
      rawBars: new Array<number>(count).fill(0),
      scaledBars: new Array<number>(count).fill(0),
      effectiveGain,
      trimStartRatio: 0,
      trimEndRatio: 1,
    };
  }

  const range = resolveAudioClipFrameRange(norm, fps);
  const trimStart = Math.max(0, Math.min(norm.durationSec, norm.trimStartSec ?? 0));
  const trimEnd = Math.max(trimStart, Math.min(norm.durationSec, trimStart + range.playableDurationSec));
  const trimStartRatio = trimStart / norm.durationSec;
  const trimEndRatio = Math.max(trimStartRatio, trimEnd / norm.durationSec);

  const srcStartF = trimStartRatio * totalPeaks;
  const srcEndF = Math.max(srcStartF + 1e-4, trimEndRatio * totalPeaks);
  const span = srcEndF - srcStartF;

  const rawBars = new Array<number>(count).fill(0);
  const scaledBars = new Array<number>(count).fill(0);

  for (let i = 0; i < count; i++) {
    const f0 = srcStartF + (i * span) / count;
    const f1 = srcStartF + ((i + 1) * span) / count;
    const idx0 = Math.max(0, Math.min(totalPeaks - 1, Math.floor(f0)));
    const idx1 = Math.max(idx0 + 1, Math.min(totalPeaks, Math.ceil(f1)));
    let maxVal = 0;
    for (let j = idx0; j < idx1; j++) {
      const v = Number(peaks[j]) || 0;
      if (v > maxVal) maxVal = v;
    }
    const clamped = Math.max(0, Math.min(1, maxVal));
    rawBars[i] = Math.round(clamped * 1000) / 1000;
    scaledBars[i] = Math.round(clamped * effectiveGain * 1000) / 1000;
  }

  return {
    rawBars,
    scaledBars,
    effectiveGain,
    trimStartRatio,
    trimEndRatio,
  };
}

export interface ExportAudioClipPlan {
  layerId: string;
  localAssetId: string;
  fileName: string;
  /** Offset into the source audio buffer in seconds */
  sourceOffsetSec: number;
  /** Start time relative to exportStartFrame in seconds */
  timelineStartSec: number;
  /** Playable duration inside the export window in seconds */
  playDurationSec: number;
  /** Linear gain (0..1) */
  gain: number;
}

export interface ExportAudioMixPlan {
  fps: number;
  exportStartFrame: number;
  exportEndFrame: number;
  totalDurationSec: number;
  clips: ExportAudioClipPlan[];
  hasActiveAudio: boolean;
}

/**
 * Plans all active (unmuted, volume > 0) audio track clips overlapping `[exportStartFrame, exportEndFrame]`.
 */
export function planExportAudioMix(
  tracks: ReadonlyArray<{ layerId: string; meta: AudioTrackMeta }>,
  exportStartFrame: number,
  exportEndFrame: number,
  fps: number
): ExportAudioMixPlan {
  const safeFps = Math.max(1, Math.min(60, fps || 12));
  const safeStart = Math.max(0, Math.round(exportStartFrame));
  const safeEnd = Math.max(safeStart, Math.round(exportEndFrame));
  const totalDurationSec = (safeEnd - safeStart + 1) / safeFps;
  const clips: ExportAudioClipPlan[] = [];

  for (const item of tracks) {
    const norm = normalizeAudioTrackMeta(item.meta);
    if (norm.muted || norm.volume <= 0 || norm.durationSec <= 0 || !norm.localAssetId) continue;
    const win = computeAudioPlaybackWindow(norm, safeStart, safeFps, safeEnd);
    if (!win || win.playDurationSec <= 0.002) continue;
    const clampedDur = Math.min(win.playDurationSec, Math.max(0, totalDurationSec - win.delaySec));
    if (clampedDur <= 0.002) continue;
    clips.push({
      layerId: item.layerId,
      localAssetId: norm.localAssetId,
      fileName: norm.fileName,
      sourceOffsetSec: win.bufferOffsetSec,
      timelineStartSec: win.delaySec,
      playDurationSec: clampedDur,
      gain: win.gain,
    });
  }

  return {
    fps: safeFps,
    exportStartFrame: safeStart,
    exportEndFrame: safeEnd,
    totalDurationSec,
    clips,
    hasActiveAudio: clips.length > 0,
  };
}

export interface PcmClipInput {
  left: Float32Array;
  right?: Float32Array;
  sampleRate: number;
  sourceOffsetSec: number;
  timelineStartSec: number;
  playDurationSec: number;
  gain: number;
}

export interface PcmMixResult {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  frameCount: number;
  durationSec: number;
  mixedClipCount: number;
  peakAmplitude: number;
  clippedSamples: number;
}

/**
 * Deterministic stereo PCM mixer with linear resampling, per-clip offset/gain, and safe [-1, 1] limiting.
 * Runs cleanly in both Node unit tests and browser/Electron workers without Web Audio dependencies.
 */
export function mixPcmChannels(
  targetSampleRate: number,
  totalDurationSec: number,
  clips: ReadonlyArray<PcmClipInput>
): PcmMixResult {
  const sampleRate = Math.max(8000, Math.min(96000, Math.round(targetSampleRate) || 48000));
  const durationSec = Math.max(0, Number.isFinite(totalDurationSec) ? totalDurationSec : 0);
  const frameCount = Math.max(0, Math.ceil(durationSec * sampleRate));
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);

  let mixedClipCount = 0;
  for (const clip of clips) {
    if (!clip || !clip.left || clip.left.length === 0) continue;
    const gain = Number.isFinite(clip.gain) ? Math.max(0, Math.min(4, clip.gain)) : 0;
    if (gain <= 0) continue;
    const srcRate = Math.max(8000, Math.min(192000, clip.sampleRate || sampleRate));
    const srcRight = clip.right && clip.right.length > 0 ? clip.right : clip.left;
    const srcLen = Math.min(clip.left.length, srcRight.length);
    if (srcLen <= 0) continue;

    const dstStart = Math.max(0, Math.round(clip.timelineStartSec * sampleRate));
    const clipDstFrames = Math.max(0, Math.round(clip.playDurationSec * sampleRate));
    const dstEnd = Math.min(frameCount, dstStart + clipDstFrames);
    if (dstEnd <= dstStart) continue;

    const ratio = srcRate / sampleRate;
    const baseSrcPos = Math.max(0, clip.sourceOffsetSec * srcRate);
    let wroteAny = false;

    for (let d = dstStart; d < dstEnd; d++) {
      const srcPos = baseSrcPos + (d - dstStart) * ratio;
      const i0 = Math.floor(srcPos);
      if (i0 < 0 || i0 >= srcLen) break;
      const i1 = Math.min(srcLen - 1, i0 + 1);
      const frac = srcPos - i0;
      const sL = clip.left[i0] * (1 - frac) + clip.left[i1] * frac;
      const sR = srcRight[i0] * (1 - frac) + srcRight[i1] * frac;
      left[d] += sL * gain;
      right[d] += sR * gain;
      wroteAny = true;
    }
    if (wroteAny) mixedClipCount++;
  }

  let peakAmplitude = 0;
  let clippedSamples = 0;
  for (let i = 0; i < frameCount; i++) {
    const absL = Math.abs(left[i]);
    const absR = Math.abs(right[i]);
    if (absL > peakAmplitude) peakAmplitude = absL;
    if (absR > peakAmplitude) peakAmplitude = absR;
    if (absL > 1) {
      clippedSamples++;
      left[i] = Math.tanh(left[i]);
    }
    if (absR > 1) {
      clippedSamples++;
      right[i] = Math.tanh(right[i]);
    }
  }

  return {
    left,
    right,
    sampleRate,
    frameCount,
    durationSec: frameCount / sampleRate,
    mixedClipCount,
    peakAmplitude: Math.round(peakAmplitude * 10000) / 10000,
    clippedSamples,
  };
}
