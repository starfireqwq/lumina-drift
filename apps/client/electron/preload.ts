import { contextBridge, ipcRenderer } from 'electron';
import type { WinTabUpdate } from './tabletProtocol';

const tabletListeners = new Set<(update: WinTabUpdate) => void>();
let beforeClose: (() => Promise<void>) | undefined;
ipcRenderer.on('lumina:prepare-close', async () => {
  try {
    await beforeClose?.();
    ipcRenderer.send('lumina:close-ready');
  } catch (error) {
    ipcRenderer.send('lumina:close-ready', error instanceof Error ? error.message : String(error));
  }
});
if (process.platform === 'win32') {
  ipcRenderer.once('atelier:tablet-port', (event) => {
    const port = event.ports[0];
    port.onmessage = event => {
      for (const listener of tabletListeners) listener(event.data);
    };
  });
  ipcRenderer.send('atelier:tablet-connect');
}

contextBridge.exposeInMainWorld('atelierDesktop', {
  isElectron: true,
  platform: process.platform,
  tablet: process.platform === 'win32' ? {
    configure: (enabled: boolean) => ipcRenderer.send('atelier:wintab-configure', enabled),
    subscribe: (callback: (update: WinTabUpdate) => void) => {
      tabletListeners.add(callback);
      return () => tabletListeners.delete(callback);
    },
  } : undefined,
  setTitleBarTheme: (payload: { color: string; symbolColor: string; backgroundColor?: string }) =>
    ipcRenderer.invoke('atelier:set-titlebar-theme', payload),
  server: {
    getStatus: () => ipcRenderer.invoke('atelier:get-server-status'),
    start: () => ipcRenderer.invoke('atelier:start-server'),
    stop: () => ipcRenderer.invoke('atelier:stop-server'),
    getNetworkAddresses: () => ipcRenderer.invoke('atelier:get-network-ips'),
    startTunnel: () => ipcRenderer.invoke('atelier:start-tunnel'),
    stopTunnel: () => ipcRenderer.invoke('atelier:stop-tunnel'),
    getTunnelStatus: () => ipcRenderer.invoke('atelier:get-tunnel-status'),
    onTunnelStatus: (callback: (url: string | null) => void) => {
      const handler = (_event: unknown, url: string | null) => callback(url);
      ipcRenderer.on('atelier:tunnel-status', handler);
      return () => ipcRenderer.removeListener('atelier:tunnel-status', handler);
    },
  },
  saveLuminaFile: (payload: {
    defaultName: string;
    existingFilePath?: string;
    onlyExisting?: boolean;
    data: Uint8Array;
  }) => ipcRenderer.invoke('lumina:save-file', payload),
  getStorageDirectory: () => ipcRenderer.invoke('lumina:storage-directory') as Promise<string>,
  onBeforeClose: (callback: () => Promise<void>) => {
    beforeClose = callback;
    return () => {
      if (beforeClose === callback) beforeClose = undefined;
    };
  },
  openLuminaFile: () => ipcRenderer.invoke('lumina:open-file'),
  consumePendingLumina: () => ipcRenderer.invoke('lumina:consume-pending'),
  onOpenLumina: (
    callback: (payload: { filePath: string; data: Uint8Array }) => void
  ) => {
    const handler = (_event: unknown, payload: { filePath: string; data: Uint8Array }) =>
      callback(payload);
    ipcRenderer.on('lumina:open-file-event', handler);
    return () => {
      ipcRenderer.removeListener('lumina:open-file-event', handler);
    };
  },
});
