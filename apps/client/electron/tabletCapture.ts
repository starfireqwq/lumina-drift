import type { MessagePortMain } from 'electron';
import { openTabletBridge } from './tabletBridge';
import type { InkSample, WinTabSample, WinTabStatus, WinTabUpdate } from './tabletProtocol';

type Geometry = { x: number; y: number; scale: number };
export type TabletCaptureMessage =
  | { type: 'connect'; enabled: boolean; focused: boolean; geometry: Geometry }
  | { type: 'configure'; enabled: boolean; focused: boolean }
  | { type: 'geometry'; geometry: Geometry }
  | { type: 'ink'; samples: WinTabSample[]; eraser: InkSample | null; forwardedAt: number }
  | { type: 'devices' };

const statuses: WinTabStatus[] = ['ready', 'driver-missing', 'driver-unavailable', 'no-pressure-axis', 'context-failed'];

function capture() {
  const [resources, handle] = process.argv.slice(2);
  const bridge = openTabletBridge(resources, Buffer.from(handle, 'hex'));
  let port: MessagePortMain | undefined;
  let enabled = false;
  let focused = false;
  let geometry: Geometry = { x: 0, y: 0, scale: 1 };
  let generation = 0;
  let status: WinTabStatus = 'disabled';
  let mouseCapture: WinTabUpdate['mouseCapture'] = 'unavailable';
  let serial: number | undefined;
  let gap = false;
  let configuring = false;
  let retryAt = 0;
  let lastContactAt = 0;
  let lastPacketAt = 0;
  let lastHoverAt = 0;
  let contacting = false;
  let deviceCheckAt = 0;
  let reconnect: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;

  function position(x: number, y: number) {
    return { x: (x - geometry.x) / geometry.scale, y: (y - geometry.y) / geometry.scale };
  }

  function publish(update: Partial<WinTabUpdate>) {
    port?.postMessage({ generation, status, mouseCapture, samples: [], publishedAt: Date.now(), ...update });
  }

  function flush() {
    let changed = false;
    if (mouseCapture === 'starting') {
      const result = bridge.execute(9);
      if (result !== 0) {
        mouseCapture = result === 1 ? 'ready' : 'unavailable';
        changed = true;
      }
    }
    if (configuring) {
      const result = bridge.execute(4);
      if (result !== 5) {
        configuring = false;
        status = statuses[result] ?? 'context-failed';
        changed = true;
      }
    }
    const now = Date.now();
    const samples: WinTabSample[] = [];
    let hover: WinTabSample | undefined;
    if (focused && enabled && status === 'ready') {
      const packets = bridge.drain(1, position);
      if (packets.length) lastPacketAt = now;
      for (const packet of packets) {
        const next = packet.serial!;
        const distance = serial === undefined ? 1 : (next - serial) >>> 0;
        // Some drivers leave the optional serial at zero on every packet.
        if (distance === 0 && next !== 0) {
          gap ||= Boolean(packet.gapBefore);
          continue;
        }
        if (distance > 0x80000000 && next !== 0) continue;
        // Only propagate real driver/ring-buffer queue overflow flags; WinTab serials can skip across hover/contexts.
        packet.gapBefore ||= gap;
        gap = false;
        serial = next;
        if (packet.contact || contacting) {
          hover = undefined;
          samples.push(packet);
          lastContactAt = now;
        } else {
          hover = packet;
        }
        contacting = packet.contact;
      }
    }
    if (hover && (samples.length || now - lastHoverAt >= 16)) {
      samples.push(hover);
      lastHoverAt = now;
    }
    const mouseSamples = focused && mouseCapture === 'ready' ? bridge.drain(8, position) : [];
    if (mouseSamples.length) lastPacketAt = now;
    if (changed || samples.length || mouseSamples.length) publish({ samples, mouseSamples, dispatch: 'capture' });
  }

  function configure(nextEnabled: boolean, nextFocused: boolean, devicesChanged = false) {
    flush();
    if (focused !== nextFocused) {
      mouseCapture = nextFocused ? 'starting' : 'unavailable';
      bridge.execute(7, Number(nextFocused));
    }
    enabled = nextEnabled;
    focused = nextFocused;
    generation++;
    serial = undefined;
    gap = false;
    contacting = false;
    lastContactAt = 0;
    configuring = enabled && focused && bridge.execute(0) === 1;
    if (!enabled || !focused) bridge.execute(2);
    status = !enabled || !focused || configuring ? 'disabled' : 'context-failed';
    retryAt = Date.now() + 2500;
    publish({ devicesChanged, inkSample: null, dispatch: 'status' });
  }

  function deviceChanged() {
    clearTimeout(reconnect);
    const whenLifted = () => {
      if (!enabled || !focused) return;
      if (Date.now() - lastContactAt < 350) reconnect = setTimeout(whenLifted, 200);
      else {
        configure(enabled, focused, true);
        tick();
      }
    };
    reconnect = setTimeout(whenLifted, 300);
  }

  function tick() {
    clearTimeout(poll);
    if (!focused || !port) return;
    const now = Date.now();
    if (enabled && !configuring && status !== 'ready' && now >= retryAt) configure(enabled, focused);
    if (enabled && now >= deviceCheckAt) {
      deviceCheckAt = now + 250;
      if (bridge.execute(10)) deviceChanged();
    }
    flush();
    const delay = configuring || mouseCapture === 'starting' || now - lastPacketAt < 300 ? 4
      : status === 'ready' || mouseCapture === 'ready' ? 8 : 250;
    poll = setTimeout(tick, delay);
  }

  process.parentPort.on('message', (event: { data: TabletCaptureMessage; ports: MessagePortMain[] }) => {
    const message = event.data;
    switch (message.type) {
      case 'connect':
        port?.close();
        port = event.ports[0];
        geometry = message.geometry;
        configure(message.enabled, message.focused);
        tick();
        break;
      case 'configure':
        if (message.enabled !== enabled || message.focused !== focused) {
          configure(message.enabled, message.focused);
          tick();
        }
        break;
      case 'geometry': geometry = message.geometry; break;
      case 'ink': {
        const drainedAt = Date.now();
        publish({
          inkSamples: message.samples.map(packet => ({
            ...packet, ...position(packet.x, packet.y), forwardedAt: message.forwardedAt, drainedAt,
          })),
          inkSample: message.eraser && { ...message.eraser, ...position(message.eraser.x, message.eraser.y) },
          dispatch: 'pointer',
        });
        break;
      }
      case 'devices': deviceChanged(); break;
    }
  });
}

if (process.type === 'utility') capture();
