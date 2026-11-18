import { useEffect, useState } from 'react';

interface TunnelBridge {
  getTunnelStatus(): Promise<{ url: string | null }>;
  onTunnelStatus?(callback: (url: string | null) => void): () => void;
  startTunnel(): Promise<{ success: boolean; url?: string; error?: string }>;
  stopTunnel(): Promise<boolean>;
}

export function useCloudflareTunnel(enabled = true) {
  const bridge: TunnelBridge | undefined = (window as Window & {
    atelierDesktop?: { server?: TunnelBridge };
  }).atelierDesktop?.server;
  const [url, setUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled || !bridge?.getTunnelStatus) return;
    let active = true;
    let receivedUpdate = false;
    const unsubscribe = bridge.onTunnelStatus?.((next) => {
      receivedUpdate = true;
      setUrl(next);
    });
    bridge.getTunnelStatus().then((status) => {
      if (active && !receivedUpdate) setUrl(status.url);
    }).catch(() => {}).finally(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bridge, enabled]);

  return { bridge, url, setUrl, ready };
}
