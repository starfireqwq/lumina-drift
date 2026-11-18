import type { CanvasModel } from '@atelier/shared';

export type CanvasGroupInfo = NonNullable<CanvasModel['group']>;

export type CanvasListEntry =
  | { kind: 'canvas'; canvas: CanvasModel }
  | { kind: 'group'; group: CanvasGroupInfo; canvases: CanvasModel[] };

const COLLAPSED_GROUPS_KEY = 'atelier_collapsed_canvas_groups';

/**
 * Groups canvases sharing the same `canvas.group.id` into collapsible folder entries
 * at the position of the group's first canvas, while preserving standalone canvases.
 */
export function buildCanvasGroupEntries(canvases: readonly CanvasModel[]): CanvasListEntry[] {
  const entries: CanvasListEntry[] = [];
  const groupMap = new Map<string, { kind: 'group'; group: CanvasGroupInfo; canvases: CanvasModel[] }>();

  for (const canvas of canvases) {
    if (!canvas.group) {
      entries.push({ kind: 'canvas', canvas });
      continue;
    }
    const existing = groupMap.get(canvas.group.id);
    if (existing) {
      existing.canvases.push(canvas);
    } else {
      const groupEntry = { kind: 'group' as const, group: canvas.group, canvases: [canvas] };
      groupMap.set(canvas.group.id, groupEntry);
      entries.push(groupEntry);
    }
  }

  return entries;
}

export function loadCollapsedCanvasGroups(): Set<string> {
  try {
    if (typeof localStorage === 'undefined') return new Set();
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

export function saveCollapsedCanvasGroups(ids: Iterable<string>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // Ignore storage quota or privacy mode errors
  }
}

export function toggleCollapsedCanvasGroup(current: ReadonlySet<string>, groupId: string): Set<string> {
  const next = new Set(current);
  if (next.has(groupId)) {
    next.delete(groupId);
  } else {
    next.add(groupId);
  }
  return next;
}
