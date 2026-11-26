import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Eye, EyeOff, RotateCcw } from 'lucide-react';
import {
  CSP_PALETTE_COLOR_PRESETS,
  CSP_PAPER_COLOR_PRESETS,
  DEFAULT_LAYER_MAIN_COLOR,
  DEFAULT_LAYER_SUB_COLOR,
  normalizeHexColor,
  normalizeLayerColorMeta,
  type EffectiveLayerColorResult,
  type LayerColorMeta,
  type LayerModel,
  type PaletteColorDisplayMode,
} from '@atelier/shared';
import type { Translations } from '../locales';
import { getEffectivePaperColor } from '../utils/layerColorDisplay';
import { useAnchoredPopover } from '../utils/popoverPosition';

type ColorLabels = Translations['layers']['colors'];
export type ColorScope = 'local' | 'synced';

const COLOR_BUTTON = 'atelier-icon-btn h-6 shrink-0 gap-0.5 border border-neutral-700/70 px-1';
const TEXT_BUTTON = 'rounded border border-atelier-border px-2 py-1 text-[11px] hover:bg-neutral-700/60';
const TRANSPARENT_SWATCH = 'repeating-linear-gradient(135deg, transparent 0 3px, #737373 3px 4px)';
const PAPER_CHECKER = 'repeating-conic-gradient(#73737399 0% 25%, transparent 0% 50%)';
const DRAFT_PRESETS = ['#4A8DFF', '#38BDF8', '#F43F5E', '#22C55E', '#F97316', '#A855F7'];
const DEFAULT_TINT = { enabled: false, mainColor: DEFAULT_LAYER_MAIN_COLOR, subColor: DEFAULT_LAYER_SUB_COLOR };

interface PopoverTrigger {
  ref: Ref<HTMLButtonElement>;
  onClick: () => void;
  'aria-haspopup': 'dialog';
  'aria-expanded': boolean;
  'aria-controls'?: string;
}

function ColorPopover({ title, testId, trigger, children }: {
  title: string;
  testId: string;
  trigger: (props: PopoverTrigger) => ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const { top, left, maxHeight, setPopoverEl } = useAnchoredPopover(open, anchorRef, popoverRef, {
    gap: 4, margin: 8, fallbackWidth: 272, fallbackHeight: 220,
  });

  useEffect(() => {
    if (!open) return;
    popoverRef.current?.focus({ preventScroll: true });
    const dismissOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!popoverRef.current?.contains(event.target) && !anchorRef.current?.contains(event.target)) setOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      anchorRef.current?.focus();
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', dismissOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', dismissOnEscape, true);
    };
  }, [open]);

  return <>
    {trigger({
      ref: anchorRef, onClick: () => setOpen((value) => !value), 'aria-haspopup': 'dialog',
      'aria-expanded': open, 'aria-controls': open ? id : undefined,
    })}
    {open && createPortal(
      <div ref={setPopoverEl} id={id} role="dialog" aria-label={title} tabIndex={-1} data-testid={testId}
        style={{ top, left, maxHeight }}
        onKeyDown={(event) => event.stopPropagation()}
        className="atelier-popover atelier-menu-in fixed z-[95] w-[17rem] max-w-[calc(100vw-16px)] space-y-2.5 overflow-y-auto overscroll-contain p-2.5 text-xs">
        <div className="font-semibold text-neutral-100">{title}</div>
        {children}
      </div>, document.body,
    )}
  </>;
}

function ColorChoices<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: readonly { id: T; label: string; disabledReason?: string }[];
  onChange: (value: T) => void;
}) {
  return <div role="group" aria-label={label} className="flex items-stretch gap-0.5 rounded border border-atelier-border bg-neutral-900/60 p-0.5">
    {options.map((option) => <span key={option.id} title={option.disabledReason} className="flex min-w-0 flex-1">
      <button type="button" aria-pressed={value === option.id} disabled={Boolean(option.disabledReason)} onClick={() => onChange(option.id)}
        className={`w-full rounded px-1 py-1 text-[11px] leading-tight disabled:opacity-40 ${value === option.id ? 'bg-indigo-500/25 text-indigo-100' : 'text-neutral-300 hover:bg-neutral-700/60'}`}>
        {option.label}
      </button>
    </span>)}
  </div>;
}

