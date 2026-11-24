import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BlendMode, CanvasMemberModel, CanvasModel, CanvasUnit, CreateCanvasDto, LayerMeta, LayerModel, LayerType, clampDpi, getCanvasRoleCapabilities } from '@atelier/shared';
import { ApiService } from './services/api';
import { OfflineSessionStore } from './services/offlineStore';
import { LuminaProjectEngine } from './engine/LuminaProjectEngine';
import { useAuth } from './context/AuthContext';
import { useI18n } from './context/I18nContext';
import { useSocket } from './context/SocketContext';
import { TopNavbar } from './components/TopNavbar';
import { CanvasTabsBar, type CanvasTabsPlacement } from './components/CanvasTabsBar';
import { AuthModal } from './components/AuthModal';
import { CreateCanvasModal } from './components/CreateCanvasModal';
import { AtelierModal } from './components/AtelierModal';
import type { CanvasPluginAccess, CanvasProjectAccess } from './components/CanvasWorkspace';
import { getPlugins, subscribePlugins } from './plugins/pluginStore';
import { getCanvasFullscreen, setCanvasFullscreen, subscribeCanvasFullscreen } from './engine/touchGestures';
import { getPluginLabels } from './plugins/pluginLabels';
import { isModernPluginManifest, resolvePluginName, type PluginManifestModern } from './plugins/pluginApi';
import {
  getV3ActivitySnapshot,
  killAllPluginV3Bridges,
  setV3ConsentRequester,
  subscribeV3Activity,
  type V3ConsentDecision,
  type V3ConsentRequest,
} from './plugins/pluginV3Client';
import { ShortcutManager, type ParsedPluginShortcutId } from './engine/ShortcutManager';
import type { PluginPanelValues } from './components/PluginPanelWindow';
import { ConnectionGateway, InitialCanvasOptions } from './components/ConnectionGateway';
import { DeleteCanvasConfirmModal } from './components/DeleteCanvasConfirmModal';
import { LiveChatDrawer } from './components/LiveChatDrawer';
import { OverlayPresence } from './components/OverlayPresence';
import { CreateMyLayerModal } from './components/CreateMyLayerModal';
import { RoomPasswordModal } from './components/RoomPasswordModal';
import { getNextCanvasTitle } from './utils/canvasName';
import { sharedRoomFromLocation } from './utils/serverLinks';
import { recordRecentVisit } from './utils/recentVisits';
import {
  type CanvasTargetContext,
  filterVisibleOfflineCanvases,
  isCanvasViewerForUser,
  isLayerDrawableForUser,
  isLocalArtistUser,
  loadClosedOfflineCanvasIds,
  pickBestInitialLayer,
  resolveAutoSelectCanvasId,
  resolveNextCanvasAfterClose,
  resolveTargetCanvasId,
  sanitizeOnlineGuestName,
  saveClosedOfflineCanvasIds,
  shouldCommitCanvasFetch,
  shouldCommitGatewayResolve,
  shouldSkipAutoAssign,
} from './utils/roomJoinGuard';
import type { LayerCanvasItem } from './engine/layerComposite';
import { useFolderAccess } from './components/workspace/useFolderAccess';
// Loaded when first needed: the workspace (Pixi), exports (ag-psd / jszip), time-lapse, settings…
const CanvasWorkspace = lazy(() => import('./components/CanvasWorkspace').then((m) => ({ default: m.CanvasWorkspace })));
const TimeLapseModal = lazy(() => import('./components/TimeLapseModal').then((m) => ({ default: m.TimeLapseModal })));
const ExportModal = lazy(() => import('./components/ExportModal').then((m) => ({ default: m.ExportModal })));
const ServerModal = lazy(() => import('./components/ServerModal').then((m) => ({ default: m.ServerModal })));
const SettingsModal = lazy(() => import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal })));
const HelpCenter = lazy(() => import('./components/help/HelpCenter').then((m) => ({ default: m.HelpCenter })));
const TimeCapsuleModal = lazy(() => import('./components/TimeCapsuleModal').then((m) => ({ default: m.TimeCapsuleModal })));
const AdminDashboardModal = lazy(() => import('./components/AdminDashboardModal').then((m) => ({ default: m.AdminDashboardModal })));
const UserProfileModal = lazy(() => import('./components/UserProfileModal').then((m) => ({ default: m.UserProfileModal })));
const PluginManager = lazy(() => import('./components/PluginManager').then((m) => ({ default: m.PluginManager })));
const PluginPanelWindow = lazy(() => import('./components/PluginPanelWindow').then((m) => ({ default: m.PluginPanelWindow })));
const PluginV3BridgeModal = lazy(() => import('./components/PluginV3BridgeModal').then((m) => ({ default: m.PluginV3BridgeModal })));
const PluginV3ConsentModal = lazy(() => import('./components/PluginV3ConsentModal').then((m) => ({ default: m.PluginV3ConsentModal })));

const EMPTY_LAYERS: LayerModel[] = [];

const THUMBS_KEY = 'atelier_canvas_thumbs';
const MAX_THUMBS = 40;

const loadThumbs = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(THUMBS_KEY) || '{}');
  } catch {
    return {};
  }
};

