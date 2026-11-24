import React, { useEffect } from 'react';
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eraser,
  Layers,
  Scissors,
  X,
} from 'lucide-react';
import { useI18n } from '../context/I18nContext';

export interface TouchClipboardMenuProps {
  isOpen: boolean;
  canEdit: boolean;
  canPaste: boolean;
  hasSelection: boolean;
  onClose: () => void;
  onCut: () => void;
  onCopy: () => void;
  onCopyAll: () => void;
  onDuplicate: () => void;
  onPaste: () => void;
  onClearLayer: () => void;
}

/**
 * Procraft-inspired 3-finger swipe-down Copy & Paste floating panel, styled with
 * Lumina Drift's `.atelier-popover` surface (Liquid Glass / Chromatic Glass / Solid).
 */
export const TouchClipboardMenu: React.FC<TouchClipboardMenuProps> = ({
  isOpen,
  canEdit,
  canPaste,
  hasSelection,
  onClose,
  onCut,
  onCopy,
  onCopyAll,
  onDuplicate,
  onPaste,
  onClearLayer,
}) => {
  const { t } = useI18n();

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const act = (fn: () => void) => {
    onClose();
    fn();
  };

  const actions = [
    {
      id: 'cut',
      label: t.touchGestures.clipCut,
      icon: <Scissors className="h-5 w-5" />,
      disabled: !canEdit,
      onClick: () => act(onCut),
    },
    {
      id: 'copy',
      label: t.touchGestures.clipCopy,
      icon: <Copy className="h-5 w-5" />,
      disabled: false,
      onClick: () => act(onCopy),
    },
    {
      id: 'copy-all',
      label: t.touchGestures.clipCopyAll,
      icon: <Layers className="h-5 w-5" />,
      disabled: false,
      onClick: () => act(onCopyAll),
    },
    {
      id: 'duplicate',
      label: t.touchGestures.clipDuplicate,
      icon: <CopyPlus className="h-5 w-5" />,
      disabled: !canEdit,
      onClick: () => act(onDuplicate),
    },
    {
      id: 'paste',
      label: t.touchGestures.clipPaste,
      icon: <ClipboardPaste className="h-5 w-5" />,
      disabled: !canEdit || !canPaste,
      onClick: () => act(onPaste),
    },
    {
      id: 'clear',
      label: hasSelection ? t.touchGestures.clipClearSelection : t.touchGestures.clipClearLayer,
      icon: <Eraser className="h-5 w-5" />,
      disabled: !canEdit,
      danger: true,
      onClick: () => act(onClearLayer),
    },
  ];

  return (
    <div
      data-touch-clipboard-menu=""
      role="dialog"
      aria-label={t.touchGestures.clipTitle}
      className="fixed inset-0 z-[92] flex items-end justify-center px-3 pb-24 sm:items-center sm:pb-0 select-none touch-none"
    >
      {/* Armed backdrop prevents synthetic click from lifting 3 fingers from closing immediately */}
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
        onPointerDown={(e) => {
          e.currentTarget.dataset.armed = '1';
        }}
        onPointerCancel={(e) => {
          delete e.currentTarget.dataset.armed;
        }}
        onClick={(e) => {
          if (e.currentTarget.dataset.armed !== '1') return;
          delete e.currentTarget.dataset.armed;
          onClose();
        }}
      />

      <div
        className="atelier-popover atelier-menu-in relative z-10 w-full max-w-[460px] rounded-3xl p-3.5 shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/25" />
        <div className="mb-3 flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold tracking-wide text-neutral-100">{t.touchGestures.clipTitle}</span>
            {hasSelection && (
              <span className="rounded-full bg-indigo-500/25 px-2 py-0.5 text-[10px] font-medium text-indigo-200 ring-1 ring-indigo-400/40">
                {t.touchGestures.clipSelectionBadge}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.common.close}
            className="atelier-icon-btn h-8 w-8 rounded-full"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {actions.map((item) => (
            <button
              key={item.id}
              type="button"
              data-clipboard-action={item.id}
              disabled={item.disabled}
              onClick={item.onClick}
              className={`flex flex-col items-center justify-center gap-1.5 rounded-2xl border px-2 py-3 text-[11px] font-medium transition active:scale-95 disabled:pointer-events-none disabled:opacity-35 ${
                item.danger
                  ? 'border-rose-400/25 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
                  : 'border-white/10 bg-white/5 text-neutral-100 hover:bg-white/15'
              }`}
            >
              {item.icon}
              <span className="truncate max-w-full">{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
