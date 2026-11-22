import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron';

const hasDiagnosticFlag = (cliFlag: string, envKey: string) =>
  process.argv.includes(cliFlag) || process.env[envKey] === '1';

if (process.platform === 'win32') {
  // Multi-monitor mixed-Hz / DPI Windows setups suffer periodic UI and window-drag stalls from native HWND occlusion walks.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  // Opt-in A/B diagnostic overrides for hardware-specific DWM/GPU isolation without affecting default builds.
  if (hasDiagnosticFlag('--atelier-no-dcomp', 'ATELIER_NO_DCOMP')) {
    app.commandLine.appendSwitch('disable-direct-composition');
  }
  if (hasDiagnosticFlag('--atelier-no-dcomp-overlays', 'ATELIER_NO_DCOMP_OVERLAYS')) {
    app.commandLine.appendSwitch('disable-direct-composition-video-overlays');
  }
  if (hasDiagnosticFlag('--atelier-angle-gl', 'ATELIER_ANGLE_GL')) {
    app.commandLine.appendSwitch('use-angle', 'gl');
  }
}
import { connectWinTab } from './winTab';
import { PluginV3BridgeManager, type BridgeInvokeRequest } from './pluginV3Bridge';
import { LocalMcpServer } from './mcpServer';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { ChildProcess, fork, spawn } from 'node:child_process';
import http from 'node:http';
import { createInterface } from 'node:readline';

type TunnelStartResult = { success: boolean; url?: string; error?: string };

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let isServerRunning = false;
let serverStart: Promise<boolean> | null = null;
let tunnelProcess: ChildProcess | null = null;
let tunnelUrl: string | null = null;
let tunnelStart: Promise<TunnelStartResult> | null = null;
let pendingLuminaPath: string | null = null;
const SERVER_PORT = 3000;

function extractLuminaPathFromArgs(args: string[]): string | null {
  for (const arg of args) {
    if (!arg || arg.startsWith('-')) continue;
    if (arg.toLowerCase().endsWith('.lumina') && fs.existsSync(arg)) {
      return path.resolve(arg);
    }
  }
  return null;
}

pendingLuminaPath = extractLuminaPathFromArgs(process.argv.slice(1));

/**
 * Atomically writes binary data to targetPath via a temporary `.tmp` file + fsync + rename.
 */
async function writeLuminaAtomically(targetPath: string, data: Uint8Array): Promise<void> {
  if (!data || data.byteLength < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new Error('Invalid .lumina archive header (expected ZIP PK signature)');
  }
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tmpPath, 'w');
    await handle.writeFile(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tmpPath, targetPath);
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Enumerates all local IPv4 network addresses (Wi-Fi, LAN, Tailscale)
 */
function getLocalNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses: Array<{ name: string; address: string; type: 'lan' | 'tailscale' | 'local' }> = [];

  addresses.push({ name: 'Localhost', address: '127.0.0.1', type: 'local' });

  for (const [name, netList] of Object.entries(interfaces)) {
    if (!netList) continue;
    for (const net of netList) {
      // 169.254.x.x is a self-assigned link-local address nobody else can reach.
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        if (net.address.startsWith('100.')) {
          addresses.push({ name: `${name} (Tailscale)`, address: net.address, type: 'tailscale' });
        } else {
          addresses.push({ name, address: net.address, type: 'lan' });
        }
      }
    }
  }

  return addresses;
}

/**
 * Checks if the server is responsive on port 3000
 */
function checkServerHealth(port: number = SERVER_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function resolveServerScript(): string | null {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'server/dist/server.js') : '',
    path.resolve(__dirname, '../../../apps/server/dist/server.js'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Starts the embedded Fastify server if available
 */
function startLocalServer(): Promise<boolean> {
  return (serverStart ??= ensureLocalServer().finally(() => { serverStart = null; }));
}

async function ensureLocalServer(): Promise<boolean> {
  const alreadyRunning = await checkServerHealth(SERVER_PORT);
  if (alreadyRunning) {
    isServerRunning = true;
    return true;
  }

  const serverScript = resolveServerScript();
  if (!serverScript) {
    return false;
  }

  try {
    const serverRoot = path.dirname(path.dirname(serverScript));
    const dataDir = app.isPackaged
      ? path.join(app.getPath('userData'), 'data')
      : path.resolve(serverRoot, 'data');
    const clientDistPath = path.join(__dirname, '../dist');

    serverProcess = fork(serverScript, [], {
      cwd: serverRoot,
      env: {
        ...process.env,
        PORT: String(SERVER_PORT),
        HOST: '0.0.0.0',
        DATA_DIR: dataDir,
        CLIENT_DIST_PATH: clientDistPath,
      },
      silent: false,
    });

    serverProcess.on('exit', () => {
      isServerRunning = false;
      serverProcess = null;
    });

    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const healthy = await checkServerHealth(SERVER_PORT);
      if (healthy) {
        isServerRunning = true;
        return true;
      }
    }

    return false;
  } catch (err) {
    console.warn('[Electron Main] Local server not started (solo offline mode ready):', err);
    return false;
  }
}

/**
 * Stops the local server
 */
function stopLocalServer(): boolean {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
    isServerRunning = false;
    return true;
  }
  isServerRunning = false;
  return true;
}

