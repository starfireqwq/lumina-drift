import {
  Affine2D,
  IDENTITY_AFFINE,
  TransformKeyframe,
  evaluateTransformKeyframes,
  multiplyAffine,
  transformToAffineMatrix,
} from '@atelier/shared';

/**
 * CSP-style animation. An animation folder is a track; each child layer is an entry on it (a cel,
 * possibly a folder of layers) that stays on screen for `meta.cel.hold` timeline frames. An entry
 * with `meta.cel.ref` reuses another cel of the same folder (it is an empty group, so it costs no
 * textures). Every animation folder plays on the same clock, so several painters can each draw
 * their own track (or add cels to a shared folder) and see one animation.
 */

export interface CelEntry {
  /** The entry's layer id */
  id: string;
  label: string;
  /** Timeline frames it stays on screen (1 = one frame) */
  hold: number;
  /** A reused cel: the layer it shows ('' = its cel was deleted, it shows nothing) */
  ref?: string;
  ownerId: string | null;
  isGroup: boolean;
}

export interface AnimationTrack {
  folderId: string;
  name: string;
  ownerId: string | null;
  shared: boolean;
  entries: CelEntry[];
}

export interface OnionSkinConfig {
  enabled: boolean;
  prevColor: string;
  nextColor: string;
  opacity: number; // 0.05 to 0.9
  prevFramesCount: number; // 0 to MAX_ONION
  nextFramesCount: number;
}

export const MAX_HOLD = 99;
/** Longest timeline that can be set (250 s at 24 FPS) */
export const MAX_TIMELINE_FRAMES = 6000;
export const MAX_ONION = 5;
/** Frames past the end of the longest track that the playhead can be put on (to place cels there) */
export const TIMELINE_SLACK = 24;

type AnimLayer = {
  id: string;
  parentId: string | null;
  layerType: string;
  sortOrder: number;
  isVisible: boolean;
  opacity: number;
  name?: string;
  ownerId?: string | null;
  meta?: { animation?: unknown; cel?: { hold?: number; ref?: string }; keyframes?: TransformKeyframe[] } | null;
};

export function upsertTransformKeyframe(
  list: ReadonlyArray<TransformKeyframe> | undefined | null,
  kf: TransformKeyframe
): TransformKeyframe[] {
  const frame = Math.max(0, Math.round(kf.frame));
  const next = (list ? list.filter((k) => Math.round(k.frame) !== frame) : []).slice();
  next.push({ ...kf, frame });
  next.sort((a, b) => a.frame - b.frame);
  return next;
}

export function removeTransformKeyframe(
  list: ReadonlyArray<TransformKeyframe> | undefined | null,
  frame: number
): TransformKeyframe[] {
  if (!list?.length) return [];
  const target = Math.round(frame);
  return list.filter((k) => Math.round(k.frame) !== target);
}

export const isAnimationFolder = (l: AnimLayer) => l.layerType === 'group' && Boolean(l.meta?.animation);

/** A track's entries, bottom layer first */
export function celEntriesOf(layers: AnimLayer[], folderId: string): CelEntry[] {
  const children = layers.filter((l) => l.parentId === folderId && l.layerType !== 'mask').sort((a, b) => a.sortOrder - b.sortOrder);
  const byId = new Map(children.map((c) => [c.id, c]));
  return children.map((l) => {
    const cel = l.meta?.cel;
    const hold = Math.max(1, Math.min(MAX_HOLD, Math.round(Number(cel?.hold) || 1)));
    let ref: string | undefined;
    if (cel?.ref !== undefined) {
      const target = byId.get(cel.ref);
      // No chains: a reference to a reference (or to itself) shows nothing
      ref = target && target.id !== l.id && target.meta?.cel?.ref === undefined ? target.id : '';
    }
    return { id: l.id, label: l.name ?? '', hold, ref, ownerId: l.ownerId ?? null, isGroup: l.layerType === 'group' };
  });
}