function ColorInput({ color, label, onChange }: { color: string; label: string; onChange: (color: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const value = normalizeHexColor(color)?.toLowerCase() ?? '#ffffff';
  useEffect(() => {
    const input = inputRef.current;
    if (input) input.value = value;
  }, [value]);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    // Native change commits the selection once, even when the picker emits input events while dragging.
    const commit = () => {
      const next = normalizeHexColor(input.value);
      if (next) onChange(next);
    };
    input.addEventListener('change', commit);
    return () => input.removeEventListener('change', commit);
  }, [onChange]);
  return <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-neutral-300">
    <input ref={inputRef} type="color" defaultValue={value} className="h-7 w-8 shrink-0 cursor-pointer rounded border border-atelier-border bg-neutral-800 p-0.5" />
    <span>{label}</span>
  </label>;
}

function ColorPresets({ colors, current, label, columns, onChange }: {
  colors: readonly string[];
  current: string | null;
  label: string;
  columns: 'grid-cols-6' | 'grid-cols-8';
  onChange: (color: string) => void;
}) {
  const selected = normalizeHexColor(current);
  return <div role="group" aria-label={label} className={`grid ${columns} gap-1`}>
    {colors.map((color) => <button type="button" key={color} title={color} aria-label={color} aria-pressed={selected === color}
      className={`h-6 rounded border hover:ring-1 hover:ring-neutral-100 ${selected === color ? 'border-neutral-100 ring-1 ring-indigo-400' : 'border-neutral-600'}`}
      style={{ backgroundColor: color }} onClick={() => onChange(color)} />)}
  </div>;
}

export function LayerPaletteColorControl({ labels, color, personalColor, sharedColor, disabled, isOffline, mode, canSync, onChangeMode, onChangeColor }: {
  labels: ColorLabels;
  color: string | null;
  personalColor: string | null;
  sharedColor: string | null;
  disabled: boolean;
  isOffline: boolean;
  mode: PaletteColorDisplayMode;
  canSync: boolean;
  onChangeMode: (mode: PaletteColorDisplayMode) => void;
  onChangeColor: (value: string | null | undefined, scope: ColorScope) => void;
}) {
  const [scope, setScope] = useState<ColorScope>('local');
  const target = isOffline || (canSync && scope === 'synced') ? 'synced' : 'local';
  const targetColor = target === 'local' ? personalColor : sharedColor;
  const apply = (value: string | null | undefined) => onChangeColor(value, target);

  return <ColorPopover title={labels.palette} testId="layer-palette-color-popover" trigger={(props) => (
    <button {...props} type="button" data-testid="layer-palette-color-btn" disabled={disabled} aria-label={labels.palette}
      title={labels.palette} className={COLOR_BUTTON}>
      <span aria-hidden className="h-3 w-3 rounded-sm border border-neutral-500" style={color ? { backgroundColor: color } : { backgroundImage: TRANSPARENT_SWATCH }} />
      <ChevronDown aria-hidden className="h-3 w-3" />
    </button>
  )}>
    {!isOffline && <>
      <div className="space-y-1">
        <div className="text-[11px] text-neutral-400">{labels.displayMode}</div>
        <ColorChoices<PaletteColorDisplayMode> label={labels.displayMode} value={mode} onChange={onChangeMode} options={[
          { id: 'shared', label: labels.shared }, { id: 'personal', label: labels.personal }, { id: 'owner', label: labels.owner },
        ]} />
      </div>
      <ColorChoices<ColorScope> label={labels.paletteScope} value={target} onChange={setScope} options={[
        { id: 'local', label: labels.localPalette },
        { id: 'synced', label: labels.sharedPalette, disabledReason: canSync ? undefined : labels.syncUnavailable },
      ]} />
    </>}
    <ColorPresets colors={CSP_PALETTE_COLOR_PRESETS} current={targetColor} label={labels.presets} columns="grid-cols-8" onChange={apply} />
    <div className="flex items-center justify-between gap-2">
      <button type="button" className={TEXT_BUTTON} aria-pressed={targetColor === null} onClick={() => apply(null)}>{labels.noColor}</button>
      <ColorInput color={targetColor ?? CSP_PALETTE_COLOR_PRESETS[0]} label={labels.custom} onChange={apply} />
    </div>
    {target === 'local' && <button type="button" className={`${TEXT_BUTTON} w-full`} onClick={() => apply(undefined)}>{labels.followShared}</button>}
  </ColorPopover>;
}

