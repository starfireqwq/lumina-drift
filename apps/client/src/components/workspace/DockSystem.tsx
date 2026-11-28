import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftRight, ArrowUpDown, ChevronDown, ChevronRight, GripHorizontal, GripVertical, Minimize2, MoreVertical, PanelBottom, PanelLeft, PanelRight, Square, X } from 'lucide-react';
import { DockSide, dockActions, type FloatGroupState, type FloatPillOrientation, type FloatPillPos, FloatRect, getDockLayout, getFloatGroupState, isToolDockPanel, PanelId, PanelPlace, type ToolDockPanelId, useDockLayout, useFloatsAllowed } from './dockStore';
import { getPanelDisplayTitle, renderPanelIcon } from './panelIcons';
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

const PLACE_OPTIONS = [
  { place: 'right', label: 'dockRight', icon: <PanelRight className="h-3.5 w-3.5" /> },
  { place: 'left', label: 'dockLeft', icon: <PanelLeft className="h-3.5 w-3.5" /> },
  { place: 'bottom', label: 'dockBottom', icon: <PanelBottom className="h-3.5 w-3.5" /> },
  { place: 'float', label: 'floatWindow', icon: <Square className="h-3.5 w-3.5" /> },
] as const;

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
  | { kind: 'group'; group: string; ids: PanelId[]; fromDock?: true }
  | { kind: 'pill-group'; group: string; ids: PanelId[] }
  | { kind: 'pill-item'; id: PanelId; fromGroup: string; orientation: FloatPillOrientation }
  | { kind: 'rail' };

type DropTarget =
  | { kind: 'dock'; side: DockSide; index: number; before?: PanelId | null; zone: DOMRect; line?: { x: number; y: number; w: number; h: number } }
  | { kind: 'tab'; group: string; leader: PanelId; zone: DOMRect }
  | { kind: 'pill-merge'; group: string; leader: PanelId; zone: DOMRect }
  | { kind: 'pill-detach'; pos: FloatPillPos; zone: DOMRect }
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
const PILL_MAGNET_RADIUS = 12;
const rectOf = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
const box = (x: number, y: number, w: number, h: number) => new DOMRect(x, y, w, h);
const containsPoint = (rect: DOMRect, x: number, y: number, padding = 0) =>
  x >= rect.left - padding && x <= rect.right + padding && y >= rect.top - padding && y <= rect.bottom + padding;

const getPillSizePx = (ui: number) => Math.round(44 * ui);
const clampPillPos = ({ x, y }: FloatPillPos, width: number, height: number): FloatPillPos => ({
  x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
  y: Math.max(48, Math.min(y, window.innerHeight - height - 8)),
});

const draggedPanels = (source: Exclude<DragSource, { kind: 'rail' }>) => 'id' in source ? [source.id] : source.ids;

const findMagneticPillTarget = (x: number, y: number, excludeGroup: string | null, excludeEl?: HTMLElement | null) => {
  const layout = getDockLayout();
  let target: Extract<DropTarget, { kind: 'pill-merge' }> | null = null;
  let nearest = Infinity;
  for (const el of document.querySelectorAll<HTMLElement>('[data-float-pill]')) {
    const group = el.dataset.floatPill;
    if (!group || group === excludeGroup || el === excludeEl) continue;
    const zone = el.getBoundingClientRect();
    if (!containsPoint(zone, x, y, PILL_MAGNET_RADIUS)) continue;
    const distance = Math.hypot(x - (zone.left + zone.width / 2), y - (zone.top + zone.height / 2));
    if (distance >= nearest) continue;
    const leader = layout.order.find((id) => isVisibleFloatMember(layout, id, group));
    if (!leader) continue;
    nearest = distance;
    target = { kind: 'pill-merge', group, leader, zone };
  }
  return target;
};

const isVisibleFloatMember = (layout: ReturnType<typeof getDockLayout>, id: PanelId, group: string) => {
  const panel = layout.panels[id];
  return panel.place === 'float' && panel.visible && panel.group === group;
};

