import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { ToolType } from '@atelier/shared';
import { ShortcutManager, makePluginToolShortcutId } from '../../engine/ShortcutManager';
import { ALL_TOOLS, ToolDef, getLocalizedToolGroups } from './toolCatalog';
import { RailGrip, startDrag } from './DockSystem';
import { TOOL_RAIL_WIDTH_MAX, TOOL_RAIL_WIDTH_MIN } from './dockStore';
import { useI18n } from '../../context/I18nContext';
import { useUiScale } from '../../theme/uiScale';
import { resolvePluginName, resolvePluginText } from '../../plugins/pluginApi';
import { getPluginLabels } from '../../plugins/pluginLabels';
import type { RegisteredPluginTool } from '../../plugins/pluginTools';
import { getPluginToolIcon } from './pluginToolIcons';

/** Shortcut label for a tool, read live from the user's ShortcutManager bindings. */
export const useShortcutLabel = () => {
  const mgr = ShortcutManager.getInstance();
  const [, setVersion] = useState(0);
  useEffect(() => mgr.subscribe(() => setVersion((v) => v + 1)), [mgr]);
  return (actionId?: string) => (actionId ? mgr.getDisplayLabel(mgr.getComboForAction(actionId)) : '');
};

interface ToolRailProps {
  currentTool: ToolType;
  onSelectTool: (tool: ToolType) => void;
  pluginTools?: readonly RegisteredPluginTool[];
  activePluginToolKey?: string | null;
  onSelectPluginTool?: (pluginId: string, toolId: string) => void;
  orientation: 'vertical' | 'horizontal' | 'grid';
  /** Vertical rail: which screen edge it is on (tooltips open toward the canvas) */
  side?: 'left' | 'right';
  width?: number;
  onResizeWidth?: (width: number) => void;
}

