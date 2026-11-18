import React from 'react';
import { Check, X } from 'lucide-react';

/**
 * The bar that floats over the top of the canvas while a transform / mesh warp is open: the tool's
 * own controls, then 套用 (accent) and 取消. Same surface and buttons as every other popover.
 */
export const CanvasActionBar: React.FC<{
  children?: React.ReactNode;
  onApply: () => void;
  onCancel: () => void;
  applyLabel?: string;
}> = ({ children, onApply, onCancel, applyLabel = '套用' }) => (
  <div
    data-transform-overlay="true"
    role="toolbar"
    aria-label="變形操作"
    onPointerDown={(e) => e.stopPropagation()}
    className="atelier-popover atelier-menu-in pointer-events-auto absolute left-1/2 top-3 flex w-max max-w-[96%] -translate-x-1/2 flex-wrap items-center gap-1.5 p-1.5 text-xs"
  >
    {children}
    {children && <div className="mx-0.5 h-5 w-px bg-neutral-700" />}
    <button type="button" onClick={onApply} className="atelier-btn atelier-btn--primary">
      <Check />{applyLabel}<kbd className="atelier-kbd hidden md:inline">Enter</kbd>
    </button>
    <button type="button" onClick={onCancel} className="atelier-btn atelier-btn--ghost">
      <X />取消<kbd className="atelier-kbd hidden md:inline">Esc</kbd>
    </button>
  </div>
);

/** A toggle chip for the bar (aria-pressed lights it in the accent colour) */
export const BarToggle: React.FC<{ on: boolean; onClick: () => void; icon?: React.ReactNode; label: string; keyHint?: string; title?: string }> = ({ on, onClick, icon, label, keyHint, title }) => (
  <button type="button" aria-pressed={on} onClick={onClick} title={title} className="atelier-btn">
    {icon}{label}{keyHint && <kbd className="atelier-kbd hidden md:inline">{keyHint}</kbd>}
  </button>
);

/** Mode picker shared by the transform and the mesh warp bars */
export const BarSelect = <T extends string>({ value, options, onChange, label }: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) => (
  <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}
    className="atelier-field h-7 cursor-pointer px-2 text-xs font-medium">
    {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
  </select>
);