/** What lies under the pointer for this drag (null: nowhere to drop, the drag is cancelled) */
const findTarget = (x: number, y: number, source: DragSource, floats: boolean, exclude?: HTMLElement | null): DropTarget | null => {
  if (source.kind === 'rail') {
    const root = rectOf('[data-dock-root]');
    if (!root) return null;
    const side = x < root.left + root.width / 2 ? 'left' : 'right';
    return { kind: 'rail', side, zone: box(side === 'left' ? root.left : root.right - 88, root.top, 88, root.height) };
  }
  const layout = getDockLayout();
  const moving = draggedPanels(source);
  const dockableTool = moving.some(isToolDockPanel);
  const myGroup = 'group' in source ? source.group : source.kind === 'pill-item' ? source.fromGroup
    : layout.panels[source.id].group;
  if (floats && !dockableTool) {
    const pill = findMagneticPillTarget(x, y, myGroup, exclude);
    if (pill) return pill;
    if (source.kind === 'pill-item') {
      const ownPill = rectOf(`[data-float-pill="${CSS.escape(source.fromGroup)}"]`);
      if (ownPill && containsPoint(ownPill, x, y)) return null;
    }
  }
  // The window being moved must not hide what is under the pointer
  const pointerEvents = exclude?.style.pointerEvents ?? '';
  if (exclude) exclude.style.pointerEvents = 'none';
  const hit = document.elementFromPoint(x, y);
  if (exclude) exclude.style.pointerEvents = pointerEvents;

  // 1. Another floating window: join it as a tab (a tab dropped back on its own window: nothing)
  const win = hit?.closest<HTMLElement>('[data-float-group]:not([data-float-pill])');
  const winGroup = win?.getAttribute('data-float-group');
  if (!dockableTool && win && winGroup && floats) {
    if (winGroup === myGroup) return null;
    const leader = layout.order.find((id) => isVisibleFloatMember(layout, id, winGroup));
    if (leader) return { kind: 'tab', group: winGroup, leader, zone: win.getBoundingClientRect() };
  }

  // 2. An existing dock: merge over a group's header or center, or insert at an edge
  const dockEl = hit?.closest<HTMLElement>('[data-dock-side]');
  const dockSide = dockEl?.getAttribute('data-dock-side') as DockSide | null;
  if (dockEl && dockSide && (!dockableTool || dockSide !== 'bottom')) {
    const vertical = dockSide !== 'bottom';
    const hovered = hit?.closest<HTMLElement>('[data-dock-leader]');
    if (hovered?.dataset.dockGroup === myGroup) return null;
    const sections = Array.from(dockEl.querySelectorAll<HTMLElement>('[data-dock-leader]')).flatMap((section) => {
      const leader = section.dataset.dockLeader as PanelId;
      const anchor = moving.includes(leader)
        ? Array.from(section.querySelectorAll<HTMLElement>('[data-dock-tab]'))
          .map((tab) => tab.dataset.dockTab as PanelId).find((id) => !moving.includes(id))
        : leader;
      return anchor ? [{ section, leader, anchor }] : [];
    });
    let index = sections.length;
    let edge: number | undefined;
    for (const [i, { section, leader }] of sections.entries()) {
      const r = section.getBoundingClientRect();
      const start = vertical ? r.top : r.left;
      const end = vertical ? r.bottom : r.right;
      const position = ((vertical ? y : x) - start) / (end - start);
      if (section === hovered) {
        const group = section.dataset.dockGroup;
        const header = hit?.closest('[data-dock-header], [role="tablist"]');
        const overHeader = header?.closest('[data-dock-leader]') === section && section.firstElementChild?.contains(header);
        const canMerge = layout.panels[leader].place === dockSide || (!dockableTool && !isToolDockPanel(leader));
        if (group && canMerge && (overHeader || (position >= 0.24 && position <= 0.76))) {
          return { kind: 'tab', group, leader, zone: r };
        }
        index = position < 0.5 ? i : i + 1;
        edge = position < 0.5 ? start : end;
        break;
      }
      if (position < 0.5) {
        index = i;
        edge = start;
        break;
      }
      edge = end;
    }
    const zone = dockEl.getBoundingClientRect();
    let line: { x: number; y: number; w: number; h: number } | undefined;
    if (edge !== undefined) {
      line = vertical ? { x: zone.left + 4, y: edge - 1.5, w: zone.width - 8, h: 3 } : { x: edge - 1.5, y: zone.top + 4, w: 3, h: zone.height - 8 };
    }
    return { kind: 'dock', side: dockSide, index, before: sections[index]?.anchor ?? null, zone, line };
  }

  // 3. A screen edge next to the canvas: opens a dock there
  const center = rectOf('[data-dock-center]');
  if (center && containsPoint(center, x, y)) {
    const w = Math.min(layout.dockSize.left, 300);
    if (x < center.left + EDGE) return { kind: 'dock', side: 'left', index: 99, zone: box(center.left, center.top, w, center.height) };
    if (x > center.right - EDGE) return { kind: 'dock', side: 'right', index: 99, zone: box(center.right - w, center.top, w, center.height) };
    if (!dockableTool && y > center.bottom - EDGE) return { kind: 'dock', side: 'bottom', index: 99, zone: box(center.left, center.bottom - layout.dockSize.bottom, center.width, layout.dockSize.bottom) };
  }

  if (!floats || (source.kind === 'group' && (!source.fromDock || dockableTool)) || source.kind === 'pill-group') return null;
  if (source.kind === 'pill-item') {
    const size = getPillSizePx(getUiScale());
    const pos = clampPillPos({ x: Math.round(x - size / 2), y: Math.round(y - size / 2) }, size, size);
    return { kind: 'pill-detach', pos, zone: box(pos.x, pos.y, size, size) };
  }
  const f = layout.panels[moving[0]].float;
  return { kind: 'float', rect: { x: Math.round(x - 60), y: Math.round(y - 14), w: f.w, h: f.h } };
};