/**
 * Starts Cloudflare Tunnel for public internet pairing
 */
function startCloudflareTunnel(): Promise<TunnelStartResult> {
  if (tunnelUrl) return Promise.resolve({ success: true, url: tunnelUrl });
  return (tunnelStart ??= (async () => {
    if (!(await startLocalServer())) return { success: false };
    return launchCloudflareTunnel();
  })().finally(() => { tunnelStart = null; }));
}

function publishTunnelStatus() {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('atelier:tunnel-status', tunnelUrl);
  }
}

function launchCloudflareTunnel(): Promise<TunnelStartResult> {
  return new Promise((resolve) => {
    try {
      const isWindows = process.platform === 'win32';
      const tunnelBinary = isWindows ? 'cloudflared.exe' : 'cloudflared';
      const packagedCloudflared = process.resourcesPath
        ? path.join(process.resourcesPath, tunnelBinary)
        : '';
      const rootCloudflared = path.resolve(__dirname, '../../../cloudflared.exe');
      const cwdCloudflared = path.resolve(process.cwd(), 'cloudflared.exe');
      const cmd = (packagedCloudflared && fs.existsSync(packagedCloudflared))
        ? packagedCloudflared
        : (isWindows && fs.existsSync(rootCloudflared))
        ? rootCloudflared
        : (isWindows && fs.existsSync(cwdCloudflared))
        ? cwdCloudflared
        : isWindows
        ? 'cloudflared.exe'
        : 'cloudflared';

      const proc = spawn(cmd, ['tunnel', '--url', `http://127.0.0.1:${SERVER_PORT}`], {
        windowsHide: true,
      });

      tunnelProcess = proc;
      let announcedUrl: string | undefined;
      let connected = false;
      const timer = setTimeout(() => {
        stopCloudflareTunnel();
        resolve({ success: false });
      }, 30000);

      const handleOutput = (line: string) => {
        if (tunnelProcess !== proc || tunnelUrl) return;
        announcedUrl ??= line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/)?.[0];
        connected ||= line.includes('Registered tunnel connection');
        if (announcedUrl && connected) {
          clearTimeout(timer);
          tunnelUrl = announcedUrl;
          publishTunnelStatus();
          resolve({ success: true, url: tunnelUrl });
        }
      };

      for (const input of [proc.stdout, proc.stderr]) {
        createInterface({ input }).on('line', handleOutput);
      }
      const handleStop = (error?: string) => {
        clearTimeout(timer);
        if (tunnelProcess === proc) {
          tunnelProcess = null;
          tunnelUrl = null;
          publishTunnelStatus();
        }
        resolve({ success: false, error });
      };
      proc.once('error', (error) => handleStop(error.message));
      proc.once('close', () => handleStop());
    } catch (error) {
      resolve({ success: false, error: error instanceof Error ? error.message : undefined });
    }
  });
}

/**
 * Stops Cloudflare Tunnel
 */
function stopCloudflareTunnel(): boolean {
  if (tunnelProcess) {
    if (!tunnelProcess.kill()) return false;
    tunnelProcess = null;
    tunnelUrl = null;
    publishTunnelStatus();
  }
  return true;
}

