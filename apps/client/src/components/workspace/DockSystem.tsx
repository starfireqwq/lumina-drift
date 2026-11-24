import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, GripVertical, MoreVertical, PanelBottom, PanelLeft, PanelRight, Square, X } from 'lucide-react';
import { DockSide, dockActions, FloatRect, getDockLayout, isToolDockPanel, PanelId, PanelPlace, PANEL_TITLES, type ToolDockPanelId, useDockLayout, useFloatsAllowed } from './dockStore';
import { getUiScale, useUiScale } from '../../theme/uiScale';
import { useI18n } from '../../context/I18nContext';

export interface PanelDef {
  id: PanelId;
  title: string;
  icon: React.ReactNode;
  render: () => React.ReactNode;
  /** Small badge text next to the title (e.g. member count) */
  badge?: React.ReactNode;
  onClose?: () => void;
}

export function ToolDockSlot({ host }: { host: HTMLElement }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = slot.current;
    node?.appendChild(host);
    return () => {
      if (node && host.parentNode === node) node.removeChild(host);
    };
  }, [host]);
  return <div ref={slot} className="contents" />;
}

const PLACE_OPTIONS: Array<{ place: PanelPlace; label: string; icon: React.ReactNode }> = [
  { place: 'right', label: '停靠右側', icon: <PanelRight className="h-3.5 w-3.5" /> },
  { place: 'left', label: '停靠左側', icon: <PanelLeft className="h-3.5 w-3.5" /> },
  { place: 'bottom', label: '停靠下方', icon: <PanelBottom className="h-3.5 w-3.5" /> },
  { place: 'float', label: '浮動視窗', icon: <Square className="h-3.5 w-3.5" /> },
];

/** Starts a pointer drag that reports the total movement since the press. */
export const startDrag = (
  e: React.PointerEvent,
  onMove: (dx: number, dy: number, ev: PointerEvent) => void,
  onEnd?: (ev: PointerEvent) => void,
) => {
  e.preventDefault();
  e.stopPropagation();
  const target = e.currentTarget as HTMLElement;
  try {
    target.setPointerCapture(e.pointerId);
  } catch {
    // capture can fail if the pointer is already gone
  }
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev: PointerEvent) => onMove(ev.clientX - sx, ev.clientY - sy, ev);
  const up = (ev: PointerEvent) => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
    onEnd?.(ev);
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
};

/* ------------------------------------------------------------------------------------------------
 * Drag-and-drop docking (CSP / Krita style): drag any panel header or tab, or a floating window's
 * title bar. While dragging, the spot it would land on lights up: a dock (with the insertion line),
 * a screen edge (a new dock), another floating window (becomes a tab) or empty space (floats).
 * ---------------------------------------------------------------------------------------------- */

type DragSource =
  | { kind: 'panel'; id: PanelId }
  | { kind: 'group'; group: string; ids: PanelId[] }
  | { kind: 'rail' };

type DropTarget =
  | { kind: 'dock'; side: DockSide; index: number; zone: DOMRect; line?: { x: number; y: number; w: number; h: number } }
  | { kind: 'tab'; group: string; leader: PanelId; zone: DOMRect }
  | { kind: 'float'; rect: FloatRect }
  | { kind: 'rail'; side: 'left' | 'right'; zone: DOMRect };

interface DragState {
  source: DragSource;
  x: number;
  y: number;
  label: string;
  target: DropTarget | null;
}

let drag: DragState | null = null;
const dragListeners = new Set<() => void>();
const setDrag = (next: DragState | null) => {
  drag = next;
  dragListeners.forEach((l) => l());
};
const useDrag = () => useSyncExternalStore(
  (cb) => { dragListeners.add(cb); return () => dragListeners.delete(cb); },
  () => drag,
  () => drag,
);

const EDGE = 56;
const rectOf = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
const box = (x: number, y: number, w: number, h: number) => new DOMRect(x, y, w, h);

