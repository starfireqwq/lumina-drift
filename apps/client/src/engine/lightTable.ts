import { Affine2D, IDENTITY_AFFINE } from '@atelier/shared';

/**
 * Light table (透光桌): cels and local external reference images a painter picks to see faded under
 * the cel they draw, instead of (or together with) onion skin's automatic neighbours.
 * Phase E2 adds per-reference transform (position, scale, rotation, flipX/Y), per-reference opacity
 * and tint/shade coloring, local IndexedDB external image refs, and a pinned edit target lock.
 * Everything stays local per browser per canvas (never uploaded to the server).
 */
export type LightTableTintMode = 'original' | 'tint' | 'shade';

export interface LightTableItemTransform {
  /** Horizontal offset in canvas pixels */
  x: number;
  /** Vertical offset in canvas pixels */
  y: number;
  /** Uniform scale factor (0.1–5) */
  scale: number;
  /** Rotation in degrees (-180..180) */
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  /** Individual opacity multiplier (0.05–1) */
  opacity: number;
  /** Optional tint hex color (e.g. '#38bdf8') when tintMode !== 'original' */
  tint: string | null;
  tintMode: LightTableTintMode;
  visible: boolean;
}

export interface LightTableExternalRef {
  id: string;
  name: string;
  width: number;
  height: number;
  scopeKind: 'cel' | 'track';
  scopeId: string;
}

export interface LightTableState {
  enabled: boolean;
  /** Global opacity multiplier for light table references, 0.05–1 */
  opacity: number;
  /** Cel id → cels shown under that cel */
  cels: Record<string, string[]>;
  /** Animation folder id → cels shown under every cel of that track */
  tracks: Record<string, string[]>;
  /** Per-reference (celId or externalRef.id) local display transform & styling */
  transforms: Record<string, LightTableItemTransform>;
  /** External image references whose binaries live in local IndexedDB */
  externalRefs: LightTableExternalRef[];
  /** Pinned edit target cel id: keeps this cel's light table active even when scrubbing/inspecting */
  pinnedTargetId: string | null;
}

export type LightTableScope = { kind: 'cel' | 'track'; id: string };

export const MAX_LIGHT_CELS = 12;
export const MAX_EXTERNAL_REFS = 12;

export const LIGHT_TABLE_TINT_SWATCHES = [
  '#38bdf8',
  '#34d399',
  '#f59e0b',
  '#f472b6',
  '#a78bfa',
] as const;

export const defaultLightTableTransform = (): LightTableItemTransform => ({
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  flipX: false,
  flipY: false,
  opacity: 1,
  tint: '#38bdf8',
  tintMode: 'original',
  visible: true,
});

export const emptyLightTable = (): LightTableState => ({
  enabled: true,
  opacity: 0.5,
  cels: {},
  tracks: {},
  transforms: {},
  externalRefs: [],
  pinnedTargetId: null,
});

const storageKey = (canvasId: string) => `atelier_light_table:${canvasId}`;

const idList = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 80))].slice(0, MAX_LIGHT_CELS)
    : [];

const idMap = (v: unknown): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, list] of Object.entries(v as Record<string, unknown>).slice(0, 2000)) {
    const ids = idList(list);
    if (k && ids.length) out[k] = ids;
  }
  return out;
};

const clampNum = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

export function cleanLightTableTransform(v: unknown): LightTableItemTransform {
  const base = defaultLightTableTransform();
  if (!v || typeof v !== 'object' || Array.isArray(v)) return base;
  const o = v as Record<string, unknown>;
  const mode = o.tintMode === 'tint' || o.tintMode === 'shade' || o.tintMode === 'original' ? o.tintMode : base.tintMode;
  const tint = typeof o.tint === 'string' && /^#[0-9a-f]{6}$/i.test(o.tint) ? o.tint : base.tint;
  return {
    x: clampNum(o.x, base.x, -16384, 16384),
    y: clampNum(o.y, base.y, -16384, 16384),
    scale: clampNum(o.scale, base.scale, 0.1, 5),
    rotation: clampNum(o.rotation, base.rotation, -180, 180),
    flipX: Boolean(o.flipX),
    flipY: Boolean(o.flipY),
    opacity: clampNum(o.opacity, base.opacity, 0.05, 1),
    tint,
    tintMode: mode,
    visible: o.visible === undefined ? true : Boolean(o.visible),
  };
}

