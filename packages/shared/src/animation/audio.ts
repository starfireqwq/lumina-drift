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
