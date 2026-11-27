import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, Check, Italic, Move, X } from 'lucide-react';
import { applyTextStyleToRange, type LayerTextMeta } from '@atelier/shared';
import type { CanvasViewport, ViewportState } from '../engine/Viewport';
import { caretRectFromLayout, createCanvasMeasurer, indexAtPoint, layoutText, selectionRectsFromLayout, textBoxRect } from '../engine/textLayer';
import { useI18n } from '../context/I18nContext';
import { getImportedFonts, subscribeFontLibrary } from '../services/fontLibrary';
import { FontPicker } from './FontPicker';
import { TextNumberField, TextStylePopover, textToolButton } from './TextStylePopover';
import { getToolbarTextStyle, initialTextBox, resizeTextBox, updateTextContent } from './textEditorState';
import { ColorPopoverButton } from './workspace/ToolOptionsBar';

interface TextCanvasEditorProps {
  meta: LayerTextMeta;
  isNew: boolean;
  viewport: CanvasViewport | null;
  viewportState: ViewportState;
  onChange: (meta: LayerTextMeta) => void;
  onCommit: () => void;
  onCancel: () => void;
}

type Point = { x: number; y: number };
type Drag =
  | { kind: 'select'; id: number; anchor: number }
  | { kind: 'move'; id: number; start: Point; origin: Point }
  | { kind: 'box'; id: number; start: Point; x: number; box: NonNullable<LayerTextMeta['box']>; vertical: boolean };

function capturePointer(event: React.PointerEvent<HTMLElement>) {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // Synthetic events may lack an active pointer.
  }
}

