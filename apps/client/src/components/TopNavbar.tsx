import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  Check,
  ChevronDown,
  Crop,
  Crown,
  Download,
  Film,
  FilePlus2,
  FolderOpen,
  HelpCircle,
  ImagePlus,
  Keyboard,
  LayoutPanelLeft,
  Lock,
  LogIn,
  LogOut,
  Menu,
  MessageSquare,
  Monitor,
  Palette,
  PanelRight,
  Puzzle,
  ArrowLeftRight,
  RotateCcw,
  Save,
  Server,
  Settings,
  ZoomIn,
  Users,
} from 'lucide-react';
import { CanvasModel, CanvasUnit, clampDpi, formatCanvasDimensions } from '@atelier/shared';
import { useAuth } from '../context/AuthContext';
import { useSocket, useSocketTelemetry } from '../context/SocketContext';
import { memberCardKey, roomMemberCards } from '../utils/roomMembers';
import { useI18n } from '../context/I18nContext';
import { OfflineSessionStore } from '../services/offlineStore';
import { ApiService } from '../services/api';
import type { Translations } from '../locales';
import { VoiceChatBar } from './VoiceChatBar';
import { ThemePicker } from './ThemePicker';
import { OverlayPresence } from './OverlayPresence';
import { WorkspaceCloudflareToggle } from './WorkspaceCloudflareToggle';
import { getPluginLabels } from '../plugins/pluginLabels';
import type { InstalledPlugin } from '../plugins/pluginStore';
import { getUserColor } from '../utils/userColors';
import { dockActions, PANEL_IDS, PANEL_TITLES, PanelId, useDesktopModeAvailable, useDockLayout, usePhoneLayout } from './workspace/dockStore';
import { useAnchoredPopover } from '../utils/popoverPosition';
import { useEffectiveWidth } from '../hooks/useEffectiveWidth';

const PainterLevelBadge: React.FC<{ visible: boolean }> = ({ visible }) => {
  const { painterLevel } = useSocketTelemetry();
  if (!visible) return null;
  return (
    <span className="rounded px-1 text-[10px] font-semibold" style={{ color: painterLevel.badgeColor }}>
      Lv.{painterLevel.level}
    </span>
  );
};

interface TopNavbarProps {
  currentCanvas?: CanvasModel | null;
  onOpenCreateCanvas?: () => void;
  onOpenAuth: () => void;
  onOpenProfile?: () => void;
  onOpenReplay?: () => void;
  onOpenExport?: () => void;
  onOpenCapsule?: () => void;
  onOpenServer?: () => void;
  onOpenSettings?: (tab?: string) => void;
  onOpenHelp?: () => void;
  onOpenAdmin?: () => void;
  onOpenChat?: () => void;
  hasUnreadChat?: boolean;
  onOpenResize?: () => void;
  onOpenGateway?: () => void;
  /** 匯入圖片…: the picked images, each to become a new layer */
  onImportImages?: (files: File[]) => void;
  onOpenProject?: () => void;
  onSaveProject?: () => void;
  onSaveProjectAs?: () => void;
  onShowStorage?: () => void;
  plugins: InstalledPlugin[];
  onManagePlugins: () => void;
  onRunPlugin: (pluginId: string, commandId: string) => void;
}

type MenuItem =
  | { kind: 'item'; label: string; icon: React.ReactNode; onSelect: () => void; checked?: boolean; hint?: string; title?: string }
  | { kind: 'sep' }
  | { kind: 'title'; label: string };

const getPanelTitle = (id: PanelId, t: Translations): string => {
  switch (id) {
    case 'color': return t.studio.colorWheel;
    case 'toolProps': return t.studio.brushSettings;
    case 'brushToolset': return t.brushPreset.toolset;
    case 'layers': return t.layers.title;
    case 'members': return t.navbar.onlineUsers;
    case 'oplog': return t.navbar.opLog;
    case 'quickKeys': return t.settings.tabShortcuts;
    default: return PANEL_TITLES[id];
  }
};

