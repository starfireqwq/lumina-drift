import React, { useEffect, useId, useState } from 'react';
import { BookOpen, Check, Cloud, Copy, LifeBuoy, Network, Smartphone, Wifi } from 'lucide-react';
import { AtelierModal, modalButton } from './AtelierModal';
import { useI18n } from '../context/I18nContext';
import { ApiService } from '../services/api';
import { isLoopbackServer } from '../utils/serverLinks';

type Way = 'lan' | 'vpn' | 'tunnel';
const WAYS: Way[] = ['lan', 'vpn', 'tunnel'];
const ICONS: Record<Way, React.FC<{ className?: string }>> = { lan: Wifi, vpn: Network, tunnel: Cloud };

interface NetAddress { name: string; address: string; type: 'lan' | 'tailscale' | 'local' }

/** Tailscale, ZeroTier One, Radmin VPN…: an address on a virtual LAN rather than the Wi-Fi */
const isVirtual = (a: NetAddress) => a.type === 'tailscale' || /tailscale|zerotier|radmin|vpn/i.test(a.name);

/**
 * The addresses friends can use to reach the server on this computer (desktop app, or a page this
 * computer serves). Empty when the server is somewhere else: then the host has the addresses.
 */
function useThisComputersAddresses() {
  const [list, setList] = useState<Array<NetAddress & { url: string }>>([]);
  useEffect(() => {
    let active = true;
    const desktop = (window as any).atelierDesktop;
    const server = (ApiService.getServerUrl() || (ApiService.isDesktopEnv() ? 'http://127.0.0.1:3000' : window.location.origin)).replace(/\/+$/, '');
    const port = (() => {
      try { return new URL(server).port || '3000'; } catch { return '3000'; }
    })();
    void (async () => {
      try {
        let found: NetAddress[] | undefined;
        if (desktop?.server?.getNetworkAddresses) found = await desktop.server.getNetworkAddresses();
        else if (desktop?.server?.getStatus) found = (await desktop.server.getStatus())?.addresses;
        else if (isLoopbackServer(server)) found = (await ApiService.getServerNetwork())?.addresses;
        if (!active || !Array.isArray(found)) return;
        setList(found.filter((a) => a?.address && a.type !== 'local').map((a) => ({ ...a, url: `http://${a.address}:${port}` })));
      } catch {
        // No addresses to show: the steps still say where to find them
      }
    })();
    return () => { active = false; };
  }, []);
  return list;
}

/**
 * 聯機教學: three ways to paint together — the same Wi-Fi, a virtual LAN (Tailscale / ZeroTier One,
 * phones included) or a public link — each in a few steps, with this computer's addresses to copy
 * and what to check when it does not connect. The full text is in the help centre.
 */
