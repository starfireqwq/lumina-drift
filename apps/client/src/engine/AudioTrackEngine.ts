import {
  AudioTrackMeta,
  DEFAULT_WAVEFORM_PEAKS,
  computeAudioPlaybackWindow,
  computeWaveformPeaks,
  mixPcmChannels,
  planExportAudioMix,
  resolveAudioClipFrameRange,
  type PcmClipInput,
} from '@atelier/shared';
import type { MixedAudioPcm } from './videoExport';

/**
 * Phase E3: Local-only IndexedDB audio storage + Web Audio playback & scrubbing engine.
 * Audio binaries stay strictly on the user's device and are NEVER uploaded automatically to the server.
 */

const DB_NAME = 'atelier_audio_assets';
const DB_VERSION = 1;
const STORE_NAME = 'audio_tracks';
const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50MB local file safety cap

export interface StoredAudioAsset {
  id: string;
  fileName: string;
  mimeType: string;
  durationSec: number;
  peaks: number[];
  blob: Blob;
  createdAt: number;
}

export interface AudioAssetSummary {
  id: string;
  linked: boolean;
  peaks: number[];
  durationSec: number;
  fileName?: string;
}

export interface PlayableAudioTrackItem {
  layerId: string;
  meta: AudioTrackMeta;
}

const memoryStore = new Map<string, StoredAudioAsset>();
const decodedBuffers = new Map<string, AudioBuffer>();
const pendingDecodes = new Map<string, Promise<AudioBuffer | null>>();
const waveformCache = new Map<string, number[]>();
const listeners = new Set<() => void>();

function notifyAssetListeners() {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // ignore listener errors
    }
  }
}

export function subscribeAudioAssets(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

let sharedAudioCtx: AudioContext | null = null;
function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    sharedAudioCtx = new Ctor();
  }
  return sharedAudioCtx;
}

async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  if (!ctx) throw new Error('Web Audio API is unavailable');
  const arr = await blob.arrayBuffer();
  return await ctx.decodeAudioData(arr.slice(0));
}

function extractMonoSamples(buffer: AudioBuffer): Float32Array {
  const ch0 = buffer.getChannelData(0);
  if (buffer.numberOfChannels <= 1) return ch0;
  const ch1 = buffer.getChannelData(1);
  const len = Math.min(ch0.length, ch1.length);
  const mixed = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    mixed[i] = (ch0[i] + ch1[i]) * 0.5;
  }
  return mixed;
}

async function persistAsset(asset: StoredAudioAsset): Promise<void> {
  memoryStore.set(asset.id, asset);
  waveformCache.set(asset.id, asset.peaks);
  const db = await openDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(asset);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
  notifyAssetListeners();
}