/** What lies under the pointer for this drag (null: nowhere to drop, the drag is cancelled) */
const findTarget = (x: number, y: number, source: DragSource, floats: boolean, exclude?: HTMLElement | null): DropTarget | null => {
  const center = rectOf('[data-dock-center]');
  if (source.kind === 'rail') {
    const root = rectOf('[data-dock-root]');
    if (!root) return null;
    const side = x < root.left + root.width / 2 ? 'left' : 'right';
    return { kind: 'rail', side, zone: box(side === 'left' ? root.left : root.right - 88, root.top, 88, root.height) };
  }
  const layout = getDockLayout();
  const moving: PanelId[] = source.kind === 'panel' ? [source.id] : source.ids;
  const dockableTool = source.kind === 'panel' && isToolDockPanel(source.id);
  const myGroup = source.kind === 'group' ? source.group : null;
  // The window being moved must not hide what is under the pointer
  if (exclude) exclude.style.pointerEvents = 'none';
  const hit = document.elementFromPoint(x, y);
  if (exclude) exclude.style.pointerEvents = '';

  // 1. Another floating window: join it as a tab (a tab dropped back on its own window: nothing)
  const win = hit?.closest<HTMLElement>('[data-float-group]');
  const winGroup = win?.getAttribute('data-float-group');
  if (!dockableTool && win && winGroup && winGroup !== myGroup && floats) {
    if (source.kind === 'panel' && layout.panels[source.id].place === 'float' && layout.panels[source.id].group === winGroup) return null;
    const leader = layout.order.find((id) => layout.panels[id].place === 'float' && layout.panels[id].visible && layout.panels[id].group === winGroup);
    if (leader) return { kind: 'tab', group: winGroup, leader, zone: win.getBoundingClientRect() };
  }

  // 2. An existing dock: insert between its panels
  const dockEl = hit?.closest<HTMLElement>('[data-dock-side]');
  const dockSide = dockEl?.getAttribute('data-dock-side') as DockSide | null;
  if (dockEl && dockSide && (!dockableTool || dockSide !== 'bottom')) {
    const vertical = dockSide !== 'bottom';
    const sections = Array.from(dockEl.querySelectorAll<HTMLElement>('[data-panel]')).filter((s) => !moving.includes(s.dataset.panel as PanelId));
    let index = sections.length;
    for (let i = 0; i < sections.length; i++) {
      const r = sections[i].getBoundingClientRect();
      if (vertical ? y < r.top + r.height / 2 : x < r.left + r.width / 2) { index = i; break; }
    }
    const zone = dockEl.getBoundingClientRect();
    let line: { x: number; y: number; w: number; h: number } | undefined;
    if (sections.length) {
      const r = (sections[index] ?? sections[sections.length - 1]).getBoundingClientRect();
      const edge = sections[index] ? (vertical ? r.top : r.left) : (vertical ? r.bottom : r.right);
      line = vertical ? { x: zone.left + 4, y: edge - 1.5, w: zone.width - 8, h: 3 } : { x: edge - 1.5, y: zone.top + 4, w: 3, h: zone.height - 8 };
    }
    return { kind: 'dock', side: dockSide, index, zone, line };
  }

  // 3. A screen edge next to the canvas: opens a dock there
  if (center && x >= center.left && x <= center.right && y >= center.top && y <= center.bottom) {
    const w = Math.min(layout.dockSize.left, 300);
    if (x < center.left + EDGE) return { kind: 'dock', side: 'left', index: 99, zone: box(center.left, center.top, w, center.height) };
    if (x > center.right - EDGE) return { kind: 'dock', side: 'right', index: 99, zone: box(center.right - w, center.top, w, center.height) };
    if (!dockableTool && y > center.bottom - EDGE) return { kind: 'dock', side: 'bottom', index: 99, zone: box(center.left, center.bottom - layout.dockSize.bottom, center.width, layout.dockSize.bottom) };
  }

  // 4. Anywhere else: a floating window (a moving window simply stays where it was dropped)
  if (source.kind === 'group' || !floats) return null;
  const f = layout.panels[source.id].float;
  return { kind: 'float', rect: { x: Math.round(x - 60), y: Math.round(y - 14), w: f.w, h: f.h } };
};

const applyDrop = (source: DragSource, target: DropTarget | null) => {
  if (!target) return;
  if (source.kind === 'rail') {
    if (target.kind === 'rail') dockActions.setRailSide(target.side);
    return;
  }
  const ids = source.kind === 'panel' ? [source.id] : source.ids;
  if (target.kind === 'dock') dockActions.dockAt(ids, target.side, target.index);
  else if (target.kind === 'tab') {
    for (const id of ids) dockActions.mergeInto(id, target.leader);
    dockActions.setActiveTab(target.group, ids[0]);
  } else if (target.kind === 'float' && source.kind === 'panel') dockActions.floatAt(source.id, target.rect);
};

export function dragDockableTool(id: ToolDockPanelId, label: string, e: PointerEvent, windowEl: HTMLElement | null, done: boolean) {
  const source = { kind: 'panel', id } as const;
  const hit = e.type === 'pointercancel' ? null : findTarget(e.clientX, e.clientY, source, true, windowEl);
  const target = hit?.kind === 'dock' ? hit : null;
  setDrag(done ? null : { source, label, x: e.clientX, y: e.clientY, target });
  if (done) applyDrop(source, target);
}

/**
 * Pointer-down handler that turns into a panel / rail drag after a few pixels of movement, so a plain
 * click (open a tab, collapse) still works. `floats` = whether floating windows are allowed here.
 */
const beginPanelDrag = (e: React.PointerEvent, source: DragSource, label: string, floats: boolean) => {
  if (e.button !== 0) return;
  const el = e.currentTarget as HTMLElement;
  const sx = e.clientX;
  const sy = e.clientY;
  const pointerId = e.pointerId;
  let started = false;
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      started = true;
      try { el.setPointerCapture(pointerId); } catch { /* pointer gone */ }
      document.body.style.cursor = 'grabbing';
    }
    ev.preventDefault();
    setDrag({ source, x: ev.clientX, y: ev.clientY, label, target: findTarget(ev.clientX, ev.clientY, source, floats) });
  };
  const end = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    document.body.style.cursor = '';
    if (!started) return;
    const target = ev.type === 'pointercancel' ? null : findTarget(ev.clientX, ev.clientY, source, floats);
    setDrag(null);
    applyDrop(source, target);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
};

