import { useSyncExternalStore } from 'react';
import type { StorageLike } from '../components/workspace/subToolStore';
import { normalizeHexColor, type PaletteSwatch } from '../utils/colorPaletteIO.ts';

export const COLOR_HISTORY_STORAGE_KEY = 'atelier_color_history_v1';
export const COLOR_HISTORY_MAX = 32;

export const DEFAULT_RECENT_COLORS = [
  '#000000', '#FFFFFF', '#EF4444', '#F97316', '#FBBF24', '#10B981',
  '#06B6D4', '#3B82F6', '#8B5CF6', '#EC4899', '#78350F', '#475569',
] as const;

export interface PinnedColorSet {
  id: string;
  name: string;
  colors: PaletteSwatch[];
}

export interface ColorHistoryState {
  history: string[];
  pinnedSets: PinnedColorSet[];
  activeSetId: string;
}

function getDefaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanSwatches(colors: readonly unknown[]): PaletteSwatch[] {
  const swatches = new Map<string, PaletteSwatch>();
  for (const color of colors) {
    const input = typeof color === 'string' ? color : isRecord(color) ? color.hex : undefined;
    if (typeof input !== 'string') continue;
    const hex = normalizeHexColor(input);
    if (!hex || swatches.has(hex)) continue;
    const name = isRecord(color) && typeof color.name === 'string' ? color.name.trim() : undefined;
    swatches.set(hex, name ? { hex, name } : { hex });
  }
  return [...swatches.values()];
}

function loadState(storage: StorageLike | undefined): ColorHistoryState {
  let saved: Record<string, unknown> = {};
  try {
    const raw = storage?.getItem(COLOR_HISTORY_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    if (isRecord(parsed)) saved = parsed;
  } catch {
    // Storage and JSON failures leave the defaults available in memory.
  }

  const pinnedSets: PinnedColorSet[] = [];
  const ids = new Set<string>();
  if (Array.isArray(saved.pinnedSets)) {
    for (const set of saved.pinnedSets) {
      if (!isRecord(set) || typeof set.id !== 'string' || !set.id.trim() || ids.has(set.id)) continue;
      ids.add(set.id);
      pinnedSets.push({
        id: set.id,
        name: (typeof set.name === 'string' && set.name.trim()) || 'Untitled Palette',
        colors: Array.isArray(set.colors) ? cleanSwatches(set.colors) : [],
      });
    }
  }
  if (pinnedSets.length === 0) {
    pinnedSets.push({
      id: 'default-favorites',
      name: 'Favorites',
      colors: DEFAULT_RECENT_COLORS.map((hex) => ({ hex })),
    });
  }

  return {
    history: Array.isArray(saved.history)
      ? cleanSwatches(saved.history.filter((hex) => typeof hex === 'string')).slice(0, COLOR_HISTORY_MAX).map(({ hex }) => hex)
      : [...DEFAULT_RECENT_COLORS],
    pinnedSets,
    activeSetId: pinnedSets.find((set) => set.id === saved.activeSetId)?.id ?? pinnedSets[0].id,
  };
}

export function createColorHistoryStore(storage: StorageLike | undefined = getDefaultStorage()) {
  let state = loadState(storage);
  let nextSetNumber = 1;
  const listeners = new Set<() => void>();

  function commit(next: ColorHistoryState): void {
    state = next;
    try {
      storage?.setItem(COLOR_HISTORY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Keep the current session usable if storage is unavailable or full.
    }
    listeners.forEach((listener) => listener());
  }

  function setActiveSet(setId: string): void {
    if (setId !== state.activeSetId && state.pinnedSets.some((set) => set.id === setId)) {
      commit({ ...state, activeSetId: setId });
    }
  }

  function addSet(name: string, colors: PaletteSwatch[]): PinnedColorSet {
    let id = `palette-${nextSetNumber++}`;
    while (state.pinnedSets.some((set) => set.id === id)) id = `palette-${nextSetNumber++}`;
    const set = { id, name, colors };
    commit({ ...state, pinnedSets: [...state.pinnedSets, set], activeSetId: id });
    return set;
  }

  function getActiveSet(): PinnedColorSet {
    return state.pinnedSets.find((set) => set.id === state.activeSetId) ?? state.pinnedSets[0];
  }

  function updateSetColors(set: PinnedColorSet, colors: PaletteSwatch[]): void {
    const pinnedSets = state.pinnedSets.map((entry) => entry === set ? { ...set, colors } : entry);
    commit({ ...state, pinnedSets });
  }

  return {
    getState: (): ColorHistoryState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    recordColor(input: string): string | null {
      const hex = normalizeHexColor(input);
      if (hex && state.history[0] !== hex) {
        const history = [hex, ...state.history.filter((color) => color !== hex)].slice(0, COLOR_HISTORY_MAX);
        commit({ ...state, history });
      }
      return hex;
    },
    clearHistory(): void {
      if (state.history.length > 0) commit({ ...state, history: [] });
    },
    setActiveSet,
    createPinnedSet(name: string, colors: ReadonlyArray<PaletteSwatch | string> = []): PinnedColorSet {
      return addSet(name.trim() || 'Untitled Palette', cleanSwatches(colors));
    },
    deletePinnedSet(setId: string): boolean {
      if (state.pinnedSets.length <= 1) return false;
      const pinnedSets = state.pinnedSets.filter((set) => set.id !== setId);
      if (pinnedSets.length === state.pinnedSets.length) return false;
      const activeSetId = state.activeSetId === setId ? pinnedSets[0].id : state.activeSetId;
      commit({ ...state, pinnedSets, activeSetId });
      return true;
    },
    pinColorToActiveSet(input: string, name?: string): boolean {
      const hex = normalizeHexColor(input);
      const set = getActiveSet();
      if (!hex || set.colors.some((color) => color.hex === hex)) return false;
      const swatchName = name?.trim();
      updateSetColors(set, [...set.colors, swatchName ? { hex, name: swatchName } : { hex }]);
      return true;
    },
    unpinColorFromActiveSet(input: string): boolean {
      const hex = normalizeHexColor(input);
      if (!hex) return false;
      const set = getActiveSet();
      const colors = set.colors.filter((color) => color.hex !== hex);
      if (colors.length === set.colors.length) return false;
      updateSetColors(set, colors);
      return true;
    },
    importPaletteSet(name: string, colors: ReadonlyArray<PaletteSwatch | string>): PinnedColorSet {
      const setName = name.trim() || 'Imported Palette';
      const swatches = cleanSwatches(colors);
      const existing = state.pinnedSets.find((set) => (
        set.name === setName && set.colors.length === swatches.length &&
        set.colors.every((swatch, index) => swatch.hex === swatches[index].hex && swatch.name === swatches[index].name)
      ));
      if (!existing) return addSet(setName, swatches);
      setActiveSet(existing.id);
      return existing;
    },
  };
}

export const colorHistoryStore = createColorHistoryStore();

export function recordUsedColor(hex: string): string | null {
  return colorHistoryStore.recordColor(hex);
}

export function useColorHistoryState(): ColorHistoryState {
  return useSyncExternalStore(colorHistoryStore.subscribe, colorHistoryStore.getState, colorHistoryStore.getState);
}
