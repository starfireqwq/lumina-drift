import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { connectWinTab } from './winTab';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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
      if (net.family === 'IPv4' && !net.internal) {
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
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0d0e12',
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
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

  connectWinTab(mainWindow);
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
  stopCloudflareTunnel();
  stopLocalServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
