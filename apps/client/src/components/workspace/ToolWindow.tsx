import React, { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { EDGE_HANDLES, Edge, resizeRect, startDrag } from './DockSystem';
import { usePhoneLayout } from './dockStore';
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
}

const KEY = (id: string) => `atelier_toolwin_${id}`;

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

const clampTo = (r: Rect, minW: number, minH: number): Rect => {
  const ui = getUiScale();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const topBar = Math.round(48 * ui);
  const minWScaled = Math.min(Math.round(minW * ui), vw - 16);
  const minHScaled = Math.min(Math.round(minH * ui), Math.max(80, vh - topBar - 8));
  const w = Math.max(minWScaled, Math.min(r.w, vw - 16));
  const h = r.h ? Math.max(minHScaled, Math.min(r.h, vh - topBar - 8)) : 0;
  return { x: Math.max(8 - w + 96, Math.min(vw - 96, r.x)), y: Math.max(topBar, Math.min(vh - 44, r.y)), w, h };
};

/**
 * A tool window over the canvas (curves, filters, rulers, colour wheel…): one look with the docked panels,
 * drag the title bar to move it, resize from any edge or corner, and it reopens where it was left.
 * Not modal: the canvas stays usable. On a phone it is a bottom sheet.
 */
export const ToolWindow: React.FC<ToolWindowProps> = ({
  id, title, icon, onClose, children, footer, actions, initial, minW = 260, minH = 160, closeOnEsc = true, bodyClassName = 'p-3',
}) => {
  const phone = usePhoneLayout();
  const titleId = useId();
  const [rect, setRect] = useState<Rect>(() => clampTo(loadRect(id, initial), minW, minH));
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const boxRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!closeOnEsc) return;
    const onKey = (e: KeyboardEvent) => {
      // A dialog above this window handles its own Esc
      if (e.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return;
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeOnEsc]);

  useEffect(() => {
    const onResize = () => setRect((r) => clampTo(r, minW, minH));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [minW, minH]);

  useEffect(() => {
    const unsub = onUiRescale((factor) => {
      setRect((r) => clampTo({
        ...r,
        w: Math.round(r.w * factor),
        h: r.h ? Math.round(r.h * factor) : 0,
      }, minW, minH));
    });
    return () => { unsub(); };
  }, [minW, minH]);

  const save = () => {
    try { localStorage.setItem(KEY(id), JSON.stringify({ ...rectRef.current, uiScale: getUiScale() })); } catch { /* ignore */ }
  };

  const move = (e: React.PointerEvent) => {
    if (e.button !== 0 || phone) return;
    const start = rectRef.current;
    startDrag(e, (dx, dy) => setRect(clampTo({ ...start, x: start.x + dx, y: start.y + dy }, minW, minH)), save);
  };

  const resize = (edge: Edge) => (e: React.PointerEvent) => {
    // A content-sized window gets its measured height the moment it is first resized
    const start = { ...rectRef.current, h: rectRef.current.h || boxRef.current?.offsetHeight || Math.round(minH * getUiScale()) };
    startDrag(e, (dx, dy) => {
      const next = resizeRect(start, edge, dx, dy);
      setRect(clampTo(next, minW, minH));
    }, save);
  };

  const header = (
    <div onPointerDown={move} onDoubleClick={() => { if (!phone) { setRect((r) => clampTo(loadRect('__none__', initial), minW, minH)); try { localStorage.removeItem(KEY(id)); } catch { /* ignore */ } } }}
      style={{ touchAction: 'none' }}
      className={`flex h-9 shrink-0 items-center gap-2 border-b border-neutral-700/70 bg-neutral-800/60 pl-3 pr-1 ${phone ? '' : 'cursor-grab active:cursor-grabbing'}`}>
      {icon && <span className="shrink-0 text-indigo-400 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
      <h2 id={titleId} className="min-w-0 flex-1 truncate text-xs font-semibold text-neutral-100">{title}</h2>
      <div className="flex shrink-0 items-center" onPointerDown={(e) => e.stopPropagation()}>
        {actions}
        <button type="button" onClick={onClose} aria-label="關閉" className="atelier-icon-btn h-7 w-7"><X className="h-4 w-4" /></button>
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

  if (phone) {
    return (
      <section role="dialog" aria-labelledby={titleId} data-tool-window={id}
        className="atelier-popover atelier-menu-in fixed inset-x-0 bottom-0 z-[70] flex max-h-[72dvh] flex-col overflow-hidden rounded-b-none pb-[env(safe-area-inset-bottom)]">
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
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h || undefined, maxHeight: rect.h ? undefined : 'calc(100dvh - 4rem)' }}
      className="atelier-popover atelier-window atelier-menu-in fixed z-[70] flex select-none flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">{body}</div>
      {EDGE_HANDLES.map((h) => (
        <div key={h.edge} onPointerDown={resize(h.edge)} aria-hidden
          style={{ touchAction: 'none', cursor: h.cursor }} className={`absolute z-10 ${h.className}`} />
      ))}
    </section>
  );
};
