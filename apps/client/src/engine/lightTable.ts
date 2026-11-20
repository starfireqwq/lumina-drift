/**
 * Light table (CSP 透光桌): cels a painter picks to see faded under the cel they draw, instead of
 * (or together with) onion skin's automatic neighbours. A pick is for one cel, or for every cel of
 * a track. Like onion skin it is the viewer's own aid: kept in this browser per canvas, never in
 * the file or on the server.
 */
export interface LightTableState {
  enabled: boolean;
  /** Opacity of the reference cels, 0.05–1 */
  opacity: number;
  /** Cel id → cels shown under that cel */
  cels: Record<string, string[]>;
  /** Animation folder id → cels shown under every cel of that track */
  tracks: Record<string, string[]>;
}

export type LightTableScope = { kind: 'cel' | 'track'; id: string };

export const MAX_LIGHT_CELS = 12;

export const emptyLightTable = (): LightTableState => ({ enabled: true, opacity: 0.5, cels: {}, tracks: {} });

const storageKey = (canvasId: string) => `atelier_light_table:${canvasId}`;

const idList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 80))].slice(0, MAX_LIGHT_CELS) : [];

const idMap = (v: unknown): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, list] of Object.entries(v as Record<string, unknown>).slice(0, 2000)) {
    const ids = idList(list);
    if (k && ids.length) out[k] = ids;
  }
  return out;
};

export function cleanLightTable(v: unknown): LightTableState {
  const base = emptyLightTable();
  if (!v || typeof v !== 'object' || Array.isArray(v)) return base;
  const o = v as Record<string, unknown>;
  const opacity = Number(o.opacity);
  return {
    enabled: o.enabled === undefined ? base.enabled : Boolean(o.enabled),
    opacity: Number.isFinite(opacity) ? Math.max(0.05, Math.min(1, opacity)) : base.opacity,
    cels: idMap(o.cels),
    tracks: idMap(o.tracks),
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

/** The cels on the light table while `celId` (of track `folderId`) is drawn; empty when switched off */
export function lightIdsFor(state: LightTableState, folderId: string | null, celId: string | null): Set<string> {
  const ids = new Set<string>();
  if (!state.enabled) return ids;
  if (folderId) for (const id of state.tracks[folderId] ?? []) ids.add(id);
  if (celId) for (const id of state.cels[celId] ?? []) ids.add(id);
  if (celId) ids.delete(celId); // the cel being drawn is on screen anyway
  return ids;
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

/** Takes every cel off one light table (CSP 解除所有圖像的登記) */
export function clearLightTable(state: LightTableState, scope: LightTableScope): LightTableState {
  const key = scope.kind === 'cel' ? 'cels' : 'tracks';
  if (!state[key][scope.id]) return state;
  const map = { ...state[key] };
  delete map[scope.id];
  return { ...state, [key]: map };
}

export const lightTableHas = (state: LightTableState, scope: LightTableScope, celId: string) => listOf(state, scope).includes(celId);
