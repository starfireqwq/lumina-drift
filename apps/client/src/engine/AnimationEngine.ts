import {
  Affine2D,
  CelMark,
  IDENTITY_AFFINE,
  TimelineLabel,
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
  /** A reused cel: the layer it shows ('' = nothing: a blank frame, or its cel was deleted) */
  ref?: string;
  /** A blank frame put on the timeline on purpose (meta.cel.ref = ''), not a reuse of a deleted cel */
  blank?: boolean;
  /** Key drawing (○) or inbetween (●) badge */
  mark?: CelMark;
  /** Optional short memo for this cel */
  note?: string;
  ownerId: string | null;
  isGroup: boolean;
}

export interface AnimationTrack {
  folderId: string;
  name: string;
  ownerId: string | null;
  shared: boolean;
  entries: CelEntry[];
  /** Shared timeline frame labels stored on the folder's meta.animation.labels */
  labels?: TimelineLabel[];
}

/**
 * How onion skin draws the neighbouring drawings: one flat colour (`tint`), the colour shaded by the
 * drawing's own lights and darks (`shade`), or the drawing as it is, only fainter (`original`)
 */
export type OnionMode = 'tint' | 'shade' | 'original';
export const ONION_MODES: readonly OnionMode[] = ['tint', 'shade', 'original'];

export interface OnionSkinConfig {
  enabled: boolean;
  prevColor: string;
  nextColor: string;
  opacity: number; // 0.05 to 0.9
  prevFramesCount: number; // 0 to MAX_ONION
  nextFramesCount: number;
  /** Missing = 'tint' (settings saved before there was a choice) */
  mode?: OnionMode;
}

/** Longest timeline that can be set (250 s at 24 FPS) */
export const MAX_TIMELINE_FRAMES = 6000;
/** A cel can stay on screen for the whole timeline */
export const MAX_HOLD = MAX_TIMELINE_FRAMES;
export const MAX_ONION = 10;
/** Max frames to each side when flipbooking (hold-to-flip) */
export const MAX_FLIP_SPAN = 5;
/** Frames past the end of the longest track that the playhead can be put on (to place cels there) */
export const TIMELINE_SLACK = 24;
/** Layer name of a blank frame (the timeline draws it as ×) */
export const BLANK_CEL_NAME = '×';

type AnimLayer = {
  id: string;
  parentId: string | null;
  layerType: string;
  sortOrder: number;
  isVisible: boolean;
  opacity: number;
  name?: string;
  ownerId?: string | null;
  meta?: {
    animation?: { fps?: number; shared?: boolean; length?: number; labels?: TimelineLabel[] } | unknown;
    cel?: { hold?: number; ref?: string; mark?: CelMark; note?: string };
    keyframes?: TransformKeyframe[];
  } | null;
};

/** Sanitize and sort timeline labels by frame (deduplicating same frame, last wins) */
export function normalizeTimelineLabels(list: ReadonlyArray<TimelineLabel> | undefined | null): TimelineLabel[] {
  if (!Array.isArray(list) || list.length === 0) return [];
  const byFrame = new Map<number, string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const frame = Math.round(Number(item.frame));
    if (!Number.isFinite(frame) || frame < 0 || frame >= MAX_TIMELINE_FRAMES) continue;
    const text = typeof item.text === 'string' ? item.text.trim().slice(0, 40) : '';
    if (!text) continue;
    byFrame.set(frame, text);
  }
  return [...byFrame.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([frame, text]) => ({ frame, text }));
}

export function upsertTimelineLabel(
  list: ReadonlyArray<TimelineLabel> | undefined | null,
  frame: number,
  text: string,
): TimelineLabel[] {
  const f = Math.max(0, Math.min(MAX_TIMELINE_FRAMES - 1, Math.round(frame)));
  const cleaned = text.trim().slice(0, 40);
  const rest = normalizeTimelineLabels(list).filter((l) => l.frame !== f);
  if (!cleaned) return rest;
  return normalizeTimelineLabels([...rest, { frame: f, text: cleaned }]);
}

export function removeTimelineLabel(
  list: ReadonlyArray<TimelineLabel> | undefined | null,
  frame: number,
): TimelineLabel[] {
  const f = Math.round(frame);
  return normalizeTimelineLabels(list).filter((l) => l.frame !== f);
}

