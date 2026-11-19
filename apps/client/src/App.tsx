import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BlendMode, CanvasModel, CanvasUnit, CreateCanvasDto, LayerMeta, LayerModel, LayerType, clampDpi } from '@atelier/shared';
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
import { getPluginLabels } from './plugins/pluginLabels';
import { ConnectionGateway, InitialCanvasOptions } from './components/ConnectionGateway';
import { DeleteCanvasConfirmModal } from './components/DeleteCanvasConfirmModal';
import { LiveChatDrawer } from './components/LiveChatDrawer';
import { OverlayPresence } from './components/OverlayPresence';
import { CreateMyLayerModal } from './components/CreateMyLayerModal';
import { RoomPasswordModal } from './components/RoomPasswordModal';
import { getNextCanvasTitle } from './utils/canvasName';
import { sharedRoomFromLocation } from './utils/serverLinks';
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

const EMPTY_LAYERS: LayerModel[] = [];

/** A painter has a layer of their own here (a new canvas's locked, shared background does not count) */
const ownsDrawableLayer = (list: LayerModel[], userId: string) =>
  list.some((l) => l.ownerId === userId && l.layerType !== 'group' && l.layerType !== 'mask' && !(l.isLocked && l.aclMode === 'shared_all'));
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
  const [isPluginManagerOpen, setIsPluginManagerOpen] = useState(false);
  const pluginAccessRef = useRef<CanvasPluginAccess | null>(null);
  const registerPluginAccess = useCallback((access: CanvasPluginAccess | null) => {
    pluginAccessRef.current = access;
  }, []);
  const runningPlugin = useRef(false);
  const { isGuest, user, isLoading: authLoading } = useAuth();
  const {
    activeCanvasId,
    joinCanvas,
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
  // The mode picker is only reachable where solo mode is allowed (local app or a localhost page).
  // Without it, the logo, the 切換模式 menu item and the ServerModal button are not rendered.
  const openGateway = OfflineSessionStore.canUseOfflineMode() ? () => {
    if (importingLumina.current) return;
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

  // Load all available canvases on boot or user change
  const fetchCanvases = async () => {
    const origin = ApiService.getServerOrigin();
    const offline = OfflineSessionStore.isOfflineMode();
    const sameTarget = () => origin === ApiService.getServerOrigin() && offline === OfflineSessionStore.isOfflineMode();
    try {
      const list = await ApiService.listCanvases();
      if (!sameTarget()) return;
      setCanvases(list);

      // The socket starts in the linked room. Fall back to the last canvas if the room is gone.
      if (list.length > 0) {
        const savedCanvasId = typeof window !== 'undefined' ? localStorage.getItem('atelier_active_canvas_id') : null;
        const targetId = list.find((c) => c.id === activeCanvasId)?.id
          ?? list.find((c) => c.id === savedCanvasId)?.id
          ?? list[0].id;
        joinCanvas(targetId);
      } else if (!isGuest) {
        try {
          const res = await ApiService.createCanvas({
            title: '🎨 流光畫室 1',
            width: 2048,
            height: 2048,
          });
          if (!sameTarget()) return;
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
    if ((targetServerUrl === 'offline' || canvasOptions?.offline) && OfflineSessionStore.canUseOfflineMode()) {
      OfflineSessionStore.setSessionMode('offline');
      reconnectServer('offline');
      setShowGateway(false);
      try {
        if (canvasOptions?.title) {
          const res = await OfflineSessionStore.createCanvas({
            title: canvasOptions.title,
            width: canvasOptions.width || 2048,
            height: canvasOptions.height || 2048,
          });
          setCanvases(await OfflineSessionStore.listCanvases());
          joinCanvas(res.canvas.id);
          return;
        }
        const list = await OfflineSessionStore.listCanvases();
        setCanvases(list);
        const chosen = list.find((entry) => entry.id === canvasOptions?.canvasId) ?? list[0];
        if (chosen) joinCanvas(chosen.id);
      } catch (err) {
        console.error('Failed to initialize offline canvas:', err);
      }
      return;
    }

    const previous = ApiService.getServerOrigin();
    reconnectServer(targetServerUrl);
    const origin = ApiService.getServerOrigin();
    if (origin !== previous) {
      setCanvases([]);
      if (!canvasOptions?.title) pendingServerLogin.current = origin;
    }
    setShowGateway(false);
    // Transition and fetch canvases from target server
    setTimeout(async () => {
      const opts = canvasOptions;
      if (origin !== ApiService.getServerOrigin() || OfflineSessionStore.isOfflineMode()) return;
      try {
        if (opts?.openLogin) setIsAuthModalOpen(true);
        if (opts?.canvasId) {
          const list = await ApiService.listCanvases();
          if (origin !== ApiService.getServerOrigin()) return;
          setCanvases(list);
          if (list.some((c) => c.id === opts.canvasId)) {
            joinCanvas(opts.canvasId);
            return;
          }
        } else if (opts?.title) {
          // 建立新房間 / 建立畫布組房間 is explicit now (the name starts empty), so it always makes a new room and promotes the creator to room owner/admin
          const list = await ApiService.listCanvases();
          if (origin !== ApiService.getServerOrigin()) return;
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
          if (origin !== ApiService.getServerOrigin()) return;
          setCanvases([...list, res.canvas]);
          joinCanvas(res.canvas.id);
          return;
        }
      } catch (err: any) {
        if (opts?.title) alert(err?.message || '建立房間失敗');
      }
      if (origin === ApiService.getServerOrigin() && !authLoading) fetchCanvases();
    }, 150);
  };

  useEffect(() => {
    if (!showGateway && !authLoading) {
      fetchCanvases();
    }
  }, [user?.id, showGateway, authLoading]);

  // Ensure valid canvas is auto-selected when canvases load
  useEffect(() => {
    if (canvases.length > 0 && !canvases.some((c) => c.id === activeCanvasId)) {
      const savedCanvasId = typeof window !== 'undefined' ? localStorage.getItem('atelier_active_canvas_id') : null;
      joinCanvas(canvases.find((c) => c.id === savedCanvasId)?.id ?? canvases[0].id);
    }
  }, [canvases, activeCanvasId]);

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

      const localLastLayerId = !isGuest && user?.id ? ApiService.getLastDrawnLayerId(canvasId, user.id) : null;
      const hintLayerId = [localLastLayerId, serverLastLayerId].find((id) =>
        Boolean(id && res.some((l) => l.id === id && l.layerType !== 'group' && !l.isLocked))
      ) ?? null;

      const tryKey = `${canvasId}:${user?.id}`;
      if (autoAssign && res.length > 0 && !isGuest && user && !hintLayerId && !autoLayerTriedRef.current.has(tryKey) && !ownsDrawableLayer(res, user.id)) {
        autoLayerTriedRef.current.add(tryKey);
        try {
          const mine = await ApiService.createLayer(canvasId, {
            name: `${user.displayName || user.username} 的圖層`,
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

        // Priority 3: Jump to the user's last-drawn layer, or own UNLOCKED layer, or public unlocked layer
        const topFirst = [...res].reverse().filter((layer) => layer.layerType !== 'group' && layer.layerType !== 'mask');
        const lastDrawnLayer = hintLayerId ? res.find((l) => l.id === hintLayerId) : undefined;
        const myUnlockedLayer = topFirst.find((l) => l.ownerId === user?.id && !l.isLocked);
        const publicUnlockedLayer = topFirst.find((l) => (l.isPublic || l.aclMode === 'shared_all' || !l.ownerId) && !l.isLocked);
        const topUnlocked = topFirst.find((l) => !l.isLocked);
        const targetLayer = lastDrawnLayer || myUnlockedLayer || publicUnlockedLayer || topUnlocked || topFirst[0];
        setActiveLayerId(targetLayer?.id ?? null);
      } else if (!isGuest) {
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
    const userChanged = lastLayerUserIdRef.current !== user?.id;
    lastLayerUserIdRef.current = user?.id;
    // A locked room's layers are refused until it is unlocked; this runs again then
    if (activeCanvasId && !roomLocked) {
      fetchLayers(activeCanvasId, null, () => cancelled, true, userChanged);
    }
    return () => { cancelled = true; };
  }, [activeCanvasId, user?.id, roomLocked]);

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
      await ApiService.deleteCanvas(canvasId);
      const remaining = canvases.filter((c) => c.id !== canvasId);
      setCanvases(remaining);
      if (activeCanvasId === canvasId && remaining.length > 0) {
        joinCanvas(remaining[0].id);
      }
    } catch (err: any) {
      alert(err.message || '無法刪除畫布');
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

  const handleRunPlugin = async (pluginId: string, commandId: string) => {
    const strings = getPluginLabels(language);
    if (runningPlugin.current) return showProjectToast(strings.working);
    const plugin = getPlugins().find(({ manifest, enabled }) => enabled && manifest.id === pluginId)?.manifest;
    if (!plugin?.commands.some(command => command.id === commandId)) return;
    const canvasId = currentCanvas?.id;
    if (!currentCanvas || roomLocked || pluginAccessRef.current?.canvasId !== canvasId) return showProjectToast(strings.needed);
    runningPlugin.current = true;
    try {
      const { runPlugin } = await import('./plugins/runPlugin');
      const action = await runPlugin(plugin, commandId, {
        width: currentCanvas.width, height: currentCanvas.height, dpi: clampDpi(currentCanvas.dpi ?? 300),
      });
      if (!getPlugins().some(entry => entry.enabled && entry.manifest === plugin)) return;
      const access = pluginAccessRef.current;
      if (canvasIdRef.current !== canvasId || !access || access.canvasId !== canvasId) return;
      if (action.kind === 'message') return showProjectToast(action.text);
      if (!await access.apply(action)) return showProjectToast(strings.failed);
      showProjectToast(`${plugin.name} · ${strings.done}`);
    } catch (error) {
      showProjectToast(`${strings.failed} ${error instanceof Error ? error.message : ''}`);
    } finally {
      runningPlugin.current = false;
    }
  };

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
    const target = layers.find((l) => l.id === layerId);
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
      const active = layers.find((l) => l.id === activeLayerId);
      if (!active || isGone(active)) {
        // The layer right below what went, else the top one
        const left = layers.filter((l) => !isGone(l) && l.layerType !== 'mask').sort((a, b) => b.sortOrder - a.sortOrder);
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
          OfflineSessionStore.setSessionMode('offline');
          reconnectServer('offline');
        }
        const group = currentCanvas?.group;
        const restored = await LuminaProjectEngine.restoreToCanvas(unpacked, undefined, {
          shareEditableLayers: collaborative,
          groupId: collaborative && group?.ownerId === user?.id ? group?.id : undefined,
        });
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
      <TopNavbar
        currentCanvas={currentCanvas}
        plugins={plugins}
        onManagePlugins={() => setIsPluginManagerOpen(true)}
        onRunPlugin={(pluginId, commandId) => void handleRunPlugin(pluginId, commandId)}
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
        onOpenHelp={() => setIsHelpOpen(true)}
        onOpenAdmin={() => setIsAdminDashboardOpen(true)}
        onOpenChat={() => setIsChatOpen(true)}
        hasUnreadChat={!isChatOpen && latestIncomingChatId !== null && latestIncomingChatId !== lastReadChatId}
        onOpenResize={() => setResizeRequest((n) => n + 1)}
        onImportImages={(files) => setImportImagesRequest((prev) => ({ files, id: (prev?.id ?? 0) + 1 }))}
      />

      {tabsPlacement === 'top' && canvasTabs}
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
              onRegisterBakeScreentone={(fn) => {
                bakeScreentoneRef.current = fn;
              }}
            />
            </Suspense>
        )}
      </div>

      {tabsPlacement === 'bottom' && canvasTabs}

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
          <HelpCenter onClose={() => setIsHelpOpen(false)}
            onOpenShortcutSettings={() => { setIsHelpOpen(false); setSettingsTab('shortcuts'); setIsSettingsModalOpen(true); }} />
        </Suspense>
      </OverlayPresence>

      <OverlayPresence open={isPluginManagerOpen}>
        <Suspense fallback={null}>
          <PluginManager plugins={plugins} onClose={() => setIsPluginManagerOpen(false)} />
        </Suspense>
      </OverlayPresence>
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
        onCreateLayer={handleCreateLayer}
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
