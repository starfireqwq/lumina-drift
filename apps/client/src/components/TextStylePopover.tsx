import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BoxSelect, Ellipsis } from 'lucide-react';
import type { LayerTextMeta } from '@atelier/shared';
import { useI18n } from '../context/I18nContext';
import { useAnchoredPopover } from '../utils/popoverPosition';
import { OverlayPresence } from './OverlayPresence';
import { ColorPopoverButton } from './workspace/ToolOptionsBar';

export const textToolButton = 'flex h-7 min-w-7 shrink-0 items-center justify-center rounded px-1 hover:bg-neutral-800 aria-pressed:bg-indigo-600/80';

export function TextNumberField({ label, value, min, max, step = 1, compact, testId, onChange }: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  step?: number;
  compact?: boolean;
  testId?: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className={`flex min-w-0 items-center gap-2 ${compact ? 'shrink-0' : 'justify-between'}`} title={label}>
      {!compact && <span className="min-w-0 break-words">{label}</span>}
      <input type="number" data-testid={testId} min={min} max={max} step={step} aria-label={label}
        value={draft ?? value ?? ''} placeholder={value === null ? '—' : undefined}
        onChange={(e) => {
          setDraft(e.currentTarget.value);
          const next = e.currentTarget.valueAsNumber;
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
        }}
        onBlur={() => setDraft(null)}
        className={`atelier-field h-7 shrink-0 px-1 text-[11px] ${compact ? 'w-12' : 'w-16'}`} />
    </label>
  );
}

const DEFAULT_SHADOW = { color: '#000000', offsetX: 2, offsetY: 2, blur: 4, opacity: 0.5 };
type TextShadow = NonNullable<LayerTextMeta['shadow']>;

export function TextStylePopover({ meta, onPatch, onToggleBox }: {
  meta: LayerTextMeta;
  onPatch: (patch: Partial<LayerTextMeta>) => void;
  onToggleBox: () => void;
}) {
  const { t: { textEditor: t } } = useI18n();
  const [moreOpen, setMoreOpen] = useState(false);
  const [shadowOpen, setShadowOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const shadowButton = useRef<HTMLButtonElement>(null);
  const morePos = useAnchoredPopover(moreOpen, moreButton, null, { align: 'right', fallbackWidth: 256 });
  const shadowPos = useAnchoredPopover(shadowOpen, shadowButton, null, { align: 'right', fallbackWidth: 224 });
  const paintOrder = meta.paintOrder ?? 'stroke-behind';
  const shadow = meta.shadow ?? DEFAULT_SHADOW;
  const setShadow = (patch: Partial<TextShadow>) => onPatch({ shadow: { ...shadow, ...patch } });

  const close = () => {
    setMoreOpen(false);
    setShadowOpen(false);
  };
  useEffect(() => {
    if (!moreOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('[data-outline-color]')) return;
      if (!target.closest('[data-text-editor-popover]')) close();
      else if (!target.closest('[data-text-editor-shadow]')) setShadowOpen(false);
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [moreOpen]);

  return (
    <>
      <button ref={moreButton} type="button" data-testid="text-editor-more" data-text-editor-popover
        aria-label={t.more} title={t.more} aria-expanded={moreOpen} aria-haspopup="dialog"
        onClick={() => moreOpen ? close() : setMoreOpen(true)} className={textToolButton}><Ellipsis size={16} /></button>
      {createPortal(
        <>
          <OverlayPresence open={moreOpen} kind="popover">
            <div ref={morePos.setPopoverEl} data-text-editor-popover role="dialog" aria-label={t.more} inert={!moreOpen}
              className="atelier-popover fixed z-[93] grid w-64 max-w-[calc(100dvw-16px)] gap-2 overflow-y-auto p-2 text-xs"
              style={{ left: morePos.left, top: morePos.top, maxHeight: morePos.maxHeight }}>
              <TextNumberField label={t.letterSpacing} min={-200} max={1000} step={10} value={meta.letterSpacing ?? 0}
                testId="text-editor-letter-spacing" onChange={(letterSpacing) => onPatch({ letterSpacing })} />
              <TextNumberField label={t.lineHeight} min={0.8} max={3} step={0.1} value={meta.lineHeight}
                testId="text-editor-line-height" onChange={(lineHeight) => onPatch({ lineHeight })} />
              <TextNumberField label={t.strokeWidth} min={0} max={30} value={meta.strokeWidth}
                testId="text-editor-stroke-width" onChange={(strokeWidth) => onPatch({ strokeWidth })} />
              {meta.strokeWidth > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <ColorPopoverButton label={t.strokeColor} title={t.strokeColor} color={meta.strokeColor} data-testid="text-editor-stroke-color"
                    onChange={(strokeColor) => onPatch({ strokeColor })} />
                  <button type="button" data-testid="text-editor-paint-order" data-value={paintOrder}
                    className={textToolButton} onClick={() => onPatch({ paintOrder: paintOrder === 'stroke-front' ? 'stroke-behind' : 'stroke-front' })}>
                    {paintOrder === 'stroke-front' ? t.strokeFront : t.strokeBehind}
                  </button>
                </div>
              )}
              <button type="button" data-testid="text-editor-box-toggle" aria-pressed={Boolean(meta.box)}
                onClick={onToggleBox} className={`${textToolButton} gap-1`}><BoxSelect size={14} />{t.wrapBox}</button>
              <button ref={shadowButton} type="button" data-testid="text-editor-shadow-toggle" data-text-editor-shadow
                aria-expanded={shadowOpen} aria-haspopup="dialog" onClick={() => setShadowOpen((open) => !open)}
                className={textToolButton}>{t.shadow}</button>
            </div>
          </OverlayPresence>
          <OverlayPresence open={shadowOpen} kind="popover">
            <div ref={shadowPos.setPopoverEl} data-text-editor-popover data-text-editor-shadow role="dialog" aria-label={t.shadow} inert={!shadowOpen}
              className="atelier-popover fixed z-[94] grid w-56 max-w-[calc(100dvw-16px)] gap-2 overflow-y-auto p-2 text-xs"
              style={{ left: shadowPos.left, top: shadowPos.top, maxHeight: shadowPos.maxHeight }}>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={Boolean(meta.shadow)} onChange={(e) => onPatch({ shadow: e.target.checked ? shadow : null })} />
                {t.shadowEnabled}
              </label>
              {meta.shadow && <>
                <ColorPopoverButton label={t.shadowColor} title={t.shadowColor} color={shadow.color} onChange={(color) => setShadow({ color })} />
                <TextNumberField label={t.shadowX} min={-1000} max={1000} value={shadow.offsetX} onChange={(offsetX) => setShadow({ offsetX })} />
                <TextNumberField label={t.shadowY} min={-1000} max={1000} value={shadow.offsetY} onChange={(offsetY) => setShadow({ offsetY })} />
                <TextNumberField label={t.shadowBlur} min={0} max={200} value={shadow.blur} onChange={(blur) => setShadow({ blur })} />
                <TextNumberField label={t.shadowOpacity} min={0} max={100} value={Math.round(shadow.opacity * 100)} onChange={(opacity) => setShadow({ opacity: opacity / 100 })} />
              </>}
            </div>
          </OverlayPresence>
        </>,
        document.body,
      )}
    </>
  );
}
