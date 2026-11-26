import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Download, FolderPlus, MoreHorizontal, Plus, Upload } from 'lucide-react';
import { BrushPackageManager, MIN_BRUSH_SPACING, type AtelierBrushPreset } from '@atelier/shared';
import type { BrushProperties } from '../engine/BrushRenderer';
import { useI18n } from '../context/I18nContext';
import { brushGroup, getBrushLibrary, newBrushId, subscribeBrushLibrary, updateBrushLibrary } from '../services/brushLibrary';
import { getUiScale } from '../theme/uiScale';

const DRAG_TYPE = 'application/x-lumina-brush-id';
const thumbnailSize = { width: 144, height: 36 };
let activeGroup: string | null = null;

function BrushStroke({ brush }: { brush: AtelierBrushPreset }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { width, height } = thumbnailSize;
    const { size, minSize, opacity, hardness, spacing, flow } = brush.properties;
    const draw = (tip?: HTMLImageElement) => {
      ctx.clearRect(0, 0, width, height);
      const radius = Math.max(2.5, Math.min(11, Math.sqrt(Math.max(1, Number(size) || 1)) * 1.55));
      const step = Math.min(12, Math.max(1, radius * (Number(spacing) || MIN_BRUSH_SPACING)));
      for (let x = 11; x <= width - 11; x += step) {
        const t = (x - 11) / (width - 22);
        const pressure = Math.min(1, Math.max((Number(minSize) || 0) / Math.max(1, Number(size) || 1) * 0.35, Math.sin(Math.PI * t) ** 0.9));
        const r = Math.max(0.8, radius * pressure);
        const y = height / 2 - 7 * Math.sin(2 * Math.PI * t);
        ctx.globalAlpha = Math.max(0.12, Math.min(1, (opacity ?? 1) * (flow ?? 1))) || 1;
        if (tip) {
          const scale = (r * 2) / Math.max(tip.naturalWidth, tip.naturalHeight);
          const tw = tip.naturalWidth * scale;
          const th = tip.naturalHeight * scale;
          ctx.drawImage(tip, x - tw / 2, y - th / 2, tw, th);
        } else {
          const gradient = ctx.createRadialGradient(x, y, r * Math.min(0.98, Math.max(0, Number(hardness ?? 1) || 0)), x, y, r);
          gradient.addColorStop(0, '#fff');
          gradient.addColorStop(1, '#ffffff00');
          ctx.fillStyle = gradient;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
    };
    const image = new Image();
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      draw();
      if (!brush.tipDataUrl) return;
      image.onload = () => draw(image);
      image.src = brush.tipDataUrl;
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      image.onload = null;
    };
  }, [brush]);
  return <canvas ref={canvasRef} {...thumbnailSize} aria-hidden="true" className="h-7 w-[104px] max-w-[48%] shrink-0" />;
}

interface BrushToolsetProps {
  currentBrushProps: BrushProperties;
  selectedId: string | null;
  onApplyPreset: (preset: AtelierBrushPreset) => void;
}

type Edit = { kind: 'group' | 'save' } | { kind: 'rename'; brush: AtelierBrushPreset };
type Menu = { x: number; y: number; anchor: HTMLElement } &
  ({ kind: 'brush'; brush: AtelierBrushPreset } | { kind: 'group'; group: string });