const applyDrop = (source: DragSource, target: DropTarget | null) => {
  if (!target) return;
  if (source.kind === 'rail') {
    if (target.kind === 'rail') dockActions.setRailSide(target.side);
    return;
  }
  const ids = draggedPanels(source);
  if (target.kind === 'dock') {
    if (source.kind === 'group' && source.fromDock) dockActions.moveDockGroup(ids[0], target);
    else dockActions.dockAt(ids, target.side, target.index, target.before);
  } else if (target.kind === 'pill-merge' || target.kind === 'tab') {
    dockActions.mergePanelsInto(ids, target.leader, { keepTargetMinimized: target.kind === 'pill-merge', activeId: ids[0] });
  } else if (target.kind === 'pill-detach' && source.kind === 'pill-item') {
    dockActions.detachToPill(source.id, target.pos, source.orientation);
  } else if (target.kind === 'float') {
    if (source.kind === 'group' && source.fromDock) dockActions.moveDockGroup(ids[0], target);
    else if (source.kind === 'panel') dockActions.floatAt(source.id, target.rect);
  }
};

export function dragDockableTool(id: ToolDockPanelId, label: string, e: PointerEvent, windowEl: HTMLElement | null, done: boolean) {
  const source = { kind: 'panel', id } as const;
  const hit = e.type === 'pointercancel' ? null : findTarget(e.clientX, e.clientY, source, true, windowEl);
  const target = hit?.kind === 'dock' || hit?.kind === 'tab' ? hit : null;
  setDrag(done ? null : { source, label, x: e.clientX, y: e.clientY, target });
  if (done) applyDrop(source, target);
}

/**
 * Pointer-down handler that turns into a panel / rail drag after a few pixels of movement, so a plain
 * click (open a tab, collapse) still works. `floats` = whether floating windows are allowed here.
 */
const beginPanelDrag = (e: React.PointerEvent, source: DragSource, label: string, floats: boolean, options?: {
  exclude?: HTMLElement;
  onMove?: (dx: number, dy: number) => void;
  onEnd?: (ev: PointerEvent, target: DropTarget | null) => void;
}) => {
  if (e.button !== 0) return;
  const el = e.currentTarget as HTMLElement;
  const sx = e.clientX;
  const sy = e.clientY;
  const pointerId = e.pointerId;
  let started = false;
  let previousCursor = '';
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    const dx = ev.clientX - sx;
    const dy = ev.clientY - sy;
    if (!started) {
      if (Math.hypot(dx, dy) < 6) return;
      started = true;
      try { el.setPointerCapture(pointerId); } catch { /* pointer gone */ }
      previousCursor = document.body.style.cursor;
      document.body.style.cursor = 'grabbing';
    }
    ev.preventDefault();
    options?.onMove?.(dx, dy);
    setDrag({ source, x: ev.clientX, y: ev.clientY, label, target: findTarget(ev.clientX, ev.clientY, source, floats, options?.exclude) });
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (drag?.source === source) {
      document.body.style.cursor = previousCursor;
      setDrag(null);
    }
  };
  const end = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    cleanup();
    if (!started) return;
    const target = ev.type === 'pointercancel' ? null : findTarget(ev.clientX, ev.clientY, source, floats, options?.exclude);
    options?.onEnd?.(ev, target);
    applyDrop(source, target);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  return cleanup;
};