export function LayerTintSwatch({ config, label }: { config: LayerColorMeta; label?: string }) {
  const sub = config.subColor ?? DEFAULT_LAYER_SUB_COLOR;
  return <span role={label ? 'img' : undefined} aria-label={label} title={label} aria-hidden={!label || undefined}
    className="h-2.5 w-3.5 shrink-0 rounded-full border border-neutral-500/70"
    style={{ backgroundImage: `linear-gradient(90deg, ${config.mainColor} 50%, ${sub} 50%)` }} />;
}

export function LayerTintControls({ labels, layer, isOffline, canSync, localConfig, effective, onChangeLocal, onChangeShared }: {
  labels: ColorLabels;
  layer: LayerModel | null;
  isOffline: boolean;
  canSync: boolean;
  localConfig: LayerColorMeta | null | undefined;
  effective: EffectiveLayerColorResult;
  onChangeLocal: (id: string, config: LayerColorMeta | undefined) => void;
  onChangeShared: (id: string, props: Partial<LayerModel>) => void | Promise<void>;
}) {
  const disabled = !layer || layer.layerType === 'mask' || layer.layerType === 'adjustment' || (isOffline && !canSync);
  const shared = normalizeLayerColorMeta(layer?.meta?.layerColor);
  const settings = (isOffline ? shared : localConfig ?? effective.config) ?? DEFAULT_TINT;
  const enabled = isOffline ? Boolean(shared?.enabled) : effective.source === 'local';
  const applyShared = (config: LayerColorMeta) => {
    if (layer && canSync) void onChangeShared(layer.id, { meta: { ...layer.meta, layerColor: config } });
  };
  const apply = (config: LayerColorMeta) => {
    if (!layer || disabled) return;
    if (isOffline) applyShared(config);
    else onChangeLocal(layer.id, config);
  };
  const changeMain = (mainColor: string) => apply({ ...settings, enabled: true, mainColor });

  return <div className="flex shrink-0 items-center gap-px">
    <button type="button" data-testid="layer-display-color-btn" disabled={disabled} aria-pressed={enabled}
      title={labels.tint} aria-label={labels.tint} className={COLOR_BUTTON}
      onClick={() => apply({ ...settings, enabled: !enabled })}>
      <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4">
        <rect x="5" y="2" width="9" height="9" rx="1" fill="#F5F5F5" />
        <rect x="2" y="5" width="9" height="9" rx="1" fill="#4A8DFF" stroke="#1E3A8A" />
      </svg>
    </button>
    <ColorPopover title={labels.tint} testId="layer-display-color-popover" trigger={(props) => (
      <button {...props} type="button" data-testid="layer-display-color-menu-btn" disabled={disabled}
        title={labels.tintSettings} aria-label={labels.tintSettings} className={COLOR_BUTTON}>
        <LayerTintSwatch config={settings} /><ChevronDown aria-hidden className="h-3 w-3" />
      </button>
    )}>
      {!isOffline && <p className="text-[11px] text-indigo-200">{labels.localTint}</p>}
      <div className="flex flex-wrap gap-2">
        <ColorInput color={settings.mainColor} label={labels.mainColor} onChange={changeMain} />
        <ColorInput color={settings.subColor ?? DEFAULT_LAYER_SUB_COLOR} label={labels.subColor}
          onChange={(subColor) => apply({ ...settings, enabled: true, subColor })} />
      </div>
      <ColorPresets colors={DRAFT_PRESETS} current={settings.mainColor} label={labels.presets} columns="grid-cols-6" onChange={changeMain} />
      {!isOffline && <div className="flex flex-wrap gap-1.5">
        {canSync && <button type="button" className={TEXT_BUTTON} onClick={() => applyShared({ ...settings, enabled: true })}>{labels.syncTint}</button>}
        {canSync && shared?.enabled && <button type="button" className={TEXT_BUTTON} onClick={() => applyShared({ ...shared, enabled: false })}>{labels.stopSyncTint}</button>}
        {layer && localConfig !== undefined && <button type="button" className={TEXT_BUTTON} onClick={() => onChangeLocal(layer.id, undefined)}>{labels.followShared}</button>}
      </div>}
    </ColorPopover>
  </div>;
}