/** The drop preview: the lit-up dock / edge / window and a chip with the panel's name under the pointer */
const DockDragLayer: React.FC = () => {
  const d = useDrag();
  if (!d) return null;
  const t = d.target;
  const zone = t && (t.kind === 'float'
    ? box(t.rect.x, t.rect.y, t.rect.w, Math.min(t.rect.h, 240))
    : t.zone);
  return (
    <div className="pointer-events-none fixed inset-0 z-[95]" aria-hidden>
      {zone && (
        <div className={`atelier-drop-zone ${t?.kind === 'float' ? 'atelier-drop-zone--float' : ''}`}
          style={{ left: zone.left, top: zone.top, width: zone.width, height: zone.height }} />
      )}
      {t?.kind === 'dock' && t.line && (
        <div className="atelier-drop-line" style={{ left: t.line.x, top: t.line.y, width: t.line.w, height: t.line.h }} />
      )}
      {d.source.kind !== 'group' && (
        <div className={`atelier-drag-chip ${t ? '' : 'opacity-60'}`} style={{ left: d.x + 14, top: d.y + 12 }}>
          <span>{d.label}</span>
          <span className="text-neutral-400">
            {!t ? '放開取消' : t.kind === 'dock' ? ({ left: '→ 左側', right: '→ 右側', bottom: '→ 下方' } as const)[t.side]
              : t.kind === 'tab' ? '→ 合併分頁' : t.kind === 'rail' ? (t.side === 'left' ? '→ 左側' : '→ 右側') : '→ 浮動'}
          </span>
        </div>
      )}
      {d.source.kind === 'group' && t && (
        <div className="atelier-drag-chip" style={{ left: d.x + 14, top: d.y + 12 }}>
          {t.kind === 'tab' ? '放開：合併成分頁' : t.kind === 'dock' ? `放開：停靠${({ left: '左側', right: '右側', bottom: '下方' } as const)[t.side]}` : ''}
        </div>
      )}
    </div>
  );
};

/** The handle at the top of the tool rail: drag it to the other side of the screen */
export const RailGrip: React.FC = () => {
  const layout = useDockLayout();
  return (
    <button type="button" aria-label="拖曳工具列到另一側" title="拖曳到另一側"
      onPointerDown={(e) => beginPanelDrag(e, { kind: 'rail' }, '工具列', false)}
      onDoubleClick={() => dockActions.setRailSide(layout.railSide === 'left' ? 'right' : 'left')}
      style={{ touchAction: 'none' }}
      className="mx-auto flex h-3 w-10 shrink-0 cursor-grab items-center justify-center rounded text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300 active:cursor-grabbing">
      <GripVertical className="h-3 w-3 rotate-90" />
    </button>
  );
};