export const ToolRail: React.FC<ToolRailProps> = ({
  currentTool,
  onSelectTool,
  pluginTools = [],
  activePluginToolKey = null,
  onSelectPluginTool,
  orientation,
  side = 'left',
  width,
  onResizeWidth,
}) => {
  const { t, language } = useI18n();
  const pluginStrings = getPluginLabels(language);
  const ui = useUiScale();
  const label = useShortcutLabel();
  const [tip, setTip] = useState<{ label: string; hint?: string; shortcutId?: string; x: number; y: number } | null>(null);
  const [scrollState, setScrollState] = useState({ canUp: false, canDown: false });
  const navRef = useRef<HTMLElement>(null);
  const vertical = orientation === 'vertical';
  const toolGroups = getLocalizedToolGroups(t);
  const actualWidth = width ?? Math.round(46 * ui);
  const cols = vertical ? Math.max(1, Math.floor((actualWidth - 8 * ui) / (29 * ui))) : 1;

  const updateScrollHints = useCallback(() => {
    const el = navRef.current;
    if (!el || !vertical) {
      setScrollState((prev) => (prev.canUp || prev.canDown ? { canUp: false, canDown: false } : prev));
      return;
    }
    const canUp = el.scrollTop > 2;
    const canDown = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setScrollState((prev) => (prev.canUp === canUp && prev.canDown === canDown ? prev : { canUp, canDown }));
  }, [vertical]);

  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    updateScrollHints();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateScrollHints) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [updateScrollHints, actualWidth, cols, toolGroups.length]);

  // Mouse wheel scrolling when tools overflow (and Shift/Alt+wheel to step tool selection directly)
  const toolRef = useRef(currentTool);
  toolRef.current = currentTool;
  const selectToolRef = useRef(onSelectTool);
  selectToolRef.current = onSelectTool;

  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (vertical && (e.shiftKey || e.altKey)) {
        const idx = ALL_TOOLS.findIndex((tool) => tool.id === toolRef.current);
        if (idx >= 0) {
          const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
          if (dir) {
            e.preventDefault();
            e.stopPropagation();
            const next = ALL_TOOLS[(idx + dir + ALL_TOOLS.length) % ALL_TOOLS.length];
            selectToolRef.current(next.id);
          }
        }
        return;
      }
      if (!vertical) {
        if (el.scrollWidth > el.clientWidth + 1 && e.deltaY !== 0) {
          e.preventDefault();
          e.stopPropagation();
          el.scrollLeft += e.deltaY;
        }
        return;
      }
      if (el.scrollHeight > el.clientHeight + 1 && e.deltaY !== 0) {
        e.preventDefault();
        e.stopPropagation();
        el.scrollTop += e.deltaY;
        updateScrollHints();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [vertical, updateScrollHints]);

  // Ensure keyboard/wheel-selected tool stays scrolled into view
  useEffect(() => {
    const el = navRef.current;
    if (!el || !vertical) return;
    const btn = el.querySelector<HTMLElement>(`[data-tool-id="${currentTool}"]`);
    if (btn && el.scrollHeight > el.clientHeight + 2) {
      btn.scrollIntoView({ block: 'nearest' });
    }
  }, [currentTool, vertical]);

  const button = (tool: ToolDef) => {
    const Icon = tool.icon;
    const key = label(tool.shortcutId);
    const active = !activePluginToolKey && currentTool === tool.id;
    return (
      <button
        key={tool.id}
        data-tool-id={tool.id}
        type="button"
        onClick={() => onSelectTool(tool.id)}
        aria-pressed={active}
        aria-label={key ? `${tool.label}（${key}）` : tool.label}
        aria-keyshortcuts={key || undefined}
        onPointerEnter={(e) => {
          if (e.pointerType !== 'mouse') return;
          const r = e.currentTarget.getBoundingClientRect();
          setTip(
            vertical
              ? { label: tool.label, hint: tool.hint, shortcutId: tool.shortcutId, x: side === 'right' ? r.left - 8 : r.right + 8, y: r.top + r.height / 2 }
              : { label: tool.label, hint: tool.hint, shortcutId: tool.shortcutId, x: r.left + r.width / 2, y: r.top - 8 },
          );
        }}
        onPointerLeave={() => setTip(null)}
        className={`atelier-icon-btn shrink-0 ${vertical ? 'h-7 w-7 !rounded-sm' : 'h-10 w-10'}`}
      >
        <Icon className={vertical ? 'h-4 w-4' : 'h-5 w-5'} />
      </button>
    );
  };

  const pluginToolButton = (item: RegisteredPluginTool) => {
    const Icon = getPluginToolIcon(item.tool.icon);
    const shortcutId = makePluginToolShortcutId(item.plugin.id, item.tool.id);
    const key = label(shortcutId);
    const displayLabel = resolvePluginText(item.tool.label, item.tool.i18nLabel, language);
    const hintText = item.tool.hint
      ? resolvePluginText(item.tool.hint, item.tool.i18nHint, language)
      : resolvePluginName(item.plugin, language);
    const active = activePluginToolKey === item.key;
    return (
      <button
        key={item.key}
        data-plugin-tool-id={item.key}
        type="button"
        onClick={() => onSelectPluginTool?.(item.plugin.id, item.tool.id)}
        aria-pressed={active}
        aria-label={key ? `${displayLabel}（${key}）` : displayLabel}
        aria-keyshortcuts={key || undefined}
        onPointerEnter={(e) => {
          if (e.pointerType !== 'mouse') return;
          const r = e.currentTarget.getBoundingClientRect();
          setTip(
            vertical
              ? { label: displayLabel, hint: hintText, shortcutId, x: side === 'right' ? r.left - 8 : r.right + 8, y: r.top + r.height / 2 }
              : { label: displayLabel, hint: hintText, shortcutId, x: r.left + r.width / 2, y: r.top - 8 },
          );
        }}
        onPointerLeave={() => setTip(null)}
        className={`atelier-icon-btn shrink-0 ${vertical ? 'h-7 w-7 !rounded-sm' : 'h-10 w-10'} ${
          active ? '!border-cyan-400/70 !bg-cyan-500/20 !text-cyan-200' : 'text-cyan-300/80'
        }`}
      >
        <Icon className={vertical ? 'h-4 w-4' : 'h-5 w-5'} />
      </button>
    );
  };

  const tooltip = tip && (
    <div className="atelier-tooltip flex items-center gap-2"
      style={vertical
        ? { left: tip.x, top: tip.y, transform: side === 'right' ? 'translate(-100%, -50%)' : 'translateY(-50%)' }
        : { left: tip.x, top: tip.y, transform: 'translate(-50%, -100%)' }}>
      <span className="font-semibold">{tip.label}</span>
      {label(tip.shortcutId) && <kbd className="atelier-kbd">{label(tip.shortcutId)}</kbd>}
      {tip.hint && <span className="max-w-[220px] whitespace-normal text-neutral-400">{tip.hint}</span>}
    </div>
  );

  if (orientation === 'grid') {
    return (
      <nav ref={navRef} aria-label={t.navbar.tools} className="grid gap-3 p-3 sm:grid-cols-2">
        {toolGroups.map((group) => (
          <div key={group.id} role="group" aria-label={group.label} className="min-w-0 space-y-1">
            <div aria-hidden className="text-xs font-medium text-neutral-300">{group.label}</div>
            <div className="flex flex-wrap gap-1">{group.tools.map(button)}</div>
          </div>
        ))}
        {pluginTools.length > 0 && (
          <div role="group" aria-label={pluginStrings.toolsBadge} className="flex min-w-0 flex-wrap gap-1">
            {pluginTools.map(pluginToolButton)}
          </div>
        )}
      </nav>
    );
  }

  if (!vertical) {
    return (
      <>
        <nav
          ref={navRef}
          aria-label={t.navbar.tools}
          className="atelier-chrome flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-t px-2 no-scrollbar touch-pan-x"
        >
          {toolGroups.map((group, gi) => (
            <React.Fragment key={group.id}>
              {gi > 0 && <div aria-hidden className="mx-0.5 h-6 w-px shrink-0 bg-neutral-700/70" />}
              <div role="group" aria-label={group.label} className="flex gap-1">
                {group.tools.map(button)}
              </div>
            </React.Fragment>
          ))}
          {pluginTools.length > 0 && (
            <>
              <div aria-hidden className="mx-0.5 h-6 w-px shrink-0 bg-cyan-500/40" />
              <div role="group" aria-label={pluginStrings.toolsBadge} className="flex gap-1">
                {pluginTools.map(pluginToolButton)}
              </div>
            </>
          )}
        </nav>
        {tooltip}
      </>
    );
  }

  return (
    <>
      <div className="relative flex min-h-0 shrink-0" style={{ width: actualWidth }}>
        <nav
          ref={navRef}
          aria-label={t.navbar.tools}
          onScroll={updateScrollHints}
          className={`atelier-chrome flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-1 pb-2 pt-1 no-scrollbar ${side === 'right' ? 'border-l' : 'border-r'}`}
        >
          <RailGrip />
          {toolGroups.map((group, gi) => (
            <React.Fragment key={group.id}>
              {gi > 0 && <div aria-hidden className="mx-1 h-px shrink-0 bg-neutral-700/70" />}
              <div
                role="group"
                aria-label={group.label}
                className="grid justify-items-center gap-0.5"
                style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
              >
                {group.tools.map(button)}
              </div>
            </React.Fragment>
          ))}
          {pluginTools.length > 0 && (
            <>
              <div aria-hidden className="mx-1 h-px shrink-0 bg-cyan-500/40" />
              <div
                role="group"
                aria-label={pluginStrings.toolsBadge}
                className="grid justify-items-center gap-0.5"
                style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
              >
                {pluginTools.map(pluginToolButton)}
              </div>
            </>
          )}
        </nav>

        {scrollState.canUp && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="向上捲動工具列"
            onClick={() => navRef.current?.scrollBy({ top: -96, behavior: 'smooth' })}
            className="absolute inset-x-0 top-0 z-10 flex h-4 items-center justify-center bg-gradient-to-b from-neutral-950/90 to-transparent text-neutral-300 hover:text-white"
          >
            <ChevronUp className="h-3 w-3" />
          </button>
        )}
        {scrollState.canDown && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="向下捲動工具列"
            onClick={() => navRef.current?.scrollBy({ top: 96, behavior: 'smooth' })}
            className="absolute inset-x-0 bottom-0 z-10 flex h-5 items-center justify-center bg-gradient-to-t from-neutral-950/95 via-neutral-950/70 to-transparent text-neutral-300 hover:text-white"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        )}

        {onResizeWidth && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="調整工具列寬度"
            style={{ touchAction: 'none' }}
            className={`group absolute inset-y-0 z-20 w-2 cursor-col-resize ${side === 'right' ? '-left-1' : '-right-1'}`}
            onDoubleClick={() => onResizeWidth(Math.round(78 * ui))}
            onPointerDown={(e) => {
              const start = actualWidth;
              startDrag(e, (dx) => {
                const raw = start + (side === 'right' ? -dx : dx);
                onResizeWidth(Math.max(TOOL_RAIL_WIDTH_MIN * ui, Math.min(TOOL_RAIL_WIDTH_MAX * ui, raw)));
              });
            }}
          >
            <div className="mx-auto h-full w-0.5 bg-indigo-500/0 transition group-hover:bg-indigo-500/60" />
          </div>
        )}
      </div>
      {tooltip}
    </>
  );
};
