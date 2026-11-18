import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, Link2, Link2Off, SquarePlus } from 'lucide-react';
import { CANVAS_UNITS, CanvasModel, CanvasUnit, CreateCanvasDto, clampDpi, formatUnitNumber, pixelsToUnit, unitToPixels } from '@atelier/shared';
import { AtelierModal, modalButton } from './AtelierModal';
import { PRESETS } from './ResizeCanvasModal';
import { useI18n } from '../context/I18nContext';

interface CreateCanvasModalProps {
  isOpen: boolean;
  defaultTitle?: string;
  groups?: NonNullable<CanvasModel['group']>[];
  initialGroupId?: string;
  onClose: () => void;
  onCreate: (dto: CreateCanvasDto) => Promise<void>;
}

const MIN = 64;
const MAX = 16384;
const clampSize = (n: number) => Math.max(MIN, Math.min(MAX, Math.round(n)));
const BACKGROUNDS = ['#FFFFFF', '#F3F4F6', '#E5E7EB', '#18181B', '#09090B'];

/** New canvas: name, size (with presets and an aspect lock), paper colour and an optional room password. */
export const CreateCanvasModal: React.FC<CreateCanvasModalProps> = ({ isOpen, defaultTitle = '', groups, initialGroupId, onClose, onCreate }) => {
  const { t } = useI18n();
  const [title, setTitle] = useState(defaultTitle);
  // Text, not numbers: a cleared field stays empty while typing instead of snapping to 64
  const [unit, setUnit] = useState<CanvasUnit>('px');
  const [dpiStr, setDpiStr] = useState('300');
  const [widthStr, setWidthStr] = useState('2048');
  const [heightStr, setHeightStr] = useState('2048');
  const [aspect, setAspect] = useState<number | null>(null);
  const [bgColor, setBgColor] = useState('#FFFFFF');
  const [enablePassword, setEnablePassword] = useState(false);
  const [roomPassword, setRoomPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupChoice, setGroupChoice] = useState(initialGroupId ?? '');
  const [groupTitle, setGroupTitle] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setTitle(defaultTitle);
    setUnit('px');
    setDpiStr('300');
    setWidthStr('2048');
    setHeightStr('2048');
    setAspect(null);
    setEnablePassword(false);
    setRoomPassword('');
    setGroupChoice(initialGroupId ?? '');
    setGroupTitle('');
    setError(null);
  }, [isOpen, defaultTitle, initialGroupId]);

  if (!isOpen) return null;

  const dpi = clampDpi(Number(dpiStr) || 300);
  const rawW = Number(widthStr);
  const rawH = Number(heightStr);
  const width = unit === 'px' ? rawW : unitToPixels(rawW, unit, dpi);
  const height = unit === 'px' ? rawH : unitToPixels(rawH, unit, dpi);
  const valid = (n: number) => Number.isFinite(n) && n >= MIN && n <= MAX;
  const availableGroups = Array.from(new Map(groups?.map((group) => [group.id, group])).values());
  const existingGroup = availableGroups.find((group) => group.id === groupChoice);
  const createGroup = Boolean(groups) && groupChoice === 'new';

  const handleUnitChange = (nextUnit: CanvasUnit) => {
    if (nextUnit === unit) return;
    const pxW = valid(width) ? clampSize(width) : 2048;
    const pxH = valid(height) ? clampSize(height) : 2048;
    setUnit(nextUnit);
    setWidthStr(formatUnitNumber(pixelsToUnit(pxW, nextUnit, dpi), nextUnit));
    setHeightStr(formatUnitNumber(pixelsToUnit(pxH, nextUnit, dpi), nextUnit));
  };

  // With the aspect lock on, typing one side follows with the other
  const changeWidth = (val: string) => {
    setWidthStr(val);
    const n = Number(val);
    if (aspect && n > 0) setHeightStr(formatUnitNumber(n / aspect, unit));
  };
  const changeHeight = (val: string) => {
    setHeightStr(val);
    const n = Number(val);
    if (aspect && n > 0) setWidthStr(formatUnitNumber(n * aspect, unit));
  };
  const toggleAspect = () => setAspect((a) => (a ? null : clampSize(width || 2048) / clampSize(height || 2048)));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || loading) return;
    if (!valid(width) || !valid(height)) {
      setError(`寬與高需在 ${MIN}～${MAX} px 之間`);
      return;
    }
    if (createGroup && !groupTitle.trim()) {
      setError(t.canvas.canvasGroupName);
      return;
    }
    if (!existingGroup && enablePassword && !roomPassword.trim()) {
      setError('請輸入房間密碼，或關閉密碼鎖');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await onCreate({
        title: title.trim(),
        width: clampSize(width),
        height: clampSize(height),
        dpi,
        unit,
        bgColor,
        roomPassword: !existingGroup && enablePassword ? roomPassword.trim() : undefined,
        groupId: existingGroup?.id,
        newGroupTitle: createGroup ? groupTitle.trim() : undefined,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || '建立畫布失敗');
    } finally {
      setLoading(false);
    }
  };

  const sizeField = (id: string, label: string, value: string, onChange: (v: string) => void) => (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="text-[11px] text-neutral-400">{label}</span>
      <span className="relative">
        <input id={id} type="number" inputMode="decimal" step={unit === 'px' ? 1 : 'any'} min={unit === 'px' ? MIN : 0.1} value={value} onChange={(e) => onChange(e.target.value)}
          onFocus={(e) => e.currentTarget.select()} aria-invalid={value !== '' && !valid(id === 'new-canvas-w' ? width : height)}
          className="atelier-field h-10 w-full px-3 pr-9 font-mono text-sm" />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-neutral-500">{unit}</span>
      </span>
    </label>
  );

  return (
    <AtelierModal
      title={t.canvas.newCanvasTitle}
      icon={<SquarePlus />}
      width="md"
      onClose={onClose}
      onSubmit={handleSubmit}
      footer={
        <>
          <button type="button" onClick={onClose} className={modalButton.secondary}>{t.common.cancel}</button>
          <button type="submit" disabled={loading || !title.trim()} className={modalButton.primary}>
            {loading ? t.common.processing : t.canvas.createCanvas}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-neutral-300">{t.canvas.canvasName}</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus placeholder={t.canvas.newCanvasTitle}
            className="atelier-field h-10 w-full px-3 text-sm" />
        </label>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-neutral-300">{t.canvas.presets}</span>
            <div className="flex items-center gap-1.5">
              <div className="flex rounded-md border border-neutral-700 bg-neutral-950/60 p-0.5 text-[11px]">
                {CANVAS_UNITS.map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => handleUnitChange(u)}
                    aria-pressed={unit === u}
                    className={`rounded px-2 py-0.5 font-mono transition ${unit === u ? 'bg-indigo-600 text-white' : 'text-neutral-300 hover:bg-neutral-800'}`}
                  >
                    {u}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1 text-[11px] text-neutral-300">
                <span>DPI</span>
                <input
                  type="number"
                  min={30}
                  max={1200}
                  value={dpiStr}
                  onChange={(e) => setDpiStr(e.target.value)}
                  onBlur={() => setDpiStr(String(clampDpi(Number(dpiStr) || 300)))}
                  className="atelier-field h-7 w-16 px-1.5 font-mono text-xs tabular-nums"
                />
              </label>
            </div>
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            {sizeField('new-canvas-w', t.canvas.width, widthStr, changeWidth)}
            <button type="button" onClick={toggleAspect} aria-pressed={Boolean(aspect)} aria-label={t.canvas.lockAspect}
              title={aspect ? t.canvas.unlockAspect : t.canvas.lockAspect} className="atelier-icon-btn mb-1 h-8 w-8">
              {aspect ? <Link2 className="h-4 w-4" /> : <Link2Off className="h-4 w-4" />}
            </button>
            {sizeField('new-canvas-h', t.canvas.height, heightStr, changeHeight)}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button key={p.label} type="button" onClick={() => {
                setWidthStr(formatUnitNumber(pixelsToUnit(p.w, unit, dpi), unit));
                setHeightStr(formatUnitNumber(pixelsToUnit(p.h, unit, dpi), unit));
                setAspect(null);
              }}
                className={`rounded-md border px-2 py-1 text-[11px] transition ${Math.round(width) === p.w && Math.round(height) === p.h ? 'border-indigo-500 bg-indigo-600/20 text-white' : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'}`}>
                {p.label}<span className="ml-1 text-neutral-500">{p.w}×{p.h}</span>
              </button>
            ))}
          </div>
          {valid(width) && valid(height) && (() => {
            const pxW = clampSize(width);
            const pxH = clampSize(height);
            const mb = Math.round((pxW * pxH * 4) / 1048576);
            const heavy = pxW * pxH > 6144 * 6144;
            return (
              <p className={`text-[11px] ${heavy ? 'text-amber-400' : 'text-neutral-500'}`}>
                {pxW} × {pxH} px · {dpi} DPI · {mb} MB
              </p>
            );
          })()}
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-medium text-neutral-300">{t.canvas.paperColor}</span>
          <div className="flex items-center gap-2">
            {BACKGROUNDS.map((c) => (
              <button key={c} type="button" onClick={() => setBgColor(c)} aria-label={`${t.canvas.paperColor} ${c}`} aria-pressed={bgColor === c}
                style={{ backgroundColor: c }}
                className={`h-7 w-7 rounded-md border ${bgColor === c ? 'border-indigo-500 ring-2 ring-indigo-500/40' : 'border-neutral-700'}`} />
            ))}
            <label className="ml-auto flex items-center gap-1.5 text-neutral-400" title={t.canvas.paperColor}>
              <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value.toUpperCase())}
                className="h-7 w-9 cursor-pointer rounded-md border border-neutral-700 bg-transparent p-0.5" />
              <span className="font-mono">{bgColor}</span>
            </label>
          </div>
        </div>

        {groups && (
          <div className="grid gap-2">
            <label className="grid gap-1 text-neutral-300">
              {t.canvas.canvasGroup}
              <select value={groupChoice} onChange={(event) => setGroupChoice(event.target.value)} className="atelier-field h-9 px-2">
                <option value="">{t.canvas.standaloneCanvas}</option>
                <option value="new">{t.canvas.newCanvasGroup}</option>
                {availableGroups.map((group) => <option key={group.id} value={group.id}>{group.title}</option>)}
              </select>
            </label>
            {createGroup && (
              <input value={groupTitle} onChange={(event) => setGroupTitle(event.target.value)} maxLength={80}
                aria-label={t.canvas.canvasGroupName} placeholder={t.canvas.canvasGroupName} className="atelier-field h-9 px-2" />
            )}
          </div>
        )}

        {existingGroup ? <p className="text-neutral-400">{t.canvas.canvasGroupInheritsAccess}</p> : (
        <div className="flex flex-col gap-2 rounded-lg border border-neutral-800 p-3">
          <label className="flex cursor-pointer items-center gap-2 text-neutral-300">
            <input type="checkbox" checked={enablePassword} onChange={(e) => setEnablePassword(e.target.checked)} className="h-4 w-4 accent-indigo-600" />
            <KeyRound className="h-3.5 w-3.5 text-amber-400" />
            <span className="font-medium">{t.canvas.roomPasswordLabel}</span>
            <span className="text-neutral-500">— {t.canvas.roomPasswordDesc}</span>
          </label>
          {enablePassword && (
            <span className="relative">
              <input type={showPassword ? 'text' : 'password'} value={roomPassword} onChange={(e) => setRoomPassword(e.target.value)}
                autoComplete="new-password" placeholder={t.gateway.passwordPlaceholder} aria-label={t.canvas.roomPasswordLabel}
                className="atelier-field h-10 w-full px-3 pr-10 text-sm" />
              <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? '隱藏密碼' : '顯示密碼'}
                className="atelier-icon-btn absolute right-1 top-1 h-8 w-8">
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </span>
          )}
        </div>
        )}

        {error && <p role="alert" className="rounded-md border border-rose-700 bg-rose-950/60 px-2.5 py-2 text-rose-200">{error}</p>}
      </div>
    </AtelierModal>
  );
};