/** The layer an entry puts on screen: itself, the cel it reuses, or nothing */
export const celLayerOf = (e: CelEntry | undefined): string | null => (!e ? null : e.ref === undefined ? e.id : e.ref || null);

export const trackLength = (entries: CelEntry[]) => entries.reduce((n, e) => n + e.hold, 0);

/** Timeline frame where entry i starts */
export const entryStart = (entries: CelEntry[], i: number) => entries.slice(0, i).reduce((n, e) => n + e.hold, 0);

/** The entry on screen at frame t, -1 past the end of the track */
export function entryIndexAt(entries: CelEntry[], t: number): number {
  let end = 0;
  for (let i = 0; i < entries.length; i++) {
    end += entries[i].hold;
    if (t < end) return t >= 0 ? i : -1;
  }
  return -1;
}

/** The animation cel holding a layer (the layer itself, or the cel folder it sits in) */
export function celOfLayer(layers: AnimLayer[], layerId: string): { folderId: string; celId: string } | null {
  const byId = new Map(layers.map((l) => [l.id, l]));
  let cur = byId.get(layerId);
  if (cur?.layerType === 'mask' && cur.parentId) cur = byId.get(cur.parentId);
  for (let depth = 0; cur && cur.parentId && depth < 16; depth++) {
    const parent = byId.get(cur.parentId);
    if (!parent) return null;
    if (isAnimationFolder(parent)) return { folderId: parent.id, celId: cur.id };
    cur = parent;
  }
  return null;
}

/**
 * Krita / OpenToonz timing on top of holds: a cel sits on a frame and shows until the next one, so
 * the empty frames after a drawing keep showing it. `starts` puts entries (moved, or `added` from
 * elsewhere) on frames; every other entry keeps its frame. Returns the track in order with the
 * holds that give those frames (the last entry keeps its own). An entry put on a taken frame takes
 * it and pushes the rest along by one; a track always starts on its first frame.
 */
export function placeEntries(
  entries: ReadonlyArray<{ id: string; hold: number }>,
  starts: ReadonlyMap<string, number>,
  added: ReadonlyArray<{ id: string; hold: number }> = []
): Array<{ id: string; start: number; hold: number }> {
  const items: Array<{ id: string; start: number; hold: number; placed: boolean; order: number }> = [];
  let t = 0;
  entries.forEach((e, i) => {
    const s = starts.get(e.id);
    items.push({ id: e.id, start: Math.max(0, Math.round(s ?? t)), hold: e.hold, placed: s !== undefined, order: i });
    t += e.hold;
  });
  added.forEach((e, i) => {
    items.push({ id: e.id, start: Math.max(0, Math.round(starts.get(e.id) ?? t)), hold: e.hold, placed: true, order: entries.length + i });
  });
  items.sort((a, b) => a.start - b.start || Number(b.placed) - Number(a.placed) || a.order - b.order);
  const out: Array<{ id: string; start: number; hold: number }> = [];
  let at = 0;
  items.forEach((it, i) => {
    const next = items[i + 1];
    // Starts strictly increase (a taken frame pushes the rest along)
    if (next) next.start = Math.max(next.start, it.start + 1);
    // Up to the next cel's frame (the first cel also covers any lead-in before where it was put)
    const hold = Math.max(1, Math.min(MAX_HOLD, next ? next.start - at : it.hold));
    out.push({ id: it.id, start: at, hold });
    at += hold;
  });
  return out;
}

/** First timeline frame showing this cel, or -1 */
export function timeOfCel(entries: CelEntry[], celId: string): number {
  const i = entries.findIndex((e) => celLayerOf(e) === celId);
  return i < 0 ? -1 : entryStart(entries, i);
}

/**
 * CSP-style in-between: where a cel added at frame `time` goes while later cels keep their frames.
 * Inside a cel it splits that cel at the playhead (the new cel starts there and runs up to the next
 * cel); on a cel's first frame it starts one frame later. null when there is no frame to take (a
 * one-frame cel under the playhead) or the playhead is past the track.
 */