const cleanTransforms = (v: unknown): Record<string, LightTableItemTransform> => {
  const out: Record<string, LightTableItemTransform> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, raw] of Object.entries(v as Record<string, unknown>).slice(0, 500)) {
    if (k && k.length <= 120) out[k] = cleanLightTableTransform(raw);
  }
  return out;
};

const cleanExternalRefs = (v: unknown): LightTableExternalRef[] => {
  if (!Array.isArray(v)) return [];
  const out: LightTableExternalRef[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim().slice(0, 100) : '';
    const scopeId = typeof o.scopeId === 'string' ? o.scopeId.trim().slice(0, 100) : '';
    if (!id || !scopeId || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 120) : 'Reference',
      width: clampNum(o.width, 512, 1, 16384),
      height: clampNum(o.height, 512, 1, 16384),
      scopeKind: o.scopeKind === 'cel' ? 'cel' : 'track',
      scopeId,
    });
    if (out.length >= MAX_EXTERNAL_REFS) break;
  }
  return out;
};

export function cleanLightTable(v: unknown): LightTableState {
  const base = emptyLightTable();
  if (!v || typeof v !== 'object' || Array.isArray(v)) return base;
  const o = v as Record<string, unknown>;
  const opacity = Number(o.opacity);
  const pinnedTargetId =
    typeof o.pinnedTargetId === 'string' && o.pinnedTargetId.trim().length > 0 && o.pinnedTargetId.length <= 100
      ? o.pinnedTargetId
      : null;
  return {
    enabled: o.enabled === undefined ? base.enabled : Boolean(o.enabled),
    opacity: Number.isFinite(opacity) ? Math.max(0.05, Math.min(1, opacity)) : base.opacity,
    cels: idMap(o.cels),
    tracks: idMap(o.tracks),
    transforms: cleanTransforms(o.transforms),
    externalRefs: cleanExternalRefs(o.externalRefs),
    pinnedTargetId,
  };
}

export function loadLightTable(canvasId: string | null | undefined): LightTableState {
  if (!canvasId) return emptyLightTable();
  try {
    return cleanLightTable(JSON.parse(localStorage.getItem(storageKey(canvasId)) || 'null'));
  } catch {
    return emptyLightTable();
  }
}

export function saveLightTable(canvasId: string | null | undefined, state: LightTableState) {
  if (!canvasId) return;
  try {
    localStorage.setItem(storageKey(canvasId), JSON.stringify(state));
  } catch {
    // storage blocked: kept for this session
  }
}

const listOf = (state: LightTableState, scope: LightTableScope) => (scope.kind === 'cel' ? state.cels : state.tracks)[scope.id] ?? [];

/** Returns the effective edit cel id respecting the pinned edit target lock. */
export function resolveLightTableTargetCel(state: LightTableState, currentCelId: string | null): string | null {
  return state.pinnedTargetId || currentCelId;
}

/** The cels on the light table while `celId` (of track `folderId`) is drawn; empty when switched off */
export function lightIdsFor(state: LightTableState, folderId: string | null, celId: string | null): Set<string> {
  const ids = new Set<string>();
  if (!state.enabled) return ids;
  const targetCelId = resolveLightTableTargetCel(state, celId);
  if (folderId) {
    for (const id of state.tracks[folderId] ?? []) {
      if (getLightTableTransform(state, id).visible) ids.add(id);
    }
  }
  if (targetCelId) {
    for (const id of state.cels[targetCelId] ?? []) {
      if (getLightTableTransform(state, id).visible) ids.add(id);
    }
  }
  if (celId) ids.delete(celId); // the cel currently on screen is drawn at full opacity anyway
  return ids;
}

