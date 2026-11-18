import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Move, X } from 'lucide-react';
import type { LayerTextMeta } from '@atelier/shared';
import type { CanvasViewport, ViewportState } from '../engine/Viewport';
import { caretRect, renderText, TEXT_FONTS } from '../engine/textLayer';
import { ColorPopoverButton } from './workspace/ToolOptionsBar';
import { useI18n } from '../context/I18nContext';

interface TextCanvasEditorProps {
  meta: LayerTextMeta;
  isNew: boolean;
  viewport: CanvasViewport | null;
  /** Re-renders on pan / zoom / rotate so the box stays on the text */
  viewportState: ViewportState;
  onChange: (meta: LayerTextMeta) => void;
  onCommit: () => void;
  onCancel: () => void;
}

/**
 * Text typed straight onto the canvas (no dialog). A transparent textarea sits exactly over the
 * text block (it follows zoom, rotation and flip); what you see is the live canvas preview, which
 * is the same rendering the layer gets (vertical forms, sideways Latin, 縱中橫). A small bar above
 * holds the text settings. Ctrl+Enter / 完成 / a click elsewhere on the canvas applies, Esc cancels.
 */
export const TextCanvasEditor: React.FC<TextCanvasEditorProps> = ({ meta, isNew, viewport, viewportState, onChange, onCommit, onCancel }) => {
  const { t } = useI18n();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{ x: number; y: number; mx: number; my: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // Keep the settings bar inside the canvas area (on a phone it ran off the right edge)
  useLayoutEffect(() => {
    const bar = barRef.current;
    const parent = bar?.offsetParent as HTMLElement | null;
    if (!bar || !parent) return;
    const want = Number(bar.dataset.left) || 8;
    bar.style.left = `${Math.max(8, Math.min(want, parent.clientWidth - bar.offsetWidth - 8))}px`;
  });
  useEffect(() => {
    areaRef.current?.focus({ preventScroll: true });
  }, []);
  // The caret is drawn where the canvas puts the next character (the textarea's own caret follows
  // the browser's vertical layout, which drifts after digits and spaces); IME text being composed
  // is part of the value, so the caret sits after it
  const [caret, setCaret] = useState<number | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  useEffect(() => {
    const read = () => {
      const a = areaRef.current;
      if (!a) return;
      setCaret(document.activeElement === a ? a.selectionEnd : null);
      setHasSelection(a.selectionStart !== a.selectionEnd);
    };
    read();
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, []);
  useEffect(() => {
    const a = areaRef.current;
    if (a && document.activeElement === a) setCaret(a.selectionEnd);
  }, [meta.content]);
  if (!viewport) return null;
  const set = (patch: Partial<LayerTextMeta>) => onChange({ ...meta, ...patch });

  const r = renderText(meta);
  const pad = Math.ceil(meta.strokeWidth + 2);
  const boxW = Math.max(meta.fontSize, r.canvas.width - pad * 2);
  const boxH = Math.max(meta.fontSize, r.canvas.height - pad * 2);
  const origin = viewport.canvasToScreen(meta.x, meta.y);
  const { zoom, rotation, mirrorX } = viewportState;
  const stop = (e: React.PointerEvent | React.MouseEvent) => e.stopPropagation();

  // Drag the grip: the text block follows the pointer in canvas pixels
  const startMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // synthetic events cannot capture
    }
    const p = viewport.screenToCanvas(e.clientX, e.clientY);
    dragRef.current = { x: meta.x, y: meta.y, mx: p.x, my: p.y };
  };
  const move = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = viewport.screenToCanvas(e.clientX, e.clientY);
    set({ x: Math.round(d.x + p.x - d.mx), y: Math.round(d.y + p.y - d.my) });
  };
  const endMove = () => {
    dragRef.current = null;
  };

  const field = 'atelier-field h-7 px-1 text-[11px]';
  return (
    <>
      {/* The text block itself: typing happens here */}
      <div onPointerDown={stop} onDoubleClick={stop} className="absolute left-0 top-0 z-30"
        style={{ transform: `translate(${origin.x}px, ${origin.y}px) rotate(${rotation}rad) scale(${mirrorX ? -zoom : zoom}, ${zoom})`, transformOrigin: '0 0' }}>
        <textarea ref={areaRef} value={meta.content} aria-label={t.textEditor.editorAria} spellCheck={false}
          placeholder={isNew ? t.textEditor.newTextPlaceholder : ''}
          onChange={(e) => set({ content: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              onCommit();
            }
          }}
          className="block resize-none overflow-hidden border-0 bg-transparent p-0 outline-none placeholder:text-neutral-400/70"
          style={{
            width: meta.vertical ? boxW : boxW + meta.fontSize, // room for the next character
            height: meta.vertical ? boxH + meta.fontSize : boxH,
            font: `${meta.fontSize}px ${meta.fontFamily}`,
            lineHeight: meta.lineHeight,
            writingMode: meta.vertical ? 'vertical-rl' : 'horizontal-tb',
            textOrientation: 'mixed',
            color: 'transparent', // the canvas preview shows the real rendering
            caretColor: 'transparent', // drawn below, where the canvas puts the next character
            outline: `${1.5 / zoom}px dashed rgba(99, 102, 241, 0.9)`,
            outlineOffset: `${pad / 2}px`,
            whiteSpace: 'pre',
          }} />
        {caret !== null && !hasSelection && (() => {
          const c = caretRect(meta, caret);
          return <span aria-hidden className="atelier-text-caret pointer-events-none absolute"
            style={{ left: c.x, top: c.y, width: c.w, height: c.h, background: meta.color === '#ffffff' ? '#6366f1' : meta.color }} />;
        })()}
      </div>

      {/* Settings bar just above the block (screen space, so it stays readable at any zoom) */}
      <div ref={barRef} data-left={Math.round(origin.x)} onPointerDown={stop} onDoubleClick={stop} role="toolbar" aria-label={t.textEditor.toolbarAria}
        className="no-scrollbar absolute z-40 flex max-w-[calc(100%-16px)] items-center gap-1 overflow-x-auto rounded-lg border border-neutral-700 bg-neutral-900/95 p-1 text-[11px] text-neutral-200 shadow-xl"
        style={{ left: Math.max(8, origin.x), top: Math.max(8, origin.y - 44) }}>
        <button type="button" onPointerDown={startMove} onPointerMove={move} onPointerUp={endMove} onPointerCancel={endMove}
          title={t.textEditor.dragMove} aria-label={t.textEditor.dragMove} style={{ touchAction: 'none' }}
          className="flex h-7 w-7 shrink-0 cursor-move items-center justify-center rounded hover:bg-neutral-800"><Move className="h-3.5 w-3.5" /></button>
        <div role="radiogroup" aria-label={t.textEditor.directionAria} className="flex shrink-0 overflow-hidden rounded border border-neutral-700">
          {[{ v: false, label: t.textEditor.horizontal }, { v: true, label: t.textEditor.vertical }].map((o) => (
            <button key={o.label} type="button" role="radio" aria-checked={meta.vertical === o.v} onClick={() => set({ vertical: o.v })}
              className={`h-7 px-2 ${meta.vertical === o.v ? 'bg-indigo-600 text-white' : 'hover:bg-neutral-800'}`}>{o.label}</button>
          ))}
        </div>
        <select value={meta.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })} aria-label={t.textEditor.fontAria} className={`${field} w-16 shrink-0`}>
          {TEXT_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <label className="flex shrink-0 items-center gap-0.5" title={t.textEditor.fontSize}>
          <span className="text-neutral-500">{t.textEditor.fontSize[0]}</span>
          <input type="number" min={8} max={400} value={meta.fontSize} aria-label={t.textEditor.fontSize}
            onChange={(e) => set({ fontSize: Math.max(8, Math.min(400, Number(e.target.value) || 8)) })} className={`${field} w-12`} />
        </label>
        <ColorPopoverButton label={t.textEditor.textColor} color={meta.color} onChange={(color) => set({ color })} />
        <label className="flex shrink-0 items-center gap-0.5" title={t.textEditor.strokeWidth}>
          <span className="text-neutral-500">{t.textEditor.strokeWidth[0]}</span>
          <input type="number" min={0} max={30} value={meta.strokeWidth} aria-label={t.textEditor.strokeWidth}
            onChange={(e) => set({ strokeWidth: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })} className={`${field} w-10`} />
        </label>
        {meta.strokeWidth > 0 && <ColorPopoverButton label={t.textEditor.strokeColor} color={meta.strokeColor} onChange={(strokeColor) => set({ strokeColor })} />}
        <label className="flex shrink-0 items-center gap-0.5" title={t.textEditor.lineHeight}>
          <span className="text-neutral-500">{t.textEditor.lineHeight}</span>
          <input type="number" min={0.8} max={3} step={0.1} value={meta.lineHeight} aria-label={t.textEditor.lineHeight}
            onChange={(e) => set({ lineHeight: Math.max(0.8, Math.min(3, Number(e.target.value) || 1.3)) })} className={`${field} w-12`} />
        </label>
        <button type="button" onClick={onCommit} disabled={!meta.content.trim()} title={t.textEditor.apply}
          className="flex h-7 shrink-0 items-center gap-1 rounded bg-indigo-600 px-2 font-bold text-white hover:bg-indigo-500 disabled:opacity-40"><Check className="h-3.5 w-3.5" />{t.textEditor.apply}</button>
        <button type="button" onClick={onCancel} title={t.textEditor.cancel} aria-label={t.textEditor.cancel}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-neutral-800"><X className="h-3.5 w-3.5" /></button>
      </div>
    </>
  );
};
