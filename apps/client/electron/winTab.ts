import { app, ipcMain, MessageChannelMain, screen, utilityProcess, type BrowserWindow } from 'electron';
import path from 'node:path';
import { openTabletBridge } from './tabletBridge';
import type { TabletCaptureMessage } from './tabletCapture';
import type { InkSample, WinTabSample } from './tabletProtocol';

export function connectWinTab(window: BrowserWindow) {
  if (process.platform !== 'win32') return;

  const hwnd = window.getNativeWindowHandle();
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../resources');
  let bridge: ReturnType<typeof openTabletBridge>;
  try {
    bridge = openTabletBridge(resources, hwnd);
  } catch (error) {
    console.warn('[Tablet] Could not load the native bridge:', error);
    return;
  }
  if (!bridge.execute(12)) console.warn('[Tablet] Could not disable Windows pen gestures for the drawing window.');

  const capture = utilityProcess.fork(path.join(__dirname, 'tabletCapture.js'), [resources, hwnd.toString('hex')], {
    serviceName: 'Lumina Tablet Capture',
  });
  let enabled = false;
  let focused = window.isFocused();
  let closed = false;
  let receiving = false;
  let inkSample: InkSample | null = null;
  const lastInk = new Map<number, WinTabSample>();
  const inkGaps = new Set<number>();
  let inkPending: WinTabSample[] = [];
  let inkFlush: NodeJS.Immediate | undefined;

  function send(message: TabletCaptureMessage) {
    if (!closed) capture.postMessage(message);
  }

  function geometry() {
    const bounds = window.getContentBounds();
    const { x, y } = screen.dipToScreenRect(window, bounds);
    return { x, y, scale: screen.getDisplayMatching(bounds).scaleFactor * window.webContents.getZoomFactor() };
  }

  function flushInk() {
    clearImmediate(inkFlush);
    inkFlush = undefined;
    send({ type: 'ink', samples: inkPending, eraser: inkSample, forwardedAt: Date.now() });
    inkPending = [];
  }

  function readInk(wParam: Buffer, prompt = false, releasing = false) {
    if (!focused || !receiving || closed) return;
    const cursor = wParam.readUInt16LE(0);
    const inContact = (wParam.readUInt16LE(2) & 0x0004) !== 0; // POINTER_MESSAGE_FLAG_INCONTACT
    if (!prompt && !inContact && !lastInk.get(cursor)?.contact) return;
    const points = bridge.ink(cursor, (x, y) => ({ x, y }));
    if (!points.length) {
      if (releasing) releaseInk(cursor);
      return;
    }
    for (const packet of points) {
      const previous = lastInk.get(cursor);
      // ENTER/DOWN and UP/LEAVE can carry the same pointer frame.
      const distance = previous ? (packet.serial! - previous.serial!) >>> 0 : 1;
      if (previous && (distance > 0x80000000 || distance === 0 && packet.contact === previous.contact &&
        packet.eraser === previous.eraser && packet.x === previous.x && packet.y === previous.y &&
        packet.pressure === previous.pressure)) {
        if (packet.gapBefore) inkGaps.add(cursor);
        continue;
      }
      packet.gapBefore = inkGaps.delete(cursor) || packet.gapBefore;
      if (packet.contact || previous?.contact) inkPending.push(packet);
      lastInk.set(cursor, packet);
    }
    const last = lastInk.get(cursor);
    if (!last) return;
    const eraserChanged = Boolean(last.eraser || inkSample);
    inkSample = last.eraser ? { ...last, eraser: true } : null;
    if (!inkPending.length && !eraserChanged) return;
    if (prompt || !last.contact) flushInk();
    else inkFlush ??= setImmediate(flushInk);
  }

  function releaseInk(cursor: number) {
    const last = lastInk.get(cursor);
    const now = Date.now();
    if (last?.contact) inkPending.push({ ...last, time: now, capturedAt: now, drainedAt: now,
      contact: false, pressure: 0, gapBefore: true });
    lastInk.delete(cursor);
    inkGaps.delete(cursor);
    if (inkSample || last?.contact) {
      inkSample = null;
      flushInk();
    }
  }

  window.hookWindowMessage(0x0246, (wParam) => readInk(wParam, true));
  window.hookWindowMessage(0x0245, (wParam) => readInk(wParam));
  window.hookWindowMessage(0x0247, (wParam) => readInk(wParam, true, true));
  for (const message of [0x024a, 0x024c]) window.hookWindowMessage(message, (wParam) => releaseInk(wParam.readUInt16LE(0)));

  const onConnect = (event: Electron.IpcMainEvent) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || closed) return;
    const { port1, port2 } = new MessageChannelMain();
    capture.postMessage({ type: 'connect', enabled, focused, geometry: geometry() } satisfies TabletCaptureMessage, [port1]);
    window.webContents.postMessage('atelier:tablet-port', null, [port2]);
    receiving = true;
  };
  const onConfigure = (event: Electron.IpcMainEvent, value: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || typeof value !== 'boolean') return;
    enabled = value;
    send({ type: 'configure', enabled, focused });
  };
  ipcMain.on('atelier:tablet-connect', onConnect);
  ipcMain.on('atelier:wintab-configure', onConfigure);

  function focus(next: boolean) {
    if (inkFlush || inkPending.length) flushInk();
    focused = next;
    lastInk.clear();
    inkGaps.clear();
    inkSample = null;
    send({ type: 'configure', enabled, focused });
  }
  window.on('focus', () => focus(true));
  window.on('blur', () => focus(false));

  const syncGeometry = () => {
    if (receiving && !closed) send({ type: 'geometry', geometry: geometry() });
  };
  window.on('move', syncGeometry);
  window.on('resize', syncGeometry);
  window.webContents.on('zoom-changed', () => setImmediate(syncGeometry));
  screen.on('display-metrics-changed', syncGeometry);
  window.hookWindowMessage(0x0219, () => send({ type: 'devices' }));

  capture.on('exit', code => {
    receiving = false;
    if (!closed) console.warn('[Tablet] Native capture process exited:', code);
  });
  window.on('closed', () => {
    closed = true;
    clearImmediate(inkFlush);
    ipcMain.removeListener('atelier:tablet-connect', onConnect);
    ipcMain.removeListener('atelier:wintab-configure', onConfigure);
    screen.removeListener('display-metrics-changed', syncGeometry);
    capture.kill();
  });
}