function createWindow() {
  const packagedIcon = process.resourcesPath ? path.join(process.resourcesPath, 'icon.ico') : '';
  const devIcon = path.join(__dirname, '../resources/icon.ico');
  const iconPath = packagedIcon && fs.existsSync(packagedIcon) ? packagedIcon : devIcon;
  const useNativeFrame = process.platform === 'win32' && hasDiagnosticFlag('--atelier-native-frame', 'ATELIER_NATIVE_FRAME');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0d0e12',
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : useNativeFrame
        ? {}
        : {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: {
              color: '#0d0e12',
              symbolColor: '#eceef2',
              height: 28,
            },
          }),
    title: 'Lumina Drift 流光 — 專業電繪與即時協同畫室',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (!hasDiagnosticFlag('--atelier-no-wintab', 'ATELIER_NO_WINTAB')) {
    connectWinTab(mainWindow);
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const builtIndex = path.join(__dirname, '../dist/index.html');
  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (fs.existsSync(builtIndex)) {
    void mainWindow.loadFile(builtIndex);
  } else {
    void mainWindow.loadURL('http://localhost:5173');
  }

  const window = mainWindow;
  let preparingClose = false;
  let readyToClose = false;
  window.on('close', (event) => {
    if (readyToClose || window.webContents.isLoadingMainFrame() || window.webContents.isCrashed()) return;
    event.preventDefault();
    if (preparingClose) return;
    preparingClose = true;
    window.webContents.send('lumina:prepare-close');
  });
  window.webContents.ipc.on('lumina:close-ready', async (_event, error?: string) => {
    if (!preparingClose || window.isDestroyed()) return;
    if (error) {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        message: '關閉前的儲存尚未完成',
        detail: error,
        buttons: ['返回畫布', '仍要關閉'],
        defaultId: 0,
        cancelId: 0,
      });
      preparingClose = false;
      if (response === 0 || window.isDestroyed()) return;
    }
    readyToClose = true;
    window.close();
  });

  window.on('closed', () => {
    mainWindow = null;
  });
}

// Single-instance lock & second-instance file association open handler
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', async (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const luminaFile = extractLuminaPathFromArgs(commandLine.slice(1));
      if (luminaFile) {
        try {
          const buf = await fs.promises.readFile(luminaFile);
          mainWindow.webContents.send('lumina:open-file-event', {
            filePath: luminaFile,
            data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
          });
        } catch (err) {
          console.error('[Electron Main] Failed to read second-instance .lumina file:', err);
        }
      }
    }
  });
}

// IPC Handlers
ipcMain.handle('atelier:get-server-status', async () => {
  const healthy = await checkServerHealth(SERVER_PORT);
  return {
    isRunning: healthy || isServerRunning,
    port: SERVER_PORT,
    addresses: getLocalNetworkAddresses(),
  };
});

ipcMain.handle('atelier:start-server', async () => {
  return await startLocalServer();
});

ipcMain.handle('atelier:stop-server', async () => {
  return stopLocalServer();
});

ipcMain.handle('atelier:get-network-ips', () => {
  return getLocalNetworkAddresses();
});

ipcMain.handle('atelier:start-tunnel', async (event) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) return { success: false };
  return startCloudflareTunnel();
});

ipcMain.handle('atelier:stop-tunnel', (event) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) return false;
  return stopCloudflareTunnel();
});

ipcMain.handle('atelier:get-tunnel-status', () => {
  return {
    isRunning: Boolean(tunnelProcess && tunnelUrl),
    url: tunnelUrl,
  };
});

ipcMain.handle(
  'atelier:set-titlebar-theme',
  (_event, payload: { color: string; symbolColor: string; backgroundColor?: string }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      if (payload?.backgroundColor || payload?.color) {
        mainWindow.setBackgroundColor(payload.backgroundColor || payload.color);
      }
      if (typeof mainWindow.setTitleBarOverlay === 'function' && payload?.color && payload?.symbolColor) {
        mainWindow.setTitleBarOverlay({
          color: payload.color,
          symbolColor: payload.symbolColor,
          height: 28,
        });
      }
    } catch {
      // Ignored on platforms where overlay isn't supported
    }
  }
);

ipcMain.handle('lumina:storage-directory', () => path.join(app.getPath('sessionData'), 'IndexedDB'));

ipcMain.handle(
  'lumina:save-file',
  async (
    _event,
    payload: { defaultName: string; existingFilePath?: string; onlyExisting?: boolean; data: Uint8Array }
  ): Promise<{ saved: boolean; filePath?: string }> => {
    let targetPath = payload.existingFilePath;
    if (targetPath) {
      const validPath = path.isAbsolute(targetPath) && path.extname(targetPath).toLowerCase() === '.lumina';
      const dir = validPath ? await fs.promises.stat(path.dirname(targetPath)).catch(() => null) : null;
      if (!dir?.isDirectory()) targetPath = undefined;
    }
    if (!targetPath) {
      if (payload.onlyExisting) throw new Error('上次的 .lumina 儲存資料夾已無法存取，請另存新檔。');
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '儲存流光專案 (.lumina)',
        defaultPath: payload.defaultName || 'artwork.lumina',
        filters: [
          { name: 'Lumina Drift Project (.lumina)', extensions: ['lumina'] },
        ],
      });
      if (result.canceled || !result.filePath) {
        return { saved: false };
      }
      targetPath = result.filePath.toLowerCase().endsWith('.lumina')
        ? result.filePath
        : `${result.filePath}.lumina`;
    }

    await writeLuminaAtomically(targetPath, payload.data);
    return { saved: true, filePath: targetPath };
  }
);

