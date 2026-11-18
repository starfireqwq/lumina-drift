import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  Check, ChevronDown, ChevronRight, Cloud, Copy, DoorOpen, Eye, EyeOff, Folder, FolderOpen, Globe, Lock, LogIn, Palette, Plus, QrCode as QrIcon, RefreshCw, Search,
} from 'lucide-react';
import type { CanvasModel } from '@atelier/shared';
import { ApiService } from '../services/api';
import { OfflineSessionStore } from '../services/offlineStore';
import { useAuth } from '../context/AuthContext';
import { PRESETS } from './ResizeCanvasModal';
import { useI18n } from '../context/I18nContext';
import { useCloudflareTunnel } from '../context/useCloudflareTunnel';
import { isLoopbackServer, parseServerLink, publicServerOrigin } from '../utils/serverLinks';
import { RESIZE_MAX, RESIZE_MIN } from '../utils/canvasResize';
import {
  buildCanvasGroupEntries,
  loadCollapsedCanvasGroups,
  saveCollapsedCanvasGroups,
  toggleCollapsedCanvasGroup,
} from '../utils/canvasGroups';

export interface NetworkAddressItem {
  name: string;
  address: string;
  type: 'lan' | 'tailscale' | 'local';
}

/** What the visitor chose on the gateway: a room to open, or a new room to create */
export interface InitialCanvasOptions {
  canvasId?: string;
  title?: string;
  password?: string;
  width?: number;
  height?: number;
  /** Guest wants to create a room: open the sign-in dialog after entering */
  openLogin?: boolean;
  offline?: boolean;
}

interface ConnectionGatewayProps {
  thumbnails?: Record<string, string>;
  onResolve: (targetServerUrl: string, nickname?: string, canvasOptions?: InitialCanvasOptions) => void;
  initialServerUrl?: string;
  onOpenLuminaProject?: () => void;
  onOpenAuth?: (serverUrl: string) => void;
  focusOnOpen?: boolean;
}

type Where = 'here' | 'lan' | 'internet';

/**
 * The first page: pick a room to join or create a new one. Where the server is (this one, the
 * LAN, the internet) is an advanced setting most people never touch.
 */