export function LayerPaperRow({ labels, canvasColor, localColor, visible, isOffline, canSync, onToggleVisible, onChangeColor }: {
  labels: ColorLabels;
  canvasColor: string;
  localColor: string | null;
  visible: boolean;
  isOffline: boolean;
  canSync: boolean;
  onToggleVisible: () => void;
  onChangeColor: (color: string | null, scope: ColorScope) => void;
}) {
  const [scope, setScope] = useState<ColorScope>('synced');
  const target = isOffline || (canSync && scope === 'synced') ? 'synced' : 'local';
  const effectiveColor = getEffectivePaperColor(canvasColor, localColor, isOffline);
  const targetColor = target === 'synced' ? canvasColor : effectiveColor;
  const apply = (color: string) => onChangeColor(color, target);
  const eyeLabel = visible ? labels.hidePaper : labels.showPaper;

  return <div data-testid="layer-paper-row" className="flex min-h-9 shrink-0 items-center gap-1 border-t border-atelier-border bg-atelier-panel pr-1.5">
    <button type="button" data-testid="layer-paper-eye" title={eyeLabel} aria-label={eyeLabel} aria-pressed={visible}
      className="atelier-icon-btn h-7 w-9 shrink-0" onClick={onToggleVisible}>
      {visible ? <Eye aria-hidden className="h-3.5 w-3.5" /> : <EyeOff aria-hidden className="h-3.5 w-3.5" />}
    </button>
    <ColorPopover title={labels.paperColor} testId="layer-paper-popover" trigger={(props) => (
      <button {...props} type="button" data-testid="layer-paper-color-btn" aria-label={labels.paperColor}
        title={labels.paperColor} className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded text-left hover:bg-neutral-700/40">
        <span aria-hidden className="h-6 w-9 shrink-0 rounded border border-neutral-600" style={{
          backgroundColor: effectiveColor, backgroundImage: visible ? undefined : PAPER_CHECKER, backgroundSize: '8px 8px',
        }} />
        <span className="truncate font-medium text-neutral-200">{labels.paper}</span>
        <span className="shrink-0 font-mono text-[10px] text-neutral-400">{effectiveColor.toUpperCase()}</span>
        <ChevronDown aria-hidden className="ml-auto mr-0.5 h-3 w-3 shrink-0 text-neutral-400" />
      </button>
    )}>
      {!isOffline && (canSync ? <ColorChoices<ColorScope> label={labels.paperScope} value={target} onChange={setScope} options={[
        { id: 'synced', label: labels.syncRoom }, { id: 'local', label: labels.localPreviewOnly },
      ]} /> : <p className="text-[11px] text-neutral-300">{labels.paperLocalHint}</p>)}
      <ColorPresets colors={CSP_PAPER_COLOR_PRESETS} current={targetColor} label={labels.presets} columns="grid-cols-6" onChange={apply} />
      <ColorInput color={targetColor} label={labels.custom} onChange={apply} />
    </ColorPopover>
    {!isOffline && localColor && <>
      <span className="max-w-[5rem] truncate rounded bg-indigo-500/20 px-1 py-0.5 text-[10px] text-indigo-100" title={labels.localPreview}>{labels.localPreview}</span>
      <button type="button" data-testid="layer-paper-reset-local" title={labels.resetPaper} aria-label={labels.resetPaper}
        className="atelier-icon-btn h-6 w-6 shrink-0" onClick={() => onChangeColor(null, 'local')}>
        <RotateCcw aria-hidden className="h-3 w-3" />
      </button>
    </>}
  </div>;
}