export async function importLocalAudioFile(
  file: File,
  fixedAssetId?: string
): Promise<StoredAudioAsset> {
  if (file.size > MAX_AUDIO_BYTES) {
    throw new Error('Audio file exceeds 50MB limit');
  }
  const buffer = await decodeBlob(file);
  const peaks = computeWaveformPeaks(extractMonoSamples(buffer), DEFAULT_WAVEFORM_PEAKS);
  const id =
    fixedAssetId && fixedAssetId.trim().length > 0
      ? fixedAssetId.trim().slice(0, 128)
      : `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  decodedBuffers.set(id, buffer);
  const asset: StoredAudioAsset = {
    id,
    fileName: file.name || 'audio',
    mimeType: file.type || 'audio/wav',
    durationSec: Math.round(buffer.duration * 1000) / 1000,
    peaks,
    blob: file,
    createdAt: Date.now(),
  };
  await persistAsset(asset);
  return asset;
}

export async function getStoredAudioAsset(id: string): Promise<StoredAudioAsset | null> {
  if (!id) return null;
  const mem = memoryStore.get(id);
  if (mem) return mem;
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => {
        const val = (req.result as StoredAudioAsset | undefined) ?? null;
        if (val) {
          memoryStore.set(id, val);
          waveformCache.set(id, val.peaks);
        }
        resolve(val);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function ensureAudioBufferLoaded(id: string): Promise<AudioBuffer | null> {
  if (!id) return null;
  const cached = decodedBuffers.get(id);
  if (cached) return cached;
  const pending = pendingDecodes.get(id);
  if (pending) return pending;
  const decode = getStoredAudioAsset(id).then(async (asset) => {
    if (!asset) return null;
    try {
      const buffer = await decodeBlob(asset.blob);
      if (pendingDecodes.get(id) !== decode) return null;
      decodedBuffers.set(id, buffer);
      if (!waveformCache.has(id)) {
        const cachePeaks = () => {
          if (decodedBuffers.get(id) !== buffer || waveformCache.has(id)) return;
          waveformCache.set(id, asset.peaks?.length ? asset.peaks : computeWaveformPeaks(extractMonoSamples(buffer)));
          notifyAssetListeners();
        };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(cachePeaks);
        else setTimeout(cachePeaks, 50);
      }
      return buffer;
    } catch {
      return null;
    }
  });
  pendingDecodes.set(id, decode);
  try {
    return await decode;
  } finally {
    if (pendingDecodes.get(id) === decode) pendingDecodes.delete(id);
  }
}

export async function loadAudioAssetSummaries(assetIds: string[]): Promise<Record<string, AudioAssetSummary>> {
  const out: Record<string, AudioAssetSummary> = {};
  await Promise.all(
    [...new Set(assetIds.filter(Boolean))].map(async (id) => {
      const asset = await getStoredAudioAsset(id);
      if (asset) {
        out[id] = {
          id,
          linked: true,
          peaks: asset.peaks,
          durationSec: asset.durationSec,
          fileName: asset.fileName,
        };
      } else {
        out[id] = { id, linked: false, peaks: [], durationSec: 0 };
      }
    })
  );
  return out;
}

export async function deleteLocalAudioAsset(id: string): Promise<void> {
  if (!id) return;
  memoryStore.delete(id);
  decodedBuffers.delete(id);
  pendingDecodes.delete(id);
  waveformCache.delete(id);
  const db = await openDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const rw = db.transaction(STORE_NAME, 'readwrite');
        rw.objectStore(STORE_NAME).delete(id);
        rw.oncomplete = () => resolve();
        rw.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
  notifyAssetListeners();
}

export function getDecodedAudioBuffer(assetId: string): AudioBuffer | null {
  return decodedBuffers.get(assetId) ?? null;
}

/**
 * Offline stereo PCM renderer for animation MP4/WebM export.
 * Loads decoded local buffers for all active audio tracks overlapping `[exportStartFrame, exportEndFrame]`,
 * applies trim offset, timeline offset, volume, and mute, and returns mixed stereo Float32 PCM.
 */
export async function renderMixedAudioTrack(
  tracks: ReadonlyArray<PlayableAudioTrackItem>,
  exportStartFrame: number,
  exportEndFrame: number,
  fps: number,
  targetSampleRate: number = 48000
): Promise<MixedAudioPcm | null> {
  const plan = planExportAudioMix(tracks, exportStartFrame, exportEndFrame, fps);
  if (!plan.hasActiveAudio || plan.totalDurationSec <= 0) return null;

  const missingAssetIds: string[] = [];
  const pcmClips: PcmClipInput[] = [];

  for (const clip of plan.clips) {
    const buffer = await ensureAudioBufferLoaded(clip.localAssetId);
    if (!buffer) {
      missingAssetIds.push(clip.localAssetId);
      continue;
    }
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    pcmClips.push({
      left,
      right,
      sampleRate: buffer.sampleRate,
      sourceOffsetSec: clip.sourceOffsetSec,
      timelineStartSec: clip.timelineStartSec,
      playDurationSec: clip.playDurationSec,
      gain: clip.gain,
    });
  }

  if (pcmClips.length === 0) {
    return {
      left: new Float32Array(0),
      right: new Float32Array(0),
      sampleRate: targetSampleRate,
      frameCount: 0,
      durationSec: plan.totalDurationSec,
      mixedTrackCount: 0,
      missingAssetIds,
      peakAmplitude: 0,
      clippedSamples: 0,
    };
  }

  const mixed = mixPcmChannels(targetSampleRate, plan.totalDurationSec, pcmClips);
  return {
    left: mixed.left,
    right: mixed.right,
    sampleRate: mixed.sampleRate,
    frameCount: mixed.frameCount,
    durationSec: mixed.durationSec,
    mixedTrackCount: mixed.mixedClipCount,
    missingAssetIds,
    peakAmplitude: mixed.peakAmplitude,
    clippedSamples: mixed.clippedSamples,
  };
}

export class AudioTrackPlayer {
  private activeNodes: Array<{ source: AudioBufferSourceNode; gain: GainNode }> = [];
  private scrubNodes: Array<{ source: AudioBufferSourceNode; gain: GainNode }> = [];
  private lastScrubMs = 0;
  private playbackRevision = 0;
  private scrubRevision = 0;

  public stopPlayback(): void {
    this.playbackRevision++;
    for (const node of this.activeNodes) {
      try {
        node.source.stop();
        node.source.disconnect();
        node.gain.disconnect();
      } catch {
        // ignore already-stopped nodes
      }
    }
    this.activeNodes = [];
  }

  public stopScrub(): void {
    this.scrubRevision++;
    for (const node of this.scrubNodes) {
      try {
        node.source.stop();
        node.source.disconnect();
        node.gain.disconnect();
      } catch {
        // ignore
      }
    }
    this.scrubNodes = [];
  }

  public async startPlayback(
    tracks: ReadonlyArray<PlayableAudioTrackItem>,
    currentFrame: number,
    fps: number,
    playbackEndFrame?: number
  ): Promise<void> {
    this.stopPlayback();
    this.stopScrub();
    const revision = this.playbackRevision;
    if (!tracks.length) return;
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        return;
      }
    }

    const now = ctx.currentTime;
    await Promise.all(tracks.map(async (item) => {
      const win = computeAudioPlaybackWindow(item.meta, currentFrame, fps, playbackEndFrame);
      if (!win || revision !== this.playbackRevision) return;
      const buffer = await ensureAudioBufferLoaded(item.meta.localAssetId);
      if (!buffer || revision !== this.playbackRevision) return;
      const startAt = now + win.delaySec;
      const lateBy = Math.max(0, ctx.currentTime - startAt);
      const offset = win.bufferOffsetSec + lateBy;
      const safeDur = Math.min(win.playDurationSec - lateBy, buffer.duration - offset);
      if (safeDur <= 0) return;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = win.gain;
      source.connect(gain);
      gain.connect(ctx.destination);

      try {
        source.start(Math.max(ctx.currentTime, startAt), offset, safeDur);
        this.activeNodes.push({ source, gain });
      } catch {
        try {
          source.disconnect();
          gain.disconnect();
        } catch {
          // ignore
        }
      }
    }));
  }

  /** Plays a short ~80ms slice at `frame` for lip-sync scrubbing. */
  public async scrubFrame(
    tracks: ReadonlyArray<PlayableAudioTrackItem>,
    frame: number,
    fps: number
  ): Promise<void> {
    const ts = performance.now();
    if (ts - this.lastScrubMs < 45) return;
    this.lastScrubMs = ts;
    this.stopScrub();
    const revision = this.scrubRevision;

    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        return;
      }
    }

    const safeFps = Math.max(1, fps || 12);
    const sliceSec = Math.max(0.055, Math.min(0.11, 1 / safeFps));
    for (const item of tracks) {
      if (item.meta.muted || item.meta.volume <= 0) continue;
      const range = resolveAudioClipFrameRange(item.meta, safeFps);
      if (frame < range.startFrame || frame > range.endFrame) continue;
      const buffer = await ensureAudioBufferLoaded(item.meta.localAssetId);
      if (revision !== this.scrubRevision) return;
      if (!buffer) continue;
      const offset = (item.meta.trimStartSec ?? 0) + (frame - range.startFrame) / safeFps;
      if (offset < 0 || offset >= buffer.duration - 0.01) continue;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = item.meta.volume;
      source.connect(gain);
      gain.connect(ctx.destination);
      try {
        source.start(ctx.currentTime, offset, Math.min(sliceSec, buffer.duration - offset));
        this.scrubNodes.push({ source, gain });
      } catch {
        // ignore
      }
    }
  }

  public destroy(): void {
    this.stopPlayback();
    this.stopScrub();
  }
}
