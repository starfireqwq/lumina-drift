import React, { useEffect, useId, useRef, useState } from 'react';
import { PanelLeft, PanelRight, X } from 'lucide-react';
import { dragDockableTool, EDGE_HANDLES, Edge, resizeRect, startDrag } from './DockSystem';
import { dockActions, type ToolDockPanelId, usePhoneLayout } from './dockStore';
import { useI18n } from '../../context/I18nContext';
import { getUiScale, onUiRescale } from '../../theme/uiScale';

interface Rect { x: number; y: number; w: number; h: number }
interface StoredRect extends Rect { uiScale?: number }

interface ToolWindowProps {
  /** Remembers where the user left this window (localStorage atelier_toolwin_<id>) */
  id: string;
  title: React.ReactNode;
  icon?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Small buttons in the title bar, left of ✕ */
  actions?: React.ReactNode;
  /** First-time rect; x < 0 = that far from the right edge. h = 0: as tall as the content */
  initial: Rect;
  minW?: number;
  minH?: number;
  /** Esc closes it (default true) */
  closeOnEsc?: boolean;
  bodyClassName?: string;
  dockPanel?: ToolDockPanelId;
  embedded?: boolean;
  fitViewport?: boolean;
  dataAttributes?: Record<`data-${string}`, string>;
}

const KEY = (id: string) => `atelier_toolwin_${id}`;
let nextToolWindowZ = 60;
const claimTopZ = () => {
  nextToolWindowZ = nextToolWindowZ >= 78 ? 61 : nextToolWindowZ + 1;
  return nextToolWindowZ;
};

const loadRect = (id: string, initial: Rect): Rect => {
  const ui = getUiScale();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY(id)) || 'null') as StoredRect | null;
    if (saved && [saved.x, saved.y, saved.w, saved.h].every(Number.isFinite)) {
      const savedScale = Number.isFinite(saved.uiScale) && saved.uiScale! > 0 ? saved.uiScale! : 1;
      const factor = ui / savedScale;
      return {
        x: saved.x,
        y: saved.y,
        w: Math.round(saved.w * factor),
        h: saved.h ? Math.round(saved.h * factor) : 0,
      };
    }
  } catch { /* ignore */ }
  const w = Math.round(initial.w * ui);
  const h = initial.h ? Math.round(initial.h * ui) : 0;
  const x = initial.x < 0 ? window.innerWidth + Math.round(initial.x * ui) - w : Math.round(initial.x * ui);
  return { x, y: Math.round(initial.y * ui), w, h };
};

const clampTo = (r: Rect, minW: number, minH: number, keepInside = false, fitViewport = false): Rect => {
  const ui = getUiScale();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const topBar = Math.round(48 * ui);
  const minWScaled = Math.min(Math.round(minW * ui), vw - 16);
  const minHScaled = Math.min(Math.round(minH * ui), Math.max(80, vh - topBar - 8));
  const w = Math.max(minWScaled, Math.min(r.w, vw - 16));
  const h = r.h ? Math.max(minHScaled, Math.min(r.h, vh - topBar - 8)) : 0;
  const minX = keepInside || fitViewport ? 8 : 8 - w + 96;
  const maxX = keepInside || fitViewport ? Math.max(8, vw - w - 8) : vw - 96;
  const maxY = fitViewport ? vh - (h || minHScaled) - 8 : vh - 44;
  return { x: Math.max(minX, Math.min(maxX, r.x)), y: Math.max(topBar, Math.min(maxY, r.y)), w, h };
};

/**
 * A tool window over the canvas (curves, filters, rulers, colour wheel…): one look with the docked panels,
 * drag the title bar to move it, resize from any edge or corner, and it reopens where it was left.
 * Not modal: the canvas stays usable. On a phone it is a bottom sheet.
 */