ipcMain.handle(
  'lumina:open-file',
  async (): Promise<{ opened: boolean; filePath?: string; data?: Uint8Array }> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '開啟流光專案 (.lumina)',
      properties: ['openFile'],
      filters: [
        { name: 'Lumina Drift Project (.lumina)', extensions: ['lumina'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { opened: false };
    }
    const filePath = result.filePaths[0];
    const buf = await fs.promises.readFile(filePath);
    return {
      opened: true,
      filePath,
      data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    };
  }
);

ipcMain.handle(
  'lumina:consume-pending',
  async (): Promise<{ filePath: string; data: Uint8Array } | null> => {
    if (!pendingLuminaPath) return null;
    const target = pendingLuminaPath;
    pendingLuminaPath = null;
    try {
      const buf = await fs.promises.readFile(target);
      return {
        filePath: target,
        data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      };
    } catch {
      return null;
    }
  }
);

const AUTH_STORE_FILE = 'auth-credentials.json';

function isAuthorizedMainSender(event: Electron.IpcMainInvokeEvent): boolean {
  return Boolean(mainWindow && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame);
}

function normalizeCredentialOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512) return null;
  return trimmed;
}

function getAuthStorePath(): string {
  return path.join(app.getPath('userData'), AUTH_STORE_FILE);
}

