import { useSyncExternalStore } from 'react';
import { useMediaQuery } from './useMediaQuery';
import { getUiScale, onUiRescale } from '../../theme/uiScale';

/**
 * Panel docking layout (CSP / Krita style): every panel lives in the left, right or bottom dock,
 * or floats as a resizable window. Shared by the top bar's 視窗 menu and the workspace.
 */
export type ToolDockPanelId = 'filters' | 'align';
export type PanelId = 'color' | 'subView' | 'autoActions' | 'brushToolset' | 'toolProps' | 'layers' | 'members' | 'oplog' | 'quickKeys' | ToolDockPanelId;
export const isToolDockPanel = (id: PanelId): id is ToolDockPanelId => id === 'filters' || id === 'align';
export type DockSide = 'left' | 'right' | 'bottom';
export type PanelPlace = DockSide | 'float';

export interface FloatRect { x: number; y: number; w: number; h: number }
export type FloatPillOrientation = 'horizontal' | 'vertical';
export interface FloatPillPos { x: number; y: number }
export interface FloatGroupState {
  minimized: boolean;
  orientation: FloatPillOrientation;
  pillPos: FloatPillPos | null;
}

export const DEFAULT_FLOAT_GROUP_STATE: FloatGroupState = {
  minimized: false,
  orientation: 'horizontal',
  pillPos: null,
};

export interface PanelLayout {
  visible: boolean;
  place: PanelPlace;
  collapsed: boolean;
  /** Share of the dock's length (flex-grow) when several panels are expanded in one dock */
  weight: number;
  float: FloatRect;
  /** Floating panels with the same group share one window, as tabs (CSP-style); the group's first panel holds the window rect */
  group: string;
}

export interface DockLayoutState {
  version: number;
  panels: Record<PanelId, PanelLayout>;
  order: PanelId[];
  dockSize: Record<DockSide, number>;
  /** The tab shown in each group */
  activeTab: Record<string, PanelId>;
  floatGroups: Record<string, FloatGroupState>;
  /** Tablets / Samsung DeX: allow floating windows on a touch screen (phones never float) */
  desktopMode: boolean;
  /** Which edge the tool rail and the size / opacity sliders sit on (left-handed painters move them right) */
  railSide: 'left' | 'right';
  /** Width in pixels of the brush size / opacity sliders strip */
  slidersWidth: number;
  /** Width in pixels of the vertical tool rail (buttons reflow into more/fewer columns) */
  toolRailWidth: number;
}

export const SLIDERS_WIDTH_MIN = 36;
export const SLIDERS_WIDTH_MAX = 120;
export const TOOL_RAIL_WIDTH_MIN = 42;
export const TOOL_RAIL_WIDTH_MAX = 220;

const clampNum = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)));

export const PANEL_IDS: PanelId[] = ['color', 'subView', 'autoActions', 'brushToolset', 'toolProps', 'layers', 'members', 'oplog', 'quickKeys'];
const LAYOUT_PANEL_IDS: PanelId[] = [...PANEL_IDS, 'filters', 'align'];

const LAYOUT_VERSION = 5;
const STORAGE_KEY = 'atelier_dock_layout';