export const ToolWindow: React.FC<ToolWindowProps> = ({
  id, title, icon, onClose, children, footer, actions, initial, minW = 260, minH = 160, closeOnEsc = true, bodyClassName = 'p-3',
  dockPanel, embedded = false, fitViewport = false, dataAttributes,
}) => {
  const phone = usePhoneLayout();
  const { t } = useI18n();
  const titleId = useId();
  const [zIndex, setZIndex] = useState<number>(() => claimTopZ());
  const [rect, setRect] = useState<Rect>(() => clampTo(loadRect(id, initial), minW, minH, true, fitViewport));
  const bringToFront = () => setZIndex(claimTopZ());
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const boxRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!closeOnEsc) return;
    const onKey = (e: KeyboardEvent) => {
      // A live dialog or open dropdown menu above this window handles its own Esc (ignore closing animations)
      if (e.key !== 'Escape') return;
      const blockers = document.querySelectorAll('[aria-modal="true"], [role="menu"]');
      for (const el of blockers) {
        if (!el.closest('[data-phase="closing"], .pointer-events-none')) return;
      }
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeOnEsc]);

  useEffect(() => {
    const onResize = () => setRect((r) => clampTo(r, minW, minH, true, fitViewport));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [minW, minH, fitViewport]);

  useEffect(() => {
    const unsub = onUiRescale((factor) => {
      setRect((r) => clampTo({
        ...r,
        w: Math.round(r.w * factor),
        h: r.h ? Math.round(r.h * factor) : 0,
      }, minW, minH, true, fitViewport));
    });
    return () => { unsub(); };
  }, [minW, minH, fitViewport]);

  const save = () => {
    try { localStorage.setItem(KEY(id), JSON.stringify({ ...rectRef.current, uiScale: getUiScale() })); } catch { /* ignore */ }
  };

  const move = (e: React.PointerEvent) => {
    if (e.button !== 0 || phone || embedded) return;
    const start = rectRef.current;
    let movingDock = false;
    const label = dockPanel === 'align' ? t.align.title : t.filters.title;
    startDrag(e, (dx, dy, ev) => {
      setRect(clampTo({ ...start, x: start.x + dx, y: start.y + dy }, minW, minH, false, fitViewport));
      if (dockPanel && (movingDock || Math.hypot(dx, dy) >= 6)) {
        movingDock = true;
        dragDockableTool(dockPanel, label, ev, boxRef.current, false);
      }
    }, (ev) => {
      save();
      if (dockPanel && movingDock) dragDockableTool(dockPanel, label, ev, boxRef.current, true);
    });
  };

  const resize = (edge: Edge) => (e: React.PointerEvent) => {
    // A content-sized window gets its measured height the moment it is first resized
    const start = { ...rectRef.current, h: rectRef.current.h || boxRef.current?.offsetHeight || Math.round(minH * getUiScale()) };
    startDrag(e, (dx, dy) => {
      const next = resizeRect(start, edge, dx, dy);
      setRect(clampTo(next, minW, minH, false, fitViewport));
    }, save);
  };

  const header = (
    <div onPointerDown={move} onDoubleClick={() => { if (!phone && !embedded) { setRect(clampTo(loadRect('__none__', initial), minW, minH, false, fitViewport)); try { localStorage.removeItem(KEY(id)); } catch { /* ignore */ } } }}
      style={{ touchAction: 'none' }}
      className={`flex h-9 shrink-0 items-center gap-2 border-b border-neutral-700/70 bg-neutral-800/60 pl-3 pr-1 ${phone || embedded ? '' : 'cursor-grab active:cursor-grabbing'}`}>
      {icon && <span className="shrink-0 text-indigo-400 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
      <h2 id={titleId} className="min-w-0 flex-1 truncate text-xs font-semibold text-neutral-100">{title}</h2>
      <div className="flex shrink-0 items-center" onPointerDown={(e) => e.stopPropagation()}>
        {actions}
        {dockPanel && !phone && !embedded && (
          <>
            <button type="button" onClick={() => dockActions.moveTo(dockPanel, 'left')} aria-label={t.toolOptions.dockToolLeft}
              title={t.toolOptions.dockToolLeft} className="atelier-icon-btn h-7 w-7"><PanelLeft className="h-4 w-4" /></button>
            <button type="button" onClick={() => dockActions.moveTo(dockPanel, 'right')} aria-label={t.toolOptions.dockToolRight}
              title={t.toolOptions.dockToolRight} className="atelier-icon-btn h-7 w-7"><PanelRight className="h-4 w-4" /></button>
          </>
        )}
        {!embedded && <button type="button" onClick={onClose} aria-label={t.common.close} className="atelier-icon-btn h-7 w-7"><X className="h-4 w-4" /></button>}
      </div>
    </div>
  );

  const body = (
    <>
      {header}
      <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain text-xs ${bodyClassName}`}>{children}</div>
      {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-neutral-800 bg-neutral-950/40 px-3 py-2">{footer}</div>}
    </>
  );

  if (embedded) {
    return (
      <section aria-labelledby={titleId} data-tool-window={id} {...dataAttributes}
        className={`flex min-w-0 flex-col ${fitViewport ? 'max-h-full overflow-hidden' : ''}`}>
        {body}
      </section>
    );
  }

  if (phone) {
    return (
      <section role="dialog" aria-labelledby={titleId} data-tool-window={id} {...dataAttributes}
        onPointerDown={bringToFront}
        style={{ zIndex }}
        className="atelier-popover atelier-menu-in fixed inset-x-0 bottom-0 flex max-h-[72dvh] flex-col overflow-hidden rounded-b-none pb-[env(safe-area-inset-bottom)]">
        {body}
      </section>
    );
  }

  return (
    <section
      ref={boxRef}
      role="dialog"
      aria-labelledby={titleId}
      data-tool-window={id}
      {...dataAttributes}
      onPointerDown={bringToFront}
      style={{ zIndex, left: rect.x, top: rect.y, width: rect.w, height: rect.h || undefined,
        maxHeight: fitViewport ? `calc(100dvh - ${rect.y + 8}px)` : rect.h ? undefined : `max(12rem, calc(100dvh - ${rect.y + 12}px))` }}
      className="atelier-popover atelier-window atelier-menu-in fixed flex select-none flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">{body}</div>
      {EDGE_HANDLES.map((h) => (
        <div key={h.edge} onPointerDown={resize(h.edge)} aria-hidden
          style={{ touchAction: 'none', cursor: h.cursor }} className={`absolute z-10 ${h.className}`} />
      ))}
    </section>
  );
};
