import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Cloud, Copy, Globe, QrCode, Share2, Wifi, X } from 'lucide-react';
import { useCloudflareTunnel } from '../context/useCloudflareTunnel';
import { useI18n } from '../context/I18nContext';
import { ApiService } from '../services/api';
import { buildRoomShareUrl, isLoopbackServer, publicServerOrigin } from '../utils/serverLinks';

interface ShareAddressItem {
  name: string;
  address: string;
  type: 'lan' | 'tailscale' | 'local';
}

export function WorkspaceCloudflareToggle({
  enabled,
  serverUrl,
  canvasId,
}: {
  enabled: boolean;
  serverUrl: string;
  canvasId?: string | null;
}) {
  const { t } = useI18n();
  const { bridge, url, setUrl, ready } = useCloudflareTunnel(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [qr, setQr] = useState('');
  const [addresses, setAddresses] = useState<ShareAddressItem[]>([]);
  const [selectedOptionId, setSelectedOptionId] = useState<string>('primary');
  const containerRef = useRef<HTMLDivElement>(null);

  const activeServer = (
    serverUrl ||
    ApiService.getServerUrl() ||
    (ApiService.isDesktopEnv() ? 'http://127.0.0.1:3000' : window.location.origin)
  ).replace(/\/+$/, '');
  const local = !serverUrl || /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):3000\/?$/i.test(serverUrl);
  const canManageTunnel = Boolean(bridge?.startTunnel && (local || url === serverUrl));

  useEffect(() => {
    if (!enabled || !shareOpen || !isLoopbackServer(activeServer)) return;
    let active = true;
    const desktop = (window as any).atelierDesktop;
    const loadAddresses = async () => {
      try {
        if (desktop?.server?.getNetworkAddresses) {
          const list = await desktop.server.getNetworkAddresses();
          if (active && Array.isArray(list)) setAddresses(list);
        } else if (desktop?.server?.getStatus) {
          const status = await desktop.server.getStatus();
          if (active && Array.isArray(status?.addresses)) setAddresses(status.addresses);
        } else {
          const res = await ApiService.getServerNetwork();
          if (active && Array.isArray(res?.addresses)) setAddresses(res.addresses);
        }
      } catch {
        // Ignore network address lookup failures
      }
    };
    void loadAddresses();
    return () => {
      active = false;
    };
  }, [enabled, shareOpen, activeServer]);

  const publicOrigin =
    publicServerOrigin(activeServer) ?? ((local || url === serverUrl || url === activeServer) ? url : null);

  const shareOptions: Array<{ id: string; label: string; url: string; isPublic: boolean }> = [];
  if (publicOrigin) {
    shareOptions.push({
      id: 'public',
      label: t.gateway.publicShareUrl,
      url: buildRoomShareUrl(publicOrigin, canvasId, previewVersion),
      isPublic: true,
    });
  }
  if (local) {
    for (const addr of addresses) {
      if (addr.type === 'local') continue;
      const lanBase = `http://${addr.address}:3000`;
      const lanUrl = buildRoomShareUrl(lanBase, canvasId);
      if (!shareOptions.some((opt) => opt.url === lanUrl)) {
        shareOptions.push({
          id: `lan-${addr.address}`,
          label: addr.type === 'tailscale' ? 'Tailscale' : addr.name || addr.address,
          url: lanUrl,
          isPublic: false,
        });
      }
    }
  }
  const fallbackUrl = buildRoomShareUrl(activeServer, canvasId, publicOrigin === activeServer ? previewVersion : undefined);
  if (fallbackUrl && !shareOptions.some((opt) => opt.url === fallbackUrl)) {
    shareOptions.push({
      id: 'server',
      label: publicOrigin ? t.gateway.publicShareUrl : t.gateway.localShareUrl,
      url: fallbackUrl,
      isPublic: Boolean(publicOrigin),
    });
  }

  const activeOption = shareOptions.find((opt) => opt.id === selectedOptionId) ?? shareOptions[0];
  const selectedShareUrl = activeOption?.url ?? fallbackUrl;

  useEffect(() => {
    if (publicOrigin) {
      setSelectedOptionId('public');
    } else if (shareOptions.length > 0 && !shareOptions.some((o) => o.id === selectedOptionId)) {
      setSelectedOptionId(shareOptions[0].id);
    }
  }, [publicOrigin, shareOptions.length]);

  useEffect(() => {
    setQr('');
    if (!shareOpen || !showQr || !selectedShareUrl) return;
    let active = true;
    QRCode.toDataURL(selectedShareUrl, { margin: 1, width: 180 })
      .then((data) => {
        if (active) setQr(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [shareOpen, showQr, selectedShareUrl]);

  useEffect(() => {
    if (!shareOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShareOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShareOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [shareOpen]);

  if (!enabled) return null;

  const openShare = () => {
    setPreviewVersion(Date.now().toString(36));
    setCopied(false);
    setShareOpen(true);
  };

  const toggle = async () => {
    if (!bridge?.startTunnel) return;
    setBusy(true);
    setError('');
    try {
      if (url) {
        if (!(await bridge.stopTunnel())) throw new Error(t.gateway.tunnelStopFailed);
        setUrl(null);
        setShareOpen(false);
      } else {
        const result = await bridge.startTunnel();
        if (!result.success || !result.url) throw new Error(t.gateway.tunnelStartFailed);
        if (!bridge.onTunnelStatus) setUrl(result.url);
        setSelectedOptionId('public');
        openShare();
      }
    } catch {
      setError(url ? t.gateway.tunnelStopFailed : t.gateway.tunnelStartFailed);
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!selectedShareUrl) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(selectedShareUrl);
      } else {
        // A public room may still be served over HTTP, where Clipboard is unavailable.
        const field = document.createElement('textarea');
        const previousFocus = document.activeElement;
        field.value = selectedShareUrl;
        field.style.cssText = 'position:fixed;inset:0;opacity:0;pointer-events:none';
        containerRef.current?.append(field);
        try {
          field.select();
          if (!document.execCommand('copy')) return;
        } finally {
          field.remove();
          if (previousFocus instanceof HTMLElement) previousFocus.focus();
        }
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div ref={containerRef} className="relative flex shrink-0 items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
      {canManageTunnel && (
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(url)}
          aria-label={t.gateway.tunnelAutoCloudflare}
          title={url || t.gateway.tunnelAutoCloudflare}
          disabled={!ready || busy}
          onClick={() => void toggle()}
          className={`atelier-icon-btn h-8 gap-1.5 px-1.5 text-xs disabled:opacity-50 ${url ? 'bg-indigo-600/20 text-indigo-200' : ''}`}
        >
          <Cloud aria-hidden="true" className="h-4 w-4" />
          <span className="hidden lg:inline">{busy ? (url ? t.gateway.tunnelClosing : t.gateway.tunnelOpening) : 'Cloudflare'}</span>
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${url ? 'bg-emerald-400' : 'bg-neutral-500'}`} />
        </button>
      )}

      <button
        type="button"
        data-workspace-share-btn=""
        aria-expanded={shareOpen}
        aria-label={t.gateway.shareRoomLink}
        title={t.gateway.shareRoomLink}
        onClick={() => shareOpen ? setShareOpen(false) : openShare()}
        className={`atelier-icon-btn h-8 gap-1.5 px-2 text-xs ${
          shareOpen || Boolean(publicOrigin) ? 'bg-indigo-600/20 text-indigo-200' : ''
        }`}
      >
        <Share2 aria-hidden="true" className="h-3.5 w-3.5" />
        <span className="hidden xl:inline">{t.gateway.shareRoomLink}</span>
      </button>

      {error && (
        <span role="alert" className="atelier-popover absolute right-0 top-full z-[75] mt-1 w-56 p-2 text-xs text-rose-300">
          {error}
        </span>
      )}

      {shareOpen && selectedShareUrl && (
        <div
          role="dialog"
          aria-label={t.gateway.shareRoomLink}
          data-workspace-share-popover=""
          className="atelier-popover atelier-menu-in absolute right-0 top-full z-[75] mt-1.5 w-80 space-y-2.5 p-3 shadow-2xl"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-bold text-neutral-100">
              {activeOption?.isPublic ? (
                <Globe className="h-3.5 w-3.5 text-cyan-400" />
              ) : (
                <Wifi className="h-3.5 w-3.5 text-emerald-400" />
              )}
              <span>{activeOption?.label ?? (publicOrigin ? t.gateway.publicShareUrl : t.gateway.localShareUrl)}</span>
            </span>
            <button
              type="button"
              onClick={() => setShareOpen(false)}
              aria-label={t.common.close}
              className="atelier-icon-btn h-6 w-6"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {shareOptions.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {shareOptions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setSelectedOptionId(opt.id)}
                  aria-pressed={activeOption?.id === opt.id}
                  className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition ${
                    activeOption?.id === opt.id
                      ? 'border-indigo-400 bg-indigo-600 text-white'
                      : 'border-neutral-700 bg-neutral-800/80 text-neutral-300 hover:bg-neutral-800'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          <p className="text-[11px] text-neutral-400">{t.gateway.shareUrlHint}</p>

          <div className="rounded-lg border border-neutral-800 bg-neutral-950/70 p-2">
            <code
              data-workspace-share-url=""
              className="block break-all font-mono text-[11px] text-indigo-200 select-all"
            >
              {selectedShareUrl}
            </code>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-workspace-copy-link=""
              onClick={() => void handleCopy()}
              aria-label={t.gateway.copyUrl}
              title={t.gateway.copyUrl}
              className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition ${
                copied
                  ? 'bg-emerald-600 text-white'
                  : 'bg-indigo-600 text-white hover:bg-indigo-500'
              }`}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copied ? t.server.copied : t.gateway.copyUrl}</span>
            </button>

            <button
              type="button"
              data-workspace-qr-toggle=""
              onClick={() => setShowQr((v) => !v)}
              aria-pressed={showQr}
              aria-label={t.gateway.showQrCode}
              title={t.gateway.showQrCodeTooltip}
              className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2.5 text-xs font-semibold transition ${
                showQr
                  ? 'border-indigo-400 bg-indigo-600/25 text-indigo-200'
                  : 'border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700'
              }`}
            >
              <QrCode className="h-3.5 w-3.5" />
              <span>QR</span>
            </button>
          </div>

          {showQr && qr && (
            <div className="flex flex-col items-center rounded-xl border border-neutral-800 bg-neutral-950/60 p-2.5">
              <img
                data-workspace-qr-img=""
                src={qr}
                alt={t.gateway.qrCodeAlt.replace('{url}', selectedShareUrl)}
                className="h-36 w-36 rounded bg-white p-1"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
