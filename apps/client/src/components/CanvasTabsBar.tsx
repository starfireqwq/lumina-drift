import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, Folder, FolderOpen, GripHorizontal, ImageOff, Lock, Pencil, Plus, X } from 'lucide-react';
import { CanvasModel } from '@atelier/shared';
import { useAuth } from '../context/AuthContext';
import { getUserColor } from '../utils/userColors';
import { useI18n } from '../context/I18nContext';
import { useEffectiveWidth } from '../hooks/useEffectiveWidth';
import {
  buildCanvasGroupEntries,
  loadCollapsedCanvasGroups,
  saveCollapsedCanvasGroups,
  toggleCollapsedCanvasGroup,
} from '../utils/canvasGroups';

export type CanvasTabsPlacement = 'top' | 'bottom';

interface CanvasTabsBarProps {
  canvases: CanvasModel[];
  activeCanvasId: string | null;
  /** canvasId -> small JPEG preview */
  thumbnails: Record<string, string>;
  expanded: boolean;
  placement: CanvasTabsPlacement;
  onMove: (placement: CanvasTabsPlacement) => void;
  onToggleExpanded: () => void;
  onSelectCanvas: (canvasId: string) => void;
  onOpenCreateModal: () => void;
  onRenameCanvas: (canvasId: string, newTitle: string) => void;
  onRequestDeleteCanvas: (canvas: CanvasModel) => void;
}

/**
 * Canvas switcher docked along a workspace edge. Collapsed: tabs. Expanded: preview cards.
 */