export interface RepeatCelPlanItem {
  /** '' for blank frame, otherwise the real cel layer id to reference */
  ref: string;
  hold: number;
  blank?: boolean;
  /** Display name for the created ref group layer */
  name: string;
}

export interface RepeatCelPlan {
  items: RepeatCelPlanItem[];
  /** Total timeline frames covered by the original selected run plus all repeated items */
  totalFrames: number;
  /** Number of extra frames added by the repeated items */
  addedFrames: number;
  /** Whether the plan was capped by maxItems */
  capped: boolean;
}

export const MAX_REPEAT_CREATED_ITEMS = 200;

/**
 * Computes the extra ref/blank entries needed to repeat a selected sequence of cels.
 * - mode 'count': total cycles including the original selection (e.g. 4 cels × count 3 = 12 frames, adding 2 cycles = 8 items).
 * - mode 'toEnd': repeats until `targetEndFrame` (timeline length), trimming the last item's hold if needed.
 */
export function planRepeatCels(
  allEntries: ReadonlyArray<CelEntry>,
  selectedIds: ReadonlyArray<string>,
  opts: { mode: 'count' | 'toEnd'; count?: number; targetEndFrame?: number; maxItems?: number },
): RepeatCelPlan {
  const idSet = new Set(selectedIds);
  const picked: Array<{ entry: CelEntry; index: number }> = [];
  allEntries.forEach((entry, index) => {
    if (idSet.has(entry.id)) picked.push({ entry, index });
  });
  if (picked.length === 0) return { items: [], totalFrames: 0, addedFrames: 0, capped: false };

  const byId = new Map(allEntries.map((e) => [e.id, e]));
  const template = picked.map(({ entry }) => {
    const targetId = celLayerOf(entry);
    if (!targetId) {
      return { ref: '', hold: entry.hold, blank: true, name: BLANK_CEL_NAME };
    }
    const targetLabel = byId.get(targetId)?.label || entry.label || '1';
    return { ref: targetId, hold: entry.hold, name: `↻ ${targetLabel}` };
  });
  const baseFrames = template.reduce((sum, item) => sum + item.hold, 0);
  const maxItems = Math.max(1, opts.maxItems ?? MAX_REPEAT_CREATED_ITEMS);
  const items: RepeatCelPlanItem[] = [];
  let addedFrames = 0;
  let capped = false;

  if (opts.mode === 'count') {
    const cycles = Math.max(1, Math.min(100, Math.round(opts.count ?? 2)));
    const extraCycles = cycles - 1;
    for (let c = 0; c < extraCycles; c++) {
      for (const tpl of template) {
        if (items.length >= maxItems) {
          capped = true;
          break;
        }
        items.push({ ...tpl });
        addedFrames += tpl.hold;
      }
      if (capped) break;
    }
  } else {
    const lastIdx = picked[picked.length - 1].index;
    const afterStart = entryStart(allEntries as CelEntry[], lastIdx) + picked[picked.length - 1].entry.hold;
    const targetEnd = Math.max(afterStart, Math.min(MAX_TIMELINE_FRAMES, Math.round(opts.targetEndFrame ?? afterStart)));
    let remaining = targetEnd - afterStart;
    let cursor = 0;
    while (remaining > 0) {
      if (items.length >= maxItems) {
        capped = true;
        break;
      }
      const tpl = template[cursor % template.length];
      const hold = Math.min(tpl.hold, remaining);
      items.push({ ...tpl, hold });
      addedFrames += hold;
      remaining -= hold;
      cursor++;
    }
  }

  return {
    items,
    totalFrames: baseFrames + addedFrames,
    addedFrames,
    capped,
  };
}

export interface SequentialRenamePlan {
  renames: Array<{ id: string; name: string }>;
  skippedOthers: number;
}

/**
 * Plans sequential cel renames (1, 2, 3...) following timeline appearance order.
 * Applies to raster and folder cels alike; skips blank frames and ref entries for numbering,
 * while keeping editable ref labels synced (`↻ <newName>`). Other painters' cels are skipped.
 */