function downloadBrushes(json: string, name: string) {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BrushToolset({ currentBrushProps, selectedId, onApplyPreset }: BrushToolsetProps) {
  const { t } = useI18n();
  const labels = t.brushPreset;
  const library = useSyncExternalStore(subscribeBrushLibrary, getBrushLibrary);
  const [group, setGroup] = useState(activeGroup);
  const [dropGroup, setDropGroup] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [name, setName] = useState('');
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editInput = useRef<HTMLInputElement>(null);
  const nameLabel = useId();

  const selectGroup = (next: string | null) => {
    activeGroup = next;
    setGroup(next);
  };
  const displayGroup = group && library.groups.includes(group) ? group : null;
  const displayed = displayGroup ? library.brushes.filter((brush) => brushGroup(brush) === displayGroup) : library.brushes;
  const title = (brush: AtelierBrushPreset) => brush.id === 'preset_thick_oil_impasto' && brush.name === '經典油畫厚塗筆 (Thick Impasto)'
    ? t.studio.impastoMixer : brush.name;

  useEffect(() => {
    if (edit) editInput.current?.focus();
  }, [edit]);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector('button')?.focus();
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      const items = Array.from(menuRef.current?.querySelectorAll('button') ?? []);
      if (event.key === 'Escape') {
        event.stopPropagation();
        menu.anchor.focus();
        setMenu(null);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  const mutate = async (update: Parameters<typeof updateBrushLibrary>[0]) => {
    setError('');
    try {
      await updateBrushLibrary(update);
      return true;
    } catch {
      setError(labels.storageError);
      return false;
    }
  };

  const copyBrush = (brush: AtelierBrushPreset, target = brushGroup(brush), rename = false) =>
    mutate((state) => ({
      groups: state.groups.includes(target) ? state.groups : [...state.groups, target],
      brushes: [...state.brushes, { ...brush, id: newBrushId(), name: rename ? `${title(brush)} ${labels.copySuffix}` : title(brush), category: target, createdAt: Date.now() }],
    }));

  const beginEdit = (next: Edit) => {
    setError('');
    setName(next.kind === 'rename' ? title(next.brush) : '');
    setEdit(next);
    setMenu(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !edit) return;
    if (edit.kind === 'group') {
      if (!await mutate((state) => state.groups.includes(trimmed) ? state : { ...state, groups: [...state.groups, trimmed] })) return;
      selectGroup(trimmed);
    } else if (edit.kind === 'rename') {
      if (!await mutate((state) => ({
        ...state,
        brushes: state.brushes.map((brush) => brush.id === edit.brush.id ? { ...brush, name: trimmed } : brush),
      }))) return;
    } else {
      const category = displayGroup ?? '自訂筆刷';
      const {
        color, customBrushUrl, customTextureUrl, dualTipUrl, secondaryColor: _secondary,
        pressureCurve, tipUrls, colorDynamics, ...settings
      } = currentBrushProps;
      const brush: AtelierBrushPreset = {
        id: newBrushId(), name: trimmed, category, version: '2.0',
        properties: {
          ...settings, color, pressureCurve, customTextureUrl, dualTipUrl,
          tipUrls: tipUrls ? [...tipUrls] : undefined,
          colorDynamics: colorDynamics ? { ...colorDynamics } : undefined,
        },
        tipDataUrl: customBrushUrl,
        tipUrls: tipUrls ? [...tipUrls] : undefined,
        textureDataUrl: customTextureUrl ?? null,
        dualTipDataUrl: dualTipUrl ?? null,
        createdAt: Date.now(),
      };
      if (!await mutate((state) => ({
        brushes: [...state.brushes, brush],
        groups: state.groups.includes(category) ? state.groups : [...state.groups, category],
      }))) return;
    }
    setEdit(null);
  };

  const importFile = async (file: File) => {
    setImporting(true);
    setError('');
    try {
      const parsed = await BrushPackageManager.parseBrushFile(await file.arrayBuffer(), file.name);
      const abrGroup = /\.abr$/i.test(file.name) ? file.name.slice(0, -4).trim() : '';
      const procreateSetGroup = /\.brushset$/i.test(file.name)
        ? (parsed[0]?.category?.trim() || file.name.slice(0, -9).trim())
        : '';
      const brushes = parsed.filter((brush) => typeof brush?.name === 'string' && brush.name.trim() && brush.properties)
        .map((brush) => ({ ...brush, id: newBrushId(), category: abrGroup || procreateSetGroup || (displayGroup ?? brushGroup(brush)) }));
      if (!brushes.length) throw new Error('No brush tips');
      if (await mutate((state) => ({
        brushes: [...state.brushes, ...brushes],
        groups: Array.from(new Set([...state.groups, ...brushes.map(brushGroup)])),
      }))) {
        selectGroup(brushGroup(brushes[0]));
        onApplyPreset(brushes[0]);
      }
    } catch {
      setError(labels.importError);
    } finally {
      setImporting(false);
    }
  };

  const drop = async (event: React.DragEvent, target: string) => {
    event.preventDefault();
    setDropGroup(null);
    const source = getBrushLibrary().brushes.find((brush) => brush.id === event.dataTransfer.getData(DRAG_TYPE));
    if (source && brushGroup(source) !== target && await copyBrush(source, target)) selectGroup(target);
  };

  const exportPack = () => downloadBrushes(BrushPackageManager.exportPackToJson({
    name: 'Lumina Drift', author: 'Lumina Drift', version: '1.0',
    brushes: library.brushes, createdAt: Date.now(),
  }), 'Lumina-Drift.asbrushpack');

  const deleteGroup = async (target: string) => {
    if (!window.confirm(labels.deleteGroupConfirm.replace('{name}', target))) return;
    if (await mutate(state => ({
      groups: state.groups.filter(group => group !== target),
      brushes: state.brushes.filter(brush => brushGroup(brush) !== target),
    })) && activeGroup === target) selectGroup(null);
  };

  const menuItems: Array<[string, () => void]> = menu?.kind === 'brush' ? [
    [labels.renameBrush, () => beginEdit({ kind: 'rename', brush: menu.brush })],
    [labels.copyBrush, () => void copyBrush(menu.brush, brushGroup(menu.brush), true)],
    [labels.exportSingle, () => downloadBrushes(BrushPackageManager.exportPresetToJson(menu.brush), `${menu.brush.name.replace(/\s+/g, '_')}.asbrush`)],
    [labels.deleteBrush, () => void mutate((state) => ({ ...state, brushes: state.brushes.filter((brush) => brush.id !== menu.brush.id) }))],
  ] : menu?.kind === 'group' ? [[labels.deleteGroup, () => void deleteGroup(menu.group)]] : [];
  const menuWidth = Math.min(window.innerWidth - 8, 160 * getUiScale());
  const menuHeight = Math.min(window.innerHeight - 8, (menu?.kind === 'group' ? 40 : 124) * getUiScale());

  return (
    <div className="flex h-full min-h-[112px] min-w-0 flex-col text-xs">
      <div className="flex shrink-0 items-center border-b border-neutral-700/70 bg-neutral-900/50">
        <div aria-label={labels.groupsLabel} className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto p-1"
          onWheel={(e) => { if (!e.deltaX) e.currentTarget.scrollLeft += e.deltaY; }}>
          {[null, ...library.groups].map((value) => (
            <button type="button" key={value === null ? 'all' : `group_${value}`} aria-pressed={displayGroup === value}
              className={`shrink-0 rounded-sm border px-2 py-1 whitespace-nowrap ${value && dropGroup === value ? 'border-indigo-400 bg-indigo-600/45' : displayGroup === value ? 'border-indigo-500/50 bg-indigo-600/25 text-neutral-100' : 'border-transparent text-neutral-300 hover:bg-neutral-800'}`}
              onClick={() => selectGroup(value)}
              onContextMenu={value === null ? undefined : (e) => {
                e.preventDefault();
                setMenu({ kind: 'group', group: value, x: e.clientX, y: e.clientY, anchor: e.currentTarget });
              }}
              onDragOver={(e) => {
                if (!value || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                setDropGroup(value);
              }}
              onDragLeave={() => setDropGroup(null)}
              onDrop={value ? (e) => void drop(e, value) : undefined}>
              {value ?? labels.allBrushes}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => beginEdit({ kind: 'group' })} className="atelier-icon-btn mr-1 h-7 w-7 shrink-0"
          aria-label={labels.newGroup} title={labels.newGroup}><FolderPlus size={15} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!displayed.length && <p className="px-3 py-4 text-neutral-400">{labels.emptyGroup}</p>}
        {displayed.map((brush) => (
          <div key={brush.id} className={`group flex min-w-0 items-center border-b border-neutral-700/60 ${selectedId === brush.id ? 'bg-indigo-600/30' : 'hover:bg-neutral-800/70'}`}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ kind: 'brush', brush, x: e.clientX, y: e.clientY, anchor: e.currentTarget.querySelector('button')! });
            }}>
            <button type="button" aria-pressed={brush.id === selectedId} title={title(brush)}
              className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-0.5 text-left text-neutral-100"
              draggable onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, brush.id);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onDragEnd={() => setDropGroup(null)}
              onClick={() => onApplyPreset(brush)}>
              <BrushStroke brush={brush} />
              <span className="truncate">{title(brush)}</span>
            </button>
            <button type="button" aria-label={`${labels.brushActions} · ${title(brush)}`} aria-haspopup="menu"
              className="atelier-icon-btn mr-1 h-6 w-6 shrink-0"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setMenu({ kind: 'brush', brush, x: rect.left, y: rect.bottom, anchor: e.currentTarget });
              }}><MoreHorizontal size={14} /></button>
          </div>
        ))}
      </div>
      {edit && <form className="flex shrink-0 flex-col gap-1 border-t border-neutral-700 px-2 py-1.5" onSubmit={(e) => void save(e)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEdit(null); } }}>
        <label id={nameLabel}>{edit.kind === 'group' ? labels.newGroup : edit.kind === 'rename' ? labels.renameBrush : labels.saveCurrentBrush}</label>
        <div className="flex min-w-0 gap-1">
          <input ref={editInput} aria-labelledby={nameLabel} className="atelier-field w-0 flex-1 px-2 py-1"
            maxLength={80} value={name} onChange={(e) => setName(e.target.value)} required />
          <button type="submit" className="rounded bg-indigo-600 px-2 text-white disabled:opacity-40" disabled={!name.trim()}>{labels.confirmSave}</button>
          <button type="button" className="atelier-icon-btn px-1" onClick={() => setEdit(null)}>{labels.cancelEdit}</button>
        </div>
      </form>}
      {error && <p role="alert" className="shrink-0 px-2 py-1 text-red-300">{error}</p>}
      <div className="flex shrink-0 items-center gap-1 border-t border-neutral-700/80 px-1 py-0.5">
        <button type="button" className="atelier-icon-btn h-7 w-7" aria-label={labels.saveCurrentBrush}
          title={labels.saveCurrentBrush} onClick={() => beginEdit({ kind: 'save' })}><Plus size={16} /></button>
        <button type="button" className="atelier-icon-btn h-7 w-7" aria-label={labels.importBrushes}
          title={labels.importBrushes} disabled={importing} onClick={() => input.current?.click()}><Upload size={14} /></button>
        <input ref={input} type="file" hidden accept=".abr,.sut,.brush,.brushset,.asbrush,.asbrushpack,.json,image/*" onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (file) void importFile(file);
        }} />
        <button type="button" className="atelier-icon-btn h-7 w-7" aria-label={labels.exportAllPack}
          title={labels.exportAllPack} disabled={!library.brushes.length} onClick={exportPack}><Download size={14} /></button>
      </div>
      {menu && createPortal(
        <div ref={menuRef} role="menu" aria-label={menu.kind === 'group' ? menu.group : labels.brushActions}
          className="atelier-chrome fixed z-[110] flex flex-col overflow-y-auto rounded border border-neutral-600 p-1 text-xs shadow-xl"
          style={{ width: menuWidth, maxHeight: menuHeight, left: Math.max(4, Math.min(window.innerWidth - menuWidth - 4, menu.x)),
            top: Math.max(4, Math.min(window.innerHeight - menuHeight - 4, menu.y)) }}
          onBlur={(e) => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setMenu(null); }}>
          {menuItems.map(([label, action]) => (
            <button type="button" key={label} role="menuitem" className="rounded px-2 py-1.5 text-left text-neutral-100 hover:bg-neutral-700 focus:bg-neutral-700"
              onClick={() => {
                action();
                setMenu(null);
              }}>{label}</button>
          ))}
        </div>, document.body)}
    </div>
  );
}