export const App: React.FC = () => {
  const { t, language } = useI18n();
  const plugins = useSyncExternalStore(subscribePlugins, getPlugins);
  const canvasFullscreen = useSyncExternalStore(subscribeCanvasFullscreen, getCanvasFullscreen, getCanvasFullscreen);
  useEffect(() => {
    if (!canvasFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCanvasFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canvasFullscreen]);
  const [isPluginManagerOpen, setIsPluginManagerOpen] = useState(false);
  const [isPluginV3ConsoleOpen, setIsPluginV3ConsoleOpen] = useState(false);
  const [v3ConsentQueue, setV3ConsentQueue] = useState<
    Array<{ request: V3ConsentRequest; resolve: (decision: V3ConsentDecision) => void }>
  >([]);
  const [v3Activity, setV3Activity] = useState(() => getV3ActivitySnapshot());

  useEffect(() => {
    setV3ConsentRequester(
      (request) =>
        new Promise<V3ConsentDecision>((resolve) => {
          setV3ConsentQueue((prev) => [...prev, { request, resolve }]);
        }),
    );
    const unsubActivity = subscribeV3Activity(() => {
      setV3Activity(getV3ActivitySnapshot());
    });
    return () => {
      setV3ConsentRequester(null);
      unsubActivity();
    };
  }, []);
  const [openPluginPanels, setOpenPluginPanels] = useState<string[]>([]);
  const [activePluginToolKey, setActivePluginToolKey] = useState<string | null>(null);
  const [slowPluginCommand, setSlowPluginCommand] = useState<string | null>(null);
  const pluginCmdAbortRef = useRef<AbortController | null>(null);
  const pluginAccessRef = useRef<CanvasPluginAccess | null>(null);
  const registerPluginAccess = useCallback((access: CanvasPluginAccess | null) => {
    pluginAccessRef.current = access;
  }, []);
  const runningPlugin = useRef(false);

  // Keep ShortcutManager synchronized with enabled plugins and current language
  useEffect(() => {
    ShortcutManager.getInstance().syncPluginShortcuts(plugins, language);
  }, [plugins, language]);

  // Automatically close any open plugin panels whose plugin was disabled or removed
  useEffect(() => {
    const validKeys = new Set<string>();
    for (const { manifest, enabled } of plugins) {
      if (!enabled || !isModernPluginManifest(manifest) || !manifest.permissions.includes('ui:panel')) continue;
      for (const panel of manifest.panels) {
        validKeys.add(`${manifest.id}:${panel.id}`);
      }
    }
    setOpenPluginPanels((prev) => {
      const filtered = prev.filter((k) => validKeys.has(k));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [plugins]);
  const { isGuest, user, isLoading: authLoading } = useAuth();
  const {
    activeCanvasId,
    joinCanvas,
    getActiveCanvasId,
    clearActiveCanvas,
    members,
    offlineMembers,
    releaseLayer,
    claimLayer,
    transferLayer,
    reorderLayer,
    reorderLayersList,
    layerUpdateEvent,
    layersSyncEvent,
    canvasResizedEvent,
    reconnectServer,
    flushCanvasWrites,
    roomAccessError,
    unlockRoom,
    chatMessages,
  } = useSocket();
  const folderAccess = useFolderAccess(activeCanvasId, user?.id, !isGuest && !authLoading);

  // Connection & Host Mode Gateway Portal
  const [showGateway, setShowGateway] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const hasDesktopHost = Boolean((window as any).atelierDesktop?.server);
    const resolved = localStorage.getItem(hasDesktopHost ? 'atelier_gateway_skip_on_launch' : 'atelier_gateway_resolved');
    return !resolved && !sharedRoomFromLocation();
  });
  const returningToGateway = useRef(false);
  const importingLumina = useRef(false);
  // The canvas picked on the gateway. The list fetched as the gateway closes opens it directly,
  // instead of joining the list's first (or the last opened) canvas on the way there.
  const gatewayCanvasRef = useRef<string | null>(null);
  // True while ANY gateway transition (pick room / resume / create / offline) is settling, so
  // background fetchCanvases and auto-select effects cannot clobber the chosen room.
  const gatewayResolvingRef = useRef(false);
  const gatewayResolveSeqRef = useRef(0);
  const gatewayTimerRef = useRef<number | null>(null);
  const fetchCanvasesSeqRef = useRef(0);

  useEffect(() => () => {
    if (gatewayTimerRef.current !== null) {
      window.clearTimeout(gatewayTimerRef.current);
      gatewayTimerRef.current = null;
    }
  }, []);

  // The mode picker is only reachable where solo mode is allowed (local app or a localhost page).
  // Without it, the logo, the 切換模式 menu item and the ServerModal button are not rendered.
  const openGateway = OfflineSessionStore.canUseOfflineMode() ? () => {
    if (importingLumina.current) return;
    if (gatewayTimerRef.current !== null) {
      window.clearTimeout(gatewayTimerRef.current);
      gatewayTimerRef.current = null;
    }
    gatewayResolveSeqRef.current += 1;
    gatewayResolvingRef.current = false;
    gatewayCanvasRef.current = null;
    returningToGateway.current = true;
    setShowGateway(true);
  } : undefined;

  const [canvases, setCanvases] = useState<CanvasModel[]>([]);
  const canvasIdRef = useRef(activeCanvasId);
  const layerRequestRef = useRef(0);
  // `${canvasId}:${userId}` already given a layer on opening (or refused one) in this tab
  const autoLayerTriedRef = useRef(new Set<string>());
  canvasIdRef.current = activeCanvasId;
  const [layerState, setLayerState] = useState<{ canvasId: string | null; items: LayerModel[] }>({
    canvasId: null,
    items: EMPTY_LAYERS,
  });
  const layers = layerState.canvasId === activeCanvasId ? layerState.items : EMPTY_LAYERS;
  const layersRef = useRef<LayerModel[]>(layers);
  layersRef.current = layers;
  const closedOfflineTabsRef = useRef<Set<string>>(loadClosedOfflineCanvasIds());
  const uncloseOfflineCanvas = useCallback((canvasId: string | null | undefined) => {
    if (!canvasId || !canvasId.startsWith('local_')) return;
    if (closedOfflineTabsRef.current.delete(canvasId)) {
      saveClosedOfflineCanvasIds(closedOfflineTabsRef.current);
    }
  }, []);
  const recordLayerCreationRef = useRef<((created: LayerModel) => void) | null>(null);
  const registerRecordLayerCreation = useCallback((fn: ((created: LayerModel) => void) | null) => {
    recordLayerCreationRef.current = fn;
  }, []);
  const [settledLayerListId, setSettledLayerListId] = useState<string | null>(null);
  useLayoutEffect(() => {
    setLayerState({ canvasId: activeCanvasId, items: EMPTY_LAYERS });
    setSettledLayerListId(null);
  }, [activeCanvasId]);
  const setLayers = useCallback((update: React.SetStateAction<LayerModel[]>) => {
    setLayerState((previous) => {
      if (canvasIdRef.current !== activeCanvasId) return previous;
      const current = previous.canvasId === activeCanvasId ? previous.items : EMPTY_LAYERS;
      return { canvasId: activeCanvasId, items: typeof update === 'function' ? update(current) : update };
    });
  }, [activeCanvasId]);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const activeLayerIdRef = useRef(activeLayerId);
  activeLayerIdRef.current = activeLayerId;

  // Canvas previews for the bottom switcher (kept per device)
  const [canvasThumbs, setCanvasThumbs] = useState<Record<string, string>>(loadThumbs);
  const handleCanvasThumbnail = useCallback((canvasId: string, dataUrl: string) => {
    const offline = OfflineSessionStore.isOfflineCanvas(canvasId);
    if (offline) OfflineSessionStore.saveThumbnail(canvasId, dataUrl);
    setCanvasThumbs((prev) => {
      const { [canvasId]: _old, ...rest } = prev;
      const entries = Object.entries({ ...rest, [canvasId]: dataUrl }).slice(-MAX_THUMBS);
      const next = Object.fromEntries(entries);
      try {
        if (!offline) localStorage.setItem(THUMBS_KEY, JSON.stringify(next));
      } catch {
        // quota full: previews just are not remembered
      }
      return next;
    });
  }, []);
  const [tabsExpanded, setTabsExpanded] = useState<boolean>(() => localStorage.getItem('atelier_tabs_expanded') === 'true');
  const [tabsPlacement, setTabsPlacement] = useState<CanvasTabsPlacement>(() =>
    localStorage.getItem('atelier_tabs_placement') === 'top' ? 'top' : 'bottom');
  const moveCanvasTabs = (placement: CanvasTabsPlacement) => {
    setTabsPlacement(placement);
    localStorage.setItem('atelier_tabs_placement', placement);
  };
  const toggleTabsExpanded = () => {
    setTabsExpanded((v) => {
      localStorage.setItem('atelier_tabs_expanded', String(!v));
      return !v;
    });
  };

  // Modals state
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const pendingServerLogin = useRef<string | null>(null);
  useEffect(() => {
    if (authLoading || showGateway || !pendingServerLogin.current) return;
    const origin = pendingServerLogin.current;
    pendingServerLogin.current = null;
    if (origin === ApiService.getServerOrigin() && isGuest) setIsAuthModalOpen(true);
  }, [authLoading, isGuest, showGateway, user?.id]);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isReplayModalOpen, setIsReplayModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isCapsuleModalOpen, setIsCapsuleModalOpen] = useState(false);
  const [isServerModalOpen, setIsServerModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  // What the help centre opens searched for (the connect guide's "full help" link)
  const [helpQuery, setHelpQuery] = useState('');
  // F1 opens the help centre from anywhere (and keeps the browser's own help page closed)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F1') return;
      e.preventDefault();
      setIsHelpOpen((open) => !open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [isAdminDashboardOpen, setIsAdminDashboardOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [lastReadChatId, setLastReadChatId] = useState<string | null>(null);
  const ownChatUserId = user?.id || 'guest';
  const latestIncomingChatId = chatMessages.reduce<string | null>(
    (latest, message) => message.userId === ownChatUserId ? latest : message.id, null);
  useLayoutEffect(() => {
    if (isChatOpen && !showGateway) setLastReadChatId(latestIncomingChatId);
  }, [isChatOpen, showGateway, latestIncomingChatId]);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isCreateMyLayerModalOpen, setIsCreateMyLayerModalOpen] = useState(false);
  const [canvasToDelete, setCanvasToDelete] = useState<CanvasModel | null>(null);
  const [resizeRequest, setResizeRequest] = useState(0);
  const [importImagesRequest, setImportImagesRequest] = useState<{ files: File[]; id: number } | null>(null);

  // Layer canvas extraction callback for export
  const projectAccessRef = useRef<CanvasProjectAccess | null>(null);
  const registerProjectAccess = useCallback((access: CanvasProjectAccess | null) => {
    projectAccessRef.current = access;
  }, []);
  const savingProjectRef = useRef<Promise<void> | null>(null);
  const [storageInfo, setStorageInfo] = useState<{ desktopFolder?: string } | null>(null);
  const luminaInputRef = useRef<HTMLInputElement>(null);
  const [projectStatusMsg, setProjectStatusMsg] = useState<string | null>(null);
  const showProjectToast = useCallback((msg: string) => {
    setProjectStatusMsg(msg);
    window.setTimeout(() => {
      setProjectStatusMsg((curr) => (curr === msg ? null : curr));
    }, 3200);
  }, []);
  const bakeScreentoneRef = useRef<
    | ((layerId: string, params: { density: number; angleRad: number; dotScale: number }) => void)
    | null
  >(null);

  const getCanvasTargetContext = (): CanvasTargetContext => ({
    serverOrigin: ApiService.getServerOrigin(),
    isOfflineMode: OfflineSessionStore.isOfflineMode(),
  });

  // Load all available canvases on boot or user change
  const fetchCanvases = async () => {
    if (gatewayResolvingRef.current) return;
    const requestSeq = ++fetchCanvasesSeqRef.current;
    const requestTarget = getCanvasTargetContext();
    const canCommit = () =>
      shouldCommitCanvasFetch({
        requestSeq,
        latestSeq: fetchCanvasesSeqRef.current,
        requestTarget,
        currentTarget: getCanvasTargetContext(),
        gatewayResolving: gatewayResolvingRef.current,
      });
    try {
      const rawList = await ApiService.listCanvases();
      if (!canCommit()) return;
      const picked = gatewayCanvasRef.current;
      gatewayCanvasRef.current = null;
      let list = rawList;
      if (requestTarget.isOfflineMode) {
        if (picked) uncloseOfflineCanvas(picked);
        list = filterVisibleOfflineCanvases(rawList, closedOfflineTabsRef.current);
        if (list.length === 0 && rawList.length > 0) {
          const fallback = [...rawList].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
          uncloseOfflineCanvas(fallback.id);
          list = [fallback];
        }
      }
      setCanvases(list);

      // The socket starts in the linked room. Fall back to the last canvas if the room is gone.
      if (list.length > 0) {
        const savedCanvasId = typeof window !== 'undefined' ? localStorage.getItem('atelier_active_canvas_id') : null;
        const targetId = resolveTargetCanvasId({
          canvases: list,
          pendingGatewayCanvasId: picked,
          liveActiveCanvasId: getActiveCanvasId(),
          sharedRoomId: requestTarget.isOfflineMode ? null : sharedRoomFromLocation(),
          savedCanvasId,
        });
        if (targetId) joinCanvas(targetId);
      } else if (!isGuest && !(!requestTarget.isOfflineMode && isLocalArtistUser(user))) {
        try {
          const res = await ApiService.createCanvas({
            title: '🎨 流光畫室 1',
            width: 2048,
            height: 2048,
          });
          if (!canCommit()) return;
          setCanvases([res.canvas]);
          joinCanvas(res.canvas.id);
        } catch (e) {
          console.error('Failed to auto-create initial canvas:', e);
        }
      }
    } catch (err) {
      console.error('Failed to load canvases:', err);
    }
  };

  const handleGatewayResolve = async (
    targetServerUrl: string,
    _nickname?: string,
    canvasOptions?: InitialCanvasOptions
  ) => {
    if (gatewayTimerRef.current !== null) {
      window.clearTimeout(gatewayTimerRef.current);
      gatewayTimerRef.current = null;
    }
    const resolveSeq = ++gatewayResolveSeqRef.current;
    fetchCanvasesSeqRef.current += 1;
    gatewayCanvasRef.current = canvasOptions?.canvasId ?? null;
    gatewayResolvingRef.current = true;
    const finishResolve = () => {
      if (resolveSeq === gatewayResolveSeqRef.current) {
        gatewayResolvingRef.current = false;
      }
    };

    if ((targetServerUrl === 'offline' || canvasOptions?.offline) && OfflineSessionStore.canUseOfflineMode()) {
      const wasOnline = !OfflineSessionStore.isOfflineMode();
      const liveId = getActiveCanvasId();
      if (wasOnline || !liveId || !OfflineSessionStore.isOfflineCanvas(liveId) || Boolean(!canvasOptions?.canvasId && canvasOptions?.title)) {
        clearActiveCanvas();
      }
      OfflineSessionStore.setSessionMode('offline');
      reconnectServer('offline');
      const requestTarget = getCanvasTargetContext();
      const stillCurrent = () =>
        shouldCommitGatewayResolve({
          resolveSeq,
          latestResolveSeq: gatewayResolveSeqRef.current,
          requestTarget,
          currentTarget: getCanvasTargetContext(),
        });
      setShowGateway(false);
      try {
        if (canvasOptions?.title) {
          const res = await OfflineSessionStore.createCanvas({
            title: canvasOptions.title,
            width: canvasOptions.width || 2048,
            height: canvasOptions.height || 2048,
          });
          uncloseOfflineCanvas(res.canvas.id);
          const allOffline = await OfflineSessionStore.listCanvases();
          const list = filterVisibleOfflineCanvases(allOffline, closedOfflineTabsRef.current);
          if (!stillCurrent()) return;
          gatewayCanvasRef.current = null;
          setCanvases(list);
          joinCanvas(res.canvas.id);
          return;
        }
        if (canvasOptions?.canvasId) {
          uncloseOfflineCanvas(canvasOptions.canvasId);
        }
        const allOffline = await OfflineSessionStore.listCanvases();
        if (!stillCurrent()) return;
        let list = filterVisibleOfflineCanvases(allOffline, closedOfflineTabsRef.current);
        if (list.length === 0 && allOffline.length > 0) {
          const fallback = [...allOffline].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
          uncloseOfflineCanvas(fallback.id);
          list = [fallback];
        }
        setCanvases(list);
        const savedCanvasId = typeof window !== 'undefined' ? localStorage.getItem('atelier_active_canvas_id') : null;
        const targetId = resolveTargetCanvasId({
          canvases: list,
          pendingGatewayCanvasId: canvasOptions?.canvasId ?? null,
          liveActiveCanvasId: getActiveCanvasId(),
          sharedRoomId: null,
          savedCanvasId,
        });
        gatewayCanvasRef.current = null;
        if (targetId) joinCanvas(targetId);
      } catch (err) {
        console.error('Failed to initialize offline canvas:', err);
      } finally {
        finishResolve();
      }
      return;
    }

    const previous = ApiService.getServerOrigin();
    const wasOffline = OfflineSessionStore.isOfflineMode();
    const nextOrigin = ApiService.getServerOrigin(targetServerUrl);
    if (nextOrigin !== previous || wasOffline) {
      setCanvases([]);
      clearActiveCanvas();
    } else if (!canvasOptions?.canvasId && canvasOptions?.title) {
      clearActiveCanvas();
    }
    reconnectServer(targetServerUrl);
    const origin = ApiService.getServerOrigin();
    const requestTarget = getCanvasTargetContext();
    const stillCurrent = () =>
      shouldCommitGatewayResolve({
        resolveSeq,
        latestResolveSeq: gatewayResolveSeqRef.current,
        requestTarget,
        currentTarget: getCanvasTargetContext(),
      });
    if (origin !== previous && !canvasOptions?.title) {
      pendingServerLogin.current = origin;
    }
    setShowGateway(false);
    // Transition and fetch canvases from target server while gatewayResolvingRef guards against races
    gatewayTimerRef.current = window.setTimeout(async () => {
      gatewayTimerRef.current = null;
      const opts = canvasOptions;
      if (!stillCurrent()) {
        finishResolve();
        return;
      }
      let resolvedRoom = false;
      try {
        if (opts?.openLogin) setIsAuthModalOpen(true);
        if (opts?.canvasId) {
          const list = await ApiService.listCanvases();
          if (!stillCurrent()) return;
          setCanvases(list);
          const savedCanvasId = typeof window !== 'undefined' ? localStorage.getItem('atelier_active_canvas_id') : null;
          const targetId = resolveTargetCanvasId({
            canvases: list,
            pendingGatewayCanvasId: opts.canvasId,
            liveActiveCanvasId: getActiveCanvasId(),
            sharedRoomId: sharedRoomFromLocation(),
            savedCanvasId,
          });
          gatewayCanvasRef.current = null;
          if (targetId) {
            joinCanvas(targetId);
            resolvedRoom = true;
          }
        } else if (opts?.title) {
          // 建立新房間 / 建立畫布組房間 is explicit now (the name starts empty), so it always makes a new room and promotes the creator to room owner/admin
          const list = await ApiService.listCanvases();
          if (!stillCurrent()) return;
          const res = await ApiService.createCanvas({
            title: opts.title,
            width: opts.width || 2048,
            height: opts.height || 2048,
            roomPassword: opts.password,
            newGroupTitle: opts.newGroupTitle,
          });
          if (opts.password && res.canvas?.id) {
            ApiService.setRoomPassword(res.canvas.id, opts.password);
          }
          if (!stillCurrent()) return;
          gatewayCanvasRef.current = null;
          setCanvases(list.some((c) => c.id === res.canvas.id) ? list : [...list, res.canvas]);
          joinCanvas(res.canvas.id);
          resolvedRoom = true;
        }
      } catch (err: any) {
        if (opts?.title) alert(err?.message || '建立房間失敗');
      } finally {
        finishResolve();
      }
      if (!resolvedRoom && stillCurrent() && !authLoading) {
        void fetchCanvases();
      }
    }, 150);
  };

  useEffect(() => {
    if (!showGateway && !authLoading && !gatewayResolvingRef.current) {
      fetchCanvases();
    }
  }, [user?.id, showGateway, authLoading]);

  // Ensure valid canvas is auto-selected when canvases load
  useEffect(() => {
    const savedCanvasId = typeof window !== 'undefined' ? localStorage.getItem('atelier_active_canvas_id') : null;
    const fallbackId = resolveAutoSelectCanvasId({
      showGateway,
      gatewayResolving: gatewayResolvingRef.current,
      canvases,
      activeCanvasId,
      pendingGatewayCanvasId: gatewayCanvasRef.current,
      sharedRoomId: OfflineSessionStore.isOfflineMode() ? null : sharedRoomFromLocation(),
      savedCanvasId,
    });
    if (fallbackId) {
      joinCanvas(fallbackId);
    }
  }, [canvases, activeCanvasId, showGateway]);

  const currentCanvas = canvases.find((c) => c.id === activeCanvasId) || null;

  /* ---------- Password rooms ---------- */
  const [memberOf, setMemberOf] = useState<Record<string, boolean>>({});
  const [unlockedRooms, setUnlockedRooms] = useState<Set<string>>(() => new Set());
  const canBypassPassword = Boolean(currentCanvas && user && (user.serverRole === 'admin' || currentCanvas.ownerId === user.id));
  useEffect(() => {
    const canvas = currentCanvas;
    if (!canvas?.hasPassword || isGuest || canBypassPassword || memberOf[canvas.id] !== undefined) return;
    let cancelled = false;
    ApiService.getCanvas(canvas.id)
      .then(async (res) => {
        if (cancelled) return;
        if (res.hasGroupAccess && !res.myMembership) await ApiService.joinCanvas({ canvasId: canvas.id });
        if (!cancelled) setMemberOf((prev) => ({ ...prev, [canvas.id]: Boolean(res.myMembership || res.hasGroupAccess) }));
      })
      .catch(() => { if (!cancelled) setMemberOf((prev) => ({ ...prev, [canvas.id]: false })); });
    return () => { cancelled = true; };
  }, [currentCanvas?.id, currentCanvas?.hasPassword, isGuest, canBypassPassword, user?.id]);

  const groupUnlocked = Boolean(currentCanvas?.group && ApiService.getRoomPassword(currentCanvas.id));
  const passwordGate = Boolean(currentCanvas?.hasPassword) && !canBypassPassword && !groupUnlocked
    && !unlockedRooms.has(currentCanvas!.id) && memberOf[currentCanvas!.id] !== true;
  const serverRefused = Boolean(currentCanvas && roomAccessError?.canvasId === currentCanvas.id);
  const roomLocked = Boolean(currentCanvas) && (passwordGate || serverRefused);
  // Remember the canvas that actually opened, for the gateway's "continue" card and room preselection.
  // Only once it has stayed open a moment: entering a room can pass through the list's first room.
  useEffect(() => {
    if (showGateway || roomLocked || !currentCanvas) return;
    const offline = OfflineSessionStore.isOfflineMode();
    const visit = {
      mode: offline ? 'offline' as const : 'online' as const,
      server: offline ? undefined : ApiService.getServerOrigin(),
      canvasId: currentCanvas.id,
      title: currentCanvas.title,
      width: currentCanvas.width,
      height: currentCanvas.height,
    };
    const timer = window.setTimeout(() => recordRecentVisit(visit), 1500);
    return () => window.clearTimeout(timer);
  }, [showGateway, roomLocked, currentCanvas?.id, currentCanvas?.title, currentCanvas?.width, currentCanvas?.height]);
  const checkingMembership = passwordGate && !isGuest && memberOf[currentCanvas!.id] === undefined;
  // "Choose another canvas" hides the prompt so the canvas bar below can be used
  const [promptHiddenFor, setPromptHiddenFor] = useState<string | null>(null);

  const handleUnlockRoom = async (password: string) => {
    if (!currentCanvas) return;
    const id = currentCanvas.id;
    if (!isGuest) {
      // Members are remembered by the server, so the password is asked only once per account
      await ApiService.joinCanvas({ canvasId: id, roomPassword: password });
      setMemberOf((prev) => ({ ...prev, [id]: true }));
    } else if (currentCanvas.group) {
      await ApiService.verifyCanvasPassword(id, password);
    }
    setUnlockedRooms((prev) => new Set(prev).add(id));
    unlockRoom(id, password);
  };

  const lastLayerUserIdRef = useRef<string | undefined>(user?.id);

  // Load layers when activeCanvasId changes or user logs in
  // autoAssign (opening a canvas): an account with no layer of its own here gets one and starts on it
  const fetchLayers = async (
    canvasId: string,
    preferredActiveId?: string | null,
    isCancelled = () => false,
    autoAssign = false,
    preferUserLayer = false
  ) => {
    if (canvasIdRef.current !== canvasId) return;
    const request = ++layerRequestRef.current;
    const isCurrent = () => !isCancelled() && canvasIdRef.current === canvasId && layerRequestRef.current === request;
    try {
      const { layers: res, lastDrawnLayerId: serverLastLayerId } = await ApiService.listLayersWithHint(canvasId);
      if (!isCurrent()) return;
      setLayers(res);

      const isOfflineCanvas = OfflineSessionStore.isOfflineCanvas(canvasId);
      const isCanvasViewer = isCanvasViewerForUser({
        user,
        isGuest,
        members,
        canvasOwnerId: canvases.find((c) => c.id === canvasId)?.ownerId ?? null,
      });
      const drawCtx = { user, isGuest, isCanvasViewer };

      const localLastLayerId = !isGuest && user?.id ? ApiService.getLastDrawnLayerId(canvasId, user.id) : null;
      const hintLayerId = [localLastLayerId, serverLastLayerId].find((id) => {
        if (!id) return false;
        const candidate = res.find((l) => l.id === id);
        return Boolean(candidate && isLayerDrawableForUser(candidate, drawCtx, res));
      }) ?? null;

      const tryKey = `${canvasId}:${user?.id}`;
      const skipAutoAssign = shouldSkipAutoAssign({
        autoAssign,
        isOfflineCanvas,
        authLoading,
        layers: res,
        hintLayerId,
        alreadyTried: autoLayerTriedRef.current.has(tryKey),
        ctx: drawCtx,
      });
      if (!skipAutoAssign && user) {
        autoLayerTriedRef.current.add(tryKey);
        try {
          const ownerLabel = isOfflineCanvas
            ? (user.displayName || user.username || '本機畫師')
            : sanitizeOnlineGuestName(user.displayName || user.username, user.username || '畫師');
          const mine = await ApiService.createLayer(canvasId, {
            name: `${ownerLabel} 的圖層`,
            blendMode: 'normal',
            layerType: 'raster',
            isPublic: false,
          });
          if (!isCurrent()) return;
          setLayers((prev) => (prev.some((l) => l.id === mine.id) ? prev : [...prev, mine]));
          setActiveLayerId(mine.id);
          return;
        } catch {
          // No right to add layers here: pick one of the existing layers as before
        }
      }

      if (res.length > 0) {
        // Priority 1: User explicitly requested an active layer (e.g. newly created layer)
        if (preferredActiveId && res.some((l: LayerModel) => l.id === preferredActiveId)) {
          setActiveLayerId(preferredActiveId);
          return;
        }

        // Priority 2: Keep current active layer unless the signed-in account just changed (e.g. guest -> login)
        if (!preferUserLayer && res.some((l) => l.id === activeLayerIdRef.current)) {
          return;
        }

        // Priority 3: Jump to the best drawable/claimable layer for this user
        const targetLayer = pickBestInitialLayer(res, drawCtx, hintLayerId);
        setActiveLayerId(targetLayer?.id ?? null);
      } else if (!isGuest && !isCanvasViewer && !(!isOfflineCanvas && isLocalArtistUser(user))) {
        // If canvas has zero layers, automatically create an initial collaborative layer
        try {
          const initialLayer = await ApiService.createLayer(canvasId, {
            name: '圖層 1',
            blendMode: 'normal',
            layerType: 'raster',
            isPublic: true,
          });
          if (!isCurrent()) return;
          setLayers([initialLayer]);
          setActiveLayerId(initialLayer.id);
        } catch {
          if (isCurrent()) setActiveLayerId(null);
        }
      }
    } catch (err) {
      console.error('Failed to load layers:', err);
    } finally {
      if (isCurrent()) setSettledLayerListId(canvasId);
    }
  };

  useEffect(() => {
    let cancelled = false;
    // A locked room's layers are refused until it is unlocked; do not fetch/autoAssign while the gateway is open
    if (activeCanvasId && !roomLocked && !showGateway) {
      const isOfflineCanvas = OfflineSessionStore.isOfflineCanvas(activeCanvasId);
      if (!isOfflineCanvas && (authLoading || isLocalArtistUser(user))) {
        return () => { cancelled = true; };
      }
      const userChanged = lastLayerUserIdRef.current !== user?.id;
      lastLayerUserIdRef.current = user?.id;
      fetchLayers(activeCanvasId, null, () => cancelled, true, userChanged);
    }
    return () => { cancelled = true; };
  }, [activeCanvasId, user?.id, roomLocked, authLoading, showGateway]);

  // Another painter (or this user's other tab) resized a canvas: the workspace rebuilds at the new size
  useEffect(() => {
    const ev = canvasResizedEvent;
    if (ev) setCanvases((prev) => prev.map((c) => (c.id === ev.canvasId ? { ...c, width: ev.width, height: ev.height } : c)));
  }, [canvasResizedEvent]);

  // Real-time synchronization of Layer updates from Socket
  useEffect(() => {
    if (layersSyncEvent && layersSyncEvent.layers && layersSyncEvent.canvasId === activeCanvasId) {
      setLayers(layersSyncEvent.layers);
    }
  }, [layersSyncEvent]);

  useEffect(() => {
    if (layerUpdateEvent?.layer && layerUpdateEvent.layer.canvasId === activeCanvasId) {
      setLayers((prev) => {
        const exists = prev.some((l) => l.id === layerUpdateEvent.layer.id);
        if (exists) {
          return prev.map((l) =>
            l.id === layerUpdateEvent.layer.id ? layerUpdateEvent.layer : l
          );
        } else {
          return [...prev, layerUpdateEvent.layer];
        }
      });
    }
  }, [layerUpdateEvent]);

  const activeLayer = layers.find((l) => l.id === activeLayerId) || null;

  // Canvas Actions
  const handleCreateCanvas = async (dto: CreateCanvasDto) => {
    if (isGuest) {
      setIsAuthModalOpen(true);
      return;
    }
    const res = await ApiService.createCanvas(dto);
    uncloseOfflineCanvas(res.canvas.id);
    setCanvases((prev) => [...prev, res.canvas]);
    joinCanvas(res.canvas.id);
  };

  const handleRenameCanvas = async (canvasId: string, newTitle: string) => {
    try {
      const updated = await ApiService.updateCanvas(canvasId, { title: newTitle });
      setCanvases((prev) => prev.map((c) => (c.id === canvasId ? updated : c)));
    } catch (err: any) {
      alert(err.message || '無法重命名畫布');
    }
  };

  const handleDeleteCanvas = async (canvasId: string) => {
    try {
      const nextId = activeCanvasId === canvasId ? resolveNextCanvasAfterClose(canvases, canvasId) : null;
      await ApiService.deleteCanvas(canvasId);
      uncloseOfflineCanvas(canvasId);
      const remaining = canvases.filter((c) => c.id !== canvasId);
      setCanvases(remaining);
      if (activeCanvasId === canvasId) {
        if (nextId) {
          joinCanvas(nextId);
        } else if (remaining.length > 0) {
          joinCanvas(remaining[0].id);
        } else if (OfflineSessionStore.isOfflineMode()) {
          clearActiveCanvas();
          returningToGateway.current = true;
          setShowGateway(true);
        }
      }
    } catch (err: any) {
      alert(err.message || '無法刪除畫布');
    }
  };

  const handleCloseOfflineCanvas = async (canvas: CanvasModel) => {
    if (!OfflineSessionStore.isOfflineMode() || !OfflineSessionStore.isOfflineCanvas(canvas.id)) return;
    await OfflineSessionStore.flushPendingWrites().catch(console.error);
    const nextId = activeCanvasId === canvas.id ? resolveNextCanvasAfterClose(canvases, canvas.id) : null;
    closedOfflineTabsRef.current.add(canvas.id);
    saveClosedOfflineCanvasIds(closedOfflineTabsRef.current);
    const remaining = canvases.filter((c) => c.id !== canvas.id);
    setCanvases(remaining);
    if (activeCanvasId === canvas.id) {
      if (nextId) {
        joinCanvas(nextId);
      } else {
        clearActiveCanvas();
        returningToGateway.current = true;
        setShowGateway(true);
      }
    }
  };

  // Layer Actions: creates right above currently active layer
  const handleCreateLayer = async (
    name: string,
    blendMode: BlendMode = 'normal',
    layerType: LayerType = 'raster',
    aboveLayerId?: string | null,
    parentId?: string | null,
    // meta: animation folder / text source; select: false keeps the active layer (masks, frames made in passing)
    extra?: { meta?: LayerMeta | null; select?: boolean; belowLayerId?: string }
  ): Promise<LayerModel | null> => {
    if (!activeCanvasId) return null;
    try {
      const selected = layers.find((layer) => layer.id === (aboveLayerId ?? activeLayerId));
      let targetAbove = aboveLayerId !== undefined ? aboveLayerId : (activeLayerId || undefined);
      let targetParent = parentId !== undefined ? parentId
        : selected?.layerType === 'group' ? selected.id : selected?.parentId;
      if (parentId === undefined) {
        // Place quick-created layers outside folders this painter has no permission to use.
        let leftGroup: LayerModel | null = null;
        for (let g = layers.find((l) => l.id === targetParent); g && !folderAccess.canAdd(g); g = layers.find((l) => l.id === g!.parentId)) leftGroup = g;
        if (leftGroup) {
          targetParent = leftGroup.parentId;
          const inside = (l: LayerModel): boolean => { for (let p = l.parentId; p; p = layers.find((x) => x.id === p)?.parentId ?? null) if (p === leftGroup!.id) return true; return false; };
          targetAbove = [leftGroup, ...layers.filter(inside)].sort((a, b) => b.sortOrder - a.sortOrder)[0].id; // above everything it held
        }
      }
      const newLayer = await ApiService.createLayer(activeCanvasId, {
        name,
        blendMode,
        layerType,
        isPublic: false,
        ...(extra?.belowLayerId ? { belowLayerId: extra.belowLayerId } : { aboveLayerId: targetAbove }),
        parentId: targetParent || undefined,
        ...(extra?.meta !== undefined ? { meta: extra.meta } : {}),
      });
      if (canvasIdRef.current !== activeCanvasId) return null;

      // Optimistically insert immediately above targetAbove in local layers state
      setLayers((prev) => {
        if (prev.some((layer) => layer.id === newLayer.id)) return prev;
        if (!targetAbove) return [...prev, newLayer];
        const idx = prev.findIndex((l) => l.id === targetAbove);
        if (idx === -1) return [...prev, newLayer];
        const copy = [...prev];
        copy.splice(idx + 1, 0, newLayer);
        return copy;
      });
      if (extra?.select !== false) setActiveLayerId(newLayer.id);
      await fetchLayers(activeCanvasId, extra?.select !== false ? newLayer.id : undefined);
      return newLayer;
    } catch (err: any) {
      alert(err.message || '建立圖層失敗');
      return null;
    }
  };

  const handleTogglePluginPanel = useCallback((pluginId: string, panelId: string) => {
    const plugin = getPlugins().find(({ manifest, enabled }) => enabled && manifest.id === pluginId)?.manifest;
    if (!plugin || !isModernPluginManifest(plugin) || !plugin.permissions.includes('ui:panel')) return;
    if (!plugin.panels.some((p) => p.id === panelId)) return;
    const key = `${pluginId}:${panelId}`;
    setOpenPluginPanels((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  const handleRunPlugin = async (pluginId: string, commandId: string) => {
    const strings = getPluginLabels(language);
    if (runningPlugin.current) return showProjectToast(strings.working);
    const plugin = getPlugins().find(({ manifest, enabled }) => enabled && manifest.id === pluginId)?.manifest;
    if (!plugin?.commands.some(command => command.id === commandId)) return;
    const canvasId = currentCanvas?.id;
    if (!currentCanvas || roomLocked || pluginAccessRef.current?.canvasId !== canvasId) return showProjectToast(strings.needed);
    runningPlugin.current = true;
    const displayName = resolvePluginName(plugin, language);
    const controller = new AbortController();
    pluginCmdAbortRef.current = controller;
    try {
      if (isModernPluginManifest(plugin)) {
        const access = pluginAccessRef.current;
        if (!access || access.canvasId !== canvasId) return;
        const result = await access.runV2Command(plugin, commandId, {
          signal: controller.signal,
          onSlowStart: () => setSlowPluginCommand(displayName),
        });
        if (!getPlugins().some(entry => entry.enabled && entry.manifest === plugin)) return;
        if (canvasIdRef.current !== canvasId) return;
        showProjectToast(result.notice || `${displayName} · ${strings.done}`);
        return;
      }
      const { runPlugin } = await import('./plugins/runPlugin');
      const action = await runPlugin(plugin, commandId, {
        width: currentCanvas.width, height: currentCanvas.height, dpi: clampDpi(currentCanvas.dpi ?? 300),
      });
      if (!getPlugins().some(entry => entry.enabled && entry.manifest === plugin)) return;
      const access = pluginAccessRef.current;
      if (canvasIdRef.current !== canvasId || !access || access.canvasId !== canvasId) return;
      if (action.kind === 'message') return showProjectToast(action.text);
      if (!await access.apply(action)) return showProjectToast(strings.failed);
      showProjectToast(`${displayName} · ${strings.done}`);
    } catch (error) {
      if (controller.signal.aborted) {
        showProjectToast(strings.aborted);
      } else {
        showProjectToast(`${strings.failed} ${error instanceof Error ? error.message : ''}`);
      }
    } finally {
      if (pluginCmdAbortRef.current === controller) pluginCmdAbortRef.current = null;
      setSlowPluginCommand(null);
      runningPlugin.current = false;
    }
  };

  const handleRunPluginRef = useRef(handleRunPlugin);
  handleRunPluginRef.current = handleRunPlugin;

  const handleSelectPluginTool = useCallback((pluginId: string, toolId: string) => {
    pluginAccessRef.current?.selectPluginTool(pluginId, toolId);
  }, []);

  useEffect(() => {
    const onPluginShortcut = (e: Event) => {
      const detail = (e as CustomEvent<ParsedPluginShortcutId>).detail;
      if (!detail) return;
      if (detail.kind === 'command') {
        void handleRunPluginRef.current(detail.pluginId, detail.commandId);
      } else if (detail.kind === 'panel') {
        handleTogglePluginPanel(detail.pluginId, detail.panelId);
      } else if (detail.kind === 'tool') {
        handleSelectPluginTool(detail.pluginId, detail.toolId);
      }
    };
    window.addEventListener('atelier:plugin-shortcut', onPluginShortcut);
    return () => window.removeEventListener('atelier:plugin-shortcut', onPluginShortcut);
  }, [handleTogglePluginPanel, handleSelectPluginTool]);

  const handlePluginPanelAction = useCallback(
    async (
      plugin: PluginManifestModern,
      panelId: string,
      actionId: string,
      values: PluginPanelValues,
      options: { onSlowStart?: () => void; signal?: AbortSignal },
    ) => {
      const strings = getPluginLabels(language);
      const canvasId = currentCanvas?.id;
      const access = pluginAccessRef.current;
      if (!currentCanvas || roomLocked || !access || access.canvasId !== canvasId) {
        throw new Error(strings.needed);
      }
      return access.runV2PanelAction(plugin, panelId, actionId, values, options);
    },
    [currentCanvas, roomLocked, language],
  );

  const handleToggleLock = async (layer: LayerModel) => {
    if (!activeCanvasId) return;
    const isOwner = user?.id === layer.ownerId;
    const isAdmin = user?.serverRole === 'admin';
    if (!isOwner && !isAdmin) {
      alert('無權限：您不是該圖層擁有者，無法修改鎖定狀態');
      return;
    }
    try {
      const updated = await ApiService.updateLayer(activeCanvasId, layer.id, {
        isLocked: !layer.isLocked,
      });
      setLayers((prev) => prev.map((l) => (l.id === layer.id ? updated : l)));
    } catch (err: any) {
      alert(err.message || '無權限修改該圖層鎖定狀態');
    }
  };

  const handleToggleVisibility = async (layer: LayerModel) => {
    if (!activeCanvasId) return;
    const isOwner = user?.id === layer.ownerId;
    const isAdmin = user?.serverRole === 'admin';
    if (!isOwner && !isAdmin && !layer.isPublic) {
      alert('無權限：您不是該圖層擁有者，無法修改他人圖層可見度');
      return;
    }
    try {
      const updated = await ApiService.updateLayer(activeCanvasId, layer.id, {
        isVisible: !layer.isVisible,
      });
      setLayers((prev) => prev.map((l) => (l.id === layer.id ? updated : l)));
    } catch (err: any) {
      alert(err.message || '無權限修改該圖層可見度');
    }
  };

  /** Deletes a layer; a group goes with everything inside it (other painters' layers in it move up out of it) */
  const handleDeleteLayer = async (layerId: string, opts?: { keepContents?: boolean }): Promise<{ deleted: string[]; lifted: string[] } | false> => {
    if (!activeCanvasId) return false;
    const liveLayers = layersRef.current;
    const target = liveLayers.find((l) => l.id === layerId);
    const isOwner = target && user?.id === target.ownerId;
    const isAdmin = user?.serverRole === 'admin';
    if (!isOwner && !isAdmin) {
      alert('無權限：您不是該圖層擁有者，無法刪除他人圖層');
      return false;
    }
    try {
      // keepContents (undo of a new group): its layers stay, moved up out of it
      const res = await ApiService.deleteLayer(activeCanvasId, layerId, !opts?.keepContents);
      if (canvasIdRef.current !== activeCanvasId) return false;
      const deleted = res?.deletedIds?.length ? res.deletedIds : [layerId];
      const lifted = res?.liftedIds ?? [];
      const gone = new Set(deleted);
      const isGone = (l: LayerModel) => gone.has(l.id) || (l.layerType === 'mask' && Boolean(l.parentId) && gone.has(l.parentId!));
      setLayers((prev) => prev.filter((l) => !isGone(l)).map((l) => (lifted.includes(l.id) ? { ...l, parentId: target?.parentId ?? null } : l)));
      const latestLayers = layersRef.current;
      const active = latestLayers.find((l) => l.id === activeLayerIdRef.current);
      if (!active || isGone(active)) {
        // The layer right below what went, else the top one
        const left = latestLayers.filter((l) => !isGone(l) && l.layerType !== 'mask').sort((a, b) => b.sortOrder - a.sortOrder);
        const next = left.find((l) => target && l.sortOrder < target.sortOrder && !lifted.includes(l.id)) ?? left[0];
        if (next) setActiveLayerId(next.id);
      }
      return { deleted, lifted };
    } catch (err: any) {
      alert(err.message || '無權限刪除該圖層');
      return false;
    }
  };

  const handleTransferLayer = async (layerId: string, targetUserId: string) => {
    if (!activeCanvasId) return;
    try {
      transferLayer(layerId, targetUserId);
      const updated = await ApiService.transferLayer(activeCanvasId, layerId, targetUserId);
      if (updated) {
        setLayers((prev) => prev.map((l) => (l.id === layerId ? updated : l)));
      }
      await fetchLayers(activeCanvasId);
    } catch (err: any) {
      alert(err.message || '轉交圖層失敗');
    }
  };

  const handleReleaseLayer = async (layerId: string) => {
    // Optimistic local update
    setLayers((prev) =>
      prev.map((l) =>
        l.id === layerId ? { ...l, ownerId: null, isPublic: true } : l
      )
    );
    try {
      if (activeCanvasId) {
        const updated = await ApiService.releaseLayer(activeCanvasId, layerId);
        if (updated) {
          setLayers((prev) =>
            prev.map((l) => (l.id === layerId ? updated : l))
          );
        }
      }
    } catch (e) {
      console.warn('REST releaseLayer fallback error:', e);
    }
    if (canvasIdRef.current !== activeCanvasId) return;
    releaseLayer(layerId);
    if (activeCanvasId) {
      await fetchLayers(activeCanvasId);
    }
  };

  const handleClaimLayer = async (layerId: string, force: boolean = false) => {
    const myId = user?.id || 'guest';
    setLayers((prev) =>
      prev.map((l) =>
        l.id === layerId ? { ...l, ownerId: myId, isPublic: false } : l
      )
    );
    try {
      if (activeCanvasId) {
        const updated = await ApiService.claimLayer(activeCanvasId, layerId);
        if (updated) {
          setLayers((prev) =>
            prev.map((l) => (l.id === layerId ? updated : l))
          );
        }
      }
    } catch (e) {
      console.warn('REST claimLayer fallback error:', e);
    }
    if (canvasIdRef.current !== activeCanvasId) return;
    claimLayer(layerId, force);
    if (activeCanvasId) {
      await fetchLayers(activeCanvasId);
    }
  };

  const handleReorderLayer = async (layerId: string, newSortOrder: number, ascendingIds?: string[]) => {
    // 1. Optimistically update local layers state immediately
    setLayers((prev) => {
      const copy = [...prev];
      if (ascendingIds) {
        // The layer panel's list has no masks: each stays right above its layer
        const at = new Map(ascendingIds.map((id, idx) => [id, (idx + 1) * 10]));
        return copy.map((l) => {
          const own = at.get(l.id);
          if (own !== undefined) return { ...l, sortOrder: own };
          const owner = l.layerType === 'mask' && l.parentId ? at.get(l.parentId) : undefined;
          return owner !== undefined ? { ...l, sortOrder: owner + 5 } : l;
        });
      }
      return copy.map((l) => (l.id === layerId ? { ...l, sortOrder: newSortOrder } : l));
    });

    // 2. Emit over socket AND REST API for rock-solid persistence
    if (ascendingIds) {
      reorderLayersList(ascendingIds);
      if (activeCanvasId) {
        try {
          await ApiService.reorderLayers(activeCanvasId, ascendingIds);
        } catch (err) {
          console.warn('[reorderLayers REST fallback]', err);
        }
      }
    } else {
      reorderLayer(layerId, newSortOrder);
    }
  };

  const handleUpdateLayerProps = async (layerId: string, props: Partial<LayerModel>) => {
    if (!activeCanvasId) return;
    try {
      const updated = await ApiService.updateLayer(activeCanvasId, layerId, props);
      setLayers((prev) => prev.map((l) => (l.id === layerId ? updated : l)));
    } catch (err: any) {
      console.error('Update layer props error:', err);
    }
  };

  const handleCanvasResized = (width: number, height: number, dpi?: number, unit?: CanvasUnit) => {
    if (!activeCanvasId) return;
    setCanvases((prev) =>
      prev.map((c) =>
        c.id === activeCanvasId
          ? {
              ...c,
              width,
              height,
              ...(dpi !== undefined ? { dpi: clampDpi(dpi) } : {}),
              ...(unit !== undefined ? { unit } : {}),
            }
          : c
      )
    );
  };

  const handleGetLayerCanvases = async (): Promise<LayerCanvasItem[]> => {
    const access = projectAccessRef.current;
    if (access?.canvasId === currentCanvas?.id && access) {
      return access.readLayers();
    }
    // Fallback if not registered
    return layers.map((layer) => {
      const c = document.createElement('canvas');
      c.width = currentCanvas?.width || 2048;
      c.height = currentCanvas?.height || 2048;
      return { layer, canvas: c };
    });
  };

  const handleSaveLuminaProject = (saveAs = false) => {
    if (!currentCanvas || showGateway || roomLocked || savingProjectRef.current) return;
    const access = projectAccessRef.current;
    if (!access?.ready || access.canvasId !== currentCanvas.id) {
      showProjectToast(t.navbar.projectLoading);
      return;
    }
    const job = (async () => {
      const res = await LuminaProjectEngine.saveProject(
        currentCanvas,
        layers,
        async () => {
          await access.flushEdits();
          if (projectAccessRef.current?.canvasId !== access.canvasId) throw new Error(t.navbar.projectLoading);
          return access.readLayers();
        },
        { saveAs }
      );
      if (res.saved) {
        if (res.previewDataUrl) {
          handleCanvasThumbnail(currentCanvas.id, res.previewDataUrl);
        }
        showProjectToast(`✅ 已儲存專案：${res.filePath || res.filename || currentCanvas.title}`);
      }
    })().catch((error: unknown) => {
      alert(error instanceof Error ? error.message : t.navbar.projectSaveFailed);
    }).finally(() => { savingProjectRef.current = null; });
    savingProjectRef.current = job;
  };

  const readStorageInfo = async () => {
    const desktop = (window as any).atelierDesktop ?? (window as any).atelierMobile;
    const desktopFolder = await desktop?.getStorageDirectory?.().catch(() => undefined);
    setStorageInfo({ desktopFolder });
  };

  const closeSaveRef = useRef<() => Promise<void>>(async () => {});
  closeSaveRef.current = async () => {
    await savingProjectRef.current;
    const access = projectAccessRef.current;
    const editable = !showGateway && !roomLocked && currentCanvas && access?.canvasId === currentCanvas.id;
    if (editable) await access.flushEdits();
    await OfflineSessionStore.flushPendingWrites();
    const snapshot = projectAccessRef.current;
    if (editable && snapshot?.ready && snapshot.canvasId === currentCanvas.id) {
      await LuminaProjectEngine.saveProject(currentCanvas, layers, snapshot.readLayers, { onlyExisting: true });
    }
    await flushCanvasWrites();
  };
  useEffect(() => {
    const desktop = (window as any).atelierDesktop ?? (window as any).atelierMobile;
    const unsubscribe = desktop?.onBeforeClose?.(() => closeSaveRef.current());
    const flush = () => void OfflineSessionStore.flushPendingWrites().catch(console.error);
    const onVisibility = () => {
      if (document.hidden) flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      unsubscribe?.();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  const handleLoadLuminaData = useCallback(
    async (data: Blob | ArrayBuffer | Uint8Array, filePath?: string, locally = false) => {
      if (importingLumina.current) return;
      importingLumina.current = true;
      try {
        const collaborative = !OfflineSessionStore.canUseOfflineMode() || (!locally && !showGateway && !OfflineSessionStore.isOfflineMode());
        const unpacked = await LuminaProjectEngine.unpackProject(data, filePath);
        if (!collaborative && !OfflineSessionStore.isOfflineMode()) {
          clearActiveCanvas();
          OfflineSessionStore.setSessionMode('offline');
          reconnectServer('offline');
        }
        const group = currentCanvas?.group;
        const restored = await LuminaProjectEngine.restoreToCanvas(unpacked, undefined, {
          shareEditableLayers: collaborative,
          groupId: collaborative && group?.ownerId === user?.id ? group?.id : undefined,
        });
        uncloseOfflineCanvas(restored.id);
        if (unpacked.previewDataUrl) {
          handleCanvasThumbnail(restored.id, unpacked.previewDataUrl);
        }
        setCanvases((prev) => [...prev.filter((c) => c.id !== restored.id && (collaborative || c.id.startsWith('local_'))), restored]);
        joinCanvas(restored.id);
        setShowGateway(false);
        await fetchLayers(restored.id, null, () => false, false);
        showProjectToast(`📂 已開啟流光專案：${restored.title}`);
      } catch (err: any) {
        alert(err?.message || '無法開啟 .lumina 專案檔');
      } finally {
        importingLumina.current = false;
      }
    },
    [showGateway, currentCanvas?.group, user?.id, handleCanvasThumbnail, showProjectToast]
  );

  const handleOpenLuminaProject = async () => {
    const desktop = typeof window !== 'undefined' ? (window as any).atelierDesktop : undefined;
    if (desktop?.openLuminaFile) {
      const res = await desktop.openLuminaFile();
      if (res?.opened && res.data) {
        await handleLoadLuminaData(res.data, res.filePath);
      }
      return;
    }
    luminaInputRef.current?.click();
  };

  // Global keyboard shortcuts for Ctrl+S (Save .lumina), Ctrl+Shift+S (Save As .lumina), Ctrl+O (Open .lumina)
  const saveRef = useRef(handleSaveLuminaProject);
  saveRef.current = handleSaveLuminaProject;
  const openRef = useRef(handleOpenLuminaProject);
  openRef.current = handleOpenLuminaProject;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        if (!e.repeat) saveRef.current(e.shiftKey);
      } else if (key === 'o' && !e.shiftKey) {
        e.preventDefault();
        void openRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Drag & drop .lumina file anywhere in window + Electron file association open handler
  const loadLuminaRef = useRef(handleLoadLuminaData);
  loadLuminaRef.current = handleLoadLuminaData;
  useEffect(() => {
    const onDropCapture = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      const luminaFile = files.find((f) => f.name.toLowerCase().endsWith('.lumina'));
      if (!luminaFile) return;
      e.preventDefault();
      e.stopPropagation();
      const filePath = (luminaFile as any).path as string | undefined;
      void loadLuminaRef.current(luminaFile, filePath);
    };
    window.addEventListener('drop', onDropCapture, true);

    const desktop = typeof window !== 'undefined' ? (window as any).atelierDesktop : undefined;
    let unsubElectronOpen: (() => void) | undefined;
    if (desktop?.consumePendingLumina) {
      desktop.consumePendingLumina().then((pending: any) => {
        if (pending?.data) {
          void loadLuminaRef.current(pending.data, pending.filePath, true);
        }
      }).catch(() => {});
    }
    if (desktop?.onOpenLumina) {
      unsubElectronOpen = desktop.onOpenLumina((payload: any) => {
        if (payload?.data) {
          void loadLuminaRef.current(payload.data, payload.filePath, true);
        }
      });
    }
    return () => {
      window.removeEventListener('drop', onDropCapture, true);
      unsubElectronOpen?.();
    };
  }, []);

  const replaySeedParticipants = useMemo(() => {
    const byId = new Map<string, { userId: string; displayName?: string | null; avatarUrl?: string | null }>();
    for (const m of offlineMembers) {
      byId.set(m.userId, { userId: m.userId, displayName: m.displayName });
    }
    for (const m of members) {
      byId.set(m.userId, { userId: m.userId, displayName: m.displayName, avatarUrl: m.avatarUrl ?? null });
    }
    if (user?.id) {
      byId.set(user.id, {
        userId: user.id,
        displayName: user.displayName || user.username,
        avatarUrl: user.avatarUrl ?? null,
      });
    }
    return Array.from(byId.values());
  }, [offlineMembers, members, user]);

  // If gateway is active, render ConnectionGateway first.
  if (showGateway) {
    return (
      <>
        <input
          ref={luminaInputRef}
          type="file"
          accept=".lumina"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void handleLoadLuminaData(file, (file as any).path);
          }}
        />
        <ConnectionGateway
          thumbnails={canvasThumbs}
          focusOnOpen={returningToGateway.current}
          onResolve={handleGatewayResolve}
          initialServerUrl={ApiService.getServerUrl()}
          onOpenLuminaProject={handleOpenLuminaProject}
          onOpenAuth={(serverUrl) => {
            reconnectServer(serverUrl);
            setIsAuthModalOpen(true);
          }}
        />
        <AuthModal
          isOpen={isAuthModalOpen}
          onClose={() => setIsAuthModalOpen(false)}
        />
      </>
    );
  }

  const canvasTabs = (
    <CanvasTabsBar
      key="canvas-tabs"
      canvases={canvases}
      activeCanvasId={activeCanvasId}
      thumbnails={canvasThumbs}
      expanded={tabsExpanded}
      placement={tabsPlacement}
      onMove={moveCanvasTabs}
      onToggleExpanded={toggleTabsExpanded}
      onSelectCanvas={(id) => joinCanvas(id)}
      onOpenCreateModal={() => setIsCreateModalOpen(true)}
      onRenameCanvas={handleRenameCanvas}
      onRequestDeleteCanvas={(canvas) => setCanvasToDelete(canvas)}
      isOfflineMode={OfflineSessionStore.isOfflineMode()}
      onCloseCanvas={(canvas) => void handleCloseOfflineCanvas(canvas)}
    />
  );

  return (
    <div
      className="atelier-app flex h-screen h-dvh w-screen flex-col overflow-hidden font-sans"
      style={{
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
    >
      <input
        ref={luminaInputRef}
        type="file"
        accept=".lumina"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void handleLoadLuminaData(file, (file as any).path);
        }}
      />
      {projectStatusMsg && (
        <div
          role="status"
          className="fixed bottom-12 left-1/2 z-[90] -translate-x-1/2 rounded-xl border border-cyan-500/40 bg-neutral-900/95 px-4 py-2 text-xs font-semibold text-cyan-200 shadow-2xl"
        >
          {projectStatusMsg}
        </div>
      )}
      {(v3Activity.activeBridgeRuns > 0 || v3Activity.mcpServerRunning) && (
        <div
          role="status"
          data-plugin-v3-active-banner="true"
          className="atelier-plugin-sweep fixed bottom-28 left-1/2 z-[91] flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-2.5 rounded-xl border border-amber-500/50 bg-neutral-900/95 px-3 py-1.5 text-xs text-amber-100 shadow-2xl"
        >
          <span className="truncate font-medium">
            {getPluginLabels(language).v3ActiveBanner}
            {v3Activity.mcpServerRunning ? ' · MCP' : ''}
            {v3Activity.activeBridgeRuns > 0 ? ` (${v3Activity.activeBridgeRuns})` : ''}
          </span>
          <button
            type="button"
            data-plugin-v3-banner-kill="true"
            onClick={() => {
              void killAllPluginV3Bridges().then(() => showProjectToast(getPluginLabels(language).v3KillAllDone));
            }}
            className="atelier-btn !h-6 shrink-0 border-rose-500/50 bg-rose-600/25 !px-2 text-[11px] text-rose-200 hover:bg-rose-600/40"
          >
            {getPluginLabels(language).v3KillAll}
          </button>
        </div>
      )}
      {slowPluginCommand && (
        <div
          role="status"
          className="atelier-plugin-sweep fixed bottom-20 left-1/2 z-[91] flex -translate-x-1/2 items-center gap-3 rounded-xl border border-cyan-500/50 bg-neutral-900/95 px-3.5 py-2 text-xs text-cyan-100 shadow-2xl"
        >
          <span className="truncate font-medium">
            {slowPluginCommand} · {getPluginLabels(language).working}
          </span>
          <button
            type="button"
            onClick={() => pluginCmdAbortRef.current?.abort()}
            className="atelier-btn !h-6 border-rose-500/50 bg-rose-600/25 !px-2 text-[11px] text-rose-200 hover:bg-rose-600/40"
          >
            {getPluginLabels(language).abort}
          </button>
        </div>
      )}
      {!canvasFullscreen && (
        <TopNavbar
          currentCanvas={currentCanvas}
          plugins={plugins}
          openPluginPanels={openPluginPanels}
          activePluginToolKey={activePluginToolKey}
          onManagePlugins={() => setIsPluginManagerOpen(true)}
          onRunPlugin={(pluginId, commandId) => void handleRunPlugin(pluginId, commandId)}
          onTogglePluginPanel={handleTogglePluginPanel}
          onSelectPluginTool={handleSelectPluginTool}
          onOpenCreateCanvas={() => setIsCreateModalOpen(true)}
          onOpenProject={handleOpenLuminaProject}
          onSaveProject={() => void handleSaveLuminaProject(false)}
          onSaveProjectAs={() => void handleSaveLuminaProject(true)}
          onShowStorage={() => void readStorageInfo()}
          onOpenAuth={() => setIsAuthModalOpen(true)}
          onOpenProfile={() => setIsProfileModalOpen(true)}
          onOpenReplay={() => setIsReplayModalOpen(true)}
          onOpenExport={() => setIsExportModalOpen(true)}
          onOpenCapsule={() => setIsCapsuleModalOpen(true)}
          onOpenServer={() => setIsServerModalOpen(true)}
          onOpenGateway={openGateway}
          onOpenSettings={(tab?: string) => { setSettingsTab(tab); setIsSettingsModalOpen(true); }}
          onOpenHelp={(query) => { setHelpQuery(query ?? ''); setIsHelpOpen(true); }}
          onOpenAdmin={() => setIsAdminDashboardOpen(true)}
          onOpenChat={() => setIsChatOpen(true)}
          hasUnreadChat={!isChatOpen && latestIncomingChatId !== null && latestIncomingChatId !== lastReadChatId}
          onOpenResize={() => setResizeRequest((n) => n + 1)}
          onImportImages={(files) => setImportImagesRequest((prev) => ({ files, id: (prev?.id ?? 0) + 1 }))}
        />
      )}

      {!canvasFullscreen && tabsPlacement === 'top' && canvasTabs}
      <div key="canvas-workspace" data-canvas-workspace="" className="relative flex min-h-0 flex-1 overflow-hidden">
        {roomLocked ? (
          <div className="atelier-workspace flex flex-1 items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-sm text-neutral-400">
              <span className="text-4xl" aria-hidden>🔒</span>
              <span>{checkingMembership ? '正在確認房間權限…' : '這是密碼房，輸入密碼後即可進入'}</span>
              {!checkingMembership && promptHiddenFor === currentCanvas?.id && (
                <button type="button" onClick={() => setPromptHiddenFor(null)}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500">
                  輸入房間密碼
                </button>
              )}
            </div>
          </div>
        ) : (
          <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-neutral-400">載入畫布中…</div>}>
            <CanvasWorkspace
              folderAccess={folderAccess}
              canvas={currentCanvas}
              activeLayer={activeLayer}
              layers={layers}
              layersLoaded={settledLayerListId === currentCanvas?.id}
              onCanvasResized={handleCanvasResized}
              onCanvasThumbnail={handleCanvasThumbnail}
              resizeRequest={resizeRequest}
              importImagesRequest={importImagesRequest}
              onRequestCreateMyLayer={() => setIsCreateMyLayerModalOpen(true)}
              onSelectLayer={(id) => setActiveLayerId(id)}
              onCreateLayer={handleCreateLayer}
              onToggleLock={handleToggleLock}
              onToggleVisibility={handleToggleVisibility}
              onDeleteLayer={handleDeleteLayer}
              onReleaseLayer={handleReleaseLayer}
              onClaimLayer={handleClaimLayer}
              onReorderLayer={handleReorderLayer}
              onUpdateLayerProps={handleUpdateLayerProps}
              onTransferLayer={handleTransferLayer}
              roomMembers={members}
              onOpenChat={() => setIsChatOpen(true)}
              onOpenAuth={() => setIsAuthModalOpen(true)}
              onQuickEnterCanvas={async () => {
                if (canvases.length > 0) {
                  joinCanvas(canvases[0].id);
                  return;
                }
                try {
                  const list = await ApiService.listCanvases();
                  if (list.length > 0) {
                    setCanvases(list);
                    joinCanvas(list[0].id);
                  } else if (isGuest) {
                    setIsAuthModalOpen(true);
                  } else {
                    const res = await ApiService.createCanvas({
                      title: '🎨 流光畫室 1',
                      width: 2048,
                      height: 2048,
                    });
                    setCanvases([res.canvas]);
                    joinCanvas(res.canvas.id);
                  }
                } catch (err: any) {
                  console.error('Quick enter error:', err);
                  setIsCreateModalOpen(true);
                }
              }}
              onQuickCreateCanvas={() => setIsCreateModalOpen(true)}
              onRegisterGetLayerCanvases={registerProjectAccess}
              onRegisterPluginAccess={registerPluginAccess}
              onActivePluginToolChange={setActivePluginToolKey}
              onRegisterBakeScreentone={(fn) => {
                bakeScreentoneRef.current = fn;
              }}
              onRegisterRecordLayerCreation={registerRecordLayerCreation}
            />
            </Suspense>
        )}
      </div>

      {!canvasFullscreen && tabsPlacement === 'bottom' && canvasTabs}

      {currentCanvas && roomLocked && !checkingMembership && promptHiddenFor !== currentCanvas.id && (
        <RoomPasswordModal
          key={currentCanvas.id}
          canvasTitle={currentCanvas.title}
          error={serverRefused && roomAccessError?.code === 'PASSWORD_INVALID' ? roomAccessError.message : null}
          isGuest={isGuest}
          onSubmit={handleUnlockRoom}
          onChooseAnother={() => {
            setPromptHiddenFor(currentCanvas.id);
            if (!tabsExpanded) toggleTabsExpanded();
          }}
          onLogin={() => setIsAuthModalOpen(true)}
        />
      )}

      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
      />

      <CreateCanvasModal
        isOpen={isCreateModalOpen}
        groups={OfflineSessionStore.isOfflineMode() ? undefined : canvases.flatMap((canvas) => canvas.group && canvas.group.ownerId === user?.id ? [canvas.group] : [])}
        initialGroupId={currentCanvas?.group?.ownerId === user?.id ? currentCanvas?.group?.id : undefined}
        defaultTitle={getNextCanvasTitle(currentCanvas?.title || (canvases.length > 0 ? canvases[canvases.length - 1].title : '畫布 1'))}
        onClose={() => setIsCreateModalOpen(false)}
        onCreate={handleCreateCanvas}
      />

      {storageInfo && currentCanvas && (
        <AtelierModal title={t.navbar.projectStorage} width="md" onClose={() => setStorageInfo(null)}>
          <dl className="space-y-4">
            <div>
              <dt className="font-semibold text-neutral-200">{t.navbar.autosaveLocation}</dt>
              <dd className="mt-1 text-neutral-300">
                {OfflineSessionStore.isOfflineCanvas(currentCanvas.id) ? t.navbar.offlineAutosave : t.navbar.serverAutosave}
              </dd>
              <dd className="mt-1 break-all font-mono text-indigo-200 select-text">
                {OfflineSessionStore.isOfflineCanvas(currentCanvas.id) ? storageInfo.desktopFolder : ApiService.getServerOrigin()}
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-neutral-200">{t.navbar.projectFileLocation}</dt>
              <dd className="mt-1 break-all text-neutral-300 select-text">
                {OfflineSessionStore.getCanvasFilePath(currentCanvas.id) || t.navbar.projectFileNotChosen}
              </dd>
              {!ApiService.isDesktopEnv() && <dd className="mt-1 text-neutral-400">{t.navbar.browserSaveLocation}</dd>}
            </div>
          </dl>
        </AtelierModal>
      )}

      <DeleteCanvasConfirmModal
        isOpen={Boolean(canvasToDelete)}
        canvas={canvasToDelete}
        onClose={() => setCanvasToDelete(null)}
        onConfirm={handleDeleteCanvas}
      />

      <OverlayPresence open={isReplayModalOpen}>
        <Suspense fallback={null}>
          <TimeLapseModal
            isOpen
            onClose={() => setIsReplayModalOpen(false)}
            canvas={currentCanvas}
            layers={layers}
            seedParticipants={replaySeedParticipants}
          />
            </Suspense>
      </OverlayPresence>

      {isExportModalOpen && (
        <Suspense fallback={null}>
          <ExportModal
            isOpen={isExportModalOpen}
            onClose={() => setIsExportModalOpen(false)}
            canvas={currentCanvas}
            layers={layers}
            getLayerCanvases={handleGetLayerCanvases}
          />
            </Suspense>
      )}

      {isServerModalOpen && (
        <Suspense fallback={null}>
          <ServerModal
            isOpen={isServerModalOpen}
            onClose={() => setIsServerModalOpen(false)}
            onOpenGateway={openGateway}
            canvasId={currentCanvas?.id}
          />
            </Suspense>
      )}

      <OverlayPresence open={isHelpOpen}>
        <Suspense fallback={null}>
          <HelpCenter onClose={() => { setIsHelpOpen(false); setHelpQuery(''); }} initialQuery={helpQuery}
            onOpenShortcutSettings={() => { setIsHelpOpen(false); setSettingsTab('shortcuts'); setIsSettingsModalOpen(true); }} />
        </Suspense>
      </OverlayPresence>

      <OverlayPresence open={isPluginManagerOpen}>
        <Suspense fallback={null}>
          <PluginManager
            plugins={plugins}
            isCollaborativeRoom={Boolean(currentCanvas?.id && !OfflineSessionStore.isOfflineCanvas(currentCanvas.id))}
            onOpenV3Console={() => {
              setIsPluginManagerOpen(false);
              setIsPluginV3ConsoleOpen(true);
            }}
            onClose={() => setIsPluginManagerOpen(false)}
          />
        </Suspense>
      </OverlayPresence>

      <OverlayPresence open={isPluginV3ConsoleOpen}>
        <Suspense fallback={null}>
          <PluginV3BridgeModal
            isCollaborativeRoom={Boolean(currentCanvas?.id && !OfflineSessionStore.isOfflineCanvas(currentCanvas.id))}
            onNotice={(msg) => showProjectToast(msg)}
            onClose={() => setIsPluginV3ConsoleOpen(false)}
          />
        </Suspense>
      </OverlayPresence>

      <OverlayPresence open={v3ConsentQueue.length > 0}>
        <Suspense fallback={null}>
          {v3ConsentQueue[0] && (
            <PluginV3ConsentModal
              request={v3ConsentQueue[0].request}
              onResolve={(decision) => {
                const current = v3ConsentQueue[0];
                setV3ConsentQueue((prev) => prev.slice(1));
                current?.resolve(decision);
              }}
            />
          )}
        </Suspense>
      </OverlayPresence>

      {currentCanvas && !roomLocked && (() => {
        const currentMemberRaw = members.find((m) => m.userId === user?.id);
        const roleRaw = currentMemberRaw
          ? ('canvasRole' in currentMemberRaw && currentMemberRaw.canvasRole
              ? currentMemberRaw.canvasRole
              : 'role' in currentMemberRaw
                ? currentMemberRaw.role
                : undefined)
          : undefined;
        const validRole: CanvasMemberModel['role'] | undefined =
          roleRaw === 'owner' || roleRaw === 'admin' || roleRaw === 'editor' || roleRaw === 'viewer'
            ? roleRaw
            : undefined;
        const currentCanvasMember: CanvasMemberModel | null = validRole && user
          ? {
              canvasId: currentCanvas.id,
              userId: user.id,
              role: validRole,
              ...getCanvasRoleCapabilities(validRole),
              joinedAt: 0,
            }
          : null;
        const panelEntries = plugins.flatMap(({ manifest, enabled }) => {
          if (!enabled || !isModernPluginManifest(manifest) || !manifest.permissions.includes('ui:panel')) return [];
          return manifest.panels.map((panel) => ({
            key: `${manifest.id}:${panel.id}`,
            plugin: manifest,
            panel,
          }));
        });
        return panelEntries.map(({ key, plugin, panel }) => {
          const openIdx = openPluginPanels.indexOf(key);
          const isOpen = openIdx !== -1;
          return (
            <OverlayPresence key={key} open={isOpen}>
              <Suspense fallback={null}>
                <PluginPanelWindow
                  plugin={plugin}
                  panel={panel}
                  layers={layers}
                  activeLayerId={activeLayerId}
                  user={user}
                  isGuest={isGuest}
                  canvasMember={currentCanvasMember}
                  stackIndex={Math.max(0, openIdx)}
                  onExecute={(actionId, vals, opts) => handlePluginPanelAction(plugin, panel.id, actionId, vals, opts)}
                  onNotice={showProjectToast}
                  onClose={() => setOpenPluginPanels((prev) => prev.filter((k) => k !== key))}
                />
              </Suspense>
            </OverlayPresence>
          );
        });
      })()}
      <OverlayPresence open={isSettingsModalOpen}>
        <Suspense fallback={null}>
          <SettingsModal
            isOpen
            initialTab={settingsTab}
            onClose={() => setIsSettingsModalOpen(false)}
          />
            </Suspense>
      </OverlayPresence>

      <OverlayPresence open={isProfileModalOpen}>
        <Suspense fallback={null}>
          <UserProfileModal
            isOpen
            onClose={() => setIsProfileModalOpen(false)}
          />
            </Suspense>
      </OverlayPresence>

      <CreateMyLayerModal
        isOpen={isCreateMyLayerModalOpen}
        onClose={() => setIsCreateMyLayerModalOpen(false)}
        onCreateLayer={async (name, blendMode, layerType) => {
          const created = await handleCreateLayer(name, blendMode, layerType);
          if (created) recordLayerCreationRef.current?.(created);
          return created;
        }}
      />

      <OverlayPresence open={isCapsuleModalOpen}>
        <Suspense fallback={null}>
          <TimeCapsuleModal
            isOpen
            onClose={() => setIsCapsuleModalOpen(false)}
            canvas={currentCanvas}
            layers={layers}
            getLayerCanvases={projectAccessRef.current?.readLayers ?? null}
            onRestoreCanvas={async (content, onProgress, preserveAuthors) => {
              if (isGuest) throw new Error('請先登入帳號：還原會建立一張新畫布。');
              const { TimeCapsuleEngine } = await import('./engine/TimeCapsuleEngine');
              const restored = await TimeCapsuleEngine.restoreToNewCanvas(content, onProgress, preserveAuthors);
              setCanvases((prev) => [...prev.filter((c) => c.id !== restored.id), restored]);
              joinCanvas(restored.id);
            }}
          />
            </Suspense>
      </OverlayPresence>

      <LiveChatDrawer isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} />

      {isAdminDashboardOpen && (
        <Suspense fallback={null}>
          <AdminDashboardModal
            isOpen={isAdminDashboardOpen}
            onClose={() => setIsAdminDashboardOpen(false)}
          />
            </Suspense>
      )}
    </div>
  );
};