export const ConnectionGateway: React.FC<ConnectionGatewayProps> = ({ onResolve, initialServerUrl = '', onOpenLuminaProject, onOpenAuth, focusOnOpen, thumbnails }) => {
  const { t } = useI18n();
  const { user, isGuest, setGuestDisplayName } = useAuth();
  const desktop = typeof window !== 'undefined' ? (window as any).atelierDesktop : null;
  const isDesktop = Boolean(desktop?.isElectron);
  const isAndroid = Boolean((window as any).atelierMobile?.isAndroid);
  const supportsOfflineMode = isDesktop || isAndroid;

  const workspaceIsLocal = !initialServerUrl || isLoopbackServer(initialServerUrl);
  const [gatewayMode, setGatewayMode] = useState<'offline' | 'online'>(() =>
    supportsOfflineMode && (OfflineSessionStore.isOfflineMode() || !initialServerUrl) ? 'offline' : 'online'
  );
  const [tab, setTab] = useState<'join' | 'create'>('join');
  const [nickname, setNickname] = useState(user?.displayName || '');
  const [remember, setRemember] = useState(true);
  const [recentCanvases, setRecentCanvases] = useState<CanvasModel[]>([]);
  const [offlineThumbnails, setOfflineThumbnails] = useState<Record<string, string>>({});

  useEffect(() => {
    if (gatewayMode !== 'offline') return;
    let active = true;
    void OfflineSessionStore.listRecentCanvases().then(async (list) => {
      if (!active) return;
      setRecentCanvases(list);
      for (const canvas of list) {
        if (!active) break;
        if (thumbnails?.[canvas.id]) {
          OfflineSessionStore.saveThumbnail(canvas.id, thumbnails[canvas.id]);
          continue;
        }
        const thumbnail = await OfflineSessionStore.getThumbnail(canvas.id);
        if (active && thumbnail) setOfflineThumbnails((prev) => ({ ...prev, [canvas.id]: thumbnail }));
      }
    }).catch((error) => console.warn('[Gateway] Failed to load offline canvases:', error));
    return () => { active = false; };
  }, [gatewayMode, thumbnails]);

  // Where the server is (advanced)
  const [where, setWhere] = useState<Where>(() => isAndroid ? 'internet' : !initialServerUrl || (workspaceIsLocal && isDesktop) ? 'here' : 'internet');
  const [addresses, setAddresses] = useState<NetworkAddressItem[]>([]);
  const [lanIp, setLanIp] = useState('');
  const [lanPort, setLanPort] = useState('3000');
  const [internetUrl, setInternetUrl] = useState(() => isDesktop && workspaceIsLocal ? '' : initialServerUrl);
  const { bridge: tunnelBridge, url: tunnelUrl, setUrl: setTunnelUrl, ready: tunnelReady } = useCloudflareTunnel(gatewayMode === 'online');
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  const [serverRunning, setServerRunning] = useState(true);
  const [roomsRefresh, setRoomsRefresh] = useState(0);
  const userChoseTabRef = useRef(false);
  const [ping, setPing] = useState<{ testing: boolean; ok: boolean | null; ms?: number; error?: string }>({ testing: false, ok: null });
  const pingRequest = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [qr, setQr] = useState('');

  // Rooms on that server
  const [rooms, setRooms] = useState<CanvasModel[] | null>(null);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [pickedRoom, setPickedRoom] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => loadCollapsedCanvasGroups());

  const handleToggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = toggleCollapsedCanvasGroup(prev, groupId);
      saveCollapsedCanvasGroups(next);
      return next;
    });
  };

  // New room
  const [title, setTitle] = useState('');
  const [preset, setPreset] = useState<number | 'custom'>(0);
  const [customWidth, setCustomWidth] = useState(String(PRESETS[0].w));
  const [customHeight, setCustomHeight] = useState(String(PRESETS[0].h));
  const size = preset === 'custom' ? { w: Number(customWidth), h: Number(customHeight) } : PRESETS[preset];
  const validDimension = (value: number) => Number.isInteger(value) && value >= RESIZE_MIN && value <= RESIZE_MAX;
  const validSize = validDimension(size.w) && validDimension(size.h);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (focusOnOpen) heading.current?.focus({ preventScroll: true });
  }, [focusOnOpen]);

  useEffect(() => {
    const load = async () => {
      try {
        const list: NetworkAddressItem[] = desktop?.server?.getNetworkAddresses
          ? await desktop.server.getNetworkAddresses()
          : (await ApiService.getServerNetwork()).addresses;
        setAddresses(list);
        const lan = list.find((a) => a.type !== 'local');
        if (lan) setLanIp((ip) => ip || lan.address);
      } catch {
        // no list: the address can still be typed in
      }
    };
    void load();
    if (isDesktop) {
      desktop.server.getStatus?.().then((s: any) => setServerRunning(Boolean(s?.isRunning))).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const here = isDesktop ? 'http://127.0.0.1:3000' : window.location.origin;
  const remoteLink = parseServerLink(internetUrl);
  const target = where === 'here' ? here : where === 'internet' ? remoteLink?.origin :
    lanIp.trim() ? parseServerLink(`http://${lanIp.trim()}:${lanPort.trim() || '3000'}`)?.origin : undefined;
  const connectionError = !target ? t.gateway.fillInternetUrlFirst : !isDesktop && !isAndroid && (
    (window.location.protocol === 'https:' && target.startsWith('http:')) ||
    (isLoopbackServer(target) && !isLoopbackServer(here))
  ) ? t.gateway.cannotConnectCheckSettings : null;
  const publicUrl = (target ? publicServerOrigin(target) : null) ??
    (target && isLoopbackServer(target) ? tunnelUrl : null);
  const shareUrl = connectionError ? undefined : publicUrl || target;
  const locationParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const invitedRoom = (where === 'internet' && remoteLink
    ? remoteLink.searchParams.get('room') || remoteLink.searchParams.get('canvas') || remoteLink.searchParams.get('canvasId')
    : null) || (!isDesktop && where === 'here' && locationParams
    ? locationParams.get('room') || locationParams.get('canvas') || locationParams.get('canvasId')
    : null);

  const resetPing = () => {
    pingRequest.current += 1;
    setPing({ testing: false, ok: null });
  };
  const chooseWhere = (next: Where) => {
    if (next === where) return;
    resetPing();
    setWhere(next);
  };

  const handlePasteOrTypeRemoteLink = (rawInput: string) => {
    setInternetUrl(rawInput);
    resetPing();
    setWhere('internet');
  };

  // The room list follows the chosen server
  useEffect(() => {
    if (gatewayMode === 'offline') return;
    setRooms(null);
    setRoomsError(connectionError);
    if (!target || connectionError) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        if (isDesktop && where === 'here' && desktop?.server?.start) {
          const status = await desktop.server.getStatus?.().catch(() => null);
          if (!status?.isRunning) {
            const started = await desktop.server.start().catch(() => false);
            if (!controller.signal.aborted) setServerRunning(Boolean(started));
          }
        }
        let res = await fetch(`${target}/api/canvases`, { signal: controller.signal });
        if (!res.ok && isDesktop && where === 'here') {
          await new Promise((r) => setTimeout(r, 350));
          res = await fetch(`${target}/api/canvases`, { signal: controller.signal });
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { canvases: CanvasModel[] };
        if (controller.signal.aborted) return;
        setRooms(data.canvases);
        if (invitedRoom) setTab('join');
        else if (data.canvases.length === 0) setTab('create');
        else if (!userChoseTabRef.current) setTab('join');
        setPickedRoom((current) => {
          if (invitedRoom) return data.canvases.some((c) => c.id === invitedRoom) ? invitedRoom : null;
          return data.canvases.some((c) => c.id === current) ? current : data.canvases[0]?.id ?? null;
        });
      } catch {
        if (!controller.signal.aborted) setRoomsError(t.gateway.cannotConnectCheckSettings);
      }
    }, 120);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [target, connectionError, invitedRoom, gatewayMode, isDesktop, where, desktop, t.gateway.cannotConnectCheckSettings, roomsRefresh]);

  useEffect(() => {
    setQr('');
    if (!showQr || !shareUrl) return;
    let active = true;
    QRCode.toDataURL(shareUrl, { margin: 1, width: 180 }).then((data) => {
      if (active) setQr(data);
    }).catch(() => {});
    return () => { active = false; };
  }, [showQr, shareUrl]);

  const testConnection = async () => {
    if (!target || connectionError) {
      setPing({ testing: false, ok: false, error: connectionError ?? t.gateway.connectionFailed });
      return;
    }
    const request = ++pingRequest.current;
    setPing({ testing: true, ok: null });
    const start = performance.now();
    const health = await ApiService.checkServerHealth(target);
    if (request !== pingRequest.current) return;
    const ok = health.ok && health.status === 'ok';
    setPing(ok ? { testing: false, ok: true, ms: Math.round(performance.now() - start) } : { testing: false, ok: false, error: health.error || t.gateway.connectionFailed });
    if (ok) setRoomsRefresh((n) => n + 1);
  };

  const toggleTunnel = async () => {
    if (!tunnelBridge || tunnelBusy) return;
    setTunnelBusy(true);
    setTunnelError(null);
    try {
      if (tunnelUrl) {
        if (await tunnelBridge.stopTunnel()) setTunnelUrl(null);
        else setTunnelError(t.gateway.tunnelStopFailed);
      } else {
        const result = await tunnelBridge.startTunnel();
        if (result.success && result.url) {
          if (!tunnelBridge.onTunnelStatus) setTunnelUrl(result.url);
          setServerRunning(true);
        } else setTunnelError(t.gateway.tunnelStartFailed);
      }
    } catch {
      setTunnelError(tunnelUrl ? t.gateway.tunnelStopFailed : t.gateway.tunnelStartFailed);
    } finally {
      setTunnelBusy(false);
    }
  };

  const toggleServer = async () => {
    if (!desktop?.server) return;
    if (serverRunning) {
      await desktop.server.stop();
      setServerRunning(false);
    } else {
      const started = Boolean(await desktop.server.start());
      setServerRunning(started);
      if (started) setRoomsRefresh((n) => n + 1);
    }
  };

  const filteredRooms = (rooms ?? []).filter((r) => `${r.group?.title ?? ''} ${r.title}`.toLowerCase().includes(query.trim().toLowerCase()));
  const roomEntries = buildCanvasGroupEntries(filteredRooms);
  const renderRoomButton = (r: CanvasModel, inGroup = false) => (
    <button key={r.id} type="button" role="radio" aria-checked={pickedRoom === r.id} onClick={() => setPickedRoom(r.id)}
      aria-label={`${r.title} (${r.width}×${r.height}${r.hasPassword ? ` · ${t.gateway.requiresPassword}` : ''})`}
      onDoubleClick={() => enter({ canvasId: r.id })}
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left ${pickedRoom === r.id ? 'border-indigo-400 bg-indigo-600/20' : 'border-transparent hover:bg-neutral-800'}`}>
      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${pickedRoom === r.id ? 'border-indigo-400 bg-indigo-500' : 'border-neutral-600'}`} aria-hidden="true">
        {pickedRoom === r.id && <Check className="h-3 w-3 text-white" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-white">{r.title}</span>
        {!inGroup && r.group && <span className="block truncate text-[10px] text-indigo-300">{r.group.title}</span>}
        <span className="block text-[11px] text-neutral-500">{r.width} × {r.height}</span>
      </span>
      {r.hasPassword && <span className="flex items-center gap-1 text-[11px] text-amber-300"><Lock className="h-3 w-3" />{t.gateway.requiresPassword}</span>}
    </button>
  );
  const picked = rooms?.find((r) => r.id === pickedRoom) ?? null;
  const canCreate = true;
  const ready = Boolean(target && !connectionError) && (tab === 'join' ? Boolean(picked) : validSize && Boolean(title.trim()) && (!usePassword || Boolean(password.trim())));

  const openAuth = () => {
    if (!target || connectionError) return;
    onOpenAuth?.(target);
  };

  const enter = (options: InitialCanvasOptions) => {
    if (!target || connectionError) return;
    if (remember) localStorage.setItem('atelier_gateway_resolved', 'true');
    else localStorage.removeItem('atelier_gateway_resolved');
    if (isGuest && nickname.trim() && nickname.trim() !== user?.displayName) setGuestDisplayName(nickname.trim());
    onResolve(target, nickname.trim() || undefined, options);
  };

  const startSoloOffline = (canvasId?: string) => {
    if (!canvasId && !validSize) return;
    if (remember) localStorage.setItem('atelier_gateway_resolved', 'true');
    else localStorage.removeItem('atelier_gateway_resolved');
    OfflineSessionStore.setSessionMode('offline');
    if (nickname.trim() && nickname.trim() !== user?.displayName) setGuestDisplayName(nickname.trim());
    onResolve('offline', nickname.trim() || undefined, canvasId ? { canvasId, offline: true } : {
      title: title.trim() || t.gateway.offlineDefaultCanvasName,
      width: size.w,
      height: size.h,
      offline: true,
    });
  };

  const canvasSizes = (hint: string, selectedStyle: string) => (
    <div className="space-y-1.5">
      <span className="text-xs font-semibold text-neutral-200">{t.canvas.newSize}</span>
      <div role="group" aria-label={t.canvas.newSize} className="flex flex-wrap gap-1.5">
        {PRESETS.map((item, index) => (
          <button key={item.label} type="button" aria-pressed={preset === index} onClick={() => setPreset(index)}
            className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${preset === index ? selectedStyle : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'}`}>
            {item.label}<span className="ml-1 text-neutral-300/80">{item.w}×{item.h}</span>
          </button>
        ))}
        <button type="button" aria-pressed={preset === 'custom'} onClick={() => setPreset('custom')}
          className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${preset === 'custom' ? selectedStyle : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'}`}>
          {t.canvas.customSize}
        </button>
      </div>
      {preset === 'custom' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            {([
              [t.canvas.width, customWidth, setCustomWidth],
              [t.canvas.height, customHeight, setCustomHeight],
            ] as const).map(([label, value, setValue]) => (
              <label key={label} className="grid gap-1 text-xs text-neutral-300">
                <span>{label} (px)</span>
                <input type="number" min={RESIZE_MIN} max={RESIZE_MAX} step={1} required value={value}
                  onChange={(event) => setValue(event.target.value)} aria-invalid={!validDimension(Number(value))}
                  className="atelier-field h-9 min-w-0 px-3 font-mono" />
              </label>
            ))}
          </div>
          <p className="text-[11px] text-neutral-400">{RESIZE_MIN}–{RESIZE_MAX} px</p>
        </>
      )}
      <p className="text-[11px] text-neutral-400">{hint}</p>
    </div>
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (gatewayMode === 'offline') {
      startSoloOffline();
      return;
    }
    if (!ready) return;
    if (tab === 'join' && picked) enter({ canvasId: picked.id });
    else if (tab === 'create' && canCreate) {
      enter({ title: title.trim(), width: size.w, height: size.h, password: usePassword ? password.trim() : undefined });
    }
  };

  const switchToOnlineMode = () => {
    userChoseTabRef.current = false;
    setTab('join');
    if (isDesktop && where === 'internet' && !remoteLink) setWhere('here');
    setGatewayMode('online');
    setRoomsRefresh((n) => n + 1);
  };

  const tabBtn = (id: 'join' | 'create', icon: React.ReactNode, label: string, hint: string) => (
    <button type="button" role="tab" aria-selected={tab === id} aria-controls={`gateway-${id}`} id={`gateway-tab-${id}`} onClick={() => { userChoseTabRef.current = true; setTab(id); }} aria-label={`${label}：${hint}`}
      className={`flex flex-1 items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${tab === id ? 'border-indigo-400 bg-indigo-600/20 text-white' : 'border-neutral-800 bg-neutral-900/60 text-neutral-300 hover:border-neutral-600'}`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tab === id ? 'bg-indigo-600 text-white' : 'bg-neutral-800 text-neutral-300'}`}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-bold">{label}</span>
        <span className="block truncate text-[11px] text-neutral-400">{hint}</span>
      </span>
    </button>
  );

  return (
    <div
      className={`fixed inset-0 z-50 overflow-y-auto bg-neutral-950 text-neutral-200${focusOnOpen ? ' atelier-gateway-enter' : ''}`}
      style={{
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
    >
      <form onSubmit={submit} className="mx-auto flex min-h-full w-full max-w-xl flex-col gap-4 px-4 py-6 sm:py-10">
        <header className="flex items-center gap-3">
          <img src={`${(import.meta as any).env?.BASE_URL || './'}logo.svg`} alt="" aria-hidden="true" className="h-11 w-11 shrink-0" />
          <div>
            <h1 ref={heading} tabIndex={-1} className="text-lg font-black text-white outline-none">Lumina Drift{t.brand && t.brand !== 'Lumina Drift' && <> <span className="font-semibold text-neutral-300">{t.brand}</span></>}</h1>
            <p className="text-xs text-neutral-400">{t.gateway.tagline}</p>
          </div>
        </header>

        {/* Primary Mode Selector: Solo Offline vs Online Collaborative (Desktop / Android only) */}
        {supportsOfflineMode && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setGatewayMode('offline')}
            aria-pressed={gatewayMode === 'offline'}
            className={`flex items-start gap-3 rounded-2xl border p-3 text-left transition ${
              gatewayMode === 'offline'
                ? 'border-cyan-400 bg-cyan-500/15 text-white shadow-lg shadow-cyan-500/10'
                : 'border-neutral-800 bg-neutral-900/60 text-neutral-300 hover:border-neutral-600'
            }`}
          >
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${gatewayMode === 'offline' ? 'bg-cyan-500 text-neutral-950' : 'bg-neutral-800 text-neutral-300'}`}>
              <Palette className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold">{t.gateway.modeSoloOffline}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-neutral-400">{t.gateway.modeSoloOfflineDesc}</span>
            </span>
          </button>

          <button
            type="button"
            onClick={switchToOnlineMode}
            aria-pressed={gatewayMode === 'online'}
            className={`flex items-start gap-3 rounded-2xl border p-3 text-left transition ${
              gatewayMode === 'online'
                ? 'border-indigo-400 bg-indigo-600/20 text-white shadow-lg shadow-indigo-500/10'
                : 'border-neutral-800 bg-neutral-900/60 text-neutral-300 hover:border-neutral-600'
            }`}
          >
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${gatewayMode === 'online' ? 'bg-indigo-600 text-white' : 'bg-neutral-800 text-neutral-300'}`}>
              <Globe className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold">{t.gateway.modeOnlineCollab}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-neutral-400">{t.gateway.modeOnlineCollabDesc}</span>
            </span>
          </button>
        </div>
        )}

        {/* Who you are */}
        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-3">
          {gatewayMode === 'offline' || isGuest ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-xs font-semibold text-neutral-200">{t.gateway.nickname}</span>
                  {gatewayMode === 'online' && (
                    <span className="block text-[11px] text-neutral-500">{t.gateway.guestNotice}</span>
                  )}
                </div>
                {onOpenAuth && gatewayMode === 'online' && (
                  <button
                    type="button"
                    onClick={openAuth}
                    disabled={Boolean(connectionError)}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
                  >
                    <LogIn className="h-3.5 w-3.5" />
                    <span>{t.navbar.loginRegister}</span>
                  </button>
                )}
              </div>
              <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={24} placeholder={t.gateway.nicknamePlaceholder}
                className="atelier-field h-9 w-full px-3 text-sm" />
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-neutral-300">{t.gateway.loggedInAs}<span className="font-semibold text-white">{user?.displayName}</span></p>
              {onOpenAuth && (
                <button
                  type="button"
                  onClick={openAuth}
                  disabled={Boolean(connectionError)}
                  className="rounded-lg border border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
                >
                  {t.navbar.loginRegister}
                </button>
              )}
            </div>
          )}
        </section>

        {gatewayMode === 'offline' ? (
          <section className="space-y-3 rounded-2xl border border-cyan-500/30 bg-neutral-900/70 p-4">
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-neutral-200">{t.gateway.roomName}</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={60}
                placeholder={t.gateway.offlineDefaultCanvasName}
                className="atelier-field h-9 w-full px-3 text-sm"
              />
            </label>
            {canvasSizes(t.gateway.offlineZeroNetworkHint, 'border-cyan-400 bg-cyan-600 text-white')}
            {onOpenLuminaProject && (
              <div className="pt-1">
                <button
                  type="button"
                    onClick={onOpenLuminaProject}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-neutral-700 bg-neutral-800/80 px-4 py-2.5 text-xs font-semibold text-neutral-100 transition hover:border-cyan-400/60 hover:bg-neutral-800"
                >
                  <FolderOpen className="h-4 w-4 text-cyan-400" />
                  <span>{t.gateway.offlineOpenLuminaButton}</span>
                </button>
              </div>
            )}
            {recentCanvases.length > 0 && (
              <div className="space-y-2 border-t border-neutral-700 pt-3">
                <h2 className="text-xs font-semibold text-neutral-200">{t.gateway.offlineRecentCanvases}</h2>
                <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
                  {recentCanvases.map((canvas) => {
                    const thumbnail = thumbnails?.[canvas.id] ?? offlineThumbnails[canvas.id];
                    return (
                      <button type="button" key={canvas.id} onClick={() => startSoloOffline(canvas.id)}
                        className="min-w-0 rounded-lg border border-neutral-700 bg-neutral-800/60 p-2 text-left hover:border-cyan-400 focus-visible:ring-2 focus-visible:ring-cyan-400">
                        <span className="flex h-16 items-center justify-center overflow-hidden rounded bg-neutral-900">
                          {thumbnail ? <img className="h-full w-full object-cover object-center" src={thumbnail} alt="" /> : <Palette className="h-5 w-5 text-neutral-500" aria-hidden="true" />}
                        </span>
                        <span className="mt-1 block truncate text-xs font-semibold text-neutral-100" title={canvas.title}>{canvas.title}</span>
                        <span className="block text-[11px] text-neutral-400">{canvas.width} × {canvas.height}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        ) : (
          <>
            {/* Quick Remote Link / Server Connection Bar */}
            <section className="space-y-2 rounded-2xl border border-indigo-500/30 bg-neutral-900/70 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-bold text-indigo-200">
                  <Globe className="h-3.5 w-3.5 text-indigo-400" />
                  <span>{t.gateway.serverLocationAria}</span>
                </span>
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => chooseWhere('here')}
                    className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                      where === 'here'
                        ? 'border-indigo-400 bg-indigo-600 text-white'
                        : 'border-neutral-700 bg-neutral-800/80 text-neutral-300 hover:bg-neutral-800'
                    }`}
                  >
                    {t.gateway.whereThisServer}
                  </button>
                  <button
                    type="button"
                    onClick={() => chooseWhere('internet')}
                    className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                      where === 'internet'
                        ? 'border-indigo-400 bg-indigo-600 text-white'
                        : 'border-neutral-700 bg-neutral-800/80 text-neutral-300 hover:bg-neutral-800'
                    }`}
                  >
                    {t.gateway.whereInternet}
                  </button>
                  <button
                    type="button"
                    onClick={() => chooseWhere('lan')}
                    className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                      where === 'lan'
                        ? 'border-indigo-400 bg-indigo-600 text-white'
                        : 'border-neutral-700 bg-neutral-800/80 text-neutral-300 hover:bg-neutral-800'
                    }`}
                  >
                    {t.gateway.whereSameWifi}
                  </button>
                </div>
              </div>

              {where === 'lan' && (
                <div className="space-y-1.5">
                  {addresses.filter((a) => a.type !== 'local').length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {addresses.filter((a) => a.type !== 'local').map((a) => (
                        <button key={a.address} type="button" onClick={() => { setLanIp(a.address); resetPing(); }} aria-pressed={lanIp === a.address}
                          className={`rounded-md border px-2 py-1 text-[11px] ${lanIp === a.address ? 'border-indigo-400 bg-indigo-600 text-white' : 'border-neutral-700 text-neutral-300'}`}>
                          {a.address}<span className="ml-1 text-neutral-400">{a.type === 'tailscale' ? 'Tailscale' : a.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-1.5">
                    <input value={lanIp} onChange={(e) => { setLanIp(e.target.value); resetPing(); }} placeholder={t.gateway.lanHostIpPlaceholder} aria-label={t.gateway.lanHostIpAria} className="atelier-field h-8 min-w-0 flex-1 px-2 text-xs" />
                    <input value={lanPort} onChange={(e) => { setLanPort(e.target.value); resetPing(); }} placeholder="3000" aria-label={t.gateway.portAria} inputMode="numeric" className="atelier-field h-8 w-20 px-2 text-xs" />
                  </div>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                {where === 'internet' && (
                  <input value={internetUrl} onChange={(e) => handlePasteOrTypeRemoteLink(e.target.value)}
                    placeholder="https://example.trycloudflare.com" aria-label={t.gateway.serverUrlAria}
                    className="atelier-field h-9 min-w-0 flex-1 px-3 text-xs" />
                )}
                <button type="button" onClick={testConnection} disabled={ping.testing}
                  className="flex h-9 shrink-0 items-center gap-1 rounded-xl border border-indigo-500/50 bg-indigo-600/25 px-3 text-xs font-semibold text-indigo-100 hover:bg-indigo-600/40">
                  <RefreshCw className={'h-3.5 w-3.5' + (ping.testing ? ' animate-spin' : '')} />
                  <span>{t.gateway.testConnection}</span>
                </button>
                {isDesktop && (
                  <button type="button" onClick={toggleServer} aria-pressed={serverRunning} className="ml-auto rounded-md border border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-800">
                    {t.gateway.localServer}{serverRunning ? t.gateway.serverRunningClickStop : t.gateway.serverStoppedClickStart}
                  </button>
                )}
              </div>
              {ping.ok === true && (
                <p className="text-[11px] text-emerald-300">{t.gateway.connectedMs.replace('{ms}', String(ping.ms ?? 0))}</p>
              )}
              {ping.ok === false && (
                <p className="text-[11px] text-rose-300">{t.gateway.cannotConnect.replace('{error}', String(ping.error ?? ''))}</p>
              )}
              {tunnelBridge?.startTunnel && (
                <div className="space-y-2 border-t border-neutral-800 pt-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-neutral-200">
                      <Cloud aria-hidden="true" className="h-4 w-4 text-indigo-400" />{t.gateway.tunnelAutoCloudflare}
                    </span>
                    <button type="button" role="switch" aria-label={t.gateway.tunnelAutoCloudflare}
                      aria-checked={Boolean(tunnelUrl)} disabled={!tunnelReady || tunnelBusy} onClick={toggleTunnel}
                      className="atelier-btn atelier-btn--ghost shrink-0 gap-2 disabled:opacity-50">
                      <span aria-hidden="true" className={`relative h-4 w-7 rounded-full transition-colors ${tunnelUrl ? 'bg-indigo-600' : 'bg-neutral-600'}`}>
                        <span className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white transition-transform motion-reduce:transition-none ${tunnelUrl ? 'translate-x-3' : ''}`} />
                      </span>
                      {tunnelBusy ? (tunnelUrl ? t.gateway.tunnelClosing : t.gateway.tunnelOpening) : tunnelUrl ? t.gateway.tunnelOn : t.gateway.tunnelOff}
                    </button>
                  </div>
                  {tunnelUrl && tunnelUrl !== shareUrl && (
                    <p className="break-all text-[11px] text-neutral-300">{t.gateway.publicShareUrl} <code className="select-all text-indigo-200">{tunnelUrl}</code></p>
                  )}
                  {tunnelError && <p role="alert" className="text-[11px] text-amber-300">{tunnelError}</p>}
                </div>
              )}
              {shareUrl && (
                <div className="space-y-1 rounded-lg border border-neutral-800 bg-neutral-950/60 p-2">
                  <span className="text-[11px] text-neutral-400">{publicUrl ? t.gateway.publicShareUrl : t.gateway.localShareUrl}</span>
                  <div className="flex items-center gap-1">
                    <code className="min-w-0 flex-1 break-all px-2 py-1 text-[11px] text-indigo-200">{shareUrl}</code>
                    <button type="button" onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(shareUrl);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      } catch {
                        setCopied(false);
                      }
                    }} aria-label={t.gateway.copyUrl} title={t.gateway.copyUrl} className="atelier-icon-btn h-7 w-7 shrink-0">
                      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                    <button type="button" onClick={() => setShowQr((v) => !v)} aria-pressed={showQr}
                      aria-label={t.gateway.showQrCode} title={t.gateway.showQrCodeTooltip} className="atelier-icon-btn h-7 w-7 shrink-0">
                      <QrIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {showQr && qr && <img src={qr} alt={t.gateway.qrCodeAlt.replace('{url}', shareUrl)} className="mx-auto mt-1 h-36 w-36 rounded bg-white p-1" />}
                </div>
              )}
            </section>

            {/* What to do */}
            <div role="tablist" aria-label={t.gateway.tabActionAria} className="flex flex-col gap-2 sm:flex-row">
              {tabBtn('join', <DoorOpen className="h-5 w-5" />, t.gateway.joinRoom, t.gateway.joinTabDesc)}
              {tabBtn('create', <Plus className="h-5 w-5" />, t.gateway.createRoom, t.gateway.createTabDesc)}
            </div>

            {tab === 'join' ? (
              <section id="gateway-join" role="tabpanel" aria-labelledby="gateway-tab-join" className="space-y-2 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-3">
                <div className="flex items-center gap-2">
                  <label className="relative flex-1">
                    <span className="sr-only">{t.gateway.searchRooms}</span>
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500" />
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.gateway.searchRoomsPlaceholder} className="atelier-field h-9 w-full pl-8 pr-3 text-sm" />
                  </label>
                </div>
                {roomsError ? (
                  <p role="alert" className="rounded-lg border border-rose-800/60 bg-rose-950/30 p-2 text-xs text-rose-200">{roomsError}</p>
                ) : rooms === null ? (
                  <p className="py-6 text-center text-xs text-neutral-500">{t.gateway.loadingRooms}</p>
                ) : filteredRooms.length === 0 ? (
                  <p className="py-6 text-center text-xs text-neutral-400">{rooms.length ? t.gateway.noRoomsMatched : t.gateway.noRoomsCreateFirst}</p>
                ) : (
                  <div role="radiogroup" aria-label={t.gateway.chooseRoomAria} className="max-h-72 space-y-1.5 overflow-y-auto">
                    {roomEntries.map((entry) => {
                      if (entry.kind === 'canvas') return renderRoomButton(entry.canvas);
                      const isGroupCollapsed = collapsedGroups.has(entry.group.id) && !query.trim();
                      return (
                        <div
                          key={`group-${entry.group.id}`}
                          data-canvas-group={entry.group.id}
                          data-collapsed={isGroupCollapsed ? 'true' : 'false'}
                          className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/40"
                        >
                          <button
                            type="button"
                            data-canvas-group-toggle={entry.group.id}
                            aria-expanded={!isGroupCollapsed}
                            aria-label={`${t.canvas.canvasGroup}: ${entry.group.title}`}
                            onClick={() => handleToggleGroup(entry.group.id)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-indigo-200 transition hover:bg-neutral-800/70"
                          >
                            {isGroupCollapsed ? (
                              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
                            )}
                            {isGroupCollapsed ? (
                              <Folder className="h-4 w-4 shrink-0 text-indigo-400" />
                            ) : (
                              <FolderOpen className="h-4 w-4 shrink-0 text-indigo-400" />
                            )}
                            <span className="min-w-0 flex-1 truncate">{entry.group.title}</span>
                            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] tabular-nums text-indigo-300">
                              {entry.canvases.length}
                            </span>
                          </button>
                          {!isGroupCollapsed && (
                            <div className="space-y-1 border-t border-neutral-800/70 p-1.5 pl-4">
                              {entry.canvases.map((r) => renderRoomButton(r, true))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            ) : (
              <section id="gateway-create" role="tabpanel" aria-labelledby="gateway-tab-create" className="space-y-3 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-3">
                {!canCreate && (
                  <div className="flex items-center gap-2 rounded-lg border border-amber-700/60 bg-amber-950/30 p-2 text-xs text-amber-100">
                    <LogIn className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{t.gateway.loginRequiredToCreate}</span>
                    <button type="button" onClick={() => enter({ openLogin: true })} className="rounded-md bg-amber-600 px-2 py-1 font-semibold text-white hover:bg-amber-500">{t.navbar.loginRegister}</button>
                  </div>
                )}
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-neutral-200">{t.gateway.roomName}</span>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} disabled={!canCreate} placeholder={t.gateway.roomNamePlaceholder}
                    className="atelier-field h-9 w-full px-3 text-sm disabled:opacity-50" />
                </label>
                {canvasSizes(t.gateway.canvasSizeHint, 'border-indigo-400 bg-indigo-600 text-white')}
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-xs text-neutral-200">
                    <input type="checkbox" checked={usePassword} disabled={!canCreate} onChange={(e) => setUsePassword(e.target.checked)} aria-label={t.gateway.password} />
                    {t.gateway.setPasswordHint}
                  </label>
                  {usePassword && (
                    <div className="relative">
                      <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t.gateway.passwordPlaceholder} autoComplete="new-password"
                        aria-label={t.gateway.password} className="atelier-field h-9 w-full px-3 pr-10 text-sm" />
                      <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? t.gateway.hidePassword : t.gateway.showPassword}
                        className="absolute right-1 top-1/2 flex h-7 w-8 -translate-y-1/2 items-center justify-center rounded text-neutral-400 hover:text-white">
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  )}
                </div>
              </section>
            )}


          </>
        )}

        <footer className="mt-auto flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="flex items-center gap-2 text-[11px] text-neutral-400">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} aria-label={t.gateway.rememberDirectEntry} />
            {t.gateway.rememberDirectEntry}
          </label>
          {gatewayMode === 'offline' ? (
            <button
              type="submit"
              disabled={!validSize}
              className="flex h-11 items-center justify-center gap-2 rounded-xl bg-cyan-600 px-5 text-sm font-bold text-white hover:bg-cyan-500 disabled:opacity-40 sm:ml-auto"
            >
              <Palette className="h-4 w-4" />
              {t.gateway.offlineStartButton}
            </button>
          ) : (
            <button type="submit" disabled={!ready || (tab === 'create' && !canCreate)}
              className="flex h-11 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 text-sm font-bold text-white hover:bg-indigo-500 disabled:opacity-40 sm:ml-auto">
              {tab === 'join' ? <DoorOpen className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {tab === 'join' ? (picked ? t.gateway.joinRoomButton.replace('{title}', picked.title) : t.gateway.selectRoomFirst) : t.gateway.createAndEnter}
            </button>
          )}
        </footer>
      </form>
    </div>
  );
};