export function celInsertAt(
  entries: ReadonlyArray<{ hold: number }>,
  time: number
): { index: number; keep: number; hold: number; start: number } | null {
  if (time < 0) return null;
  let start = 0;
  for (let i = 0; i < entries.length; i++) {
    const end = start + entries[i].hold;
    if (time < end) {
      const at = time > start ? time : start + 1;
      return at < end ? { index: i, keep: at - start, hold: end - at, start: at } : null;
    }
    start = end;
  }
  return null;
}

export type TimecodeMode = 'sf' | 'frames';

/** A timeline frame (0-based) as CSP shows it: seconds + frame of that second ("1+5"), or the frame number */
export function formatTimecode(frame: number, fps: number, mode: TimecodeMode): string {
  const n = Math.max(0, Math.round(frame) || 0);
  if (mode === 'frames') return String(n + 1);
  const f = Math.max(1, Math.round(fps) || 1);
  return `${Math.floor(n / f)}+${(n % f) + 1}`;
}

/** Reads "1+5" (seconds + frame) or "29" (frame number) back as a 0-based frame; null if unreadable */
export function parseTimecode(text: string, fps: number): number | null {
  const s = text.trim();
  const f = Math.max(1, Math.round(fps) || 1);
  const sf = /^(\d{1,5})\s*\+\s*(\d{1,5})$/.exec(s);
  if (sf) return Number(sf[2]) >= 1 ? Number(sf[1]) * f + Number(sf[2]) - 1 : null;
  return /^\d{1,6}$/.test(s) && Number(s) >= 1 ? Number(s) - 1 : null;
}

export interface AnimationView {
  /** Timeline frame on screen */
  time: number;
  /** The folder being edited: only it gets onion skin */
  activeFolderId: string | null;
  onion: OnionSkinConfig | null;
  /** Export: only these animation folders' layers are shown (null = everything) */
  only?: Set<string> | null;
  /** Light table: these cels are shown faded (`opacity` of their own) as a reference while drawing */
  light?: { opacity: number; ids: ReadonlySet<string> } | null;
}

/**
 * What the animation puts on screen at one frame: in every animation folder only the cel at that
 * frame is visible (onion skin adds tinted neighbours in the edited folder).
 */
