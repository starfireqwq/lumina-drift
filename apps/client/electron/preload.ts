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
  fonts: {
    listLocal: (force?: boolean) => ipcRenderer.invoke('fonts:listLocal', force) as Promise<string[]>,
  },
  tablet: process.platform === 'win32' ? {
    configure: (enabled: boolean) => ipcRenderer.send('atelier:wintab-configure', enabled),
    subscribe: (callback: (update: WinTabUpdate) => void) => {
      tabletListeners.add(callback);
      return () => tabletListeners.delete(callback);
    },
  } : undefined,
  setTitleBarTheme: (payload: { color: string; symbolColor: string; backgroundColor?: string }) =>
    ipcRenderer.invoke('atelier:set-titlebar-theme', payload),
  auth: {
    isAvailable: () => ipcRenderer.invoke('atelier:auth-available') as Promise<boolean>,
    getSaved: (origin: string) =>
      ipcRenderer.invoke('atelier:auth-get-saved', origin) as Promise<{ username: string; password: string } | null>,
    saveCredentials: (origin: string, username: string, password: string) =>
      ipcRenderer.invoke('atelier:auth-save-credentials', origin, username, password) as Promise<boolean>,
    clearCredentials: (origin: string) =>
      ipcRenderer.invoke('atelier:auth-clear-credentials', origin) as Promise<boolean>,
  },
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
  exportFolder: {
    pickDirectory: (title?: string) =>
      ipcRenderer.invoke('atelier:export-pick-directory', { title }) as Promise<{
        canceled: boolean;
        dirId?: string;
        dirPath?: string;
      }>,
    writeFile: (dirId: string, fileName: string, data: Uint8Array) =>
      ipcRenderer.invoke('atelier:export-write-file', { dirId, fileName, data }) as Promise<{
        ok: boolean;
        filePath?: string;
        error?: string;
      }>,
    closeDirectory: (dirId: string) =>
      ipcRenderer.invoke('atelier:export-close-directory', dirId) as Promise<boolean>,
  },
  pluginV3: {
    listProfiles: () => ipcRenderer.invoke('atelier:plugin-v3-list-profiles'),
    pickExecutable: () => ipcRenderer.invoke('atelier:plugin-v3-pick-exe'),
    saveToolProfile: (input: {
      id: string;
      label: string;
      executablePath: string;
      argTemplate?: string[];
      expectsOutputFile?: boolean;
      timeoutMs?: number;
    }) => ipcRenderer.invoke('atelier:plugin-v3-save-tool', input),
    removeToolProfile: (id: string) => ipcRenderer.invoke('atelier:plugin-v3-remove-tool', id),
    invokeTool: (req: {
      runId?: string;
      toolId: string;
      args?: Record<string, unknown>;
      stdinText?: string;
      inputFileName?: string;
      inputBytes?: Uint8Array;
      outputFileName?: string;
      timeoutMs?: number;
    }) => ipcRenderer.invoke('atelier:plugin-v3-invoke-tool', req),
    abortRun: (runId: string) => ipcRenderer.invoke('atelier:plugin-v3-abort-run', runId),
    killAll: () => ipcRenderer.invoke('atelier:plugin-v3-kill-all'),
    mcpServer: {
      getStatus: () => ipcRenderer.invoke('atelier:plugin-v3-mcp-server-status'),
      start: (options?: { port?: number; allowWrite?: boolean }) =>
        ipcRenderer.invoke('atelier:plugin-v3-mcp-server-start', options),
      stop: () => ipcRenderer.invoke('atelier:plugin-v3-mcp-server-stop'),
      setAllowWrite: (allowWrite: boolean) =>
        ipcRenderer.invoke('atelier:plugin-v3-mcp-server-set-write', allowWrite),
      rotateToken: () => ipcRenderer.invoke('atelier:plugin-v3-mcp-server-rotate-token'),
      onCanvasRequest: (
        callback: (payload: {
          requestId: string;
          toolName: string;
          args: Record<string, unknown>;
          allowWrite: boolean;
        }) => void,
      ) => {
        const handler = (
          _event: unknown,
          payload: { requestId: string; toolName: string; args: Record<string, unknown>; allowWrite: boolean },
        ) => callback(payload);
        ipcRenderer.on('lumina:mcp-canvas-request', handler);
        return () => {
          ipcRenderer.removeListener('lumina:mcp-canvas-request', handler);
        };
      },
      sendCanvasResponse: (payload: { requestId: string; ok: boolean; result?: unknown; error?: string }) => {
        ipcRenderer.send('lumina:mcp-canvas-response', payload);
      },
    },
    mcpClient: {
      saveProfile: (input: { id: string; label: string; endpointUrl: string; bearerToken?: string }) =>
        ipcRenderer.invoke('atelier:plugin-v3-save-mcp-client', input),
      removeProfile: (id: string) => ipcRenderer.invoke('atelier:plugin-v3-remove-mcp-client', id),
      call: (payload: { serverId: string; method: string; params?: unknown; timeoutMs?: number }) =>
        ipcRenderer.invoke('atelier:plugin-v3-mcp-client-call', payload),
    },
  },
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