/** The drop preview: the lit-up dock / edge / window and a chip with the panel's name under the pointer */
const DockDragLayer: React.FC = () => {
  const { t } = useI18n();
  const d = useDrag();
  if (!d) return null;
  const target = d.target;
  const groupDrag = d.source.kind === 'group' || d.source.kind === 'pill-group';
  const pillPreview = target?.kind === 'pill-merge' || target?.kind === 'pill-detach';
  const floatPreview = target?.kind === 'float' || target?.kind === 'pill-detach';
  const zone = target && (target.kind === 'float'
    ? box(target.rect.x, target.rect.y, target.rect.w, Math.min(target.rect.h, 240))
    : target.zone);
  const dockHints = groupDrag
    ? { left: t.dock.dropGroupDockLeft, right: t.dock.dropGroupDockRight, bottom: t.dock.dropGroupDockBottom }
    : { left: t.dock.dropDockLeft, right: t.dock.dropDockRight, bottom: t.dock.dropDockBottom };
  let hint: string;
  switch (target?.kind) {
    case 'dock': hint = dockHints[target.side]; break;
    case 'rail': hint = target.side === 'left' ? t.dock.dropRailLeft : t.dock.dropRailRight; break;
    case 'tab': hint = groupDrag ? t.dock.dropGroupMergeTab : t.dock.dropMergeTab; break;
    case 'pill-merge': hint = groupDrag ? t.dock.dropGroupMergePill : t.dock.dropMergePill; break;
    case 'pill-detach': hint = t.dock.dropDetachPill; break;
    case 'float': hint = t.dock.dropFloat; break;
    default: hint = t.dock.dropCancel;
  }
  return (
    <div className="pointer-events-none fixed inset-0 z-[95]" aria-hidden>
      {zone && (
        <div className={`atelier-drop-zone${floatPreview ? ' atelier-drop-zone--float' : ''}${pillPreview ? ' atelier-drop-zone--pill' : ''}`}
          style={{ left: zone.left, top: zone.top, width: zone.width, height: zone.height }} />
      )}
      {target?.kind === 'dock' && target.line && (
        <div className="atelier-drop-line" style={{ left: target.line.x, top: target.line.y, width: target.line.w, height: target.line.h }} />
      )}
      {(!groupDrag || target) && (
        <div className={`atelier-drag-chip ${target ? '' : 'opacity-60'}`} style={{ left: d.x + 14, top: d.y + 12 }}>
          {!groupDrag && d.source.kind !== 'rail' && <span>{d.label}</span>}
          <span className={groupDrag ? undefined : 'text-neutral-400'}>{hint}</span>
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
      return { leader: members[0], label: members.map((m) => getPanelDisplayTitle(m, t)).join('・') };
    }) : [];
  const groupSize = layout.order.filter((p) => layout.panels[p].place === 'float' && layout.panels[p].visible && layout.panels[p].group === myGroup).length;
  const canMinimize = place === 'float' && !isTool;
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
  const menuHeight = Math.min(window.innerHeight - 8, (174 + windows.length * 30 + (canMinimize ? 30 : 0)) * ui);
  return (
    <div className="relative">
      <button ref={ref} type="button" aria-label={t.dock.panelPosition} title={t.dock.dockOrFloat} aria-expanded={open}
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
              {o.icon}<span>{!isTool ? t.dock[o.label] : o.place === 'left' ? t.toolOptions.dockToolLeft : o.place === 'right' ? t.toolOptions.dockToolRight : t.toolOptions.floatTool}</span>
            </button>
          ))}
          {canMinimize && (
            <button type="button" role="menuitem" onClick={() => { dockActions.minimizeFloatGroup(myGroup); setOpen(false); }} className={item}>
              <Minimize2 className="h-3.5 w-3.5" /><span>{t.dock.minimizeToPill}</span>
            </button>
          )}
          {windows.length > 0 && (
            <>
              <div className="my-1 h-px bg-neutral-700/70" />
              <div className="px-2 py-0.5 text-[10px] text-neutral-500">{t.dock.mergeAsTab}</div>
              {windows.map((w) => (
                <button key={w.leader} type="button" role="menuitem" onClick={() => { dockActions.mergeInto(id, w.leader); setOpen(false); }} className={item}>
                  <Square className="h-3.5 w-3.5" /><span className="truncate">{w.label}</span>
                </button>
              ))}
            </>
          )}
          {place === 'float' && groupSize > 1 && (
            <button type="button" role="menuitem" onClick={() => { dockActions.detach(id); setOpen(false); }} className={item}>
              <Square className="h-3.5 w-3.5" /><span>{t.dock.detachWindow}</span>
            </button>
          )}
          <div className="my-1 h-px bg-neutral-700/70" />
          <button type="button" role="menuitem" onClick={() => { if (onClose) onClose(); else dockActions.hide(id); setOpen(false); }} className={item}>
            <X className="h-3.5 w-3.5" /><span>{isTool ? t.common.close : place === 'float' && groupSize > 1 ? t.dock.hideTab : t.dock.hidePanel}</span>
          </button>
        </div>, document.body
      )}
    </div>
  );
};