export function animationDisplay<T extends AnimLayer>(
  layers: T[],
  view: AnimationView | null,
  canvasWidth = 0,
  canvasHeight = 0
): Array<T & { onionTint?: number; renderTransform?: Affine2D }> {
  const folders = layers.filter(isAnimationFolder);
  let hasKeyframes = false;
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].meta?.keyframes?.length) {
      hasKeyframes = true;
      break;
    }
  }
  if (folders.length === 0 && !view?.only && !hasKeyframes) return layers;
  const time = view?.time ?? 0;
  const tint = (hex: string) => parseInt(hex.replace('#', ''), 16) || 0;
  const byId = new Map<string, T>();
  const children = new Map<string, T[]>();
  for (const l of layers) {
    byId.set(l.id, l);
    if (l.parentId) {
      let arr = children.get(l.parentId);
      if (!arr) children.set(l.parentId, (arr = []));
      arr.push(l);
    }
  }

  // Evaluate hierarchical transform keyframes (parent groups cascade cleanly onto children)
  const worldTransforms = hasKeyframes ? new Map<string, Affine2D>() : null;
  if (worldTransforms) {
    const defaultPx = canvasWidth / 2;
    const defaultPy = canvasHeight / 2;
    const localMap = new Map<string, Affine2D>();
    for (const l of layers) {
      const kfs = l.meta?.keyframes;
      if (kfs && kfs.length > 0) {
        const evaluated = evaluateTransformKeyframes(kfs, time, defaultPx, defaultPy);
        localMap.set(l.id, transformToAffineMatrix(evaluated));
      }
    }
    const resolveWorld = (id: string, depth = 0): Affine2D => {
      const cached = worldTransforms.get(id);
      if (cached) return cached;
      const layer = byId.get(id);
      if (!layer || depth > 16) return IDENTITY_AFFINE;
      const local = localMap.get(id) ?? IDENTITY_AFFINE;
      const res = layer.parentId && byId.has(layer.parentId)
        ? multiplyAffine(resolveWorld(layer.parentId, depth + 1), local)
        : local;
      worldTransforms.set(id, res);
      return res;
    };
    for (const l of layers) resolveWorld(l.id);
  }

  // Per cel layer: shown, tinted, on the light table, or (default) hidden. `fade` scales the onion opacity
  const celState = new Map<string, { tint?: number; fade?: number; light?: number }>();
  const hidden = new Set<string>();
  const lightIds = view?.light?.ids;
  for (const folder of folders) {
    const entries = celEntriesOf(layers, folder.id);
    for (const e of entries) hidden.add(e.id);
    const idx = entryIndexAt(entries, time);
    const shown = celLayerOf(entries[idx]);
    if (shown) celState.set(shown, {});
    // Light table cels the painter picked come before onion skin (an explicit choice)
    if (lightIds?.size) {
      for (const e of entries) {
        const id = celLayerOf(e);
        if (id && lightIds.has(id) && !celState.has(id)) celState.set(id, { light: view!.light!.opacity });
      }
    }
    const onion = folder.id === view?.activeFolderId ? view?.onion : null;
    if (!onion?.enabled || idx < 0) continue;
    const walk = (step: -1 | 1, count: number, color: string) => {
      const seen = new Set<string>(shown ? [shown] : []);
      let distance = 0;
      for (let i = idx + step; i >= 0 && i < entries.length && distance < count; i += step) {
        const id = celLayerOf(entries[i]);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        distance++;
        // The nearest drawing at the set opacity, each one further away fainter (1, 0.8, 0.6… of 5)
        if (!celState.has(id)) celState.set(id, { tint: tint(color), fade: 1 - (distance - 1) / count });
      }
    };
    walk(-1, onion.prevFramesCount, onion.prevColor);
    walk(1, onion.nextFramesCount, onion.nextColor);
  }

  // A tinted cel folder tints everything inside it
  const tintOf = new Map<string, number>();
  const tintTree = (id: string, t: number) => {
    for (const c of children.get(id) ?? []) {
      tintOf.set(c.id, t);
      tintTree(c.id, t);
    }
  };
  for (const [id, s] of celState) if (s.tint !== undefined) tintTree(id, s.tint);

  // Export scope: layers outside the chosen folders are hidden
  let allowed: Set<string> | null = null;
  if (view?.only) {
    allowed = new Set();
    const add = (id: string) => {
      allowed!.add(id);
      for (const c of children.get(id) ?? []) add(c.id);
    };
    for (const id of view.only) add(id);
  }

  const opacity = view?.onion?.opacity ?? 0.35;
  return layers.map((l) => {
    const m = worldTransforms?.get(l.id);
    const withTransform = m && !m.isIdentity ? { renderTransform: m } : null;
    if (allowed && !allowed.has(l.id) && l.layerType !== 'group') {
      return withTransform ? { ...l, isVisible: false, ...withTransform } : { ...l, isVisible: false };
    }
    const state = celState.get(l.id);
    if (hidden.has(l.id) && !state) {
      return withTransform ? { ...l, isVisible: false, ...withTransform } : { ...l, isVisible: false };
    }
    if (state?.light !== undefined) {
      if (!l.isVisible) return withTransform ? { ...l, ...withTransform } : l;
      return { ...l, opacity: l.opacity * state.light, ...withTransform };
    }
    if (state?.tint !== undefined) {
      if (!l.isVisible) return withTransform ? { ...l, ...withTransform } : l;
      const faded = opacity * (state.fade ?? 1);
      return l.layerType === 'group'
        ? { ...l, opacity: faded, ...withTransform }
        : { ...l, opacity: faded, onionTint: state.tint, ...withTransform };
    }
    const inherited = tintOf.get(l.id);
    if (inherited !== undefined && l.layerType !== 'group' && l.layerType !== 'mask') {
      return { ...l, onionTint: inherited, ...withTransform };
    }
    return withTransform ? { ...l, ...withTransform } : l;
  });
}