const ownValue = <T,>(record: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;

export const getFloatGroupState = (layout: DockLayoutState, group: string): FloatGroupState =>
  ownValue(layout.floatGroups, group) ?? DEFAULT_FLOAT_GROUP_STATE;

const defaultLayout = (): DockLayoutState => ({
  version: LAYOUT_VERSION,
  panels: {
    color: { visible: true, place: 'right', collapsed: false, weight: 1.28, float: { x: 120, y: 120, w: 280, h: 430 }, group: 'color' },
    subView: { visible: false, place: 'left', collapsed: false, weight: 1, float: { x: 100, y: 120, w: 300, h: 360 }, group: 'subView' },
    autoActions: { visible: false, place: 'left', collapsed: false, weight: 1, float: { x: 120, y: 140, w: 300, h: 420 }, group: 'autoActions' },
    brushToolset: { visible: true, place: 'right', collapsed: false, weight: 1, float: { x: 160, y: 140, w: 280, h: 420 }, group: 'toolProps' },
    toolProps: { visible: true, place: 'right', collapsed: false, weight: 1, float: { x: 160, y: 140, w: 280, h: 420 }, group: 'toolProps' },
    layers: { visible: true, place: 'right', collapsed: false, weight: 1.05, float: { x: 200, y: 160, w: 300, h: 460 }, group: 'layers' },
    members: { visible: false, place: 'float', collapsed: false, weight: 1, float: { x: -1, y: 96, w: 280, h: 340 }, group: 'members' },
    oplog: { visible: false, place: 'bottom', collapsed: false, weight: 1, float: { x: 240, y: 200, w: 320, h: 260 }, group: 'oplog' },
    // CSP's edge keyboard: big shortcut buttons, off until opened from 視窗
    quickKeys: { visible: false, place: 'left', collapsed: false, weight: 1, float: { x: 80, y: 140, w: 240, h: 320 }, group: 'quickKeys' },
    filters: { visible: false, place: 'float', collapsed: false, weight: 1, float: { x: -352, y: 96, w: 340, h: 420 }, group: 'filters' },
    align: { visible: false, place: 'float', collapsed: false, weight: 1, float: { x: -304, y: 132, w: 280, h: 420 }, group: 'align' },
  },
  order: [...LAYOUT_PANEL_IDS],
  dockSize: { left: 260, right: 300, bottom: 190 },
  activeTab: {},
  floatGroups: {},
  desktopMode: false,
  railSide: 'left',
  slidersWidth: 44,
  toolRailWidth: 46,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const roundPillPos = ({ x, y }: FloatPillPos): FloatPillPos => ({ x: Math.round(x), y: Math.round(y) });

const normalizePillPos = (value: unknown): FloatPillPos | null => {
  if (!isRecord(value)) return null;
  const { x, y } = value;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return roundPillPos({ x, y });
};

const normalizeFloatGroups = (value: unknown): DockLayoutState['floatGroups'] => {
  if (!isRecord(value)) return {};
  const groups: [string, FloatGroupState][] = [];
  for (const [group, entry] of Object.entries(value)) {
    if (!group.trim() || !isRecord(entry)) continue;
    groups.push([group, {
      minimized: Boolean(entry.minimized),
      orientation: entry.orientation === 'vertical' ? 'vertical' : 'horizontal',
      pillPos: normalizePillPos(entry.pillPos),
    }]);
  }
  return Object.fromEntries(groups);
};

export const loadDockLayout = (storage?: Pick<Storage, 'getItem'>): DockLayoutState => {
  try {
    const raw = (storage ?? localStorage).getItem(STORAGE_KEY);
    if (!raw) return scaledLayout(defaultLayout(), getUiScale());
    const parsed = JSON.parse(raw) as Omit<DockLayoutState, 'floatGroups'> & { floatGroups?: unknown };
    if (parsed.version !== 4 && parsed.version !== LAYOUT_VERSION) return scaledLayout(defaultLayout(), getUiScale());
    const base = defaultLayout();
    const scale = getUiScale();
    const mergedPanels = { ...base.panels, ...parsed.panels };
    const order = parsed.order.filter((id) => LAYOUT_PANEL_IDS.includes(id));
    if (!parsed.panels.brushToolset) {
      const props = mergedPanels.toolProps;
      mergedPanels.brushToolset = { ...base.panels.brushToolset, place: props.place, group: props.group, float: props.float };
      order.splice(Math.max(0, order.indexOf('toolProps')), 0, 'brushToolset');
    }
    // Ensure color wheel panel preserves enough vertical space for HLS/HSV toggle + transparent swatch
    if (mergedPanels.color) {
      mergedPanels.color = {
        ...mergedPanels.color,
        weight: Math.max(1.22, mergedPanels.color.weight || 1.28),
        float: {
          ...mergedPanels.color.float,
          h: Math.max(Math.round(410 * scale), mergedPanels.color.float?.h || 430),
        },
      };
    }
    // Panels added in later versions get their defaults
    return {
      ...base,
      ...parsed,
      version: LAYOUT_VERSION,
      panels: mergedPanels,
      order: [...order, ...LAYOUT_PANEL_IDS.filter((id) => !order.includes(id))],
      dockSize: { ...base.dockSize, ...parsed.dockSize },
      activeTab: parsed.activeTab ?? {},
      floatGroups: parsed.version === LAYOUT_VERSION ? normalizeFloatGroups(parsed.floatGroups) : {},
      desktopMode: Boolean(parsed.desktopMode),
      railSide: parsed.railSide === 'right' ? 'right' : 'left',
      slidersWidth: Number.isFinite(parsed.slidersWidth)
        ? clampNum(parsed.slidersWidth, SLIDERS_WIDTH_MIN * scale, SLIDERS_WIDTH_MAX * scale)
        : Math.round(base.slidersWidth * scale),
      toolRailWidth: Number.isFinite(parsed.toolRailWidth)
        ? clampNum(parsed.toolRailWidth, TOOL_RAIL_WIDTH_MIN * scale, TOOL_RAIL_WIDTH_MAX * scale)
        : Math.round(base.toolRailWidth * scale),
    };
  } catch {
    return scaledLayout(defaultLayout(), getUiScale());
  }
};

let state: DockLayoutState = typeof window === 'undefined' ? defaultLayout() : loadDockLayout();
const listeners = new Set<() => void>();

const commit = (next: DockLayoutState) => {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the layout just is not remembered
  }
  listeners.forEach((l) => l());
};

const patchPanel = (id: PanelId, patch: Partial<PanelLayout>) =>
  commit({ ...state, panels: { ...state.panels, [id]: { ...state.panels[id], ...patch } } });

const isFloatMember = (panel: PanelLayout | undefined, group: string) =>
  panel?.place === 'float' && panel.group === group;

const firstVisibleFloatMember = (panels: DockLayoutState['panels'], order: PanelId[], group: string) =>
  order.find((id) => panels[id].visible && isFloatMember(panels[id], group));

const pruneFloatGroups = (panels: DockLayoutState['panels'], floatGroups: DockLayoutState['floatGroups']) => {
  const occupied = new Set(Object.values(panels).filter((panel) => panel.place === 'float').map((panel) => panel.group));
  return Object.fromEntries(Object.entries(floatGroups).filter(([group]) => occupied.has(group)));
};

const repairSourceActiveTabs = (panels: DockLayoutState['panels'], order: PanelId[], movedIds: PanelId[]) => {
  const activeTab = { ...state.activeTab };
  const sourceGroups = new Map<string, PanelPlace>();
  for (const id of movedIds) {
    const previous = state.panels[id];
    if (previous.group === panels[id].group && previous.place === panels[id].place) continue;
    if (!sourceGroups.has(previous.group) || ownValue(activeTab, previous.group) === id) {
      sourceGroups.set(previous.group, previous.place);
    }
  }
  for (const [group, place] of sourceGroups) {
    const id = ownValue(activeTab, group);
    if (!id) continue;
    const panel = panels[id];
    if (panel?.group === group && panel.place === state.panels[id]?.place) continue;
    const replacement = order.find((member) => panels[member].visible && panels[member].place === place && panels[member].group === group);
    if (replacement) activeTab[group] = replacement;
    else delete activeTab[group];
  }
  return activeTab;
};

const unusedGroupKey = (group: string) => {
  const used = new Set([
    ...Object.values(state.panels).map((panel) => panel.group),
    ...Object.keys(state.floatGroups),
    ...Object.keys(state.activeTab),
  ]);
  let suffix = 1;
  while (used.has(`${group}-${suffix}`)) suffix++;
  return `${group}-${suffix}`;
};

const movePanelToOwnGroup = (id: PanelId, patch: Partial<PanelLayout>, order = state.order, pillState?: FloatGroupState) => {
  const panel = { ...state.panels[id], ...patch, group: id };
  const panels = { ...state.panels, [id]: panel };
  const floatGroups = { ...state.floatGroups };
  const remaining = panel.place === 'float'
    ? order.filter((member) => member !== id && isFloatMember(panels[member], id))
    : [];
  let remainingGroup: string | undefined;
  if (remaining.length) {
    // Free the panel ID for its own window while keeping the existing group together.
    remainingGroup = unusedGroupKey(id);
    for (const member of remaining) panels[member] = { ...panels[member], group: remainingGroup };
    const groupState = ownValue(floatGroups, id);
    if (groupState) floatGroups[remainingGroup] = groupState;
    const oldLeader = firstVisibleFloatMember(state.panels, state.order, id);
    const newLeader = firstVisibleFloatMember(panels, order, remainingGroup) ?? remaining[0];
    if (oldLeader === id) panels[newLeader] = { ...panels[newLeader], float: state.panels[id].float };
  }
  if (panel.place === 'float') {
    const previous = remainingGroup ? DEFAULT_FLOAT_GROUP_STATE : getFloatGroupState(state, id);
    floatGroups[id] = pillState ?? { ...previous, minimized: false };
  }
  const activeTab = repairSourceActiveTabs(panels, order, [id, ...remaining]);
  if (remainingGroup) {
    const previous = ownValue(state.activeTab, id);
    const active = previous && isFloatMember(panels[previous], remainingGroup)
      ? previous
      : firstVisibleFloatMember(panels, order, remainingGroup);
    if (active) activeTab[remainingGroup] = active;
  }
  commit({ ...state, order, panels, activeTab, floatGroups: pruneFloatGroups(panels, floatGroups) });
};

const offsetFloatRect = (id: PanelId, preferVisible = false): FloatRect => {
  const { group } = state.panels[id];
  const visibleLeader = preferVisible ? firstVisibleFloatMember(state.panels, state.order, group) : undefined;
  const leader = visibleLeader ?? state.order.find((member) => isFloatMember(state.panels[member], group)) ?? id;
  const rect = state.panels[leader].float;
  return { ...rect, x: rect.x + 32, y: rect.y + 32 };
};

const patchFloatGroup = (group: string, patch: Partial<FloatGroupState>) => {
  const groupState = getFloatGroupState(state, group);
  commit({ ...state, floatGroups: { ...state.floatGroups, [group]: { ...groupState, ...patch } } });
};

const expandFloatGroup = (group: string, activePanelId?: PanelId) => {
  const groupState = getFloatGroupState(state, group);
  const floatGroups = { ...state.floatGroups, [group]: { ...groupState, minimized: false } };
  if (!activePanelId || !isFloatMember(state.panels[activePanelId], group)) {
    commit({ ...state, floatGroups });
    return;
  }
  const panels = { ...state.panels, [activePanelId]: { ...state.panels[activePanelId], visible: true, collapsed: false } };
  const leader = firstVisibleFloatMember(state.panels, state.order, group);
  if (leader) panels[leader] = { ...panels[leader], collapsed: false };
  commit({ ...state, panels, activeTab: { ...state.activeTab, [group]: activePanelId }, floatGroups });
};

const showPanel = (id: PanelId) => {
  const panel = state.panels[id];
  if (panel.place === 'float' && getFloatGroupState(state, panel.group).minimized) expandFloatGroup(panel.group, id);
  else patchPanel(id, { visible: true, collapsed: false });
};

const mergePanelsInto = (ids: PanelId[], target: PanelId, options?: { keepTargetMinimized?: boolean; activeId?: PanelId }) => {
  const group = state.panels[target].group;
  const uniqueIds = [...new Set(ids)];
  const moved = uniqueIds.filter((id) => !isFloatMember(state.panels[id], group));
  const others = state.order.filter((id) => !moved.includes(id));
  const lastTab = others.reduce((at, id, index) => isFloatMember(state.panels[id], group) ? index : at, -1);
  const order = [...others.slice(0, lastTab + 1), ...moved, ...others.slice(lastTab + 1)];
  const panels = { ...state.panels };
  for (const id of moved) panels[id] = { ...panels[id], place: 'float', visible: true, collapsed: false, group };

  const current = getFloatGroupState(state, group);
  const floatGroups = {
    ...state.floatGroups,
    [group]: { ...current, minimized: options?.keepTargetMinimized ?? current.minimized },
  };
  const activeTab = repairSourceActiveTabs(panels, order, moved);
  const selected = options?.activeId ?? uniqueIds[0] ?? target;
  const previous = ownValue(activeTab, group);
  const active = isFloatMember(panels[selected], group)
    ? selected
    : previous && isFloatMember(panels[previous], group)
      ? previous
      : firstVisibleFloatMember(panels, order, group);
  commit({
    ...state,
    order,
    panels,
    activeTab: active ? { ...activeTab, [group]: active } : activeTab,
    floatGroups: pruneFloatGroups(panels, floatGroups),
  });
};

export const dockActions = {
  toggle: (id: PanelId) => {
    if (state.panels[id].visible) patchPanel(id, { visible: false, collapsed: false });
    else showPanel(id);
  },
  show: showPanel,
  hide: (id: PanelId) => patchPanel(id, { visible: false }),
  setCollapsed: (id: PanelId, collapsed: boolean) => patchPanel(id, { collapsed }),
  minimizeFloatGroup: (group: string, pillPos?: FloatPillPos) => {
    const current = getFloatGroupState(state, group);
    const leader = firstVisibleFloatMember(state.panels, state.order, group);
    const rect = leader ? state.panels[leader].float : undefined;
    const position = pillPos ?? current.pillPos ?? (rect && rect.x >= 0 && rect.y >= 0 ? rect : undefined);
    patchFloatGroup(group, { minimized: true, pillPos: normalizePillPos(position) });
  },
  expandFloatGroup,
  setFloatGroupOrientation: (group: string, orientation: FloatPillOrientation) => patchFloatGroup(group, { orientation }),
  toggleFloatGroupOrientation: (group: string) => {
    const { orientation } = getFloatGroupState(state, group);
    patchFloatGroup(group, { orientation: orientation === 'horizontal' ? 'vertical' : 'horizontal' });
  },
  setFloatGroupPillPos: (group: string, pillPos: FloatPillPos) => patchFloatGroup(group, { pillPos: roundPillPos(pillPos) }),
  moveTo: (id: PanelId, place: PanelPlace) => {
    // Moving to a dock appends the panel at the end of that dock; floating, it gets a window of its own
    const order = [...state.order.filter((p) => p !== id), id];
    movePanelToOwnGroup(id, { place, visible: true, collapsed: false }, order);
  },
  /** Puts a panel into the floating window that holds `target`, as a tab, and shows it */
  mergeInto: (id: PanelId, target: PanelId) => mergePanelsInto([id], target),
  mergePanelsInto,
  /** Takes a tab out of its floating window into a window of its own, a little offset */
  detach: (id: PanelId) => movePanelToOwnGroup(id, { float: offsetFloatRect(id) }),
  detachToPill: (id: PanelId, pillPos: FloatPillPos, orientation?: FloatPillOrientation) => {
    movePanelToOwnGroup(id, { place: 'float', visible: true, collapsed: false, float: offsetFloatRect(id, true) }, state.order, {
      minimized: true,
      orientation: orientation ?? 'horizontal',
      pillPos: roundPillPos(pillPos),
    });
  },
  /**
   * Docks panels (a dragged panel, or every tab of a dragged window) into a dock, before the panel
   * that is `index`-th among that dock's visible panels (past the end = at the bottom / right end).
   */
  dockAt: (ids: PanelId[], side: DockSide, index: number) => {
    const others = state.order.filter((p) => !ids.includes(p));
    const inDock = others.filter((p) => state.panels[p].visible && state.panels[p].place === side);
    const anchor = inDock[index];
    const at = anchor ? others.indexOf(anchor) : (inDock.length ? others.indexOf(inDock[inDock.length - 1]) + 1 : others.length);
    const order = [...others.slice(0, at), ...ids, ...others.slice(at)];
    const panels = { ...state.panels };
    for (const id of ids) panels[id] = { ...panels[id], place: side, visible: true, collapsed: false, group: id };
    commit({ ...state, order, panels, activeTab: repairSourceActiveTabs(panels, order, ids), floatGroups: pruneFloatGroups(panels, state.floatGroups) });
  },
  /** Takes a panel out (of a dock or a tabbed window) into a floating window of its own at `rect` */
  floatAt: (id: PanelId, rect: FloatRect) => {
    const order = [...state.order.filter((p) => p !== id), id];
    movePanelToOwnGroup(id, { place: 'float', visible: true, collapsed: false, float: rect }, order);
  },
  setActiveTab: (group: string, id: PanelId) => commit({ ...state, activeTab: { ...state.activeTab, [group]: id } }),
  activate: (id: PanelId) => {
    const panel = state.panels[id];
    if (panel.place === 'float' && getFloatGroupState(state, panel.group).minimized) {
      expandFloatGroup(panel.group, id);
      return;
    }
    const panels = { ...state.panels, [id]: { ...panel, visible: true, collapsed: false } };
    const leader = state.order.find((p) => panels[p].visible && panels[p].place === panel.place && panels[p].group === panel.group);
    if (leader) panels[leader] = { ...panels[leader], collapsed: false };
    commit({ ...state, panels, activeTab: { ...state.activeTab, [panel.group]: id } });
  },
  setDesktopMode: (desktopMode: boolean) => commit({ ...state, desktopMode }),
  setRailSide: (railSide: 'left' | 'right') => commit({ ...state, railSide }),
  /** Left and right docks trade places (the whole panel column moves to the other side) */
  swapDocks: () => {
    const panels = { ...state.panels };
    for (const id of LAYOUT_PANEL_IDS) {
      const place = panels[id].place;
      if (place === 'left' || place === 'right') panels[id] = { ...panels[id], place: place === 'left' ? 'right' : 'left' };
    }
    commit({ ...state, panels, dockSize: { ...state.dockSize, left: state.dockSize.right, right: state.dockSize.left } });
  },
  setFloat: (id: PanelId, float: FloatRect) => patchPanel(id, { float }),
  setWeights: (weights: Partial<Record<PanelId, number>>) => {
    const panels = { ...state.panels };
    for (const [id, weight] of Object.entries(weights) as Array<[PanelId, number]>) {
      panels[id] = { ...panels[id], weight };
    }
    commit({ ...state, panels });
  },
  setDockSize: (side: DockSide, size: number) => commit({ ...state, dockSize: { ...state.dockSize, [side]: size } }),
  setSlidersWidth: (slidersWidth: number) => {
    const ui = getUiScale();
    commit({ ...state, slidersWidth: clampNum(slidersWidth, SLIDERS_WIDTH_MIN * ui, SLIDERS_WIDTH_MAX * ui) });
  },
  setToolRailWidth: (toolRailWidth: number) => {
    const ui = getUiScale();
    commit({ ...state, toolRailWidth: clampNum(toolRailWidth, TOOL_RAIL_WIDTH_MIN * ui, TOOL_RAIL_WIDTH_MAX * ui) });
  },
  reset: () => commit(scaledLayout(defaultLayout(), getUiScale())),
};

/** Dock widths and floating window sizes are pixels: they grow / shrink with 介面縮放 */
function scaledLayout(s: DockLayoutState, factor: number): DockLayoutState {
  if (factor === 1) return s;
  const panels = { ...s.panels };
  for (const id of LAYOUT_PANEL_IDS) {
    const f = panels[id].float;
    panels[id] = { ...panels[id], float: { ...f, w: Math.round(f.w * factor), h: Math.round(f.h * factor) } };
  }
  const dockSize = { left: Math.round(s.dockSize.left * factor), right: Math.round(s.dockSize.right * factor), bottom: Math.round(s.dockSize.bottom * factor) };
  const slidersWidth = Math.round((s.slidersWidth || 44) * factor);
  const toolRailWidth = Math.round((s.toolRailWidth || 78) * factor);
  return { ...s, panels, dockSize, slidersWidth, toolRailWidth };
}
onUiRescale((factor) => commit(scaledLayout(state, factor)));

export const getDockLayout = () => state;

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export const useDockLayout = () => useSyncExternalStore(subscribe, getDockLayout, getDockLayout);

const TOUCH_UNDER_1280 = '(pointer: coarse) and (max-width: 1279px)';
/** A phone's shorter screen side is under 600 CSS px, in portrait and landscape alike. */
const isPhoneScreen = () => typeof window !== 'undefined' && Math.min(window.screen.width, window.screen.height) < 600;

/**
 * Phone layout (bottom tool bar, panels as sheets). A phone keeps it when turned sideways and
 * switches to the desktop layout only through 桌面模式, in either orientation. Other screens use
 * it below 768 px wide.
 */
export const usePhoneLayout = () => {
  const layout = useDockLayout();
  const narrow = useMediaQuery('(max-width: 767px)');
  const touchLandscape = useMediaQuery('(any-pointer: coarse) and (max-height: 599px) and (orientation: landscape) and (max-width: 1100px)');
  return isPhoneScreen() || touchLandscape ? !layout.desktopMode : narrow;
};

/**
 * Floating windows need room and a precise pointer: on a touch screen narrower than 1280 px
 * floating panels dock on the right unless 桌面模式 is on. A Samsung DeX desktop has a mouse,
 * so it floats freely.
 */
export const useFloatsAllowed = () => {
  const layout = useDockLayout();
  const touchUnder1280 = useMediaQuery(TOUCH_UNDER_1280);
  return layout.desktopMode || !touchUnder1280;
};

/**
 * Touch tablet canvas-first layout: active on touch tablets (`(pointer: coarse)` under 1280px)
 * when not in 桌面模式 and not already using phone layout. Never active on desktop/mouse screens.
 */
export const useTouchTabletLayout = () => {
  const layout = useDockLayout();
  const phone = usePhoneLayout();
  const touchUnder1280 = useMediaQuery(TOUCH_UNDER_1280);
  return !layout.desktopMode && !phone && touchUnder1280;
};

/** True when either phone layout or non-desktop touch tablet canvas-first mode is active. */
export const useTouchCanvasMode = () => {
  const phone = usePhoneLayout();
  const tablet = useTouchTabletLayout();
  return phone || tablet;
};

/** 桌面模式 matters on phones (layout) and touch tablets (floating); a mouse screen never needs it. */
export const useDesktopModeAvailable = () => useMediaQuery(TOUCH_UNDER_1280) || isPhoneScreen();

export const PANEL_TITLES: Record<PanelId, string> = {
  brushToolset: '筆刷工具集',
  color: '色彩',
  subView: '子視圖',
  autoActions: '自動動作',
  toolProps: '工具屬性',
  layers: '圖層',
  members: '成員',
  oplog: '操作日誌',
  quickKeys: '快捷鍵面板',
  filters: '濾鏡',
  align: '對齊',
};