/** All registered cel ids for this track/target regardless of individual visibility switch (for UI listing). */
export function registeredLightCelIdsFor(state: LightTableState, folderId: string | null, celId: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const targetCelId = resolveLightTableTargetCel(state, celId);
  if (folderId) {
    for (const id of state.tracks[folderId] ?? []) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  if (targetCelId) {
    for (const id of state.cels[targetCelId] ?? []) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/** Active external references for the given folder and cel (respecting pinned target lock). */
export function externalRefsFor(
  state: LightTableState,
  folderId: string | null,
  celId: string | null,
  opts?: { visibleOnly?: boolean }
): LightTableExternalRef[] {
  const targetCelId = resolveLightTableTargetCel(state, celId);
  return state.externalRefs.filter((ref) => {
    const match =
      (ref.scopeKind === 'track' && folderId && ref.scopeId === folderId) ||
      (ref.scopeKind === 'cel' && targetCelId && ref.scopeId === targetCelId);
    if (!match) return false;
    if (opts?.visibleOnly && (!state.enabled || !getLightTableTransform(state, ref.id).visible)) return false;
    return true;
  });
}

export function getLightTableTransform(state: LightTableState, refId: string): LightTableItemTransform {
  return state.transforms[refId] ?? defaultLightTableTransform();
}

export function updateLightTableTransform(
  state: LightTableState,
  refId: string,
  patch: Partial<LightTableItemTransform>
): LightTableState {
  const current = getLightTableTransform(state, refId);
  const next = cleanLightTableTransform({ ...current, ...patch });
  return {
    ...state,
    transforms: { ...state.transforms, [refId]: next },
  };
}

export function resetLightTableTransform(state: LightTableState, refId: string): LightTableState {
  if (!state.transforms[refId]) return state;
  const nextTransforms = { ...state.transforms };
  delete nextTransforms[refId];
  return { ...state, transforms: nextTransforms };
}

export function addExternalLightRef(state: LightTableState, ref: LightTableExternalRef): LightTableState {
  const filtered = state.externalRefs.filter((r) => r.id !== ref.id);
  return {
    ...state,
    externalRefs: [...filtered, ref].slice(-MAX_EXTERNAL_REFS),
  };
}

export function removeExternalLightRef(state: LightTableState, refId: string): LightTableState {
  const nextRefs = state.externalRefs.filter((r) => r.id !== refId);
  const nextTransforms = { ...state.transforms };
  delete nextTransforms[refId];
  return {
    ...state,
    externalRefs: nextRefs,
    transforms: nextTransforms,
  };
}

export function setPinnedLightTarget(state: LightTableState, celId: string | null): LightTableState {
  return {
    ...state,
    pinnedTargetId: celId || null,
  };
}

/** Converts a per-reference light-table transform into an Affine2D centered around the canvas midpoint. */
export function lightTableTransformToAffine(
  t: LightTableItemTransform,
  canvasWidth: number,
  canvasHeight: number
): Affine2D {
  const sx = t.scale * (t.flipX ? -1 : 1);
  const sy = t.scale * (t.flipY ? -1 : 1);
  const rad = (t.rotation * Math.PI) / 180;
  if (
    Math.abs(t.x) < 1e-6 &&
    Math.abs(t.y) < 1e-6 &&
    Math.abs(sx - 1) < 1e-6 &&
    Math.abs(sy - 1) < 1e-6 &&
    Math.abs(rad) < 1e-6
  ) {
    return IDENTITY_AFFINE;
  }
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  const px = canvasWidth / 2;
  const py = canvasHeight / 2;
  const tx = px + t.x - (a * px + c * py);
  const ty = py + t.y - (b * px + d * py);
  return { a, b, c, d, tx, ty, isIdentity: false };
}

/** Puts a cel on (or takes it off) the light table of one cel or of a whole track */
export function toggleLightCel(state: LightTableState, scope: LightTableScope, celId: string): LightTableState {
  const list = listOf(state, scope);
  const next = list.includes(celId) ? list.filter((id) => id !== celId) : [...list, celId].slice(-MAX_LIGHT_CELS);
  const key = scope.kind === 'cel' ? 'cels' : 'tracks';
  const map = { ...state[key] };
  if (next.length) map[scope.id] = next;
  else delete map[scope.id];
  return { ...state, [key]: map };
}

/** Takes every cel (and external ref in that scope) off one light table */
export function clearLightTable(state: LightTableState, scope: LightTableScope): LightTableState {
  const key = scope.kind === 'cel' ? 'cels' : 'tracks';
  const map = { ...state[key] };
  delete map[scope.id];
  const externalRefs = state.externalRefs.filter((r) => !(r.scopeKind === scope.kind && r.scopeId === scope.id));
  return { ...state, [key]: map, externalRefs };
}

export const lightTableHas = (state: LightTableState, scope: LightTableScope, celId: string) => listOf(state, scope).includes(celId);