const ONION_KEY = 'atelier_onion_skin';
const LOOP_KEY = 'atelier_anim_loop';

/**
 * This viewer's player: the frame on screen, playback, playback range and onion skin are their
 * own (as in CSP); the cels and their timing are layers, synced like any layer.
 */
export class AnimationEngine {
  private fps = 12;
  private playing = false;
  private loop = true;
  private time = 0;
  private length = 1;
  private range: { start: number; end: number } | null = null;
  private playTimer: ReturnType<typeof setInterval> | null = null;

  private onionSkinConfig: OnionSkinConfig = {
    enabled: true,
    prevColor: '#ef4444',
    nextColor: '#10b981',
    opacity: 0.35,
    prevFramesCount: 1,
    nextFramesCount: 1,
  };

  // byUser: the viewer moved (timeline, playback); false when the timeline changed under them
  private onFrameChangeListeners: Array<(time: number, byUser: boolean) => void> = [];
  private onPlaybackStateChangeListeners: Array<(isPlaying: boolean) => void> = [];

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(ONION_KEY) || 'null');
      if (saved && typeof saved === 'object') this.onionSkinConfig = AnimationEngine.cleanOnion({ ...this.onionSkinConfig, ...saved });
      this.loop = localStorage.getItem(LOOP_KEY) !== '0';
    } catch {
      // storage blocked: defaults
    }
  }

  private static cleanOnion(c: OnionSkinConfig): OnionSkinConfig {
    const count = (n: number) => Math.max(0, Math.min(MAX_ONION, Math.round(Number(n) || 0)));
    return {
      enabled: Boolean(c.enabled),
      prevColor: /^#[0-9a-f]{6}$/i.test(c.prevColor) ? c.prevColor : '#ef4444',
      nextColor: /^#[0-9a-f]{6}$/i.test(c.nextColor) ? c.nextColor : '#10b981',
      opacity: Math.max(0.05, Math.min(0.9, Number(c.opacity) || 0.35)),
      prevFramesCount: count(c.prevFramesCount),
      nextFramesCount: count(c.nextFramesCount),
    };
  }

  public getFps(): number {
    return this.fps;
  }

  public setFps(fps: number) {
    const next = Math.max(1, Math.min(60, Math.round(fps) || 12));
    if (next === this.fps) return;
    this.fps = next;
    if (this.playing) {
      this.pause();
      this.play();
    }
  }

  /** Timeline length in frames (the longest track); keeps the frame on screen where possible */
  public setLength(frames: number) {
    const next = Math.max(1, Math.round(frames) || 1);
    if (next === this.length) return;
    this.length = next;
    if (this.range && this.range.start >= next) this.range = null;
    else if (this.range) this.range = { start: this.range.start, end: Math.min(this.range.end, next - 1) };
    if (this.time >= next + TIMELINE_SLACK) {
      this.time = next - 1;
      this.notifyFrameChange(false);
    }
  }

  public getLength(): number {
    return this.length;
  }

  public getTime(): number {
    return this.time;
  }

  public getIsPlaying(): boolean {
    return this.playing;
  }

  /** Playback loops inside the range (both ends included); null = the whole timeline */
  public getRange() {
    return this.range ? { ...this.range } : null;
  }

  public setRange(range: { start: number; end: number } | null) {
    if (!range) this.range = null;
    else {
      const a = Math.max(0, Math.min(this.length - 1, Math.round(range.start)));
      const b = Math.max(0, Math.min(this.length - 1, Math.round(range.end)));
      this.range = { start: Math.min(a, b), end: Math.max(a, b) };
    }
    this.notifyFrameChange(false);
  }

  public getOnionSkinConfig(): OnionSkinConfig {
    return { ...this.onionSkinConfig };
  }

  public setOnionSkinConfig(config: Partial<OnionSkinConfig>) {
    this.onionSkinConfig = AnimationEngine.cleanOnion({ ...this.onionSkinConfig, ...config });
    try {
      localStorage.setItem(ONION_KEY, JSON.stringify(this.onionSkinConfig));
    } catch {
      // storage blocked: kept for this session
    }
    this.notifyFrameChange(false); // the canvas redraws the neighbouring cels
  }

  public togglePlay() {
    if (this.playing) this.pause();
    else this.play();
  }

  public play() {
    const span = this.range ? this.range.end - this.range.start + 1 : this.length;
    if (this.playing || span < 2) return;
    if (this.range && (this.time < this.range.start || this.time > this.range.end)) this.goTo(this.range.start);
    else if (this.time >= (this.range?.end ?? this.length - 1)) this.goTo(this.range?.start ?? 0); // from the top again
    this.playing = true;
    this.notifyPlaybackState();
    this.playTimer = setInterval(() => this.tick(), 1000 / this.fps);
  }

  public pause() {
    if (!this.playing) return;
    this.playing = false;
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
    this.notifyPlaybackState();
  }

  private tick() {
    const start = this.range?.start ?? 0;
    const end = this.range?.end ?? this.length - 1;
    if (this.time + 1 <= end) this.goTo(this.time + 1);
    else if (this.loop) this.goTo(start);
    else this.pause(); // played once: stays on the last frame
  }

  /** Loop playback (CSP 重複播放); off, playback stops on the last frame. This viewer's own */
  public getLoop(): boolean {
    return this.loop;
  }

  public setLoop(loop: boolean) {
    this.loop = loop;
    try {
      localStorage.setItem(LOOP_KEY, loop ? '1' : '0');
    } catch {
      // storage blocked: kept for this session
    }
    this.notifyPlaybackState();
  }

  /** First / last frame of the playback range (the whole timeline without one) */
  public goToStart() {
    this.goTo(this.range?.start ?? 0);
  }

  public goToEnd() {
    this.goTo(this.range?.end ?? this.length - 1);
  }

  public goToNextFrame() {
    this.goTo(this.time + 1 >= this.length ? 0 : this.time + 1);
  }

  public goToPrevFrame() {
    this.goTo(this.time - 1 < 0 ? this.length - 1 : this.time - 1);
  }

  /** Also past the end (up to TIMELINE_SLACK frames): a frame to put a cel on. Playback stays inside the length */
  public goTo(time: number) {
    this.time = Math.max(0, Math.min(Math.round(time) || 0, this.length - 1 + TIMELINE_SLACK));
    this.notifyFrameChange(true);
  }

  public onFrameChange(cb: (time: number, byUser: boolean) => void) {
    this.onFrameChangeListeners.push(cb);
    return () => {
      this.onFrameChangeListeners = this.onFrameChangeListeners.filter((l) => l !== cb);
    };
  }

  public onPlaybackStateChange(cb: (isPlaying: boolean) => void) {
    this.onPlaybackStateChangeListeners.push(cb);
    return () => {
      this.onPlaybackStateChangeListeners = this.onPlaybackStateChangeListeners.filter((l) => l !== cb);
    };
  }

  private notifyFrameChange(byUser: boolean) {
    for (const cb of this.onFrameChangeListeners) cb(this.time, byUser);
  }

  private notifyPlaybackState() {
    for (const cb of this.onPlaybackStateChangeListeners) cb(this.playing);
  }

  public destroy() {
    this.pause();
    this.onFrameChangeListeners = [];
    this.onPlaybackStateChangeListeners = [];
  }
}