export default function ConnectGuideModal({ onClose, onOpenHelp }: { onClose: () => void; onOpenHelp?: (query: string) => void }) {
  const { t } = useI18n();
  const g = t.connectGuide;
  const baseId = useId();
  const [way, setWay] = useState<Way>('lan');
  const [copied, setCopied] = useState<string | null>(null);
  const addresses = useThisComputersAddresses();
  const shown = addresses.filter((a) => (way === 'vpn' ? isVirtual(a) : way === 'lan' ? !isVirtual(a) : false));

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const field = document.createElement('textarea');
      field.value = url;
      document.body.appendChild(field);
      field.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
      field.remove();
    }
    setCopied(url);
    window.setTimeout(() => setCopied((c) => (c === url ? null : c)), 1600);
  };

  const steps: string[] = way === 'lan' ? [g.lan.s1, g.lan.s2, g.lan.s3] : way === 'vpn' ? [g.vpn.s1, g.vpn.s2, g.vpn.s3] : [g.tunnel.s1, g.tunnel.s2, g.tunnel.s3];
  const intro = way === 'vpn' ? g.vpn.intro : way === 'tunnel' ? g.tunnel.intro : null;

  const tabs = (
    <div role="tablist" aria-label={g.tabsAria} className="grid shrink-0 grid-cols-3 gap-1 border-b border-neutral-800 px-3 py-2"
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const next = WAYS[(WAYS.indexOf(way) + (e.key === 'ArrowRight' ? 1 : WAYS.length - 1)) % WAYS.length];
        setWay(next);
        document.getElementById(`${baseId}-tab-${next}`)?.focus();
      }}>
      {WAYS.map((w) => {
        const Icon = ICONS[w];
        const selected = w === way;
        return (
          <button key={w} id={`${baseId}-tab-${w}`} type="button" role="tab" aria-selected={selected} aria-controls={`${baseId}-panel`}
            tabIndex={selected ? 0 : -1} onClick={() => setWay(w)}
            className={`atelier-guide-tab flex min-w-0 flex-col items-center gap-0.5 rounded-lg px-1.5 py-2 text-center transition ${
              selected ? 'bg-indigo-500/15 text-white ring-1 ring-indigo-400/50' : 'text-neutral-300 hover:bg-neutral-800'}`}>
            <Icon className={`h-4 w-4 ${selected ? 'text-cyan-300' : 'text-neutral-400'}`} />
            <span className="text-xs font-semibold leading-tight">{g.tabs[w]}</span>
            <span className="text-[10px] leading-tight text-neutral-400">{g.badges[w]}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <AtelierModal title={g.title} subtitle={g.subtitle} icon={<Network />} onClose={onClose} width="lg" toolbar={tabs}
      footer={(
        <>
          {onOpenHelp && (
            <button type="button" className={`${modalButton.secondary} mr-auto inline-flex items-center gap-1.5`} onClick={() => onOpenHelp(g.helpQuery)}>
              <BookOpen className="h-3.5 w-3.5" />{g.moreHelp}
            </button>
          )}
          <button type="button" className={modalButton.primary} onClick={onClose}>{g.done}</button>
        </>
      )}>
      <div key={way} id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${way}`} className="space-y-3">
        {intro && <p className="atelier-guide-step leading-relaxed text-neutral-300">{intro}</p>}
        <ol className="space-y-2">
          {steps.map((step, i) => (
            <li key={i} className="atelier-guide-step flex gap-2.5 leading-relaxed text-neutral-200" style={{ '--i': i + 1 } as React.CSSProperties}>
              <span aria-hidden className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-500/25 text-[11px] font-bold text-indigo-200">{i + 1}</span>
              <span className="min-w-0">{step}</span>
            </li>
          ))}
        </ol>

        {way === 'vpn' && (
          <div className="atelier-guide-step space-y-1.5" style={{ '--i': 4 } as React.CSSProperties}>
            <p className="flex gap-2 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 leading-relaxed text-cyan-50">
              <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" /><span className="min-w-0">{g.vpn.phone}</span>
            </p>
            <p className="px-1 text-[11px] text-neutral-400">{g.vpn.pcAlt}</p>
          </div>
        )}
        {way === 'tunnel' && (
          <p className="atelier-guide-step rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-2 text-[11px] leading-relaxed text-neutral-400" style={{ '--i': 4 } as React.CSSProperties}>
            {g.tunnel.note}
          </p>
        )}

        {shown.length > 0 && (
          <div className="atelier-guide-step rounded-lg border border-neutral-800 bg-neutral-950/40 p-2" style={{ '--i': 5 } as React.CSSProperties}>
            <div className="mb-1 px-1 text-[11px] font-semibold text-neutral-300">{g.addressesTitle}</div>
            <ul className="space-y-1">
              {shown.map((a) => (
                <li key={a.url} className="flex items-center gap-2 rounded-md px-1 py-0.5">
                  <span className="min-w-0 flex-1">
                    <span className="block break-all font-mono text-[12px] text-neutral-100">{a.url}</span>
                    <span className="block truncate text-[10px] text-neutral-500" title={a.name}>{a.type === 'tailscale' ? 'Tailscale' : a.name}</span>
                  </span>
                  <button type="button" onClick={() => void copy(a.url)} aria-label={`${g.copy} ${a.url}`}
                    className="atelier-icon-btn h-7 shrink-0 gap-1 px-2 text-[11px]">
                    {copied === a.url ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
                    <span>{copied === a.url ? g.copied : g.copy}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <details className="atelier-guide-step group rounded-lg border border-neutral-800 bg-neutral-950/30" style={{ '--i': 6 } as React.CSSProperties}>
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-amber-200">
            <LifeBuoy className="h-4 w-4 shrink-0" />{g.troubleTitle}
          </summary>
          <ul className="list-disc space-y-1 px-3 pb-3 pl-8 leading-relaxed text-neutral-300">
            <li>{g.trouble.firewall}</li>
            <li>{g.trouble.same}</li>
            <li>{g.trouble.port}</li>
            <li>{g.trouble.blocked}</li>
          </ul>
        </details>
      </div>
    </AtelierModal>
  );
}