export function planSequentialCelRenames(
  entries: ReadonlyArray<CelEntry>,
  canEdit: (entryId: string) => boolean,
): SequentialRenamePlan {
  const renames: Array<{ id: string; name: string }> = [];
  const newNameById = new Map<string, string>();
  let skippedOthers = 0;
  let seq = 0;

  for (const e of entries) {
    if (e.ref !== undefined || e.blank) continue;
    seq += 1;
    const desired = String(seq);
    if (!canEdit(e.id)) {
      skippedOthers += 1;
      newNameById.set(e.id, e.label);
      continue;
    }
    newNameById.set(e.id, desired);
    if (e.label !== desired) renames.push({ id: e.id, name: desired });
  }

  for (const e of entries) {
    if (!e.ref || e.blank) continue;
    if (!canEdit(e.id)) continue;
    const targetName = newNameById.get(e.ref);
    if (!targetName) continue;
    const desired = `↻ ${targetName}`;
    if (e.label !== desired) renames.push({ id: e.id, name: desired });
  }

  return { renames, skippedOthers };
}

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

/** Previous (-1) or next (+1) keyframe frame number strictly before/after `currentFrame`, or null */
export function adjacentKeyframeFrame(
  list: ReadonlyArray<TransformKeyframe> | undefined | null,
  currentFrame: number,
  direction: -1 | 1,
): number | null {
  if (!list?.length) return null;
  const cur = Math.round(currentFrame);
  const frames = [...new Set(list.map((k) => Math.round(k.frame)))].sort((a, b) => a - b);
  if (direction < 0) {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i] < cur) return frames[i];
    }
    return null;
  }
  for (let i = 0; i < frames.length; i++) {
    if (frames[i] > cur) return frames[i];
  }
  return null;
}

/**
 * Finds the previous/next keyframe frame: prefers the active layer's own keyframes,
 * falling back to all keyed layers when the active layer has none.
 */
