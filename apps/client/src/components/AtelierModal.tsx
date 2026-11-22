import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

const WIDTHS = { sm: 'sm:max-w-sm', md: 'sm:max-w-md', lg: 'sm:max-w-xl', xl: 'sm:max-w-2xl' } as const;

/** Footer buttons of every dialog */
export const modalButton = {
  secondary: 'rounded-lg px-4 py-2 text-xs text-neutral-300 transition hover:bg-neutral-800 disabled:opacity-50',
  primary: 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50',
  danger: 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:opacity-50',
};

interface AtelierModalProps {
  title: React.ReactNode;
  icon?: React.ReactNode;
  /** One line under the title */
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Between the header and the body, e.g. tabs */
  toolbar?: React.ReactNode;
  width?: keyof typeof WIDTHS;
  tone?: 'default' | 'danger';
  /** Makes the panel a form, so Enter submits */
  onSubmit?: (e: React.FormEvent) => void;
  /** Body without the default padding (it brings its own layout) */
  flush?: boolean;
}

/**
 * The one dialog look (.atelier-modal): a header with the title and a close button, a body that
 * scrolls and a footer that stays. On a phone it is a bottom sheet the width of the screen.
 * Esc and a click on the backdrop close it.
 */
export const AtelierModal: React.FC<AtelierModalProps> = ({
  title, icon, subtitle, onClose, children, footer, toolbar, width = 'sm', tone = 'default', onSubmit, flush,
}) => {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement & HTMLFormElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Esc closes wherever the focus is (a dialog opened from a menu starts with the focus outside it);
  // the focus moves in unless a field already took it (autoFocus)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const panelClass = `atelier-modal flex outline-none max-h-[calc(100dvh-1rem)] w-full flex-col overflow-hidden rounded-b-none sm:max-h-[calc(100dvh-2rem)] sm:rounded-b-[14px] ${WIDTHS[width]}`;
  const content = (
    <>
      <div className={`flex shrink-0 items-start justify-between gap-3 border-b px-5 py-3.5 ${tone === 'danger' ? 'border-rose-900/60 bg-rose-950/20' : 'border-neutral-800'}`}>
        <div className="min-w-0">
          <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold text-white">
            {icon && <span className={`shrink-0 [&>svg]:h-4 [&>svg]:w-4 ${tone === 'danger' ? 'text-rose-400' : 'text-indigo-400'}`}>{icon}</span>}
            <span className="truncate">{title}</span>
          </h2>
          {subtitle && <p className="mt-0.5 text-[11px] text-neutral-400">{subtitle}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="關閉" className="atelier-icon-btn -mr-1 h-8 w-8 shrink-0"><X className="h-4 w-4" /></button>
      </div>
      {toolbar}
      <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain text-xs ${flush ? '' : 'px-5 py-4'}`}>{children}</div>
      {footer && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-neutral-800 bg-neutral-950/40 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-3">
          {footer}
        </div>
      )}
    </>
  );

  return (
    <div
      className="atelier-modal-backdrop fixed inset-0 z-[90] flex items-end justify-center sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {onSubmit
        ? <form ref={panelRef} tabIndex={-1} onSubmit={onSubmit} className={panelClass}>{content}</form>
        : <div ref={panelRef} tabIndex={-1} className={panelClass}>{content}</div>}
    </div>
  );
};