const MinimizeToPillButton: React.FC<{ group: string; onClick: () => void }> = ({ group, onClick }) => {
  const { t } = useI18n();
  return (
    <button type="button" data-dock-minimize-pill={group} aria-label={t.dock.minimizeToPill} title={t.dock.minimizeToPill}
      onClick={onClick} className="atelier-icon-btn h-6 w-6">
      <Minimize2 className="h-3.5 w-3.5" />
    </button>
  );
};

const PanelHeader: React.FC<{
  def: PanelDef;
  place: PanelPlace;
  collapsed: boolean;
  group?: string;
  onMinimizeToPill?: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
}> = ({ def, place, collapsed, group, onMinimizeToPill, onPointerDown }) => {
  const { t } = useI18n();
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={() => dockActions.setCollapsed(def.id, !collapsed)}
      style={{ touchAction: 'none' }}
      title={place === 'float' ? t.dock.dragFloatHeaderHint : t.dock.dragPanelHint}
      className="flex h-8 shrink-0 cursor-grab items-center gap-1 border-b border-neutral-700/70 bg-neutral-800/60 pl-1 pr-1 text-xs active:cursor-grabbing"
      data-float-header={place === 'float' ? '' : undefined}
      data-dock-header={place !== 'float' ? '' : undefined}
    >
      <button type="button" aria-expanded={!collapsed} aria-label={(collapsed ? t.dock.expandPanel : t.dock.collapsePanel).replace('{title}', def.title)}
        onClick={() => dockActions.setCollapsed(def.id, !collapsed)} onPointerDown={(e) => e.stopPropagation()}
        className="atelier-icon-btn h-6 w-6">
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      <span className="text-indigo-400 [&>svg]:h-3.5 [&>svg]:w-3.5">{def.icon}</span>
      <span className="truncate font-semibold text-neutral-100">{def.title}</span>
      {def.badge}
      <div className="ml-auto flex items-center" onPointerDown={(e) => e.stopPropagation()}>
        {place === 'float' && group && <MinimizeToPillButton group={group} onClick={() => onMinimizeToPill?.()} />}
        <PanelMenu id={def.id} place={place} onClose={def.onClose} />
        <button type="button" aria-label={`${t.dock.hidePanel} · ${def.title}`} title={t.dock.hidePanelHint}
          onClick={() => def.onClose ? def.onClose() : dockActions.hide(def.id)} className="atelier-icon-btn h-6 w-6">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

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

const groupDockPanels = (panels: PanelDef[], layout: ReturnType<typeof useDockLayout>) => {
  const groups = new Map<string, PanelDef[]>();
  for (const def of panels) {
    const group = layout.panels[def.id].group;
    const tabs = groups.get(group);
    if (tabs) tabs.push(def);
    else groups.set(group, [def]);
  }
  return Array.from(groups);
};

const DockedPanels: React.FC<{ stacks: ReturnType<typeof groupDockPanels>; vertical: boolean; place: DockSide }> = ({ stacks, vertical, place }) => {
  const { t } = useI18n();
  const layout = useDockLayout();
  const floats = useFloatsAllowed();
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className={`flex min-h-0 min-w-0 flex-1 ${vertical ? 'flex-col' : 'flex-row'}`}>
      {stacks.map(([group, tabs], i) => {
        const def = tabs[0];
        const p = layout.panels[def.id];
        const active = tabs.find((tab) => tab.id === layout.activeTab[group]) ?? def;
        const prev = stacks[i - 1]?.[1][0];
        const showSplitter = prev && !layout.panels[prev.id].collapsed && !p.collapsed;
        return (
          <React.Fragment key={group}>
            {showSplitter && <Splitter a={prev.id} b={def.id} vertical={vertical} containerRef={ref} />}
            {!showSplitter && i > 0 && <div className={vertical ? 'h-px shrink-0 bg-neutral-700/70' : 'w-px shrink-0 bg-neutral-700/70'} />}
            <section
              data-panel={def.id}
              data-dock-group={group}
              data-dock-leader={def.id}
              aria-label={active.title}
              className="flex min-h-0 min-w-0 flex-col overflow-hidden"
              style={p.collapsed ? { flex: '0 0 auto' } : { flex: `${p.weight} 1 0px`, minHeight: vertical ? 70 : undefined, minWidth: vertical ? undefined : 160 }}
            >
              {tabs.length === 1 ? <PanelHeader def={def} place={place} collapsed={p.collapsed}
                onPointerDown={(e) => beginPanelDrag(e, { kind: 'panel', id: def.id }, def.title, floats)} /> : (
                <div data-dock-header="" title={t.dock.dragPanelHint} style={{ touchAction: 'none' }}
                  onPointerDown={(e) => beginPanelDrag(e, { kind: 'group', group, ids: tabs.map((tab) => tab.id), fromDock: true }, active.title, floats)}
                  onDoubleClick={() => dockActions.setCollapsed(def.id, !p.collapsed)}
                  className="flex h-8 shrink-0 cursor-grab items-center border-b border-neutral-700/70 bg-neutral-800/60 px-1 active:cursor-grabbing">
                  <span data-dock-drag-handle="" className="grid h-7 w-7 shrink-0 place-items-center text-neutral-400">
                    <GripHorizontal aria-hidden className="h-4 w-4" />
                  </span>
                  <div className="flex min-w-0 flex-1 items-stretch self-stretch overflow-x-auto no-scrollbar" role="tablist" aria-label={t.dock.windowTabsAria}>
                    {tabs.map((tab) => (
                      <button key={tab.id} type="button" role="tab" aria-selected={tab.id === active.id && !p.collapsed}
                        data-dock-tab={tab.id} title={t.dock.dragTabDetachHint} style={{ touchAction: 'none' }}
                        className={`flex shrink-0 cursor-grab items-center gap-1 px-1.5 text-xs [&>svg]:h-3.5 [&>svg]:w-3.5 ${tab.id === active.id && !p.collapsed ? 'border-b border-indigo-400 bg-indigo-600/20 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-700'}`}
                        onClick={() => dockActions.activate(tab.id)}
                        onDoubleClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          beginPanelDrag(e, { kind: 'panel', id: tab.id }, tab.title, floats);
                        }}>
                        {tab.icon}{tab.title}
                      </button>
                    ))}
                  </div>
                  <div className="flex shrink-0 items-center" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                    <button type="button" aria-expanded={!p.collapsed} aria-label={(p.collapsed ? t.dock.expandPanel : t.dock.collapsePanel).replace('{title}', active.title)}
                      onClick={() => dockActions.setCollapsed(def.id, !p.collapsed)} className="atelier-icon-btn h-6 w-6">
                      {p.collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>
                    <PanelMenu id={active.id} place={place} onClose={active.onClose} />
                  </div>
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
      <DockedPanels stacks={groupDockPanels(list, layout)} vertical place={side} />
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
  const stacks = groupDockPanels(list, layout);
  const allCollapsed = stacks.every(([, [leader]]) => layout.panels[leader.id].collapsed);
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
      <DockedPanels stacks={stacks} vertical={false} place="bottom" />
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

interface FloatingGroupProps {
  group: string;
  defs: PanelDef[];
  zIndex: number;
  onFocus: () => void;
}

const FloatingPillGroup: React.FC<FloatingGroupProps & { groupState: FloatGroupState }> = ({ group, defs, zIndex, onFocus, groupState }) => {
  const { t } = useI18n();
  const layout = useDockLayout();
  const floats = useFloatsAllowed();
  const ui = useUiScale();
  const pillRef = useRef<HTMLElement>(null);
  const suppressClickRef = useRef(false);
  const cancelDragRef = useRef<(() => void) | undefined>(undefined);
  const [dragPos, setDragPos] = useState<FloatPillPos | null>(null);
  const { orientation, pillPos } = groupState;
  const vertical = orientation === 'vertical';
  const single = defs.length === 1;
  const leader = defs[0];
  const active = defs.find((def) => def.id === layout.activeTab[group]) ?? leader;
  const rightDockOpen = Object.values(layout.panels).some((panel) => panel.visible && panel.place === 'right');
  const { x, y } = pillPos ?? clampRect(layout.panels[leader.id].float, rightDockOpen ? layout.dockSize.right : 0);
  const pos = dragPos ?? { x, y };
  const pillSize = getPillSizePx(ui);

  useLayoutEffect(() => {
    const keepInViewport = () => {
      const el = pillRef.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      const w = Math.ceil(width);
      const h = Math.ceil(height);
      const next = clampPillPos({ x: Math.round(x), y: Math.round(y) }, w, h);
      if (!pillPos || next.x !== pillPos.x || next.y !== pillPos.y) dockActions.setFloatGroupPillPos(group, next);
      setDragPos((current) => current && clampPillPos(current, w, h));
    };
    keepInViewport();
    window.addEventListener('resize', keepInViewport);
    return () => window.removeEventListener('resize', keepInViewport);
  }, [defs.length, group, orientation, pillPos, ui, x, y]);

  useLayoutEffect(() => () => cancelDragRef.current?.(), []);

  const dragPill = (ev: React.PointerEvent, item?: PanelDef) => {
    const el = pillRef.current;
    if (ev.button !== 0 || !el) return;
    cancelDragRef.current?.();
    suppressClickRef.current = false;
    if (item) {
      cancelDragRef.current = beginPanelDrag(ev, { kind: 'pill-item', id: item.id, fromGroup: group, orientation }, item.title, floats, {
        onMove: () => { suppressClickRef.current = true; },
      });
      return;
    }
    const start = el.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const positionAt = (dx: number, dy: number) => clampPillPos(
      { x: Math.round(start.left + dx), y: Math.round(start.top + dy) }, Math.ceil(start.width), Math.ceil(start.height),
    );
    cancelDragRef.current = beginPanelDrag(ev, { kind: 'pill-group', group, ids: defs.map((def) => def.id) }, '', floats, {
      exclude: el,
      onMove: (dx, dy) => {
        suppressClickRef.current = true;
        setDragPos(positionAt(dx, dy));
      },
      onEnd: (end, target) => {
        if (!target && end.type !== 'pointercancel') {
          dockActions.setFloatGroupPillPos(group, positionAt(end.clientX - startX, end.clientY - startY));
        }
        setDragPos(null);
      },
    });
  };

  const orientationLabel = vertical ? t.dock.switchToHorizontal : t.dock.switchToVertical;
  const controlSize = vertical ? 'h-6 w-8' : 'h-8 w-6';
  const controlClass = `atelier-pill-btn ${controlSize}`;
  return (
    <section ref={pillRef}
      data-float-group={group} data-float-pill={group} data-pill-orientation={orientation} data-pill-count={defs.length}
      role="region" aria-label={t.dock.pillGroupAria.replace('{titles}', defs.map((def) => def.title).join('、'))}
      onPointerDown={onFocus}
      style={{ left: pos.x, top: pos.y, zIndex, ...(single
        ? { width: pillSize, height: pillSize }
        : { width: 'max-content', maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100dvh - 56px)' }) }}
      className={`atelier-popover atelier-float-pill fixed flex select-none items-center rounded-full ${vertical ? 'flex-col' : 'flex-row'} ${single ? '' : 'gap-1 overflow-auto p-1 no-scrollbar'}`}>
      {!single && (
        <button type="button" data-pill-grip={group} aria-label={t.dock.dragPillHint} title={t.dock.dragPillHint}
          onPointerDown={(ev) => dragPill(ev)} className={`${controlClass} cursor-grab touch-none active:cursor-grabbing`}>
          {vertical ? <GripHorizontal className="h-4 w-4" /> : <GripVertical className="h-4 w-4" />}
        </button>
      )}
      {defs.map((def) => (
        <button key={def.id} type="button" data-pill-panel={def.id} data-pill-active={single ? undefined : def.id === active.id}
          aria-label={t.dock.expandFromPill.replace('{title}', def.title)}
          title={single ? `${def.title} — ${t.dock.dragPillHint}` : t.dock.dragPillIconHint.replace('{title}', def.title)}
          onPointerDown={(ev) => dragPill(ev, single ? undefined : def)}
          onClick={(ev) => {
            if (ev.detail > 0 && suppressClickRef.current) return;
            onFocus();
            dockActions.expandFloatGroup(group, def.id);
          }}
          className={`atelier-pill-btn touch-none ${single ? 'h-full w-full cursor-grab active:cursor-grabbing' : 'h-8 w-8'}`}>
          {renderPanelIcon(def.id, 'h-4 w-4')}
        </button>
      ))}
      {!single && (
        <button type="button" data-pill-toggle-orientation={group} aria-label={orientationLabel} title={orientationLabel}
          onClick={() => dockActions.toggleFloatGroupOrientation(group)} className={controlClass}>
          {vertical ? <ArrowLeftRight className="h-4 w-4" /> : <ArrowUpDown className="h-4 w-4" />}
        </button>
      )}
    </section>
  );
};

/**
 * One floating window. Several floating panels can share it as tabs (CSP-style). Drag the title bar to
 * move it (onto another window = merge, onto a dock or screen edge = dock it), drag a tab out to take
 * it apart, and resize from any edge or corner.
 */
const FloatingGroup: React.FC<FloatingGroupProps> = ({ group, defs, zIndex, onFocus }) => {
  const { t } = useI18n();
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
  const minimize = () => dockActions.minimizeFloatGroup(group);

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
          <PanelHeader def={leader} place="float" collapsed={p.collapsed} group={group} onMinimizeToPill={minimize} onPointerDown={dragWindow} />
        ) : (
          <div onPointerDown={dragWindow} onDoubleClick={() => dockActions.setCollapsed(leader.id, !p.collapsed)} style={{ touchAction: 'none' }}
            data-float-header=""
            title={t.dock.dragFloatHeaderHint}
            className="flex h-8 shrink-0 cursor-grab items-end gap-0.5 border-b border-neutral-700/70 bg-neutral-800/60 px-1 text-xs active:cursor-grabbing">
            <span data-float-drag-handle="" title={t.dock.dragFloatHeaderHint} className="grid h-7 w-7 shrink-0 place-items-center text-neutral-400">
              <GripHorizontal aria-hidden className="h-4 w-4" />
            </span>
            <div role="tablist" aria-label={t.dock.windowTabsAria} className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto no-scrollbar">
              {defs.map((d) => (
                <button key={d.id} type="button" role="tab" aria-selected={d.id === active.id}
                  onClick={() => dockActions.setActiveTab(group, d.id)}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    beginPanelDrag(e, { kind: 'panel', id: d.id }, d.title, floats);
                  }}
                  style={{ touchAction: 'none' }}
                  title={t.dock.dragTabDetachHint}
                  className={`flex h-7 shrink-0 items-center gap-1 rounded-t-md px-2 ${d.id === active.id ? 'bg-neutral-900 text-white' : 'text-neutral-400 hover:text-neutral-100'}`}>
                  <span className="text-indigo-400 [&>svg]:h-3.5 [&>svg]:w-3.5">{d.icon}</span>
                  <span className="truncate">{d.title}</span>
                  {d.badge}
                </button>
              ))}
            </div>
            <div className="mb-0.5 flex items-center" onPointerDown={(e) => e.stopPropagation()}>
              <MinimizeToPillButton group={group} onClick={minimize} />
              <PanelMenu id={active.id} place="float" />
              <button type="button" aria-label={`${t.dock.hideTab} · ${active.title}`} title={t.dock.hideTab}
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
      {Array.from(groups.entries()).map(([group, defs], i) => {
        const groupState = getFloatGroupState(layout, group);
        const props = { group, defs, zIndex: front === group ? 46 : 40 + i, onFocus: () => setFront(group) };
        return groupState.minimized
          ? <FloatingPillGroup key={group} {...props} groupState={groupState} />
          : <FloatingGroup key={group} {...props} />;
      })}
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
