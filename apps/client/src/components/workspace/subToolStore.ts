import { useSyncExternalStore } from 'react';
import type { ToolType } from '@atelier/shared';
import { ALL_SUB_TOOLS, TOOL_CATEGORIES, findCategory, findSubTool, findSubToolForTool } from './toolCatalog';
import type { SubToolDef, SubToolId, SubToolParams, ToolCategoryId } from './toolCatalog';

export const SUB_TOOL_STORAGE_KEY = 'atelier_subtool_state_v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type ToolRailMode = 'compact' | 'classic';

export interface SubToolStoreState {
  activeCategoryId: ToolCategoryId;
  activeSubToolId: SubToolId;
  lastSubToolByCategory: Record<ToolCategoryId, SubToolId>;
  paramsBySubTool: Partial<Record<SubToolId, SubToolParams>>;
  railMode: ToolRailMode;
}

export interface SubToolStore {
  getState(): SubToolStoreState;
  subscribe(listener: () => void): () => void;
  selectCategory(categoryId: ToolCategoryId): SubToolDef;
  selectSubTool(subToolId: SubToolId): SubToolDef;
  activateCategoryShortcut(categoryId: ToolCategoryId): SubToolDef;
  syncFromToolType(tool: ToolType, hint?: Parameters<typeof findSubToolForTool>[1]): SubToolDef | undefined;
  getSubToolParams(subToolId: SubToolId): SubToolParams;
  updateSubToolParams(subToolId: SubToolId, patch: Partial<SubToolParams>): SubToolParams;
  resetSubToolParams(subToolId: SubToolId): SubToolParams;
  setRailMode(mode: ToolRailMode): void;
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

function loadState(storage: StorageLike | undefined): SubToolStoreState {
  let saved: Record<string, unknown> = {};
  try {
    const raw = storage?.getItem(SUB_TOOL_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    if (isRecord(parsed)) saved = parsed;
  } catch {
    // A blocked read or invalid JSON falls back to the catalog defaults.
  }

  const savedLast = isRecord(saved.lastSubToolByCategory) ? saved.lastSubToolByCategory : {};
  const legacyShape = savedLast.shape === 'shape' || savedLast.shape === 'text' ? savedLast.shape : undefined;
  const lastSubToolByCategory = Object.fromEntries(TOOL_CATEGORIES.map((category) => {
    const savedId = category.id === 'comic' && legacyShape ? legacyShape : savedLast[category.id];
    const last = category.subTools.find((subTool) => subTool.id === savedId);
    return [category.id, last?.id ?? category.defaultSubToolId];
  })) as SubToolStoreState['lastSubToolByCategory'];

  const savedSubTool = typeof saved.activeSubToolId === 'string' ? findSubTool(saved.activeSubToolId) : undefined;
  const savedCategory = TOOL_CATEGORIES.find((category) => category.id === saved.activeCategoryId);
  const activeCategoryId = saved.activeCategoryId === 'shape'
    ? 'comic'
    : savedSubTool?.categoryId ?? savedCategory?.id ?? 'paint';
  const activeSubToolId = savedSubTool?.categoryId === activeCategoryId
    ? savedSubTool.id
    : lastSubToolByCategory[activeCategoryId];
  lastSubToolByCategory[activeCategoryId] = activeSubToolId;

  const savedParams = isRecord(saved.paramsBySubTool) ? saved.paramsBySubTool : {};
  const paramsBySubTool: SubToolStoreState['paramsBySubTool'] = {};
  for (const subTool of ALL_SUB_TOOLS) {
    const params = savedParams[subTool.id];
    if (isRecord(params)) paramsBySubTool[subTool.id] = params;
  }

  return {
    activeCategoryId,
    activeSubToolId,
    lastSubToolByCategory,
    paramsBySubTool,
    railMode: saved.railMode === 'classic' ? 'classic' : 'compact',
  };
}

function requireSubTool(subToolId: SubToolId): SubToolDef {
  const subTool = findSubTool(subToolId);
  if (!subTool) throw new RangeError(`Unknown sub-tool: ${subToolId}`);
  return subTool;
}

export function createSubToolStore(storage: StorageLike | undefined = getDefaultStorage()): SubToolStore {
  let state = loadState(storage);
  const listeners = new Set<() => void>();

  function commit(next: SubToolStoreState): void {
    state = next;
    try {
      storage?.setItem(SUB_TOOL_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Keep the in-memory state usable when storage is unavailable.
    }
    listeners.forEach((listener) => listener());
  }

  function activateSubTool(subTool: SubToolDef): SubToolDef {
    const { categoryId, id } = subTool;
    if (state.activeSubToolId !== id) {
      commit({
        ...state,
        activeCategoryId: categoryId,
        activeSubToolId: id,
        lastSubToolByCategory: { ...state.lastSubToolByCategory, [categoryId]: id },
      });
    }
    return subTool;
  }

  function selectSubTool(subToolId: SubToolId): SubToolDef {
    return activateSubTool(requireSubTool(subToolId));
  }

  function selectCategory(categoryId: ToolCategoryId): SubToolDef {
    return selectSubTool(state.lastSubToolByCategory[categoryId]);
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    selectCategory,
    selectSubTool,
    activateCategoryShortcut(categoryId) {
      if (categoryId !== state.activeCategoryId) return selectCategory(categoryId);
      const category = findCategory(categoryId);
      if (!category) throw new RangeError(`Unknown tool category: ${categoryId}`);
      const index = category.subTools.findIndex((subTool) => subTool.id === state.activeSubToolId);
      return activateSubTool(category.subTools[(index + 1) % category.subTools.length]);
    },
    syncFromToolType(tool, hint) {
      const subTool = findSubToolForTool(tool, hint);
      return subTool && activateSubTool(subTool);
    },
    getSubToolParams(subToolId) {
      const subTool = findSubTool(subToolId);
      return subTool ? { ...subTool.defaultParams, ...state.paramsBySubTool[subToolId] } : {};
    },
    updateSubToolParams(subToolId, patch) {
      const subTool = requireSubTool(subToolId);
      const params = { ...state.paramsBySubTool[subToolId], ...patch };
      commit({ ...state, paramsBySubTool: { ...state.paramsBySubTool, [subToolId]: params } });
      return { ...subTool.defaultParams, ...params };
    },
    resetSubToolParams(subToolId) {
      const subTool = requireSubTool(subToolId);
      if (state.paramsBySubTool[subToolId]) {
        const paramsBySubTool = { ...state.paramsBySubTool };
        delete paramsBySubTool[subToolId];
        commit({ ...state, paramsBySubTool });
      }
      return { ...subTool.defaultParams };
    },
    setRailMode(mode) {
      if (mode !== state.railMode) commit({ ...state, railMode: mode });
    },
  };
}

export const subToolStore = createSubToolStore();

export function useSubToolStore(): SubToolStoreState {
  return useSyncExternalStore(subToolStore.subscribe, subToolStore.getState, subToolStore.getState);
}