function readAuthStore(): Record<string, string> {
  try {
    const filePath = getAuthStorePath();
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function writeAuthStore(store: Record<string, string>): boolean {
  try {
    const filePath = getAuthStorePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function canEncryptCredentials(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

ipcMain.handle('atelier:auth-available', (event) => {
  if (!isAuthorizedMainSender(event)) return false;
  return canEncryptCredentials();
});

ipcMain.handle('atelier:auth-get-saved', (event, rawOrigin: unknown) => {
  if (!isAuthorizedMainSender(event) || !canEncryptCredentials()) return null;
  const origin = normalizeCredentialOrigin(rawOrigin);
  if (!origin) return null;
  const encoded = readAuthStore()[origin];
  if (typeof encoded !== 'string' || !encoded) return null;
  try {
    const decrypted = safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    const parsed = JSON.parse(decrypted) as { username?: unknown; password?: unknown };
    if (typeof parsed?.username !== 'string' || typeof parsed?.password !== 'string') return null;
    if (!parsed.username || !parsed.password) return null;
    return { username: parsed.username, password: parsed.password };
  } catch {
    return null;
  }
});

ipcMain.handle(
  'atelier:auth-save-credentials',
  (event, rawOrigin: unknown, rawUsername: unknown, rawPassword: unknown) => {
    if (!isAuthorizedMainSender(event) || !canEncryptCredentials()) return false;
    const origin = normalizeCredentialOrigin(rawOrigin);
    if (!origin || typeof rawUsername !== 'string' || typeof rawPassword !== 'string') return false;
    const username = rawUsername.trim();
    if (!username || username.length > 256 || !rawPassword || rawPassword.length > 1024) return false;
    try {
      const store = readAuthStore();
      const encrypted = safeStorage.encryptString(JSON.stringify({ username, password: rawPassword }));
      store[origin] = encrypted.toString('base64');
      return writeAuthStore(store);
    } catch {
      return false;
    }
  }
);

ipcMain.handle('atelier:auth-clear-credentials', (event, rawOrigin: unknown) => {
  if (!isAuthorizedMainSender(event)) return false;
  const origin = normalizeCredentialOrigin(rawOrigin);
  if (!origin) return false;
  const store = readAuthStore();
  if (!(origin in store)) return true;
  delete store[origin];
  return writeAuthStore(store);
});

// Phase D1 / D4: Authorized directory picker & flat file writer for batch animation exports
const exportDirectories = new Map<string, string>();
const MAX_EXPORT_DIR_SESSIONS = 16;

function isSafeFlatFileName(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) return false;
  if (trimmed === '.' || trimmed === '..') return false;
  if (/[\\/\x00-\x1f]/.test(trimmed)) return false;
  if (path.basename(trimmed) !== trimmed) return false;
  return true;
}

ipcMain.handle(
  'atelier:export-pick-directory',
  async (event, payload?: { title?: string }): Promise<{ canceled: boolean; dirId?: string; dirPath?: string }> => {
    if (!isAuthorizedMainSender(event) || !mainWindow || mainWindow.isDestroyed()) {
      return { canceled: true };
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim() : '選擇輸出資料夾',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    const dirPath = path.resolve(result.filePaths[0]);
    const dirId = crypto.randomUUID();
    if (exportDirectories.size >= MAX_EXPORT_DIR_SESSIONS) {
      const oldest = exportDirectories.keys().next().value;
      if (oldest) exportDirectories.delete(oldest);
    }
    exportDirectories.set(dirId, dirPath);
    return { canceled: false, dirId, dirPath };
  }
);

ipcMain.handle(
  'atelier:export-write-file',
  async (
    event,
    payload: { dirId?: unknown; fileName?: unknown; data?: unknown }
  ): Promise<{ ok: boolean; filePath?: string; error?: string }> => {
    if (!isAuthorizedMainSender(event)) {
      return { ok: false, error: 'Unauthorized IPC sender' };
    }
    if (typeof payload?.dirId !== 'string') {
      return { ok: false, error: 'Invalid export directory session' };
    }
    const dirPath = exportDirectories.get(payload.dirId);
    if (!dirPath) {
      return { ok: false, error: 'Export directory session expired or unknown' };
    }
    if (!isSafeFlatFileName(payload.fileName)) {
      return { ok: false, error: 'Invalid export filename' };
    }
    if (!(payload.data instanceof Uint8Array)) {
      return { ok: false, error: 'Invalid binary payload' };
    }
    const targetPath = path.resolve(dirPath, payload.fileName);
    if (path.dirname(targetPath) !== dirPath) {
      return { ok: false, error: 'Path traversal rejected' };
    }
    try {
      await fs.promises.writeFile(
        targetPath,
        Buffer.from(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength)
      );
      return { ok: true, filePath: targetPath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
);

ipcMain.handle('atelier:export-close-directory', (event, dirId: unknown): boolean => {
  if (!isAuthorizedMainSender(event) || typeof dirId !== 'string') return false;
  return exportDirectories.delete(dirId);
});

// Plugin API v3.0: Isolated desktop bridge & local loopback MCP server/client
const pluginV3Bridge = new PluginV3BridgeManager();
const pendingMcpCanvasCalls = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

const localMcpServer = new LocalMcpServer(async (toolName, args, allowWrite) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Lumina Drift window is unavailable.');
  }
  const requestId = crypto.randomUUID();
  return await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingMcpCanvasCalls.delete(requestId);
      reject(new Error('MCP canvas execution timed out.'));
    }, 15000);
    pendingMcpCanvasCalls.set(requestId, { resolve, reject, timer });
    mainWindow!.webContents.send('lumina:mcp-canvas-request', {
      requestId,
      toolName,
      args,
      allowWrite,
    });
  });
});

ipcMain.on(
  'lumina:mcp-canvas-response',
  (event, payload: { requestId?: unknown; ok?: unknown; result?: unknown; error?: unknown }) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
      return;
    }
    if (typeof payload?.requestId !== 'string') return;
    const pending = pendingMcpCanvasCalls.get(payload.requestId);
    if (!pending) return;
    pendingMcpCanvasCalls.delete(payload.requestId);
    clearTimeout(pending.timer);
    if (payload.ok === true) {
      pending.resolve(payload.result);
    } else {
      pending.reject(new Error(typeof payload.error === 'string' ? payload.error : 'MCP canvas call failed.'));
    }
  },
);

ipcMain.handle('atelier:plugin-v3-list-profiles', (event) => {
  if (!isAuthorizedMainSender(event)) return { tools: [], mcpClients: [] };
  return pluginV3Bridge.listProfiles();
});

ipcMain.handle('atelier:plugin-v3-pick-exe', async (event) => {
  if (!isAuthorizedMainSender(event) || !mainWindow || mainWindow.isDestroyed()) {
    return { canceled: true };
  }
  return pluginV3Bridge.pickExecutable(mainWindow);
});

