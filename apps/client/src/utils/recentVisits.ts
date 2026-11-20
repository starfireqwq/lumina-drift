/**
 * Where the artist last painted, so the gateway can offer a one-tap way back
 * (with a preview) instead of making them pick the mode, the server and the room again.
 * Stored per browser in localStorage; a room that is gone is only discovered when checked.
 */
export type VisitMode = 'offline' | 'online';

export interface RecentVisit {
  mode: VisitMode;
  /** Server origin of an online room; absent for solo canvases */
  server?: string;
  canvasId: string;
  title: string;
  width: number;
  height: number;
  at: number;
}

export const RECENT_VISITS_KEY = 'atelier_recent_visits';
export const RECENT_VISITS_LIMIT = 12;

/** One spelling per server: `localhost` and `127.0.0.1` on the same port are the same machine. */
export function normalizeServer(server: string | undefined): string | undefined {
  if (!server) return undefined;
  try {
    const url = new URL(server);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return url.origin;
  } catch {
    return undefined;
  }
}

const sameRoom = (a: RecentVisit, b: RecentVisit) =>
  a.mode === b.mode && (a.server ?? '') === (b.server ?? '') && a.canvasId === b.canvasId;

const isVisit = (value: unknown): value is RecentVisit => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (v.mode === 'offline' || (v.mode === 'online' && typeof v.server === 'string' && normalizeServer(v.server) === v.server))
    && typeof v.canvasId === 'string' && v.canvasId.length > 0
    && typeof v.title === 'string'
    && typeof v.width === 'number' && typeof v.height === 'number'
    && typeof v.at === 'number';
};

export function parseRecentVisits(raw: string | null): RecentVisit[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isVisit).slice(0, RECENT_VISITS_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Newest first; visiting a room again moves it to the front instead of adding a copy. */
export function addRecentVisit(list: RecentVisit[], visit: RecentVisit): RecentVisit[] {
  const { server, ...rest } = visit;
  const origin = normalizeServer(server);
  if (visit.mode === 'online' && !origin) return list;
  const entry: RecentVisit = visit.mode === 'online' ? { ...rest, server: origin } : rest;
  return [entry, ...list.filter((v) => !sameRoom(v, entry))].slice(0, RECENT_VISITS_LIMIT);
}

export function removeRecentVisit(list: RecentVisit[], visit: RecentVisit): RecentVisit[] {
  return list.filter((v) => !sameRoom(v, visit));
}

/** The room last opened on this server, for preselecting it in the room list. */
export function lastVisitOn(list: RecentVisit[], server: string | undefined): RecentVisit | undefined {
  const origin = normalizeServer(server);
  return origin ? list.find((v) => v.mode === 'online' && v.server === origin) : undefined;
}

export function loadRecentVisits(): RecentVisit[] {
  try {
    return parseRecentVisits(localStorage.getItem(RECENT_VISITS_KEY));
  } catch {
    return [];
  }
}

const saveRecentVisits = (list: RecentVisit[]) => {
  try {
    localStorage.setItem(RECENT_VISITS_KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked: the shortcut is a convenience */
  }
};

/** Called whenever a canvas opens; skips the write when nothing changed. */
export function recordRecentVisit(visit: Omit<RecentVisit, 'at'>, now = Date.now()): void {
  const list = loadRecentVisits();
  const next = addRecentVisit(list, { ...visit, at: now });
  const [head] = list;
  const [fresh] = next;
  if (head && fresh && sameRoom(head, fresh) && head.title === fresh.title && head.width === fresh.width && head.height === fresh.height) return;
  saveRecentVisits(next);
}

export function forgetRecentVisit(visit: RecentVisit): RecentVisit[] {
  const next = removeRecentVisit(loadRecentVisits(), visit);
  saveRecentVisits(next);
  return next;
}