/** A small dropdown menu (click to open, Esc / outside click to close). Portaled so horizontal scroll never clips it. */
const DropdownMenu: React.FC<{ label: React.ReactNode; title: string; items?: MenuItem[]; children?: React.ReactNode; align?: 'left' | 'right'; width?: string; buttonClass?: string; protectCanvas?: boolean }> = ({
  label, title, items, children, align = 'left', width = 'w-56', buttonClass = 'atelier-icon-btn h-8 gap-1 px-2 text-xs font-medium', protectCanvas,
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fallbackWidth = width === 'w-80' ? 320 : width === 'w-64' ? 256 : 224;
  const pos = useAnchoredPopover(open, ref, menuRef, { align, gap: 4, margin: 8, fallbackWidth });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (document.documentElement.classList.contains('atelier-theme-vt') || ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      if (protectCanvas && e.target instanceof Element && e.target.closest('.atelier-canvas-viewport')) {
        e.preventDefault();
        e.stopPropagation();
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, protectCanvas]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button type="button" title={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={buttonClass}>
        {label}
      </button>
      {typeof document !== 'undefined' && createPortal(
        <OverlayPresence open={open} kind="popover">
          <div ref={pos.setPopoverEl} role="menu"
            style={{ top: pos.top, left: pos.left, maxHeight: pos.maxHeight }}
            className={`atelier-popover fixed z-[85] ${width} max-w-[calc(100vw-16px)] overflow-y-auto p-1.5`}>
            {children}
            {items?.map((item, i) => {
              if (item.kind === 'sep') return <div key={i} className="my-1 h-px bg-neutral-700/70" />;
              if (item.kind === 'title') return <div key={i} className="px-2 pb-1 pt-1.5 text-[10px] font-bold uppercase tracking-wider text-neutral-500">{item.label}</div>;
              return (
                <button key={i} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked}
                  title={item.title}
                  onClick={() => { item.onSelect(); setOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-800">
                  <span className="flex h-4 w-4 items-center justify-center text-neutral-400 [&>svg]:h-3.5 [&>svg]:w-3.5">{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                  {item.hint && <kbd className="atelier-kbd">{item.hint}</kbd>}
                  {item.checked !== undefined && <Check className={`h-3.5 w-3.5 ${item.checked ? 'text-indigo-400' : 'text-transparent'}`} />}
                </button>
              );
            })}
          </div>
        </OverlayPresence>,
        document.body
      )}
    </div>
  );
};

export const TopNavbar: React.FC<TopNavbarProps> = ({
  currentCanvas,
  onOpenCreateCanvas,
  onOpenAuth,
  onOpenProfile,
  onOpenReplay,
  onOpenExport,
  onOpenCapsule,
  onOpenServer,
  onOpenGateway,
  onOpenSettings,
  onOpenHelp,
  onOpenAdmin,
  onOpenChat,
  hasUnreadChat,
  onOpenResize,
  onImportImages,
  onOpenProject,
  onSaveProject,
  onSaveProjectAs,
  onShowStorage,
  plugins,
  onManagePlugins,
  onRunPlugin,
}) => {
  const { t, language } = useI18n();
  const pluginText = getPluginLabels(language);
  const { user, isGuest, logout } = useAuth();
  const { isConnected, members, voiceState, joinVoice, leaveVoice, toggleVoiceMute, serverUrl } = useSocket();
  const memberCards = roomMemberCards(members);
  const isOffline = OfflineSessionStore.isOfflineMode();
  const isLocalDesktop = ApiService.isLocalDesktopServer();
  const layout = useDockLayout();
  const desktopModeAvailable = useDesktopModeAvailable();
  const phoneLayout = usePhoneLayout();
  const importInputRef = useRef<HTMLInputElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const { effectiveWidth, viewportWidth } = useEffectiveWidth(headerRef);
  const isNarrowMobile = viewportWidth < 600;
  // The phone layout keeps the compact ☰ menu when the phone is turned sideways.
  const showDesktopMenus = !phoneLayout && effectiveWidth >= 680;
  const showBrandText = effectiveWidth >= 1020;
  const showCanvasPill = effectiveWidth >= 1140;
  const showVoice = !isNarrowMobile || effectiveWidth >= 768;
  const showVoiceText = effectiveWidth >= 1240;
  const showCloudflareText = effectiveWidth >= 1180;
  const showShareText = effectiveWidth >= 1340;
  const showSettingsText = effectiveWidth >= 840;
  const showServerStatusText = effectiveWidth >= 1300;
  const showProfileName = effectiveWidth >= 1040;
  const showLevelBadge = effectiveWidth >= 1280;
  const showLoginText = effectiveWidth >= 760;
  const showHelpIcon = effectiveWidth >= 680;

  const fileItems: MenuItem[] = [
    ...(onOpenCreateCanvas ? [{ kind: 'item' as const, label: t.navbar.newCanvas, icon: <FilePlus2 />, onSelect: onOpenCreateCanvas }] : []),
    ...(onOpenProject ? [{ kind: 'item' as const, label: isOffline ? t.navbar.openProject : t.navbar.importCollaborativeProject, icon: <FolderOpen />, hint: 'Ctrl+O', onSelect: onOpenProject }] : []),
    ...(onSaveProject && currentCanvas ? [{ kind: 'item' as const, label: t.navbar.saveProject, icon: <Save />, hint: 'Ctrl+S', onSelect: onSaveProject }] : []),
    ...(onSaveProjectAs && currentCanvas ? [{ kind: 'item' as const, label: t.navbar.saveProjectAs, icon: <Download />, hint: 'Ctrl+Shift+S', onSelect: onSaveProjectAs }] : []),
    ...(onShowStorage && currentCanvas ? [{ kind: 'item' as const, label: t.navbar.projectStorage, icon: <FolderOpen />, onSelect: onShowStorage }] : []),
    ...(onOpenResize && currentCanvas ? [{ kind: 'item' as const, label: `${t.canvas.resizeTitle}…`, icon: <Crop />, onSelect: onOpenResize }] : []),
    { kind: 'sep' },
    ...(onImportImages && currentCanvas && !isGuest ? [{ kind: 'item' as const, label: `${t.reference.openImage}…`, icon: <ImagePlus />, onSelect: () => importInputRef.current?.click() }] : []),
    ...(onOpenExport ? [{ kind: 'item' as const, label: `${t.navbar.export} (PNG/PSD/ORA)…`, icon: <Download />, onSelect: onOpenExport }] : []),
    ...(onOpenReplay ? [{ kind: 'item' as const, label: t.navbar.replay, icon: <Film />, onSelect: onOpenReplay }] : []),
    ...(onOpenCapsule ? [{ kind: 'item' as const, label: t.navbar.timeCapsule, icon: <Archive />, onSelect: onOpenCapsule }] : []),
    { kind: 'sep' },
    ...(onOpenGateway ? [{ kind: 'item' as const, label: t.server.switchMode, icon: <ArrowLeftRight />, onSelect: onOpenGateway }] : []),
    ...(onOpenServer ? [{ kind: 'item' as const, label: t.server.title, icon: <Server />, onSelect: onOpenServer }] : []),
  ];

  const windowItems: MenuItem[] = [
    { kind: 'title', label: t.navbar.window },
    ...PANEL_IDS.map((id) => ({
      kind: 'item' as const,
      label: getPanelTitle(id, t),
      icon: <LayoutPanelLeft />,
      checked: layout.panels[id].visible,
      onSelect: () => dockActions.toggle(id),
    })),
    { kind: 'sep' },
    { kind: 'title', label: t.settings.tabAppearance },
    { kind: 'item', label: t.navbar.swapPanels, icon: <ArrowLeftRight />, onSelect: () => dockActions.swapDocks() },
    {
      kind: 'item',
      label: t.navbar.toolbarOnRight,
      icon: <PanelRight />,
      checked: layout.railSide === 'right',
      onSelect: () => dockActions.setRailSide(layout.railSide === 'right' ? 'left' : 'right'),
    },
    // Phones: desktop vs phone layout. Touch tablets: floating windows. Hidden where a mouse makes it moot.
    ...(desktopModeAvailable ? [{
      kind: 'item' as const,
      label: t.navbar.desktopMode,
      icon: <Monitor />,
      checked: layout.desktopMode,
      title: t.navbar.desktopModeTooltip,
      onSelect: () => dockActions.setDesktopMode(!layout.desktopMode),
    }] : []),
    { kind: 'item', label: t.common.reset, icon: <RotateCcw />, onSelect: () => dockActions.reset() },
    { kind: 'sep' },
    { kind: 'item', label: `${t.settings.uiScale}…`, icon: <ZoomIn />, onSelect: () => onOpenSettings?.('general') },
  ];

  const enabledPlugins = plugins.filter(plugin => plugin.enabled);
  const pluginItems: MenuItem[] = [
    { kind: 'item', label: pluginText.manage, icon: <Puzzle />, onSelect: onManagePlugins },
    { kind: 'sep' },
    ...enabledPlugins.flatMap(({ manifest }): MenuItem[] => [
      { kind: 'title', label: manifest.name },
      ...manifest.commands.map((command): MenuItem => ({
        kind: 'item', label: command.label, icon: <Puzzle />, onSelect: () => onRunPlugin(manifest.id, command.id),
      })),
    ]),
    ...(!enabledPlugins.length ? [{ kind: 'title' as const, label: pluginText.noCommands }] : []),
  ];
  const helpItems: MenuItem[] = [
    { kind: 'item', label: t.help.centerTitle, icon: <HelpCircle />, hint: 'F1', onSelect: () => onOpenHelp?.() },
    { kind: 'item', label: t.settings.tabShortcuts, icon: <Keyboard />, onSelect: () => onOpenSettings?.('shortcuts') },
  ];

  const membersOpen = layout.panels.members.visible;
  const isElectron = typeof window !== 'undefined' && Boolean((window as any).atelierDesktop?.isElectron);
  const isMac = typeof window !== 'undefined' && (window as any).atelierDesktop?.platform === 'darwin';
  const [zoomPct, setZoomPct] = useState(100);

  useEffect(() => {
    setZoomPct(100);
  }, [currentCanvas?.id]);

  useEffect(() => {
    const onZoom = (e: Event) => {
      const z = (e as CustomEvent<number>).detail;
      if (Number.isFinite(z)) setZoomPct(Math.round(z * 1000) / 10);
    };
    window.addEventListener('atelier:zoom', onZoom);
    return () => window.removeEventListener('atelier:zoom', onZoom);
  }, []);

  const docUnit: CanvasUnit = currentCanvas?.unit || 'px';
  const docDpi = clampDpi(currentCanvas?.dpi ?? 300);
  const docInfoFull = currentCanvas
    ? `${currentCanvas.title} (${formatCanvasDimensions(currentCanvas.width, currentCanvas.height, docUnit, docDpi)} ${docDpi}dpi ${zoomPct.toFixed(1)}% : RGB:sRGB IEC61966-2.1) - Lumina Drift`
    : 'Lumina Drift 流光 — 專業電繪與即時協同畫室';

  useEffect(() => {
    if (typeof document !== 'undefined') document.title = docInfoFull;
  }, [docInfoFull]);

  const brand = (compact: boolean) => {
    const subBrand = !compact && t.brand && t.brand !== 'Lumina Drift' ? t.brand : '';
    const showText = compact || showBrandText;
    const content = <>
      <img src={`${(import.meta as any).env?.BASE_URL || './'}logo.svg`} alt="" className={`${compact ? 'h-3.5 w-3.5' : 'h-7 w-7'} shrink-0`} />
      {showText && (
        <span className={compact ? 'font-semibold text-neutral-100' : 'whitespace-nowrap text-sm font-semibold text-white'}>
          Lumina Drift{subBrand && <span className="font-normal text-neutral-400"> {subBrand}</span>}
        </span>
      )}
    </>;
    const layout = `flex shrink-0 items-center gap-1.5 ${compact ? 'px-1' : 'pr-1'}`;
    return onOpenGateway ? (
      <button type="button" onClick={onOpenGateway} aria-label={`Lumina Drift — ${t.server.switchMode}`}
        className={`${layout} atelier-no-drag rounded-md hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400`}>
        {content}
      </button>
    ) : <div className={layout}>{content}</div>;
  };

  return (
    <>
      {isElectron && (
        <div
          className="atelier-drag-region flex h-7 shrink-0 items-center justify-between border-b border-neutral-800/90 bg-neutral-950 px-2.5 text-[11px] text-neutral-300 select-none"
          style={isMac ? { paddingLeft: '76px', minHeight: '28px' } : { paddingRight: '142px', minHeight: '28px' }}
        >
          {brand(true)}
          <div className="mx-3 min-w-0 flex-1 truncate text-center font-medium tabular-nums text-neutral-200" title={docInfoFull}>
            {currentCanvas ? (
              <>
                <span className="font-semibold text-neutral-100">{currentCanvas.title}</span>
                <span className="mx-1.5 text-neutral-400">
                  ({formatCanvasDimensions(currentCanvas.width, currentCanvas.height, docUnit, docDpi)} {docDpi}dpi {zoomPct.toFixed(1)}% : RGB:sRGB IEC61966-2.1)
                </span>
              </>
            ) : (
              <span>{docInfoFull}</span>
            )}
          </div>
        </div>
      )}
    <header ref={headerRef} className={`atelier-chrome relative z-40 flex shrink-0 select-none items-center gap-1 border-b px-2 ${isNarrowMobile ? 'h-11' : 'min-h-11 flex-wrap py-0.5'}`}>
      {onImportImages && (
        <input ref={importInputRef} type="file" accept="image/*,.svg" multiple hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = ''; // the same file can be picked again
            if (files.length) onImportImages(files);
          }} />
      )}
      {/* Brand */}
      {brand(false)}

      {/* Menus: full on wide layout, compact ☰ when narrow or heavily scaled */}
      {showDesktopMenus ? (
        <div className="flex shrink-0 items-center">
          <DropdownMenu label={<>{t.navbar.file}<ChevronDown className="h-3 w-3" /></>} title={t.navbar.file} items={fileItems} />
          <DropdownMenu label={<>{t.navbar.window}<ChevronDown className="h-3 w-3" /></>} title={t.navbar.window} items={windowItems} />
          <DropdownMenu label={<>{pluginText.menu}<ChevronDown className="h-3 w-3" /></>} title={pluginText.menu} items={pluginItems} width="w-64" />
          <DropdownMenu label={<>{t.navbar.help}<ChevronDown className="h-3 w-3" /></>} title={t.navbar.help} items={helpItems} />
        </div>
      ) : (
        <div className="shrink-0">
          <DropdownMenu label={<Menu className="h-4 w-4" />} title={t.navbar.file} buttonClass="atelier-icon-btn h-8 w-8"
            items={[
              ...(!isOffline && !isLocalDesktop ? [{
                kind: 'title' as const,
                label: isGuest ? t.navbar.loginRegister : (user?.displayName || user?.username || t.navbar.userProfile),
              }, ...(isGuest
                ? [{ kind: 'item' as const, label: t.navbar.loginRegister, icon: <LogIn />, onSelect: onOpenAuth }]
                : [
                    ...(onOpenProfile ? [{ kind: 'item' as const, label: t.navbar.userProfile, icon: <Users />, onSelect: onOpenProfile }] : []),
                    { kind: 'item' as const, label: t.navbar.logout, icon: <LogOut />, onSelect: logout },
                  ]), { kind: 'sep' as const }] : []),
              { kind: 'title', label: t.navbar.file }, ...fileItems, { kind: 'sep' },
              ...windowItems, { kind: 'sep' },
              { kind: 'title', label: pluginText.menu }, ...pluginItems, { kind: 'sep' }, ...helpItems,
            ]} />
        </div>
      )}

      {currentCanvas && showCanvasPill && (
        <div className="ml-1 flex min-w-0 max-w-[220px] items-center gap-1.5 overflow-hidden rounded-md bg-neutral-950/50 px-2 py-1 text-xs" title={currentCanvas.title}>
          {currentCanvas.hasPassword && <span title={t.navbar.passwordProtected} className="inline-flex shrink-0"><Lock className="h-3 w-3 shrink-0 text-amber-400" aria-label={t.navbar.passwordRoom} /></span>}
          <span className="min-w-0 truncate font-medium text-neutral-100">{currentCanvas.title}</span>
        </div>
      )}

      <div className="ml-auto flex min-w-0 items-center gap-1 py-0.5">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto no-scrollbar">
        {/* Who is here: opens the floating members window */}
        <button type="button" onClick={() => dockActions.toggle('members')} aria-pressed={membersOpen}
          title={t.navbar.onlineUsers} className="atelier-icon-btn h-8 shrink-0 gap-1.5 px-1.5">
          <span className="flex -space-x-1.5">
            {memberCards.slice(0, 3).map((m) => (
              <span key={memberCardKey(m)} className="flex h-5 w-5 items-center justify-center overflow-hidden rounded-full border-2 border-neutral-900 text-[9px] font-bold"
                style={{ backgroundColor: m.color || getUserColor(m.userId).hex, color: '#fff' }}>
                {m.avatarUrl ? <img src={m.avatarUrl} alt="" className="h-full w-full object-cover" /> : (m.displayName || '?')[0]}
              </span>
            ))}
            {memberCards.length === 0 && <Users className="h-4 w-4" />}
          </span>
          <span className="text-xs tabular-nums">{memberCards.length}</span>
        </button>

        {onOpenChat && (
          <button type="button" onClick={onOpenChat} title={t.collab.liveChat} aria-label={t.collab.liveChat} className="atelier-icon-btn relative h-8 w-8 shrink-0">
            <MessageSquare className="h-4 w-4" />
            {hasUnreadChat && <span data-chat-unread="" aria-hidden="true" className="absolute right-1 top-1 h-2 w-2 rounded-full bg-indigo-400" />}
          </button>
        )}

        {!isOffline && showVoice && (
          <div className="shrink-0">
            <VoiceChatBar voiceState={voiceState} onJoinVoice={joinVoice} onLeaveVoice={leaveVoice} onToggleMute={toggleVoiceMute} currentUserName={user?.displayName} compact={!showVoiceText} />
          </div>
        )}

        <WorkspaceCloudflareToggle enabled={!isOffline} serverUrl={serverUrl} canvasId={currentCanvas?.id} compactCloudflare={!showCloudflareText} compactShare={!showShareText} />

        <DropdownMenu label={<Palette className="h-4 w-4" />} title={t.settings.themeSelect} align="right" width="w-80" buttonClass="atelier-icon-btn h-8 w-8 shrink-0" protectCanvas>
          <div className="p-1.5">
            <div className="mb-2 text-[11px] font-semibold text-neutral-300">{t.settings.themeSelect}</div>
            <ThemePicker compact />
          </div>
        </DropdownMenu>

        {onOpenHelp && showHelpIcon && (
          <button type="button" onClick={onOpenHelp} title={`${t.navbar.help} (F1)`} aria-label={t.navbar.help} className="atelier-icon-btn inline-flex h-8 w-8 shrink-0">
            <HelpCircle className="h-4 w-4" />
          </button>
        )}

        {/* Labelled and in the accent colour: the one place for 介面縮放, themes, shortcuts, server */}
        {onOpenSettings && (
          <button type="button" onClick={() => onOpenSettings()} title={t.navbar.settings} aria-label={t.navbar.settings}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-indigo-500/70 bg-indigo-600/20 px-2 text-xs font-semibold text-indigo-200 transition hover:bg-indigo-600/40 hover:text-white">
            <Settings className="h-4 w-4" />
            {showSettingsText && <span>{t.navbar.settings}</span>}
          </button>
        )}

        {user?.serverRole === 'admin' && onOpenAdmin && (
          <button type="button" onClick={onOpenAdmin} title={t.navbar.adminDashboard} aria-label={t.navbar.adminDashboard} className="atelier-icon-btn h-8 w-8 shrink-0 !text-amber-400">
            <Crown className="h-4 w-4" />
          </button>
        )}

        {isOffline ? (
          <button
            type="button"
            onClick={onOpenGateway ?? onOpenServer}
            title={`${t.navbar.offlineBadge} — ${t.server.switchMode}`}
            aria-label={t.navbar.offlineBadge}
            className="mx-1 flex h-7 shrink-0 items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/15 px-2 py-0.5 text-[10px] font-semibold text-cyan-300 transition hover:bg-cyan-500/25"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400" />
            {effectiveWidth >= 700 && <span>{t.navbar.offlineBadge}</span>}
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpenGateway ?? onOpenServer}
            title={onOpenGateway ? t.server.switchMode : t.server.title}
            aria-label={onOpenGateway ? t.server.switchMode : t.server.title}
            className={`mx-1 flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold transition ${
              isConnected
                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                : 'border-rose-500/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
            }`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-rose-500'}`} />
            {showServerStatusText && <span>{isConnected ? t.navbar.connected : t.navbar.disconnected}</span>}
          </button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {user && (
          <button type="button" onClick={onOpenProfile} title={t.navbar.userProfile} aria-label={`${user.displayName} — ${t.navbar.userProfile}`} className="atelier-icon-btn h-8 shrink-0 gap-1.5 px-1.5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border text-[10px] font-black"
              style={{ borderColor: getUserColor(user.id).hex, backgroundColor: `${getUserColor(user.id).hex}25`, color: getUserColor(user.id).hex }}>
              {user.avatarUrl ? <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" /> : (user.displayName || user.username || '畫')[0].toUpperCase()}
            </span>
            {showProfileName && <span className="max-w-[90px] truncate text-xs font-medium">{user.displayName}</span>}
            <PainterLevelBadge visible={showLevelBadge} />
          </button>
        )}

        {!isOffline && !isLocalDesktop && (isGuest ? (
          <button type="button" onClick={onOpenAuth} title={t.navbar.loginRegister} aria-label={t.navbar.loginRegister} className="flex h-8 shrink-0 items-center gap-1 rounded-lg bg-indigo-600 px-2.5 text-xs font-semibold text-white hover:bg-indigo-500">
            <LogIn className="h-3.5 w-3.5" />{showLoginText && <span>{t.navbar.loginRegister}</span>}
          </button>
        ) : (
          <button type="button" onClick={logout} title={t.navbar.logout} aria-label={t.navbar.logout} className="atelier-icon-btn h-8 w-8 shrink-0 hover:!text-rose-400">
            <LogOut className="h-4 w-4" />
          </button>
        ))}
      </div>
      </div>
    </header>
    </>
  );
};
