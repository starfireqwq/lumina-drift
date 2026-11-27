import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, RefreshCw, Search, Trash2, Upload } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { getFontLabel, getTextFontPresetKey, TEXT_FONTS } from '../engine/textLayer';
import { filterFontGroups, quoteFontFamily, restoreImportedFonts, useFontLibrary } from '../services/fontLibrary';
import { useAnchoredPopover } from '../utils/popoverPosition';

interface FontPickerProps {
  value: string;
  onChange: (fontFamily: string) => void;
  ariaLabel?: string;
  compact?: boolean;
  className?: string;
  testId?: string;
  showGenericFamilies?: boolean;
}

const actionClass = 'inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md border border-neutral-700 px-2 text-xs hover:bg-neutral-800 disabled:opacity-50';

export function FontPicker({ value, onChange, ariaLabel, compact, className, testId, showGenericFamilies }: FontPickerProps) {
  const { t: { textEditor: t } } = useI18n();
  const { importedFonts, localFonts, scanningLocal, importing, error, importFiles, removeFont, rescanLocalFonts } = useFontLibrary();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const id = useId();
  const position = useAnchoredPopover(open, trigger, panel, { fallbackWidth: 360, fallbackHeight: 450 });
  const label = ariaLabel ?? t.fontAria;
  const presets = useMemo(() => {
    const fonts = TEXT_FONTS.map((font) => {
      const key = getTextFontPresetKey(font.id);
      return { ...font, label: key ? t.presetFonts[key] : font.label };
    });
    if (showGenericFamilies) {
      fonts.push(...Object.entries(t.genericFonts).map(([id, label]) => ({ id, label })));
    }
    return fonts;
  }, [showGenericFamilies, t.genericFonts, t.presetFonts]);
  const currentLabel = importedFonts.find((font) => font.family === value)?.name
    ?? presets.find((font) => font.id === value)?.label
    ?? getFontLabel(value);
  const groups = useMemo(() => open
    ? filterFontGroups(query, { imported: importedFonts, presets, local: localFonts })
    : null, [open, query, importedFonts, presets, localFonts]);

  useEffect(() => {
    if (!open) return;
    search.current?.focus({ preventScroll: true });
    void restoreImportedFonts();
    void rescanLocalFonts({ force: false });
    const outside = (event: PointerEvent | FocusEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
    };
  }, [open, rescanLocalFonts]);

  const close = () => {
    setOpen(false);
    const target = returnFocus.current?.isConnected ? returnFocus.current : trigger.current;
    target?.focus({ preventScroll: true });
    returnFocus.current = null;
  };

  const onPanelKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    const target = event.target as HTMLElement;
    const onSearch = target === search.current;
    if ((!onSearch && !target.hasAttribute('data-font-option')) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (onSearch && event.key !== 'ArrowDown') return;
    const options = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[data-font-option]') ?? []);
    if (!options.length) return;
    const index = options.indexOf(target as HTMLButtonElement);
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: options.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    if (next < 0) search.current?.focus();
    else options[Math.min(next, options.length - 1)].focus();
  };

  const option = (family: string, name: string, sample = t.fontSample, selected = family === value) => (
    <button type="button" data-font-option aria-pressed={selected} title={name}
      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-neutral-800 focus-visible:outline focus-visible:outline-indigo-400 aria-pressed:bg-indigo-500/20"
      onClick={() => { close(); onChange(family); }}>
      <Check aria-hidden="true" size={14} className={`shrink-0 text-indigo-300 ${selected ? '' : 'invisible'}`} />
      <span className="min-w-0 flex-1" style={{ fontFamily: family }}>
        <span className="block truncate text-sm">{name}</span>
        <span aria-hidden="true" className="block truncate text-xs text-neutral-400">{sample}</span>
      </span>
    </button>
  );

  const group = (key: string, title: string, items: ReactNode[]) => (
    <section aria-labelledby={`${id}-${key}`}>
      <h3 id={`${id}-${key}`} className="px-2 pb-1 pt-2 text-[11px] font-semibold text-neutral-400">{title}</h3>
      <ul className="space-y-0.5">{items}</ul>
    </section>
  );

  return (
    <>
      <button ref={trigger} type="button" data-font-picker data-testid={testId}
        aria-label={`${label} · ${currentLabel}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        title={currentLabel}
        className={`atelier-field inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 text-left text-xs ${compact ? 'h-7 max-w-32' : 'h-7 max-w-44'} ${className ?? ''}`}
        onPointerDown={() => {
          if (!open) returnFocus.current = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
        }}
        onKeyDown={(event) => {
          if (open && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        onClick={() => {
          if (open) close();
          else {
            setQuery('');
            setOpen(true);
          }
        }}>
        <span className="truncate" style={{ fontFamily: value }}>{currentLabel}</span>
        <ChevronDown size={13} aria-hidden="true" className="shrink-0" />
      </button>
      {groups && createPortal(
        <section id={id} role="dialog" aria-label={label} data-font-picker ref={position.setPopoverEl}
          className="pointer-events-auto fixed z-[10000] flex w-[min(360px,calc(100vw-16px))] flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 text-neutral-100 shadow-2xl"
          style={{ left: position.left, top: position.top, maxHeight: Math.min(450, position.maxHeight) }}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={onPanelKeyDown}>
          <div className="shrink-0 space-y-2 border-b border-neutral-700 p-2">
            <div className="relative">
              <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2 top-2 text-neutral-400" />
              <input ref={search} type="search" aria-label={t.fontSearch} placeholder={t.fontSearch} value={query}
                onChange={(event) => setQuery(event.target.value)} className="atelier-field h-8 w-full rounded-md pl-8 pr-2 text-xs" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className={actionClass} disabled={importing} onClick={() => fileInput.current?.click()}>
                <Upload size={13} aria-hidden="true" />{t.importFont}
              </button>
              <input ref={fileInput} type="file" accept=".ttf,.otf,.woff,.woff2" multiple hidden
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length) void importFiles(files);
                  event.target.value = '';
                }} />
              <button type="button" className={actionClass} disabled={scanningLocal} onClick={() => void rescanLocalFonts()}>
                <RefreshCw size={13} aria-hidden="true" className={scanningLocal ? 'animate-spin' : undefined} />{t.rescanFonts}
              </button>
            </div>
            {(scanningLocal || importing) && <p role="status" className="text-xs text-neutral-300">{importing ? t.importingFonts : t.scanningFonts}</p>}
            {error && <p role="alert" className="text-xs text-red-300">{t.fontErrors[error]}</p>}
          </div>
          <div className="min-h-0 overflow-y-auto overscroll-contain p-1.5">
            {groups.imported.length > 0 && group('imported', t.importedFonts, groups.imported.map((font) => (
              <li key={font.id} className="flex items-center gap-1">
                {option(font.family, font.name)}
                <button type="button" title={`${t.deleteFont} · ${font.name}`} aria-label={`${t.deleteFont} · ${font.name}`}
                  className="mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-red-500/15 hover:text-red-300"
                  onClick={() => { search.current?.focus(); void removeFont(font.id); }}>
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            )))}
            {groups.presets.length > 0 && group('presets', t.presetFontsTitle, groups.presets.map((font) => (
              <li key={font.id} className="flex">{option(font.id, font.label, font.sample)}</li>
            )))}
            {groups.local.length > 0 && group('local', t.localFonts, groups.local.map((name) => {
              const family = quoteFontFamily(name);
              return <li key={name} className="flex">{option(family, name, t.fontSample, family === value || name === value)}</li>;
            }))}
            {!groups.imported.length && !groups.presets.length && !groups.local.length && !scanningLocal &&
              <p role="status" className="px-2 py-3 text-xs text-neutral-400">{t.noFontsFound}</p>}
          </div>
        </section>,
        document.body,
      )}
    </>
  );
}
