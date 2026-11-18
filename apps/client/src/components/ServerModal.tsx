import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Check,
  Copy,
  Globe,
  Laptop,
  Play,
  QrCode,
  Radio,
  Server,
  Smartphone,
  Square,
  Tablet,
  Wifi,
  X,
  ExternalLink,
  Sparkles,
} from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { ApiService } from '../services/api';
import { useCloudflareTunnel } from '../context/useCloudflareTunnel';
import { buildRoomShareUrl, isLoopbackServer, publicServerOrigin } from '../utils/serverLinks';

interface ServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenGateway?: () => void;
  canvasId?: string | null;
}

export interface NetworkAddressInfo {
  name: string;
  address: string;
  type: 'lan' | 'tailscale' | 'local';
}

export const ServerModal: React.FC<ServerModalProps> = ({ isOpen, onClose, onOpenGateway, canvasId }) => {
  const { t } = useI18n();
  const [isRunning, setIsRunning] = useState<boolean>(true);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [qrUrlTarget, setQrUrlTarget] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [addresses, setAddresses] = useState<NetworkAddressInfo[]>([
    { name: '本機 (Localhost)', address: '127.0.0.1', type: 'local' },
  ]);

  const port = 3000;
  const { url: tunnelUrl } = useCloudflareTunnel(isOpen);
  const activeServer = ApiService.getServerUrl() || (ApiService.isDesktopEnv() ? `http://127.0.0.1:${port}` : window.location.origin);
  const isLocal = isLoopbackServer(activeServer);
  const publicUrl = publicServerOrigin(activeServer) ?? (isLocal ? tunnelUrl : null);
  const links = publicUrl
    ? [{ name: t.gateway.publicShareUrl, type: 'public', url: buildRoomShareUrl(publicUrl, canvasId) }]
    : isLocal
      ? addresses.map(({ name, type, address }) => ({ name, type, url: buildRoomShareUrl(`http://${address}:${port}`, canvasId) }))
      : [{ name: t.gateway.localShareUrl, type: 'lan', url: buildRoomShareUrl(activeServer, canvasId) }];

  useEffect(() => {
    setQrDataUrl('');
    if (!isOpen || !qrUrlTarget) return;
    let active = true;
    QRCode.toDataURL(qrUrlTarget, { margin: 1, width: 180 })
      .then((data) => {
        if (active) setQrDataUrl(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isOpen, qrUrlTarget]);

  useEffect(() => {
    if (!isOpen) return;

    // Detect Electron desktop environment
    const desktop = (window as any).atelierDesktop;
    if (desktop?.server) {
      desktop.server.getStatus().then((status: any) => {
        setIsRunning(Boolean(status?.isRunning));
        if (status?.addresses && status.addresses.length > 0) {
          setAddresses(status.addresses);
        }
      });
    } else if (isLocal) {
      // Query server network API
      ApiService.getServerNetwork()
        .then((res) => {
          if (res?.addresses && res.addresses.length > 0) {
            setAddresses(res.addresses);
          }
        })
        .catch(() => {
          const host = window.location.hostname || '127.0.0.1';
          const isLocal = host === 'localhost' || host === '127.0.0.1';
          setAddresses([
            { name: isLocal ? '本機 (Localhost)' : '當前伺服器主機', address: host, type: isLocal ? 'local' : 'lan' },
          ]);
        });
      setIsRunning(true);
    }
  }, [isOpen, isLocal]);

  const handleToggleServer = async () => {
    const desktop = (window as any).atelierDesktop;
    if (desktop?.server) {
      if (isRunning) {
        await desktop.server.stop();
        setIsRunning(false);
      } else {
        const started = await desktop.server.start();
        setIsRunning(Boolean(started));
      }
    } else {
      setIsRunning(!isRunning);
    }
  };

  const copyToClipboard = async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2500);
    } catch {
      setCopiedIndex(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div role="dialog" aria-modal="true" className="atelier-modal-backdrop fixed inset-0 z-[70] flex items-center justify-center p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="atelier-modal max-h-[calc(100dvh-1rem)] w-full max-w-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800 bg-neutral-900">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-emerald-600/20 text-emerald-400 border border-emerald-500/30">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white tracking-wide">
                {t.server.title}
              </h3>
              <p className="text-xs text-neutral-400">{t.server.subtitle}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 flex flex-col gap-4 overflow-y-auto max-h-[75vh]">
          {/* Status Bar */}
          <div className="flex items-center justify-between p-3.5 bg-neutral-900/80 border border-neutral-800 rounded-xl">
            <div className="flex items-center gap-3">
              <div className="relative flex items-center justify-center">
                <span
                  className={`w-3.5 h-3.5 rounded-full ${
                    isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
                  }`}
                />
              </div>
              <div>
                <span className="text-xs font-bold text-white block">
                  {isRunning ? t.server.running : t.server.stopped}
                </span>
                <span className="text-[11px] text-neutral-400 font-mono">
                  Port: {port} • Fastify + WebSocket (WAL SQLite)
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleToggleServer}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition shadow ${
                isRunning
                  ? 'bg-rose-600/20 text-rose-300 hover:bg-rose-600/30 border border-rose-500/30'
                  : 'bg-emerald-600 text-white hover:bg-emerald-500'
              }`}
            >
              {isRunning ? (
                <>
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>{t.server.stop}</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>{t.server.start}</span>
                </>
              )}
            </button>
          </div>

          {/* Connection Links */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-bold text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5 text-indigo-400" />
              {t.server.copyLink}
            </span>

            {links.map(({ name, type, url }, idx) => {
              const isCopied = copiedIndex === idx;
              const isQrShown = qrUrlTarget === url;

              return (
                <div
                  key={url}
                  className="flex flex-col gap-2 p-3 bg-neutral-900/60 border border-neutral-800 rounded-xl hover:border-neutral-700 transition"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-2 bg-neutral-800 rounded-lg text-neutral-400 shrink-0">
                        {type === 'tailscale' || type === 'public' ? (
                          <Globe className="w-4 h-4 text-cyan-400" />
                        ) : type === 'lan' ? (
                          <Wifi className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <Laptop className="w-4 h-4 text-indigo-400" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white truncate">
                            {name}
                          </span>
                          {type !== 'public' && <span className="text-[10px] px-1.5 rounded bg-neutral-800 text-neutral-400 border border-neutral-700 font-mono uppercase">{type}</span>}
                        </div>
                        <span className="text-xs text-indigo-400 font-mono block truncate select-all">
                          {url}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                      <button
                        type="button"
                        onClick={() => copyToClipboard(url, idx)}
                        className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition shrink-0 ${
                          isCopied
                            ? 'bg-emerald-600 text-white'
                            : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200'
                        }`}
                      >
                        {isCopied ? (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            <span>{t.server.copied}</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>{t.server.copyLink}</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => setQrUrlTarget((prev) => (prev === url ? null : url))}
                        aria-pressed={isQrShown}
                        aria-label={t.gateway.showQrCode}
                        title={t.gateway.showQrCodeTooltip}
                        className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition shrink-0 ${
                          isQrShown
                            ? 'bg-indigo-600 text-white'
                            : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200'
                        }`}
                      >
                        <QrCode className="w-3.5 h-3.5" />
                        <span>QR</span>
                      </button>
                    </div>
                  </div>

                  {isQrShown && qrDataUrl && (
                    <div className="flex justify-center pt-1">
                      <img
                        src={qrDataUrl}
                        alt={t.gateway.qrCodeAlt.replace('{url}', url)}
                        className="h-36 w-36 rounded bg-white p-1 shadow"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Device Instructions Box */}
          <div className="p-4 bg-indigo-950/30 border border-indigo-900/50 rounded-xl flex flex-col gap-2.5">
            <div className="flex items-center gap-2 text-indigo-300 text-xs font-bold">
              <Tablet className="w-4 h-4" />
              <span>{t.server.tipsTitle}</span>
            </div>
            <div className="text-[11px] text-neutral-300 whitespace-pre-line leading-relaxed pl-6">
              {t.server.tipsDesc}
            </div>
            <div className="flex items-center gap-3 pt-1 text-[10px] text-neutral-400 border-t border-indigo-900/30">
              <span className="flex items-center gap-1">
                <Laptop className="w-3 h-3 text-neutral-400" /> Windows / Mac / Linux
              </span>
              <span className="flex items-center gap-1">
                <Tablet className="w-3 h-3 text-neutral-400" /> iPad (Apple Pencil)
              </span>
              <span className="flex items-center gap-1">
                <Smartphone className="w-3 h-3 text-neutral-400" /> Android (S-Pen) / Phone
              </span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-neutral-800 bg-neutral-900 flex items-center justify-between">
          {onOpenGateway ? (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenGateway();
              }}
              className="px-3.5 py-1.5 bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 border border-indigo-500/30 font-medium text-xs rounded-xl transition flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{t.server.switchMode}</span>
            </button>
          ) : <div />}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white font-medium text-xs rounded-xl transition"
          >
            {t.common.close}
          </button>
        </div>
      </div>
    </div>
  );
};