const PanelMenu: React.FC<{ id: PanelId; place: PanelPlace; onClose?: () => void }> = ({ id, place, onClose }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const layout = useDockLayout();
  const floats = useFloatsAllowed();
  const myGroup = layout.panels[id].group;
  // Other floating windows this panel can join as a tab (one entry per window, named by its tabs)
  const isTool = isToolDockPanel(id);
  const windows = floats && !isTool ? Array.from(new Set(layout.order.filter((p) => !isToolDockPanel(p) && layout.panels[p].visible && layout.panels[p].place === 'float').map((p) => layout.panels[p].group)))
    .filter((g) => !(place === 'float' && g === myGroup))
    .map((g) => {
      const members = layout.order.filter((p) => layout.panels[p].place === 'float' && layout.panels[p].visible && layout.panels[p].group === g);
      return { leader: members[0], label: members.map((m) => PANEL_TITLES[m]).join('・') };
    }) : [];
  const groupSize = layout.order.filter((p) => layout.panels[p].place === 'float' && layout.panels[p].visible && layout.panels[p].group === myGroup).length;
  const ref = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (ev: PointerEvent) => {
      if (!ref.current?.contains(ev.target as Node) && !menuRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    const resize = () => setOpen(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', resize);
    };
  }, [open]);
  const item = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-800';
  const anchor = open ? ref.current?.getBoundingClientRect() : undefined;
  const ui = getUiScale();
  const menuWidth = Math.min(window.innerWidth - 8, 160 * ui);
  const menuHeight = Math.min(window.innerHeight - 8, (174 + windows.length * 30) * ui);
  return (
    <div className="relative">
      <button ref={ref} type="button" aria-label="面板位置" title="停靠或浮動" aria-expanded={open}
        onClick={() => setOpen((v) => !v)} className="atelier-icon-btn h-6 w-6">
        <MoreVertical className="h-3.5 w-3.5" />
      </button>
      {anchor && createPortal(
        <div ref={menuRef} role="menu" className="atelier-popover fixed z-[100] w-40 overflow-y-auto p-1"
          style={{
            width: menuWidth,
            left: Math.max(4, Math.min(window.innerWidth - menuWidth - 4, anchor.right - menuWidth)),
            top: Math.max(4, Math.min(anchor.bottom + 4, window.innerHeight - menuHeight - 4)),
            maxHeight: menuHeight,
          }}>
          {PLACE_OPTIONS.filter((o) => (floats || o.place !== 'float') && (!isTool || o.place !== 'bottom')).map((o) => (
            <button key={o.place} type="button" role="menuitemradio" aria-checked={place === o.place}
              onClick={() => { dockActions.moveTo(id, o.place); setOpen(false); }}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${place === o.place ? 'bg-indigo-600 text-white' : 'text-neutral-200 hover:bg-neutral-800'}`}>
              {o.icon}<span>{!isTool ? o.label : o.place === 'left' ? t.toolOptions.dockToolLeft : o.place === 'right' ? t.toolOptions.dockToolRight : t.toolOptions.floatTool}</span>
            </button>
          ))}
          {windows.length > 0 && (
            <>
              <div className="my-1 h-px bg-neutral-700/70" />
              <div className="px-2 py-0.5 text-[10px] text-neutral-500">合併成分頁</div>
              {windows.map((w) => (
                <button key={w.leader} type="button" role="menuitem" onClick={() => { dockActions.mergeInto(id, w.leader); setOpen(false); }} className={item}>
                  <Square className="h-3.5 w-3.5" /><span className="truncate">{w.label}</span>
                </button>
              ))}
            </>
          )}
          {place === 'float' && groupSize > 1 && (
            <button type="button" role="menuitem" onClick={() => { dockActions.detach(id); setOpen(false); }} className={item}>
              <Square className="h-3.5 w-3.5" /><span>分離成獨立視窗</span>
            </button>
          )}
          <div className="my-1 h-px bg-neutral-700/70" />
          <button type="button" role="menuitem" onClick={() => { if (onClose) onClose(); else dockActions.hide(id); setOpen(false); }} className={item}>
            <X className="h-3.5 w-3.5" /><span>{isTool ? t.common.close : '隱藏'}</span>
          </button>
        </div>, document.body
      )}
    </div>
  );
};

const PanelHeader: React.FC<{
  def: PanelDef;
  place: PanelPlace;
  collapsed: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}> = ({ def, place, collapsed, onPointerDown }) => (
  <div
    onPointerDown={onPointerDown}
    onDoubleClick={() => dockActions.setCollapsed(def.id, !collapsed)}
    style={{ touchAction: 'none' }}
    title="拖曳：移動、停靠或分離"
    className="flex h-8 shrink-0 cursor-grab items-center gap-1 border-b border-neutral-700/70 bg-neutral-800/60 pl-1 pr-1 text-xs active:cursor-grabbing"
    data-float-header={place === 'float' ? '' : undefined}
  >
    <button type="button" aria-expanded={!collapsed} aria-label={collapsed ? `展開${def.title}` : `收合${def.title}`}
      onClick={() => dockActions.setCollapsed(def.id, !collapsed)} onPointerDown={(e) => e.stopPropagation()}
      className="atelier-icon-btn h-6 w-6">
      {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
    </button>
    <span className="text-indigo-400 [&>svg]:h-3.5 [&>svg]:w-3.5">{def.icon}</span>
    <span className="truncate font-semibold text-neutral-100">{def.title}</span>
    {def.badge}
    <div className="ml-auto flex items-center" onPointerDown={(e) => e.stopPropagation()}>
      <PanelMenu id={def.id} place={place} onClose={def.onClose} />
      <button type="button" aria-label={`隱藏${def.title}`} title="隱藏（「視窗」選單可再開啟）"
        onClick={() => def.onClose ? def.onClose() : dockActions.hide(def.id)} className="atelier-icon-btn h-6 w-6">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
);

/** Where a panel shows: floating panels dock on the right where floating is off, except lightweight transient panels (members, oplog) */
const placeOf = (layout: ReturnType<typeof useDockLayout>, id: PanelId, floats: boolean): PanelPlace =>
  layout.panels[id].place === 'float' && !floats && id !== 'members' && id !== 'oplog' ? 'right' : layout.panels[id].place;

const visiblePanels = (panels: PanelDef[], place: PanelPlace, layout: ReturnType<typeof useDockLayout>, floats = true) =>
  layout.order
    .map((id) => panels.find((p) => p.id === id))
    .filter((p): p is PanelDef => Boolean(p && (isToolDockPanel(p.id) || layout.panels[p.id].visible) && placeOf(layout, p.id, floats) === place));

/** Splitter between two expanded panels: drags their flex weights. */
const Splitter: React.FC<{ a: PanelId; b: PanelId; vertical: boolean; containerRef: React.RefObject<HTMLDivElement | null> }> = ({ a, b, vertical, containerRef }) => {
  const layout = useDockLayout();
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      style={{ touchAction: 'none' }}
      className={`group relative shrink-0 ${vertical ? 'h-1.5 cursor-row-resize' : 'w-1.5 cursor-col-resize'}`}
      onPointerDown={(e) => {
        const container = containerRef.current;
        const elA = container?.querySelector<HTMLElement>(`[data-panel="${a}"]`);
        const elB = container?.querySelector<HTMLElement>(`[data-panel="${b}"]`);
        if (!elA || !elB) return;
        const sizeA = vertical ? elA.offsetHeight : elA.offsetWidth;
        const sizeB = vertical ? elB.offsetHeight : elB.offsetWidth;
        const total = layout.panels[a].weight + layout.panels[b].weight;
        startDrag(e, (dx, dy) => {
          const delta = vertical ? dy : dx;
          const nextA = Math.max(70, Math.min(sizeA + sizeB - 70, sizeA + delta));
          const wa = (total * nextA) / (sizeA + sizeB);
          dockActions.setWeights({ [a]: wa, [b]: total - wa });
        });
      }}
    >
      <div className={`absolute bg-indigo-500/0 transition group-hover:bg-indigo-500/60 ${vertical ? 'inset-x-0 top-0.5 h-0.5' : 'inset-y-0 left-0.5 w-0.5'}`} />
    </div>
  );
};

const DockedPanels: React.FC<{ list: PanelDef[]; vertical: boolean; place: DockSide }> = ({ list, vertical, place }) => {
  const layout = useDockLayout();
  const floats = useFloatsAllowed();
  const ref = useRef<HTMLDivElement>(null);
  const groups = new Map<string, PanelDef[]>();
  for (const def of list) {
    const group = layout.panels[def.id].group;
    const tabs = groups.get(group);
    if (tabs) tabs.push(def);
    else groups.set(group, [def]);
  }
  const stacks = Array.from(groups);
  return (
    <div ref={ref} className={`flex min-h-0 min-w-0 flex-1 ${vertical ? 'flex-col' : 'flex-row'}`}>
      {stacks.map(([group, tabs], i) => {
        const def = tabs[0];
        const p = layout.panels[def.id];
        const active = tabs.find((tab) => tab.id === layout.activeTab[group]) ?? def;
        const prev = stacks[i - 1]?.[1][0];
        const showSplitter = prev && !layout.panels[prev.id].collapsed && !p.collapsed;
        return (
          <React.Fragment key={def.id}>
            {showSplitter && <Splitter a={prev.id} b={def.id} vertical={vertical} containerRef={ref} />}
            {!showSplitter && i > 0 && <div className={vertical ? 'h-px shrink-0 bg-neutral-700/70' : 'w-px shrink-0 bg-neutral-700/70'} />}
            <section
              data-panel={def.id}
              aria-label={active.title}
              className="flex min-h-0 min-w-0 flex-col overflow-hidden"
              style={p.collapsed ? { flex: '0 0 auto' } : { flex: `${p.weight} 1 0px`, minHeight: vertical ? 70 : undefined, minWidth: vertical ? undefined : 160 }}
            >
              {tabs.length === 1 ? <PanelHeader def={def} place={place} collapsed={p.collapsed}
                onPointerDown={(e) => beginPanelDrag(e, { kind: 'panel', id: def.id }, def.title, floats)} /> : (
                <div className="flex h-8 shrink-0 items-center border-b border-neutral-700/70 bg-neutral-800/60 px-1">
                  <div className="flex min-w-0 flex-1 items-stretch self-stretch overflow-x-auto no-scrollbar" role="tablist" aria-label={active.title}>
                    {tabs.map((tab) => (
                      <button key={tab.id} type="button" role="tab" aria-selected={tab.id === active.id && !p.collapsed}
                        className={`flex shrink-0 cursor-grab items-center gap-1 px-1.5 text-xs [&>svg]:h-3.5 [&>svg]:w-3.5 ${tab.id === active.id && !p.collapsed ? 'border-b border-indigo-400 bg-indigo-600/20 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-700'}`}
                        onClick={() => dockActions.activate(tab.id)}
                        onPointerDown={(e) => beginPanelDrag(e, { kind: 'panel', id: tab.id }, tab.title, floats)}>
                        {tab.icon}{tab.title}
                      </button>
                    ))}
                  </div>
                  <PanelMenu id={active.id} place={place} />
                </div>
              )}
              {!p.collapsed && <div role={tabs.length > 1 ? 'tabpanel' : undefined} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{active.render()}</div>}
            </section>
          </React.Fragment>
        );
      })}
    </div>
  );
};

/** Left / right dock column with a draggable inner edge. */
export const DockColumn: React.FC<{ side: 'left' | 'right'; panels: PanelDef[] }> = ({ side, panels }) => {
  const layout = useDockLayout();
  const floats = useFloatsAllowed();
  // 介面縮放: limits grow with the interface (a larger interface may take more of the screen)
  const ui = useUiScale();
  const list = visiblePanels(panels, side, layout, floats);
  if (list.length === 0) return null;
  const width = layout.dockSize[side];
  const cap = Math.min(50, Math.round(34 * Math.max(1, ui)));
  return (
    <aside aria-label={side === 'right' ? '右側面板' : '左側面板'} data-dock-side={side} style={{ width: `min(${width}px, ${cap}vw)`, minWidth: Math.round(220 * ui) }}
      className={`atelier-chrome relative flex min-h-0 shrink-0 flex-col ${side === 'right' ? 'border-l' : 'border-r'}`}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="調整面板寬度"
        style={{ touchAction: 'none' }}
        className={`group absolute inset-y-0 z-10 w-2 cursor-col-resize ${side === 'right' ? '-left-1' : '-right-1'}`}
        onPointerDown={(e) => {
          const start = width;
          startDrag(e, (dx) => dockActions.setDockSize(side, Math.max(220 * ui, Math.min(560 * ui, start + (side === 'right' ? -dx : dx)))));
        }}
      >
        <div className="mx-auto h-full w-0.5 bg-indigo-500/0 transition group-hover:bg-indigo-500/60" />
      </div>
      <DockedPanels list={list} vertical place={side} />
    </aside>
  );
};

/** Bottom dock row with a draggable top edge. */
export const DockRow: React.FC<{ panels: PanelDef[] }> = ({ panels }) => {
  const layout = useDockLayout();
  const floats = useFloatsAllowed();
  const ui = useUiScale();
  const list = visiblePanels(panels, 'bottom', layout, floats);
  if (list.length === 0) return null;
  const allCollapsed = list.every((p) => layout.panels[p.id].collapsed);
  const height = layout.dockSize.bottom;
  return (
    <div aria-label="下方面板" data-dock-side="bottom" style={allCollapsed ? undefined : { height }}
      className="atelier-chrome relative flex shrink-0 border-t">
      {!allCollapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="調整下方面板高度"
          style={{ touchAction: 'none' }}
          className="group absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
          onPointerDown={(e) => {
            const start = height;
            startDrag(e, (_dx, dy) => dockActions.setDockSize('bottom', Math.max(120 * ui, Math.min(480 * ui, start - dy))));
          }}
        >
          <div className="my-auto mt-0.5 h-0.5 w-full bg-indigo-500/0 transition group-hover:bg-indigo-500/60" />
        </div>
      )}
      <DockedPanels list={list} vertical={false} place="bottom" />
    </div>
  );
};

/** Smallest floating window, at 100 % 介面縮放 */
const MIN_W_BASE = 220;
const MIN_H_BASE = 120;

/** x < 0 means "never placed": open just left of the right dock instead of on top of it. */
const clampRect = (r: FloatRect, rightInset = 0): FloatRect => {
  const ui = getUiScale();
  const MIN_W = MIN_W_BASE * ui;
  const MIN_H = MIN_H_BASE * ui;
  const topBar = Math.round(48 * ui);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(MIN_W, Math.min(r.w, vw - 16));
  const h = Math.max(MIN_H, Math.min(r.h, vh - 56));
  const x = r.x < 0 ? Math.max(8, vw - w - 16 - rightInset) : Math.max(8 - w + 80, Math.min(vw - 80, r.x));
  const y = Math.max(topBar, Math.min(vh - 40, r.y));
  return { x, y, w, h };
};

export type Edge = 'l' | 'r' | 't' | 'b' | 'lt' | 'rt' | 'lb' | 'rb';
export const EDGE_HANDLES: Array<{ edge: Edge; className: string; cursor: string }> = [
  { edge: 'l', className: 'inset-y-3 -left-1 w-2', cursor: 'ew-resize' },
  { edge: 'r', className: 'inset-y-3 -right-1 w-2', cursor: 'ew-resize' },
  { edge: 't', className: 'inset-x-3 -top-1 h-2', cursor: 'ns-resize' },
  { edge: 'b', className: 'inset-x-3 -bottom-1 h-2', cursor: 'ns-resize' },
  { edge: 'lt', className: '-left-1 -top-1 h-3.5 w-3.5', cursor: 'nwse-resize' },
  { edge: 'rb', className: '-bottom-1 -right-1 h-3.5 w-3.5', cursor: 'nwse-resize' },
  { edge: 'rt', className: '-right-1 -top-1 h-3.5 w-3.5', cursor: 'nesw-resize' },
  { edge: 'lb', className: '-bottom-1 -left-1 h-3.5 w-3.5', cursor: 'nesw-resize' },
];

/** New rect after dragging one edge / corner by (dx, dy); the opposite edge stays put */
export const resizeRect = (start: FloatRect, edge: Edge, dx: number, dy: number): FloatRect => {
  const ui = getUiScale();
  const MIN_W = MIN_W_BASE * ui;
  const MIN_H = MIN_H_BASE * ui;
  const topBar = Math.round(48 * ui);
  let { x, y, w, h } = start;
  if (edge.includes('r')) w = Math.max(MIN_W, start.w + dx);
  if (edge.includes('b')) h = Math.max(MIN_H, start.h + dy);
  if (edge.includes('l')) {
    w = Math.max(MIN_W, start.w - dx);
    x = start.x + start.w - w;
  }
  if (edge.includes('t')) {
    h = Math.max(MIN_H, start.h - dy);
    y = start.y + start.h - h;
    if (y < topBar) { h -= topBar - y; y = topBar; }
  }
  return { x, y, w, h };
};

/**
 * One floating window. Several floating panels can share it as tabs (CSP-style). Drag the title bar to
 * move it (onto another window = merge, onto a dock or screen edge = dock it), drag a tab out to take
 * it apart, and resize from any edge or corner.
 */
const FloatingGroup: React.FC<{ group: string; defs: PanelDef[]; zIndex: number; onFocus: () => void }> = ({ group, defs, zIndex, onFocus }) => {
  const layout = useDockLayout();
  const floats = useFloatsAllowed();
  const leader = defs[0];
  const p = layout.panels[leader.id];
  const active = defs.find((d) => d.id === layout.activeTab[group]) ?? leader;
  const rightDockOpen = Object.values(layout.panels).some((x) => x.visible && x.place === 'right');
  const [rect, setRect] = useState(() => clampRect(p.float, rightDockOpen ? layout.dockSize.right : 0));
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const sectionRef = useRef<HTMLElement>(null);

  // A panel dropped as a new window brings its own rect
  useEffect(() => {
    setRect(clampRect(p.float, rightDockOpen ? layout.dockSize.right : 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.float.x, p.float.y, p.float.w, p.float.h]);

  useEffect(() => {
    const onResize = () => setRect((r) => clampRect(r));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const save = () => dockActions.setFloat(leader.id, rectRef.current);

  const dragWindow = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const start = rectRef.current;
    const source: DragSource = { kind: 'group', group, ids: defs.map((d) => d.id) };
    const el = sectionRef.current;
    startDrag(e, (dx, dy, ev) => {
      setRect(clampRect({ ...start, x: start.x + dx, y: start.y + dy }));
      setDrag({ source, x: ev.clientX, y: ev.clientY, label: '', target: findTarget(ev.clientX, ev.clientY, source, floats, el) });
    }, (ev) => {
      const target = drag && ev.type !== 'pointercancel' ? findTarget(ev.clientX, ev.clientY, source, floats, el) : null;
      setDrag(null);
      if (target) applyDrop(source, target);
      else save();
    });
  };

  const resizeFrom = (edge: Edge) => (e: React.PointerEvent) => {
    const start = rectRef.current;
    startDrag(e, (dx, dy) => setRect(clampRect(resizeRect(start, edge, dx, dy))), save);
  };

  return (
    <section
      ref={sectionRef}
      data-float-group={group}
      aria-label={defs.map((d) => d.title).join('、')}
      onPointerDown={onFocus}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: p.collapsed ? undefined : rect.h, zIndex }}
      className="atelier-popover atelier-window fixed flex flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
        {defs.length === 1 ? (
          <PanelHeader def={leader} place="float" collapsed={p.collapsed} onPointerDown={dragWindow} />
        ) : (
          <div onPointerDown={dragWindow} onDoubleClick={() => dockActions.setCollapsed(leader.id, !p.collapsed)} style={{ touchAction: 'none' }}
            data-float-header=""
            title="拖曳移動；拖到其他視窗或畫面邊緣可合併／停靠"
            className="flex h-8 shrink-0 cursor-grab items-end gap-0.5 border-b border-neutral-700/70 bg-neutral-800/60 px-1 text-xs active:cursor-grabbing">
            <div role="tablist" aria-label="視窗分頁" className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto no-scrollbar" onPointerDown={(e) => e.stopPropagation()}>
              {defs.map((d) => (
                <button key={d.id} type="button" role="tab" aria-selected={d.id === active.id}
                  onClick={() => dockActions.setActiveTab(group, d.id)}
                  onPointerDown={(e) => beginPanelDrag(e, { kind: 'panel', id: d.id }, d.title, floats)}
                  style={{ touchAction: 'none' }}
                  title="拖出視窗即可分離"
                  className={`flex h-7 shrink-0 items-center gap-1 rounded-t-md px-2 ${d.id === active.id ? 'bg-neutral-900 text-white' : 'text-neutral-400 hover:text-neutral-100'}`}>
                  <span className="text-indigo-400 [&>svg]:h-3.5 [&>svg]:w-3.5">{d.icon}</span>
                  <span className="truncate">{d.title}</span>
                  {d.badge}
                </button>
              ))}
            </div>
            <div className="mb-0.5 flex items-center" onPointerDown={(e) => e.stopPropagation()}>
              <PanelMenu id={active.id} place="float" />
              <button type="button" aria-label={`隱藏${active.title}`} title="隱藏這個分頁"
                onClick={() => dockActions.hide(active.id)} className="atelier-icon-btn h-6 w-6">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
        {!p.collapsed && (
          <div role={defs.length > 1 ? 'tabpanel' : undefined} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{active.render()}</div>
        )}
      </div>
      {!p.collapsed && EDGE_HANDLES.map((h) => (
        <div key={h.edge} onPointerDown={resizeFrom(h.edge)} aria-hidden
          style={{ touchAction: 'none', cursor: h.cursor }} className={`absolute z-10 ${h.className}`} />
      ))}
    </section>
  );
};

export const FloatingPanels: React.FC<{ panels: PanelDef[] }> = ({ panels }) => {
  const layout = useDockLayout();
  const floats = useFloatsAllowed();
  const list = visiblePanels(panels, 'float', layout, floats);
  const groups = new Map<string, PanelDef[]>();
  for (const def of list) {
    const g = layout.panels[def.id].group || def.id;
    groups.set(g, [...(groups.get(g) || []), def]);
  }
  const [front, setFront] = useState<string | null>(null);
  return (
    <>
      {Array.from(groups.entries()).map(([group, defs], i) => (
        <FloatingGroup key={group} group={group} defs={defs} zIndex={front === group ? 46 : 40 + i} onFocus={() => setFront(group)} />
      ))}
      <DockDragLayer />
    </>
  );
};

/** Phone & non-desktop tablet layout: one panel at a time in a frosted slide-up or slide-out drawer. */
export type MobilePanelDef = Omit<PanelDef, 'id'> & { id: PanelId | 'toolPicker' };

export const MobilePanelSheet: React.FC<{
  def: MobilePanelDef | null;
  placement?: 'bottom' | 'right';
  quickTabs?: Array<{ id: MobilePanelDef['id']; label: string; icon: React.ReactNode }>;
  onSelectTab?: (id: MobilePanelDef['id']) => void;
  onClose: () => void;
}> = ({ def, placement = 'bottom', quickTabs, onSelectTab, onClose }) => {
  const { t } = useI18n();
  const [dragOffset, setDragOffset] = useState(0);
  const dragRef = useRef<{ pointerId: number; start: number } | null>(null);

  if (!def) return null;
  const isRight = placement === 'right';

  const onGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement | null)?.closest?.('button')) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    dragRef.current = { pointerId: e.pointerId, start: isRight ? e.clientX : e.clientY };
    setDragOffset(0);
  };
  const onGripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const delta = (isRight ? e.clientX : e.clientY) - drag.start;
    setDragOffset(Math.max(0, delta));
  };
  const onGripUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const delta = (isRight ? e.clientX : e.clientY) - drag.start;
    setDragOffset(0);
    if (delta > 68) onClose();
  };

  return (
    <div
      data-mobile-panel={def.id}
      data-drawer-placement={placement}
      className={`fixed inset-0 z-[60] flex ${isRight ? 'justify-end' : 'flex-col justify-end'}`}
      role="dialog"
      aria-label={def.title}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div
        className={
          isRight
            ? 'atelier-popover relative flex h-full w-[min(360px,88vw)] min-h-0 flex-col rounded-none border-l shadow-2xl'
            : 'atelier-popover relative flex max-h-[min(78dvh,100%)] min-h-0 flex-col rounded-b-none rounded-t-2xl border-t shadow-2xl'
        }
        style={{
          ...(isRight
            ? {
                paddingTop: 'env(safe-area-inset-top, 0px)',
                paddingBottom: 'env(safe-area-inset-bottom, 0px)',
                paddingRight: 'env(safe-area-inset-right, 0px)',
                transform: dragOffset > 0 ? `translate3d(${dragOffset}px, 0, 0)` : undefined,
              }
            : {
                paddingBottom: 'env(safe-area-inset-bottom, 0px)',
                paddingLeft: 'env(safe-area-inset-left, 0px)',
                paddingRight: 'env(safe-area-inset-right, 0px)',
                transform: dragOffset > 0 ? `translate3d(0, ${dragOffset}px, 0)` : undefined,
              }),
          transition: dragOffset > 0 ? 'none' : 'transform 180ms cubic-bezier(.2, .8, .2, 1)',
        }}
      >
        <div
          style={{ touchAction: 'none' }}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={() => { dragRef.current = null; setDragOffset(0); }}
        >
          {!isRight && <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-white/30" />}
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/10 px-3 text-sm font-semibold text-neutral-100">
            <span className="shrink-0 text-indigo-400 [&>svg]:h-4 [&>svg]:w-4">{def.icon}</span>
            <span className="min-w-0 truncate">{def.title}</span>
            <button type="button" onClick={onClose} aria-label={t.common.close} className="atelier-icon-btn ml-auto h-8 w-8 shrink-0">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        {quickTabs && quickTabs.length > 0 && onSelectTab && (
          <div className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-b border-white/10 px-2 py-1.5">
            {quickTabs.map((tab) => {
              const active = tab.id === def.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onSelectTab(tab.id)}
                  className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition ${
                    active
                      ? 'bg-indigo-500/25 text-white ring-1 ring-indigo-400/70'
                      : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
                  }`}
                >
                  <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{tab.icon}</span>
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{def.render()}</div>
      </div>
    </div>
  );
};