ipcMain.handle(
  'atelier:plugin-v3-save-tool',
  (
    event,
    input: {
      id: string;
      label: string;
      executablePath: string;
      argTemplate?: string[];
      expectsOutputFile?: boolean;
      timeoutMs?: number;
    },
  ) => {
    if (!isAuthorizedMainSender(event)) throw new Error('Unauthorized IPC sender.');
    return pluginV3Bridge.saveToolProfile(input);
  },
);

ipcMain.handle('atelier:plugin-v3-remove-tool', (event, id: unknown) => {
  if (!isAuthorizedMainSender(event) || typeof id !== 'string') return false;
  return pluginV3Bridge.removeToolProfile(id);
});

ipcMain.handle(
  'atelier:plugin-v3-invoke-tool',
  async (event, req: BridgeInvokeRequest) => {
    if (!isAuthorizedMainSender(event)) {
      return { ok: false, runId: '', durationMs: 0, error: 'Unauthorized IPC sender.' };
    }
    return pluginV3Bridge.invokeLocalTool(req);
  },
);

ipcMain.handle('atelier:plugin-v3-abort-run', (event, runId: unknown) => {
  if (!isAuthorizedMainSender(event) || typeof runId !== 'string') return false;
  return pluginV3Bridge.abortRun(runId);
});

ipcMain.handle('atelier:plugin-v3-kill-all', async (event) => {
  if (!isAuthorizedMainSender(event)) return { stoppedRuns: 0, mcpStopped: false };
  const stoppedRuns = pluginV3Bridge.killAll();
  const wasRunning = localMcpServer.getStatus().running;
  await localMcpServer.stop();
  for (const [id, pending] of pendingMcpCanvasCalls.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Stopped by emergency kill switch.'));
    pendingMcpCanvasCalls.delete(id);
  }
  return { stoppedRuns, mcpStopped: wasRunning };
});

ipcMain.handle('atelier:plugin-v3-mcp-server-status', (event) => {
  if (!isAuthorizedMainSender(event)) return null;
  return localMcpServer.getStatus();
});

ipcMain.handle(
  'atelier:plugin-v3-mcp-server-start',
  async (event, options?: { port?: number; allowWrite?: boolean }) => {
    if (!isAuthorizedMainSender(event)) throw new Error('Unauthorized IPC sender.');
    return localMcpServer.start(options);
  },
);

ipcMain.handle('atelier:plugin-v3-mcp-server-stop', async (event) => {
  if (!isAuthorizedMainSender(event)) return null;
  return localMcpServer.stop();
});

ipcMain.handle('atelier:plugin-v3-mcp-server-set-write', (event, allowWrite: unknown) => {
  if (!isAuthorizedMainSender(event)) return null;
  return localMcpServer.setAllowWrite(allowWrite === true);
});

ipcMain.handle('atelier:plugin-v3-mcp-server-rotate-token', (event) => {
  if (!isAuthorizedMainSender(event)) return null;
  return localMcpServer.rotateToken();
});

ipcMain.handle(
  'atelier:plugin-v3-save-mcp-client',
  (
    event,
    input: { id: string; label: string; endpointUrl: string; bearerToken?: string },
  ) => {
    if (!isAuthorizedMainSender(event)) throw new Error('Unauthorized IPC sender.');
    return pluginV3Bridge.saveMcpClientProfile(input);
  },
);

ipcMain.handle('atelier:plugin-v3-remove-mcp-client', (event, id: unknown) => {
  if (!isAuthorizedMainSender(event) || typeof id !== 'string') return false;
  return pluginV3Bridge.removeMcpClientProfile(id);
});

ipcMain.handle(
  'atelier:plugin-v3-mcp-client-call',
  async (
    event,
    payload: { serverId: string; method: string; params?: unknown; timeoutMs?: number },
  ) => {
    if (!isAuthorizedMainSender(event)) {
      return { ok: false, error: 'Unauthorized IPC sender.' };
    }
    if (typeof payload?.serverId !== 'string' || typeof payload?.method !== 'string') {
      return { ok: false, error: 'Invalid MCP client call payload.' };
    }
    return pluginV3Bridge.callLocalMcpJsonRpc(
      payload.serverId,
      payload.method,
      payload.params,
      payload.timeoutMs,
    );
  },
);

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  createWindow();

  // Check if local server is already running in background (non-blocking)
  void checkServerHealth(SERVER_PORT).then((isUp) => {
    if (isUp) isServerRunning = true;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  pluginV3Bridge.killAll('Application closing.');
  void localMcpServer.stop();
  stopCloudflareTunnel();
  stopLocalServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