export const TextCanvasEditor: React.FC<TextCanvasEditorProps> = ({ meta, isNew, viewport, viewportState, onChange, onCommit, onCancel }) => {
  const { t: { textEditor: t } } = useI18n();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const composition = useRef<LayerTextMeta | null>(null);
  const currentMeta = useRef(meta);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  const measurer = useMemo(createCanvasMeasurer, []);
  const importedFont = useSyncExternalStore(subscribeFontLibrary, () => getImportedFonts().find((font) => font.family === meta.fontFamily));
  const layout = useMemo(() => layoutText(meta, measurer), [meta, measurer, importedFont]);
  const toolbarStyle = useMemo(() => getToolbarTextStyle(meta, selection.start, selection.end), [meta, selection]);
  const caret = focused && selection.start === selection.end ? caretRectFromLayout(layout, meta, selection.end) : null;
  const highlights = useMemo(() => selectionRectsFromLayout(layout, selection.start, selection.end), [layout, selection]);
  const origin = viewport?.canvasToScreen(meta.x, meta.y);

  const readSelection = () => {
    const area = areaRef.current;
    if (!area) return;
    const { selectionStart: start, selectionEnd: end } = area;
    setSelection((previous) => previous.start === start && previous.end === end ? previous : { start, end });
  };
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.focus({ preventScroll: true });
    readSelection();
    const read = () => { if (document.activeElement === area) readSelection(); };
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [viewport]);
  useLayoutEffect(() => { currentMeta.current = meta; }, [meta]);
  useLayoutEffect(() => {
    const bar = barRef.current;
    const parent = bar?.offsetParent;
    if (!bar || !(parent instanceof HTMLElement) || !origin) return;
    const place = () => {
      bar.style.left = `${Math.max(8, Math.min(origin.x, parent.clientWidth - bar.offsetWidth - 8))}px`;
      bar.style.top = `${Math.max(8, Math.min(origin.y - bar.offsetHeight - 8, parent.clientHeight - bar.offsetHeight - 8))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(parent);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [origin?.x, origin?.y]);

  if (!viewport || !origin) return null;
  const { zoom, rotation, mirrorX } = viewportState;
  const boxW = meta.box?.width ?? Math.max(meta.fontSize, Math.ceil(layout.width) + (meta.vertical ? 0 : meta.fontSize));
  const boxH = meta.box?.height ?? Math.max(meta.fontSize, Math.ceil(layout.height) + (meta.vertical ? meta.fontSize : 0));

  const replace = (next: LayerTextMeta) => {
    currentMeta.current = next;
    onChange(next);
  };
  const patch = (next: Partial<LayerTextMeta>) => replace({ ...currentMeta.current, ...next });
  const readRange = () => {
    const area = areaRef.current;
    return area ? { start: area.selectionStart, end: area.selectionEnd } : selection;
  };
  const styleRange = (next: Parameters<typeof applyTextStyleToRange>[3]) => {
    const { start, end } = readRange();
    replace(applyTextStyleToRange(currentMeta.current, start, end, next));
  };
  const toggleStyle = (key: 'bold' | 'italic') => {
    const { start, end } = readRange();
    const current = currentMeta.current;
    const { style, mixed } = getToolbarTextStyle(current, start, end);
    replace(applyTextStyleToRange(current, start, end, { [key]: mixed[key] || !style[key] }));
  };
  const changeContent = (content: string) => {
    const before = currentMeta.current;
    if (content !== before.content) replace(updateTextContent(before, content, composition.current ?? before));
    readSelection();
  };

  const pointAt = (event: React.PointerEvent) => viewport.screenToCanvas(event.clientX, event.clientY);
  const textIndexAt = (point: Point) => indexAtPoint(layout, meta, point.x - meta.x, point.y - meta.y);
  const selectBetween = (anchor: number, at: number) => {
    areaRef.current?.setSelectionRange(Math.min(anchor, at), Math.max(anchor, at), at < anchor ? 'backward' : 'forward');
    readSelection();
  };
  const startSelection = (event: React.PointerEvent<HTMLTextAreaElement>) => {
    if (event.button !== 0 || !event.isPrimary || composition.current) return;
    event.preventDefault();
    const area = event.currentTarget;
    const at = textIndexAt(pointAt(event));
    const anchor = event.shiftKey ? (area.selectionDirection === 'backward' ? area.selectionEnd : area.selectionStart) : at;
    area.focus({ preventScroll: true });
    selectBetween(anchor, at);
    drag.current = { kind: 'select', id: event.pointerId, anchor };
    capturePointer(event);
  };

  const startMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    drag.current = { kind: 'move', id: event.pointerId, start: pointAt(event), origin: { x: meta.x, y: meta.y } };
    capturePointer(event);
  };
  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary || !meta.box) return;
    event.preventDefault();
    drag.current = { kind: 'box', id: event.pointerId, start: pointAt(event), x: meta.x, box: meta.box, vertical: meta.vertical };
    capturePointer(event);
  };
  const updateDrag = (event: React.PointerEvent) => {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    const point = pointAt(event);
    if (active.kind === 'select') {
      selectBetween(active.anchor, textIndexAt(point));
    } else {
      const dx = point.x - active.start.x;
      const dy = point.y - active.start.y;
      if (active.kind === 'move') patch({ x: Math.round(active.origin.x + dx), y: Math.round(active.origin.y + dy) });
      else patch(resizeTextBox(active.box, active.x, active.vertical, dx, dy));
    }
  };
  const endDrag = (event: React.PointerEvent) => {
    if (drag.current?.id === event.pointerId) drag.current = null;
  };
  const toggleBox = () => patch({ box: meta.box ? null : initialTextBox(meta, textBoxRect(meta)) });
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();

  const align = meta.align ?? 'start';
  const alignment = [
    { value: 'start', label: meta.vertical ? t.alignTop : t.alignLeft, Icon: AlignLeft },
    { value: 'center', label: t.alignCenter, Icon: AlignCenter },
    { value: 'end', label: meta.vertical ? t.alignBottom : t.alignRight, Icon: AlignRight },
  ] as const;
  const { style, mixed } = toolbarStyle;
  return (
    <div className="contents" onPointerDown={stop} onDoubleClick={stop}
      onPointerMove={(event) => { stop(event); updateDrag(event); }}
      onPointerUp={(event) => { stop(event); endDrag(event); }}
      onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || composition.current) return;
        if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'Escape') onCancel();
          else onCommit();
        }
      }}>
      <div className="absolute left-0 top-0 z-30"
        style={{ transform: `translate(${origin.x}px, ${origin.y}px) rotate(${rotation}rad) scale(${mirrorX ? -zoom : zoom}, ${zoom})`, transformOrigin: '0 0' }}>
        <textarea ref={areaRef} value={meta.content} aria-label={t.editorAria} spellCheck={false}
          placeholder={isNew ? t.newTextPlaceholder : ''}
          onChange={(event) => changeContent(event.currentTarget.value)}
          onCompositionStart={() => { composition.current = currentMeta.current; }}
          onCompositionEnd={(event) => {
            changeContent(event.currentTarget.value);
            composition.current = null;
          }}
          onPointerDown={startSelection} onSelect={readSelection}
          onFocus={() => { setFocused(true); readSelection(); }}
          onBlur={() => setFocused(false)}
          className="block touch-none resize-none overflow-hidden border-0 bg-transparent p-0 outline-none placeholder:text-neutral-400/70 selection:bg-transparent selection:text-transparent"
          style={{
            width: boxW,
            height: boxH,
            font: `${meta.fontSize}px ${meta.fontFamily}`,
            lineHeight: meta.lineHeight,
            writingMode: meta.vertical ? 'vertical-rl' : 'horizontal-tb',
            textAlign: align,
            letterSpacing: `${(meta.letterSpacing ?? 0) / 1000}em`,
            color: 'transparent',
            caretColor: 'transparent',
            outline: `${1.5 / zoom}px dashed rgba(99, 102, 241, 0.9)`,
            whiteSpace: meta.box ? 'pre-wrap' : 'pre',
            overflowWrap: meta.box ? 'anywhere' : undefined,
          }} />
        {highlights.map((rect, i) => (
          <span key={i} aria-hidden className="pointer-events-none absolute bg-indigo-400/[0.35]"
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />
        ))}
        {caret && <span aria-hidden className="atelier-text-caret pointer-events-none absolute"
          style={{ left: caret.x, top: caret.y, width: caret.w, height: caret.h, background: style.color.toLowerCase() === '#ffffff' ? '#6366f1' : style.color }} />}
        {meta.box && <button type="button" data-testid="text-editor-box-handle" aria-label={t.resizeBox} title={t.resizeBox}
          onPointerDown={startResize} className="absolute touch-none rounded-sm border-2 border-white bg-indigo-500"
          style={{
            left: meta.vertical ? 0 : boxW,
            top: boxH,
            width: 20 / zoom,
            height: 20 / zoom,
            transform: 'translate(-50%, -50%)',
            cursor: meta.vertical !== mirrorX ? 'nesw-resize' : 'nwse-resize',
          }} />}
      </div>
      <div ref={barRef} data-testid="text-editor-toolbar" role="toolbar" aria-label={t.toolbarAria}
        className="absolute z-40 flex w-max max-w-[calc(100%-16px)] flex-wrap items-center gap-1 rounded-lg border border-neutral-700 bg-neutral-900/95 p-1 text-[11px] text-neutral-200 shadow-xl">
        <button type="button" onPointerDown={startMove} title={t.dragMove} aria-label={t.dragMove}
          className={`${textToolButton} cursor-move touch-none`}><Move size={14} /></button>
        <div role="group" aria-label={t.directionAria} className="flex shrink-0 gap-0.5 rounded border border-neutral-700 p-0.5">
          {[{ vertical: false, label: t.horizontal }, { vertical: true, label: t.vertical }].map((choice) => (
            <button key={choice.label} type="button" aria-pressed={meta.vertical === choice.vertical}
              onClick={() => patch({ vertical: choice.vertical })}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded px-2 hover:bg-neutral-800 aria-pressed:bg-indigo-600 aria-pressed:font-semibold aria-pressed:text-white">
              <AlignLeft size={14} aria-hidden="true" className={choice.vertical ? 'rotate-90' : undefined} />{choice.label}
            </button>
          ))}
        </div>
        <FontPicker value={meta.fontFamily} onChange={(fontFamily) => patch({ fontFamily })} ariaLabel={t.fontAria} testId="text-editor-font" />
        <TextNumberField label={t.fontSize} compact min={8} max={400} value={mixed.fontSize ? null : style.fontSize}
          testId="text-editor-size" onChange={(fontSize) => styleRange({ fontSize })} />
        <ColorPopoverButton label={t.textColor} title={t.textColor} color={style.color} mixed={mixed.color} data-testid="text-editor-color"
          onChange={(color) => styleRange({ color })} />
        <div className="flex shrink-0">
          <button type="button" data-testid="text-editor-bold" title={t.bold} aria-label={t.bold} aria-pressed={mixed.bold ? 'mixed' : style.bold}
            onClick={() => toggleStyle('bold')}
            className={`${textToolButton} aria-[pressed=mixed]:bg-indigo-600/[0.35]`}><Bold size={15} /></button>
          <button type="button" data-testid="text-editor-italic" title={t.italic} aria-label={t.italic} aria-pressed={mixed.italic ? 'mixed' : style.italic}
            onClick={() => toggleStyle('italic')}
            className={`${textToolButton} aria-[pressed=mixed]:bg-indigo-600/[0.35]`}><Italic size={15} /></button>
        </div>
        <div className="flex shrink-0">
          {alignment.map(({ value, label, Icon }) => (
            <button key={value} type="button" data-testid={`text-editor-align-${value}`} title={label} aria-label={label}
              aria-pressed={align === value} onClick={() => patch({ align: value })}
              className={textToolButton}><Icon size={15} className={meta.vertical ? 'rotate-90' : undefined} /></button>
          ))}
        </div>
        <TextStylePopover meta={meta} onPatch={patch} onToggleBox={toggleBox} />
        <div className="flex shrink-0 gap-1">
          <button type="button" data-testid="text-editor-apply" onClick={onCommit} disabled={!meta.content.trim()} title={t.apply} aria-label={t.apply}
            className={`${textToolButton} bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40`}><Check size={15} /></button>
          <button type="button" data-testid="text-editor-cancel" onClick={onCancel} title={t.cancel} aria-label={t.cancel}
            className={textToolButton}><X size={15} /></button>
        </div>
      </div>
    </div>
  );
};