export const CanvasTabsBar: React.FC<CanvasTabsBarProps> = ({
  canvases,
  activeCanvasId,
  thumbnails,
  expanded,
  placement,
  onMove,
  onToggleExpanded,
  onSelectCanvas,
  onOpenCreateModal,
  onRenameCanvas,
  onRequestDeleteCanvas,
}) => {
  const { user } = useAuth();
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => loadCollapsedCanvasGroups());
  const activeRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const { effectiveWidth } = useEffectiveWidth(navRef);
  const showTabLabels = effectiveWidth >= 640;
  const entries = buildCanvasGroupEntries(canvases);

  const handleToggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = toggleCollapsedCanvasGroup(prev, groupId);
      saveCollapsedCanvasGroups(next);
      return next;
    });
  };
  const dragRef = useRef<{ pointerId: number; startY: number; bounds: DOMRect; moved: boolean } | null>(null);
  const ignorePointerClick = useRef(false);
  const [dropGuide, setDropGuide] = useState<number | null>(null);
  const opposite = placement === 'top' ? 'bottom' : 'top';
  const moveLabel = opposite === 'top' ? t.canvas.moveCanvasTabsTop : t.canvas.moveCanvasTabsBottom;
  const ExpandIcon = (placement === 'top' ? !expanded : expanded) ? ChevronDown : ChevronUp;

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    ignorePointerClick.current = false;
    const workspace = event.currentTarget.closest('.atelier-app')?.querySelector('[data-canvas-workspace]');
    if (!workspace) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, bounds: workspace.getBoundingClientRect(), moved: false };
  };

  const dropPlacement = (y: number, bounds: DOMRect): CanvasTabsPlacement =>
    y < (bounds.top + bounds.bottom) / 2 ? 'top' : 'bottom';

  const moveDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || (!drag.moved && Math.abs(event.clientY - drag.startY) < 6)) return;
    drag.moved = true;
    setDropGuide(dropPlacement(event.clientY, drag.bounds) === 'top' ? drag.bounds.top : drag.bounds.bottom - 3);
  };

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDropGuide(null);
    if (!drag.moved) return;
    ignorePointerClick.current = true;
    if (event.type === 'pointerup') onMove(dropPlacement(event.clientY, drag.bounds));
  };

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeCanvasId, canvases.length, expanded]);

  const canManage = (canvas: CanvasModel) => user?.serverRole === 'admin' || user?.id === canvas.ownerId;
  /** Same colour language as the layer list: owner-colour edge; someone else's canvas also gets a wash of their colour */
  const ownerStyle = (canvas: CanvasModel): React.CSSProperties => {
    const hex = getUserColor(canvas.ownerId).hex;
    // A border, not box-shadow: the active tab's ring is a box-shadow
    return user?.id === canvas.ownerId
      ? { borderLeft: `3px solid ${hex}` }
      : { borderLeft: `3px solid ${hex}`, backgroundImage: `linear-gradient(90deg, ${hex}33, transparent 70%)` };
  };
  const ownerTitle = (canvas: CanvasModel) => (user?.id === canvas.ownerId ? t.canvas.myCanvas : t.canvas.otherCanvas);

  const startRename = (canvas: CanvasModel, e: React.SyntheticEvent) => {
    e.stopPropagation();
    if (!canManage(canvas)) return;
    setEditingId(canvas.id);
    setEditingTitle(canvas.title);
  };

  const saveRename = (canvas: CanvasModel) => {
    const title = editingTitle.trim();
    if (title && title !== canvas.title) onRenameCanvas(canvas.id, title);
    setEditingId(null);
  };

  const renameInput = (canvas: CanvasModel, className: string) => (
    <input
      type="text"
      aria-label={t.canvas.canvasName}
      value={editingTitle}
      onChange={(e) => setEditingTitle(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setEditingId(null);
        }
      }}
      onBlur={() => saveRename(canvas)}
      autoFocus
      className={`atelier-field px-1.5 py-0.5 text-xs ${className}`}
    />
  );

  const actions = (canvas: CanvasModel) => canManage(canvas) && (
    <span className="flex shrink-0 items-center opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
      <button type="button" onClick={(e) => startRename(canvas, e)} title={t.canvas.renameCanvas} aria-label={`${t.canvas.renameCanvas} ${canvas.title}`}
        className="atelier-icon-btn h-6 w-6"><Pencil className="h-3 w-3" /></button>
      {canvases.length > 1 && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onRequestDeleteCanvas(canvas); }} title={t.canvas.deleteCanvas} aria-label={`${t.canvas.deleteCanvas} ${canvas.title}`}
          className="atelier-icon-btn h-6 w-6 hover:!text-rose-400"><X className="h-3.5 w-3.5" /></button>
      )}
    </span>
  );

  const renderTab = (canvas: CanvasModel, inGroup = false) => {
    const active = canvas.id === activeCanvasId;
    return (
      <div key={canvas.id} ref={active ? activeRef : undefined} role="tab" aria-selected={active} tabIndex={0}
        onClick={() => onSelectCanvas(canvas.id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectCanvas(canvas.id); }}
        onDoubleClick={(e) => startRename(canvas, e)}
        title={`${canvas.title}（${ownerTitle(canvas)}）`}
        style={ownerStyle(canvas)}
        className={`group flex h-7 max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md pl-2 pr-0.5 text-xs transition ${active ? 'bg-indigo-600/20 text-white ring-1 ring-inset ring-indigo-500/60' : 'text-neutral-300 hover:bg-neutral-800'}`}>
        {thumbnails[canvas.id]
          ? <img src={thumbnails[canvas.id]} alt="" className="h-4 w-4 shrink-0 rounded-sm object-cover ring-1 ring-neutral-600" />
          : <span className="h-4 w-4 shrink-0 rounded-sm ring-1 ring-neutral-600" style={{ background: canvas.bgColor || '#fff' }} />}
        {canvas.hasPassword && <Lock className="h-3 w-3 shrink-0 text-amber-400" aria-label="密碼房" />}
        {!inGroup && canvas.group && <span className="max-w-16 shrink-0 truncate text-[10px] text-indigo-300" title={canvas.group.title}>{canvas.group.title}</span>}
        {editingId === canvas.id ? renameInput(canvas, 'w-32') : <span className="truncate">{canvas.title}</span>}
        {editingId !== canvas.id && actions(canvas)}
      </div>
    );
  };

  const renderCard = (canvas: CanvasModel, inGroup = false) => {
    const active = canvas.id === activeCanvasId;
    const thumb = thumbnails[canvas.id];
    return (
      <div key={canvas.id} ref={active ? activeRef : undefined} role="tab" aria-selected={active} tabIndex={0}
        onClick={() => onSelectCanvas(canvas.id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectCanvas(canvas.id); }}
        className={`group flex w-36 shrink-0 cursor-pointer flex-col overflow-hidden rounded-lg border transition ${active ? 'border-indigo-500 ring-2 ring-indigo-500/40' : 'border-neutral-700 hover:border-neutral-500'}`}>
        <div className="relative flex h-20 items-center justify-center overflow-hidden bg-neutral-950" style={{ backgroundImage: 'repeating-conic-gradient(rgb(var(--n-800)) 0% 25%, transparent 0% 50%)', backgroundSize: '12px 12px' }}>
          {thumb
            ? <img src={thumb} alt={`${canvas.title}`} className="h-full w-full object-cover object-center" />
            : (
              <div className="flex flex-col items-center gap-1 text-[10px] text-neutral-500">
                <span className="h-8 w-12 rounded-sm shadow ring-1 ring-neutral-600" style={{ background: canvas.bgColor || '#fff', aspectRatio: `${canvas.width} / ${canvas.height}` }} />
                <span className="flex items-center gap-1"><ImageOff className="h-3 w-3" />開啟後產生預覽</span>
              </div>
            )}
          {canvas.hasPassword && <span className="absolute left-1 top-1 rounded bg-black/60 p-0.5"><Lock className="h-3 w-3 text-amber-400" /></span>}
        </div>
        <div className="flex items-center gap-1 bg-neutral-900 px-1.5 py-1" style={ownerStyle(canvas)} title={ownerTitle(canvas)} onDoubleClick={(e) => startRename(canvas, e)}>
          {editingId === canvas.id
            ? renameInput(canvas, 'w-full')
            : (
              <>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[11px] font-medium ${active ? 'text-white' : 'text-neutral-200'}`}>{canvas.title}</span>
                  {!inGroup && canvas.group && <span className="block truncate text-[10px] text-indigo-300">{canvas.group.title}</span>}
                  <span className="block text-[10px] tabular-nums text-neutral-500">{canvas.width} × {canvas.height}</span>
                </span>
                {actions(canvas)}
              </>
            )}
        </div>
      </div>
    );
  };

  return (
    <nav ref={navRef} aria-label={t.canvas.canvasSwitcher} data-canvas-tabs-placement={placement}
      className={`atelier-chrome shrink-0 select-none ${placement === 'top' ? 'border-b' : 'border-t'}`}>
      {dropGuide !== null && <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 z-[80] h-[3px] bg-indigo-400" style={{ top: dropGuide }} />}
      <div className="flex items-center gap-1 px-1.5" style={expanded ? undefined : { height: 36 }}>
        <button type="button" title={moveLabel} aria-label={moveLabel}
          className="atelier-icon-btn h-7 w-7 shrink-0 touch-none cursor-grab active:cursor-grabbing"
          onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag}
          onPointerCancel={endDrag} onLostPointerCapture={endDrag}
          onClick={(event) => {
            if (event.detail === 0 || !ignorePointerClick.current) onMove(opposite);
          }}>
          <GripHorizontal aria-hidden="true" className="h-4 w-4" />
        </button>
        <button type="button" onClick={onToggleExpanded} aria-expanded={expanded}
          title={expanded ? '收起畫布預覽' : '展開畫布預覽'}
          aria-label={`${t.canvas.canvasName} (${canvases.length})`}
          className="atelier-icon-btn h-7 shrink-0 gap-1 px-2 text-[11px] font-semibold">
          <ExpandIcon className="h-3.5 w-3.5" />
          {showTabLabels && <span>{t.canvas.canvasName}</span>}
          <span className="rounded bg-neutral-800 px-1 text-[10px] text-neutral-400">{canvases.length}</span>
        </button>

        {!expanded && (
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar touch-pan-x" role="tablist">
            {entries.map((entry) => {
              if (entry.kind === 'canvas') return renderTab(entry.canvas);
              const isCollapsed = collapsedGroups.has(entry.group.id);
              const hasActive = entry.canvases.some((c) => c.id === activeCanvasId);
              return (
                <div
                  key={`group-${entry.group.id}`}
                  data-canvas-group={entry.group.id}
                  data-collapsed={isCollapsed ? 'true' : 'false'}
                  className="flex shrink-0 items-center gap-0.5 rounded-md border border-indigo-500/30 bg-indigo-600/10 px-1 py-0.5"
                >
                  <button
                    type="button"
                    data-canvas-group-toggle={entry.group.id}
                    aria-expanded={!isCollapsed}
                    aria-label={`${t.canvas.canvasGroup}: ${entry.group.title}`}
                    title={`${entry.group.title} (${isCollapsed ? t.canvas.expandCanvasGroup : t.canvas.collapseCanvasGroup})`}
                    onClick={() => handleToggleGroup(entry.group.id)}
                    className={`flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] font-semibold transition ${
                      isCollapsed && hasActive
                        ? 'bg-indigo-600/25 text-white ring-1 ring-inset ring-indigo-500/60'
                        : 'text-indigo-200 hover:bg-neutral-800'
                    }`}
                  >
                    {isCollapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
                    {isCollapsed ? <Folder className="h-3.5 w-3.5 shrink-0 text-indigo-400" /> : <FolderOpen className="h-3.5 w-3.5 shrink-0 text-indigo-400" />}
                    <span className="max-w-28 truncate">{entry.group.title}</span>
                    <span className="rounded bg-neutral-800/90 px-1 text-[10px] tabular-nums text-indigo-300">{entry.canvases.length}</span>
                  </button>
                  {!isCollapsed && entry.canvases.map((canvas) => renderTab(canvas, true))}
                </div>
              );
            })}
          </div>
        )}
        {expanded && <span className="flex-1 truncate text-[11px] text-neutral-500">{t.canvas.renameCanvas}</span>}

        <button type="button" onClick={onOpenCreateModal} title={t.canvas.newCanvasTitle} aria-label={t.canvas.newCanvasTitle} className="atelier-icon-btn h-7 shrink-0 gap-1 px-2 text-[11px] font-semibold">
          <Plus className="h-3.5 w-3.5" />{showTabLabels && <span>{t.canvas.newCanvasTitle}</span>}
        </button>
      </div>

      {expanded && (
        <div className="flex items-stretch gap-2 overflow-x-auto px-2 pb-2 no-scrollbar touch-pan-x" role="tablist" aria-label={t.canvas.canvasSwitcher}>
          {entries.map((entry) => {
            if (entry.kind === 'canvas') return renderCard(entry.canvas);
            const isCollapsed = collapsedGroups.has(entry.group.id);
            const hasActive = entry.canvases.some((c) => c.id === activeCanvasId);
            if (isCollapsed) {
              return (
                <button
                  key={`group-${entry.group.id}`}
                  type="button"
                  data-canvas-group={entry.group.id}
                  data-collapsed="true"
                  data-canvas-group-toggle={entry.group.id}
                  aria-expanded={false}
                  aria-label={`${t.canvas.canvasGroup}: ${entry.group.title}`}
                  title={`${entry.group.title} (${t.canvas.expandCanvasGroup})`}
                  onClick={() => handleToggleGroup(entry.group.id)}
                  className={`flex w-36 shrink-0 flex-col overflow-hidden rounded-lg border text-left transition ${
                    hasActive ? 'border-indigo-500 ring-2 ring-indigo-500/40' : 'border-indigo-500/40 hover:border-indigo-400'
                  }`}
                >
                  <div className="relative flex h-20 flex-col items-center justify-center gap-1 bg-neutral-950 text-indigo-300">
                    <Folder className="h-7 w-7 text-indigo-400" />
                    <span className="rounded bg-indigo-600/20 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-indigo-200">
                      {entry.canvases.length}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 bg-neutral-900 px-2 py-1.5">
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-semibold text-indigo-200">{entry.group.title}</span>
                      <span className="block truncate text-[10px] text-neutral-400">{t.canvas.expandCanvasGroup}</span>
                    </span>
                  </div>
                </button>
              );
            }
            return (
              <div
                key={`group-${entry.group.id}`}
                data-canvas-group={entry.group.id}
                data-collapsed="false"
                className="flex shrink-0 flex-col gap-1.5 rounded-xl border border-indigo-500/35 bg-indigo-600/10 p-1.5"
              >
                <button
                  type="button"
                  data-canvas-group-toggle={entry.group.id}
                  aria-expanded={true}
                  aria-label={`${t.canvas.canvasGroup}: ${entry.group.title}`}
                  title={`${entry.group.title} (${t.canvas.collapseCanvasGroup})`}
                  onClick={() => handleToggleGroup(entry.group.id)}
                  className="flex items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-xs font-semibold text-indigo-200 transition hover:bg-neutral-800/80"
                >
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
                  <span className="max-w-44 truncate">{entry.group.title}</span>
                  <span className="rounded bg-neutral-800 px-1.5 text-[10px] tabular-nums text-indigo-300">{entry.canvases.length}</span>
                </button>
                <div className="flex gap-2">
                  {entry.canvases.map((canvas) => renderCard(canvas, true))}
                </div>
              </div>
            );
          })}
          <button type="button" onClick={onOpenCreateModal}
            className="flex w-28 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-neutral-600 text-[11px] text-neutral-400 hover:border-indigo-500 hover:text-indigo-300">
            <Plus className="h-5 w-5" />{t.canvas.newCanvasTitle}
          </button>
        </div>
      )}
    </nav>
  );
};