export function findAdjacentKeyframe(
  layers: ReadonlyArray<AnimLayer>,
  activeLayerId: string | null | undefined,
  currentFrame: number,
  direction: -1 | 1,
): number | null {
  const active = activeLayerId ? layers.find((l) => l.id === activeLayerId) : undefined;
  if (active?.meta?.keyframes?.length) {
    return adjacentKeyframeFrame(active.meta.keyframes, currentFrame, direction);
  }
  const all: TransformKeyframe[] = [];
  for (const l of layers) {
    if (l.meta?.keyframes?.length) all.push(...l.meta.keyframes);
  }
  return adjacentKeyframeFrame(all, currentFrame, direction);
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
    const blank = cel?.ref === '' ? { blank: true } : null;
    const mark: CelMark | undefined = cel?.mark === 'key' || cel?.mark === 'inbetween' ? cel.mark : undefined;
    const note = typeof cel?.note === 'string' && cel.note.trim() ? cel.note.trim().slice(0, 120) : undefined;
    return {
      id: l.id,
      label: l.name ?? '',
      hold,
      ref,
      ...blank,
      ...(mark ? { mark } : null),
      ...(note ? { note } : null),
      ownerId: l.ownerId ?? null,
      isGroup: l.layerType === 'group',
    };
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

/**
 * Where playback is `elapsedMs` after it left `startFrame`, counted from the clock rather than from
 * timer ticks: a late tick skips to where the animation should be instead of drifting behind.
 * Plays `first`–`last` (both included); `ended` = a play that does not loop reached `last`.
 */
export function playbackFrame(
  startFrame: number,
  elapsedMs: number,
  fps: number,
  first: number,
  last: number,
  loop: boolean
): { frame: number; ended: boolean } {
  const steps = Math.max(0, Math.floor((elapsedMs * Math.max(1, fps)) / 1000 + 1e-6));
  const target = startFrame + steps;
  if (target <= last) return { frame: target, ended: false };
  if (!loop) return { frame: last, ended: true };
  const span = Math.max(1, last - first + 1);
  return { frame: first + ((((target - first) % span) + span) % span), ended: false };
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
  /**
   * Drawing on this layer: it and the groups around it are shown where they were drawn (their own
   * keyframes left out), so a stroke lands under the pen; playback and export still move them
   */
  original?: string | null;
}

/** The layer, or a group around it, has keyframes: on screen it may sit somewhere else than where it is drawn */
export function movedByKeyframes(layers: ReadonlyArray<AnimLayer>, layerId: string | null | undefined): boolean {
  const byId = new Map<string, AnimLayer>();
  for (const l of layers) byId.set(l.id, l);
  let cur = layerId ? byId.get(layerId) : undefined;
  for (let depth = 0; cur && depth < 32; depth++) {
    if (cur.meta?.keyframes?.length) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
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
): Array<T & { onionTint?: number; onionMode?: 'shade'; renderTransform?: Affine2D; renderOpacityApplied?: boolean }> {
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

  // Evaluate hierarchical transform & opacity keyframes (parent groups cascade cleanly onto children)
  const worldTransforms = hasKeyframes ? new Map<string, Affine2D>() : null;
  const localOpacities = hasKeyframes ? new Map<string, number>() : null;
  if (worldTransforms) {
    const defaultPx = canvasWidth / 2;
    const defaultPy = canvasHeight / 2;
    const localMap = new Map<string, Affine2D>();
    // Drawing on a layer: its own keyframes and those of the groups around it are left out
    const unmoved = new Set<string>();
    for (let id = view?.original ?? null, depth = 0; id && depth < 32; depth++) {
      unmoved.add(id);
      id = byId.get(id)?.parentId ?? null;
    }
    for (const l of layers) {
      const kfs = l.meta?.keyframes;
      if (kfs && kfs.length > 0 && !unmoved.has(l.id)) {
        const evaluated = evaluateTransformKeyframes(kfs, time, defaultPx, defaultPy);
        localMap.set(l.id, transformToAffineMatrix(evaluated));
        if (evaluated.opacity !== 1) localOpacities!.set(l.id, evaluated.opacity);
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
        // The nearest drawing at the set opacity, each one further away fainter (1, 0.8, 0.6… of 5).
        // 'original' only fades it: no colour, so no filter to run
        if (!celState.has(id)) celState.set(id, { tint: onion.mode === 'original' ? undefined : tint(color), fade: 1 - (distance - 1) / count });
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
  const shade = view?.onion?.mode === 'shade' ? ({ onionMode: 'shade' } as const) : null;
  return layers.map((l) => {
    const m = worldTransforms?.get(l.id);
    const kfOpacity = localOpacities?.get(l.id);
    const baseOpacity = kfOpacity === undefined ? l.opacity : Math.max(0, Math.min(1, l.opacity * kfOpacity));
    const withTransform = m && !m.isIdentity ? { renderTransform: m } : null;
    const withOpacity = kfOpacity === undefined ? null : { opacity: baseOpacity, renderOpacityApplied: true as const };
    const withKf = withTransform || withOpacity ? { ...withTransform, ...withOpacity } : null;
    if (allowed && !allowed.has(l.id) && l.layerType !== 'group') {
      return withKf ? { ...l, isVisible: false, ...withKf } : { ...l, isVisible: false };
    }
    const state = celState.get(l.id);
    if (hidden.has(l.id) && !state) {
      return withKf ? { ...l, isVisible: false, ...withKf } : { ...l, isVisible: false };
    }
    if (state?.light !== undefined) {
      if (!l.isVisible) return withKf ? { ...l, ...withKf } : l;
      return { ...l, ...withKf, opacity: baseOpacity * state.light };
    }
    if (state?.fade !== undefined) {
      if (!l.isVisible) return withKf ? { ...l, ...withKf } : l;
      const faded = opacity * state.fade * (kfOpacity ?? 1);
      return l.layerType === 'group' || state.tint === undefined
        ? { ...l, ...withKf, opacity: faded }
        : { ...l, ...withKf, opacity: faded, onionTint: state.tint, ...shade };
    }
    const inherited = tintOf.get(l.id);
    if (inherited !== undefined && l.layerType !== 'group' && l.layerType !== 'mask') {
      return { ...l, onionTint: inherited, ...shade, ...withKf };
    }
    return withKf ? { ...l, ...withKf } : l;
  });
}

/**
 * One frame's picture as a string, for telling frames apart: every layer really on screen (it and
 * every group around it shown) with its opacity and keyframe transform. Same string = same picture.
 */
export function frameSignature(list: ReadonlyArray<AnimLayer & { renderTransform?: Affine2D }>): string {
  const byId = new Map<string, AnimLayer>();
  for (const l of list) byId.set(l.id, l);
  const shown = new Map<string, boolean>();
  const isShown = (l: AnimLayer, depth: number): boolean => {
    const known = shown.get(l.id);
    if (known !== undefined) return known;
    const parent = l.parentId ? byId.get(l.parentId) : undefined;
    const on = l.isVisible && (!parent || depth > 32 || isShown(parent, depth + 1));
    shown.set(l.id, on);
    return on;
  };
  let s = '';
  for (const l of list) {
    if (!isShown(l, 0)) continue;
    s += `${l.id}:${l.opacity.toFixed(3)}`;
    const m = l.renderTransform;
    if (m && !m.isIdentity) s += `@${m.a.toFixed(4)},${m.b.toFixed(4)},${m.c.toFixed(4)},${m.d.toFixed(4)},${m.tx.toFixed(2)},${m.ty.toFixed(2)}`;
    s += '|';
  }
  return s;
}

/**
 * GIF / video frames from `start` to `end`: one segment per distinct picture, so a held drawing is
 * one longer frame, while a drawing that only moves by keyframes gets a frame for every step.
 * `only`: the animation folders being exported (null = everything).
 */
export function exportSegments<T extends AnimLayer>(
  layers: T[],
  start: number,
  end: number,
  only: Set<string> | null,
  canvasWidth: number,
  canvasHeight: number
): Array<{ time: number; hold: number }> {
  const segments: Array<{ time: number; hold: number }> = [];
  let keyAt: (t: number) => string;
  if (layers.some((l) => l.meta?.keyframes?.length)) {
    keyAt = (t) => frameSignature(animationDisplay(layers, { time: t, activeFolderId: null, onion: null, only }, canvasWidth, canvasHeight));
  } else {
    // Nothing moves by keyframes: the picture changes only where a track's drawing does, so the
    // drawings on screen are the key (a long timeline plans in a few ms, also on a phone)
    const tracks = layers.filter((l) => isAnimationFolder(l) && (!only || only.has(l.id))).map((f) => celEntriesOf(layers, f.id));
    keyAt = (t) => tracks.map((entries) => celLayerOf(entries[entryIndexAt(entries, t)]) ?? '-').join('|');
  }
  let last: string | null = null;
  for (let t = start; t <= end; t++) {
    const key = keyAt(t);
    if (key === last) segments[segments.length - 1].hold++;
    else segments.push({ time: t, hold: 1 });
    last = key;
  }
  return segments;
}

const ONION_KEY = 'atelier_onion_skin';
const LOOP_KEY = 'atelier_anim_loop';
const FLIP_SPAN_KEY = 'atelier_anim_flip_span';
/** A gap between ticks longer than this (a hidden tab gets none) restarts the count instead of jumping ahead */
const RESYNC_AFTER_MS = 500;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
// Display-synced ticks in the app; a timer where there is no screen (scripts)
const requestFrame = (cb: (now: number) => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : (setTimeout(() => cb(nowMs()), 16) as unknown as number);
const cancelFrame = (id: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

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
  /** Pending animation-frame callback while playing (0 = none) */
  private rafId = 0;
  /** Playback counts frames from here: when it (re)started and the frame it was on */
  private clock = { at: 0, frame: 0, lastTick: 0, shown: 0 };
  /** Flipbook (手翻書): frame to return to on release, span N to each side, and active timer */
  private flipOrigin: number | null = null;
  private flipSpan = 2;
  private flipTimer: ReturnType<typeof setInterval> | null = null;

  private onionSkinConfig: OnionSkinConfig = {
    enabled: true,
    prevColor: '#ef4444',
    nextColor: '#10b981',
    opacity: 0.35,
    prevFramesCount: 1,
    nextFramesCount: 1,
    mode: 'tint',
  };

  // byUser: the viewer moved (timeline, playback); false when the timeline changed under them
  private onFrameChangeListeners: Array<(time: number, byUser: boolean) => void> = [];
  private onPlaybackStateChangeListeners: Array<(isPlaying: boolean) => void> = [];

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(ONION_KEY) || 'null');
      if (saved && typeof saved === 'object') this.onionSkinConfig = AnimationEngine.cleanOnion({ ...this.onionSkinConfig, ...saved });
      this.loop = localStorage.getItem(LOOP_KEY) !== '0';
      const savedFlip = Number(localStorage.getItem(FLIP_SPAN_KEY));
      if (Number.isFinite(savedFlip) && savedFlip >= 1) {
        this.flipSpan = Math.max(1, Math.min(MAX_FLIP_SPAN, Math.round(savedFlip)));
      }
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
      mode: ONION_MODES.includes(c.mode as OnionMode) ? c.mode : 'tint',
    };
  }

  public getFps(): number {
    return this.fps;
  }

  public setFps(fps: number) {
    const next = Math.max(1, Math.min(60, Math.round(fps) || 12));
    if (next === this.fps) return;
    this.fps = next;
    // Keeps playing: the new speed counts from the frame on screen
    if (this.playing) this.startClock(nowMs());
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
    this.startClock(nowMs());
    this.scheduleTick();
  }

  public pause() {
    if (!this.playing) return;
    this.playing = false;
    if (this.rafId) {
      cancelFrame(this.rafId);
      this.rafId = 0;
    }
    this.notifyPlaybackState();
  }

  /** Playback counts frames from the frame on screen, now */
  private startClock(now: number) {
    this.clock = { at: now, frame: this.time, lastTick: now, shown: this.time };
  }

  private scheduleTick() {
    if (!this.rafId) this.rafId = requestFrame((now) => {
      this.rafId = 0;
      if (!this.playing) return;
      this.tick(now);
      if (this.playing) this.scheduleTick();
    });
  }

  /**
   * Shows the frame the clock is on. A slow screen skips frames to keep the timing; after a pause
   * in the ticks (a background tab) or a move by hand, playback goes on from the frame on screen.
   */
  private tick(now: number) {
    if (now - this.clock.lastTick > RESYNC_AFTER_MS || this.time !== this.clock.shown) this.startClock(now);
    this.clock.lastTick = now;
    const start = this.range?.start ?? 0;
    const end = this.range?.end ?? this.length - 1;
    const { frame, ended } = playbackFrame(this.clock.frame, now - this.clock.at, this.fps, start, end, this.loop);
    if (frame !== this.time) this.goTo(frame);
    this.clock.shown = this.time;
    if (ended) this.pause(); // played once: stays on the last frame
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

  /** Personal flipbook span N (1..MAX_FLIP_SPAN frames on each side of the current frame) */
  public getFlipSpan(): number {
    return this.flipSpan;
  }

  public setFlipSpan(span: number) {
    const next = Math.max(1, Math.min(MAX_FLIP_SPAN, Math.round(Number(span) || 1)));
    if (next === this.flipSpan) return;
    this.flipSpan = next;
    try {
      localStorage.setItem(FLIP_SPAN_KEY, String(next));
    } catch {
      // storage blocked: kept for this session
    }
    this.notifyFrameChange(false);
  }

  public isFlipping(): boolean {
    return this.flipOrigin !== null;
  }

  /** Peek at `origin + offset` while holding a flip key; call `endFlip()` on release to snap back */
  public flip(offset: number) {
    if (this.playing) this.pause();
    if (this.flipOrigin === null) this.flipOrigin = this.time;
    const target = Math.max(0, Math.min(this.length - 1, this.flipOrigin + Math.round(offset)));
    if (target !== this.time) {
      this.time = target;
      this.notifyFrameChange(true);
    }
  }

  /** Hold-to-flip ping-pong loop between [origin - N, origin + N]; release via `endFlip()` snaps back */
  public startFlipLoop() {
    if (this.flipTimer !== null) return;
    if (this.playing) this.pause();
    if (this.flipOrigin === null) this.flipOrigin = this.time;
    const origin = Math.max(0, Math.min(this.length - 1, this.flipOrigin));
    const lo = Math.max(0, origin - this.flipSpan);
    const hi = Math.min(this.length - 1, origin + this.flipSpan);
    if (lo >= hi) return;
    const seq: number[] = [];
    for (let f = lo; f <= hi; f++) seq.push(f);
    for (let f = hi - 1; f > lo; f--) seq.push(f);
    // Start immediately on a neighbour so holding feels instant
    let idx = seq.indexOf(origin);
    if (idx < 0) idx = 0;
    const step = () => {
      idx = (idx + 1) % seq.length;
      const next = seq[idx];
      if (next !== this.time) {
        this.time = next;
        this.notifyFrameChange(true);
      }
    };
    step();
    const intervalMs = Math.max(40, Math.round(1000 / Math.max(1, this.fps)));
    this.flipTimer = setInterval(step, intervalMs);
  }

  /** End flipbook preview and snap playhead back to where flipping started (no undo record) */
  public endFlip() {
    if (this.flipTimer !== null) {
      clearInterval(this.flipTimer);
      this.flipTimer = null;
    }
    if (this.flipOrigin === null) return;
    const origin = this.flipOrigin;
    this.flipOrigin = null;
    if (this.time !== origin) {
      this.time = Math.max(0, Math.min(origin, this.length - 1 + TIMELINE_SLACK));
      this.notifyFrameChange(true);
    }
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
    this.endFlip();
    this.pause();
    this.onFrameChangeListeners = [];
    this.onPlaybackStateChangeListeners = [];
  }
}
