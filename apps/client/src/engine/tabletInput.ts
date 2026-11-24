import type { InkSample, TabletMode, TabletPreference, WinTabSample, WinTabStatus, WinTabUpdate } from '../../electron/tabletProtocol';
import { getTouchSimulatedPressure, TouchPressureSimulator } from './inputPreferences';
import { DEFAULT_PRESSURE_CURVE, readStylusPressureCurve } from './stylusPressure';

type DesktopTablet = {
  configure(enabled: boolean): void;
  subscribe(callback: (update: WinTabUpdate) => void): () => void;
};
type InputEvent = Pick<PointerEvent, 'clientX' | 'clientY' | 'timeStamp' | 'pointerType' | 'pointerId' | 'pressure' | 'button' | 'buttons'>;
export type TabletPoint = InputEvent & Pick<PointerEvent, 'tiltX' | 'tiltY' | 'twist'> & {
  nativePressure?: number;
  gapBefore?: boolean;
};
export type TabletMotion = { runs: TabletPoint[][]; lifted: boolean };
type NativeSource = 'ink' | 'wintab' | 'mouse';
type Snapshot = {
  preference: TabletPreference;
  mode: TabletMode;
  driver: WinTabStatus;
  nativeSource: NativeSource | null;
};

const desktop = (globalThis as typeof globalThis & { atelierDesktop?: { isElectron: boolean; platform: string; tablet?: DesktopTablet } }).atelierDesktop;
export const hasNativeTabletModes = desktop?.isElectron === true && desktop.platform === 'win32';
const bridge = hasNativeTabletModes ? desktop?.tablet : undefined;
const preferenceKey = 'atelier_tablet_input';
const listeners = new Set<() => void>();
const active = new Set<TabletStroke>();
const inkDevices = new Set<number>();
let generation = -1;
let samples: WinTabSample[] = [];
let nativeInk: WinTabSample[] = [];
let nativeMouse: WinTabSample[] = [];
let mouseCapture = false;
let inkSample: InkSample | null = null;
const matchTime = 42;

// This cache is only for identifying a pointer at contact. Active strokes own
// their unread packets independently, including packets from a closing generation.
function retainRecent(packets: WinTabSample[]) {
  // The native stream can arrive before Chromium dispatches the matching down.
  const cutoff = performance.timeOrigin + performance.now() - 500;
  return packets.filter(packet => packet.time >= cutoff);
}

const isPreference = (value: unknown): value is TabletPreference => value === 'auto' || value === 'ink' || value === 'wintab';
function readPreference(): TabletPreference {
  try {
    const value = localStorage.getItem(preferenceKey);
    if (isPreference(value)) return value;
  } catch { /* Storage may be unavailable. */ }
  return 'auto';
}

const pointerMode = hasNativeTabletModes ? 'ink' : 'browser';
let snapshot: Snapshot = {
  preference: hasNativeTabletModes ? readPreference() : 'auto',
  mode: pointerMode,
  driver: bridge ? 'disabled' : 'bridge-unavailable',
  nativeSource: null,
};

function publish(next: Partial<Snapshot>) {
  const state = { ...snapshot, ...next };
  if (state.preference === snapshot.preference && state.mode === snapshot.mode && state.driver === snapshot.driver &&
      state.nativeSource === snapshot.nativeSource) return;
  snapshot = state;
  if (typeof document !== 'undefined') document.documentElement.dataset.drawingInput = state.nativeSource ?? 'pointer';
  for (const listener of listeners) listener();
}

function ingest(update: WinTabUpdate) {
  if (update.generation < generation) return;
  if (update.inkSample !== undefined) inkSample = update.inkSample;
  if (update.mouseCapture !== undefined) mouseCapture = update.mouseCapture === 'ready';
  if (update.devicesChanged) inkDevices.clear();
  const changed = update.generation !== generation;
  if (changed) {
    generation = update.generation;
    samples = [];
    nativeInk = [];
    nativeMouse = [];
  }
  const ink = update.inkSamples ?? [];
  const mouse = update.mouseSamples ?? [];
  // Keep the complete incoming batch available for late attachment before
  // expiring the small cache used for matching new pointers.
  if (update.samples.length) samples = samples.concat(update.samples);
  if (ink.length) nativeInk = nativeInk.concat(ink);
  if (mouse.length) nativeMouse = nativeMouse.concat(mouse);
  publish({
    driver: update.status,
    ...((changed || (snapshot.mode === 'wintab' && update.status !== 'ready')) && !active.size
      ? { mode: pointerMode, nativeSource: null } : {}),
  });
  if (changed || update.samples.length || ink.length || mouse.length) {
    for (const stroke of active) stroke.receivePackets(changed, update.samples, ink, mouse);
  }
  if (update.samples.length) samples = retainRecent(samples);
  if (ink.length) nativeInk = retainRecent(nativeInk);
  if (mouse.length) nativeMouse = retainRecent(nativeMouse);
}

export const getTabletSnapshot = () => snapshot;
export function subscribeTablet(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let configured: boolean | undefined;
function configureDriver() {
  if (!bridge || active.size) return;
  const enabled = snapshot.preference !== 'ink';
  if (configured !== enabled) {
    configured = enabled;
    bridge.configure(enabled);
  }
  if (!enabled || snapshot.driver !== 'ready') publish({ mode: pointerMode });
}

export function setTabletPreference(value: TabletPreference) {
  if (!hasNativeTabletModes || !isPreference(value)) return;
  try { localStorage.setItem(preferenceKey, value); } catch { /* Keep the choice for this session. */ }
  publish({ preference: value });
  configureDriver();
}

bridge?.subscribe(ingest);
configureDriver();

function matchedSample(event: InputEvent, cursor?: number, packets = samples, maxDistance = 18) {
  const time = performance.timeOrigin + event.timeStamp;
  let best: WinTabSample | undefined;
  let bestScore = Infinity;
  const released = new Set<number>();
  for (let i = packets.length - 1; i >= 0; i--) {
    const sample = packets[i];
    const elapsed = time - sample.time;
    if (Math.abs(elapsed) > matchTime || (cursor !== undefined && cursor !== sample.cursor)) continue;
    if (!sample.contact) {
      if (elapsed > 8) released.add(sample.cursor);
      continue;
    }
    if (released.has(sample.cursor)) continue;
    const distance = Math.hypot(event.clientX - sample.x, event.clientY - sample.y);
    const score = distance + Math.abs(elapsed) * 0.35;
    if (distance <= maxDistance && score < bestScore) {
      best = sample;
      bestScore = score;
    }
  }
  return best;
}

function matchedMouseDown(event: InputEvent) {
  const time = performance.timeOrigin + event.timeStamp;
  for (let i = nativeMouse.length - 1; i >= 0; i--) {
    const packet = nativeMouse[i];
    if (packet.down && Math.abs(packet.time - time) <= matchTime &&
        Math.hypot(event.clientX - packet.x, event.clientY - packet.y) <= 8) return packet;
  }
}

const deviceId = (event: InputEvent) =>
  (event as InputEvent & { persistentDeviceId?: number }).persistentDeviceId || 0;
const reportsInkPressure = (event: InputEvent) => event.pointerType === 'pen' && event.pressure > 0 && event.pressure !== 0.5;
const PEN_ERASER_BUTTON = 5;
const PEN_ERASER_MASK = 32;
export const hasDrawingContact = (event: Pick<InputEvent, 'buttons' | 'pointerType'>) =>
  (event.buttons & (event.pointerType === 'pen' ? PEN_ERASER_MASK | 1 : 1)) !== 0;

export function isTabletEraser(event: InputEvent, starting = false): boolean {
  const isPen = event.pointerType === 'pen';
  if (isPen && ((event.buttons & PEN_ERASER_MASK) !== 0 || event.button === PEN_ERASER_BUTTON)) return true;
  if (!bridge || (!isPen && !(starting && event.pointerType === 'mouse' && hasDrawingContact(event)))) return false;
  // Windows pointer IDs are remapped by Chromium. Match native packets by position and time.
  const time = performance.timeOrigin + event.timeStamp;
  if (isPen && inkSample && (!starting || inkSample.contact) &&
      Math.abs(time - inkSample.time) <= 42 &&
      Math.hypot(event.clientX - inkSample.x, event.clientY - inkSample.y) <= 18) return true;
  if (snapshot.preference === 'ink' || snapshot.driver !== 'ready') return false;
  if (starting) return matchedSample(event)?.eraser === true;
  for (let i = samples.length - 1; i >= 0; i--) {
    const sample = samples[i];
    if (Math.abs(time - sample.time) <= 42 && Math.hypot(event.clientX - sample.x, event.clientY - sample.y) <= 18) {
      return sample.eraser === true;
    }
  }
  return false;
}

export class TabletStroke {
  readonly generation = generation;
  readonly pointerId: number;
  private readonly pointerIsPen: boolean;
  private readonly pointerIsTouch: boolean;
  private readonly touchSimulator?: TouchPressureSimulator;
  private readonly penCurve;
  private readonly contactMask: number;
  private readonly expectsEraser: boolean;
  private lastNativePressure: number;
  private previousPoint: TabletPoint;
  private nativeLast?: WinTabSample;
  private nativeSource?: NativeSource;
  private unread: WinTabSample[] = [];
  private switched = false;
  private interrupted = false;
  readonly initialPoint: TabletPoint;
  private latestEvent: TabletPoint;
  private rawPoints: TabletPoint[] = [];
  private rawThrough?: TabletPoint;
  onMotionAvailable?: () => void;

  constructor(event: TabletPoint, sample: WinTabSample | undefined, source: NativeSource | undefined,
    private pendingNative: NativeSource[], private readonly trackMotion: boolean) {
    this.nativeSource = source;
    this.nativeLast = sample;
    this.pointerId = event.pointerId;
    this.pointerIsPen = event.pointerType === 'pen';
    this.pointerIsTouch = event.pointerType === 'touch';
    this.touchSimulator = this.pointerIsTouch && !this.isPen && getTouchSimulatedPressure()
      ? new TouchPressureSimulator(event)
      : undefined;
    this.contactMask = event.pointerType === 'pen' && ((event.buttons & PEN_ERASER_MASK) !== 0 ||
      (event.button === PEN_ERASER_BUTTON && !(event.buttons & 1))) ? PEN_ERASER_MASK : 1;
    this.expectsEraser = this.contactMask === PEN_ERASER_MASK || isTabletEraser(event, true);
    this.penCurve = this.isPen || pendingNative.some(source => source !== 'mouse')
      ? readStylusPressureCurve() ?? DEFAULT_PRESSURE_CURVE : undefined;
    this.lastNativePressure = sample?.pressure ?? 0;
    if (reportsInkPressure(event)) {
      const id = deviceId(event);
      if (id) inkDevices.add(id);
    }
    this.initialPoint = sample ? this.nativePoint(sample, event) : event;
    this.previousPoint = this.initialPoint;
    this.latestEvent = event;
    if (trackMotion && sample && source) this.queueAfter(sample, source);
    if (trackMotion && 'isTrusted' in event && event.isTrusted && event.pointerType !== 'touch' && typeof window !== 'undefined' &&
        'onpointerrawupdate' in window) {
      window.addEventListener('pointerrawupdate', this.onRawPointer, true);
    }
  }

  get mode(): TabletMode {
    return this.nativeSource === 'wintab' ? 'wintab' : pointerMode;
  }

  get isPen() {
    return this.pointerIsPen || (this.nativeSource !== undefined && this.nativeSource !== 'mouse');
  }

  get isTouchSimulated() {
    return Boolean(this.touchSimulator && !this.isPen);
  }

  get touchTravelDistance() {
    return this.touchSimulator?.distance ?? 0;
  }

  get hasNativeMotion() {
    return this.nativeSource !== undefined;
  }

  get awaitingNativeStart() {
    return this.trackMotion && !this.nativeSource && this.pendingNative.length > 0;
  }

  get curve() {
    return this.isPen ? this.penCurve : undefined;
  }

  pressure(event: InputEvent & { nativePressure?: number }) {
    if (event.nativePressure !== undefined) return { raw: event.nativePressure, normalized: event.nativePressure };
    if (reportsInkPressure(event)) {
      const id = deviceId(event);
      if (id) inkDevices.add(id);
    }
    if (this.nativeSource && this.nativeSource !== 'mouse' && this.generation === generation) {
      const pressure = matchedSample(event, this.nativeLast?.cursor, this.nativeSource === 'ink' ? nativeInk : samples)?.pressure;
      if (pressure !== undefined) this.lastNativePressure = pressure;
    }
    // A 0.5 contact packet can be real pen pressure. The raster pipeline resolves ambiguous rebound at lift.
    const raw = this.nativeSource ? this.lastNativePressure : event.pressure;
    if (!this.isPen) {
      if (this.pointerIsTouch) {
        if (this.touchSimulator) {
          const isRelease = 'type' in event && (event as { type?: string }).type === 'pointerup';
          return { raw, normalized: this.touchSimulator.sample(event, isRelease) };
        }
        return { raw, normalized: 1 };
      }
      return { raw, normalized: raw > 0 ? raw : 0.5 };
    }
    return { raw, normalized: Number.isFinite(raw) ? raw : 0.02 };
  }

  releasePressure(event: InputEvent & { nativePressure?: number }) {
    if (!this.isPen && this.pointerIsTouch && this.touchSimulator) {
      return { raw: event.pressure, normalized: this.touchSimulator.release(event) };
    }
    return this.pressure(event);
  }

  isContact(event: InputEvent) {
    if (event.pointerType === 'touch') return true;
    // Windows can deliver an isolated zero-pressure sample while tip contact remains down.
    return (event.buttons & this.contactMask) !== 0 &&
      (this.contactMask === PEN_ERASER_MASK || (event.buttons & PEN_ERASER_MASK) === 0);
  }

  contactPoints(event: PointerEvent, waitForNativeRelease = false): TabletMotion {
    const lifted = event.type === 'pointerup' || event.type === 'pointercancel' || !this.isContact(event);
    if (!lifted) this.latestEvent = event;
    this.attachNative();
    if (this.nativeSource) {
      const motion = this.nativeMotion()!;
      return { ...motion, lifted: motion.lifted || (lifted && !waitForNativeRelease) };
    }

    let points = this.pointerSamples(event, lifted);
    if (this.rawThrough && event.isTrusted && (event.type === 'pointermove' || event.type === 'pointerup' || event.type === 'pointercancel')) {
      const through = this.rawThrough;
      // pointermove and pointerup can repeat preceding raw samples, sometimes with several at the same timestamp.
      let overlap = -1;
      for (let i = points.length - 1; i >= 0; i--) {
        const point = points[i];
        if (point.timeStamp === through.timeStamp &&
            point.clientX === through.clientX && point.clientY === through.clientY && point.pressure === through.pressure) {
          overlap = i;
          break;
        }
      }
      points = overlap >= 0 ? points.slice(overlap + 1) : points.filter(point => point.timeStamp > through.timeStamp);
    }
    return { runs: this.splitMotion(this.takeRawPoints().concat(points)), lifted };
  }

  private pointerSamples(event: PointerEvent, lifted = !this.isContact(event)): TabletPoint[] {
    let batch: PointerEvent[] = [];
    try { batch = event.getCoalescedEvents?.() ?? []; } catch { /* Some synthetic pointers have no batch. */ }
    const points: TabletPoint[] = [];
    for (const point of batch) {
      if (this.isContact(point)) points.push(point);
      else if (lifted) break;
    }
    // The dispatched trusted event can have interpolated coordinates.
    if (!lifted && (!points.length || (!event.isTrusted && points.at(-1) !== event))) points.push(event);
    return points;
  }

  private onRawPointer = (event: Event) => {
    if (!(event instanceof PointerEvent) || !event.isTrusted || event.pointerId !== this.pointerId ||
        this.nativeSource || !this.isContact(event)) return;
    const points = this.pointerSamples(event);
    if (!points.length) return;
    this.rawThrough = points[points.length - 1];
    this.latestEvent = this.rawThrough;
    this.rawPoints.push(...points);
    this.onMotionAvailable?.();
  };

  private takeRawPoints() {
    const points = this.rawPoints;
    this.rawPoints = [];
    return points;
  }

  consumeMotion(): TabletMotion | undefined {
    if (this.nativeSource) return this.nativeMotion();
    if (this.rawPoints.length) return { runs: this.splitMotion(this.takeRawPoints()), lifted: false };
  }

  nativeMotion(): TabletMotion | undefined {
    const first = this.nativeLast;
    if (!first) return;
    const switched = this.switched;
    this.switched = false;
    const points: TabletPoint[] = [];
    if (switched) {
      const pt = this.nativePoint(first, this.latestEvent);
      // Skip duplicating the already-painted anchor when continuing from Chromium pointer events mid-stroke.
      const dist = Math.hypot(pt.clientX - this.previousPoint.clientX, pt.clientY - this.previousPoint.clientY);
      if (this.previousPoint === this.initialPoint || dist >= 1.5) points.push(pt);
    }
    const unread = this.unread;
    this.unread = [];
    let lifted = this.interrupted;
    for (const packet of unread) {
      if (!packet.contact || Boolean(packet.eraser) !== Boolean(first.eraser)) {
        lifted = true;
        break;
      }
      this.nativeLast = packet;
      points.push(this.nativePoint(packet, this.latestEvent));
    }
    return { runs: this.splitMotion(points, false), lifted };
  }

  receivePackets(changed: boolean, winTab: WinTabSample[], ink: WinTabSample[], mouse: WinTabSample[]) {
    if (!this.trackMotion) return;
    if (this.generation !== generation) {
      if (!changed) return;
      this.pendingNative = [];
      this.interrupted = this.hasNativeMotion;
    } else if (this.nativeSource) {
      this.queuePackets(this.nativeSource === 'ink' ? ink : this.nativeSource === 'mouse' ? mouse : winTab);
    } else {
      this.attachNative();
    }
    if (this.hasNativeMotion) this.onMotionAvailable?.();
  }

  private attachNative() {
    if (!this.awaitingNativeStart || this.generation !== generation) return;
    for (const source of this.pendingNative) {
      const mouseDown = source === 'mouse' ? matchedMouseDown(this.initialPoint) : undefined;
      const fromStart = this.previousPoint === this.initialPoint;
      const bank = this.packetBank(source);
      const sample = source === 'mouse'
        ? mouseDown && (fromStart ? mouseDown : matchedSample(this.previousPoint, mouseDown.cursor, bank, 8))
        : matchedSample(fromStart ? this.initialPoint : this.latestEvent, undefined, bank) ??
          matchedSample(this.latestEvent, undefined, bank);
      // The tool (tip or eraser) was selected at pointerdown.
      if (!sample || Boolean(sample.eraser) !== this.expectsEraser) continue;
      this.nativeSource = source;
      this.nativeLast = sample;
      this.pendingNative = [];
      // A physical mouse can continue from a nearby point already painted by
      // Chromium. Replaying that point in a new run would leave a false seam.
      this.switched = source !== 'mouse' || fromStart;
      this.rawPoints = [];
      this.rawThrough = undefined;
      this.queueAfter(sample, source);
      publish({ mode: this.mode, nativeSource: source });
      return;
    }
  }

  private queueAfter(sample: WinTabSample, source: NativeSource) {
    const bank = this.packetBank(source);
    this.queuePackets(bank.slice(bank.lastIndexOf(sample) + 1));
  }

  private packetBank(source: NativeSource) {
    return source === 'ink' ? nativeInk : source === 'mouse' ? nativeMouse : samples;
  }

  private queuePackets(packets: WinTabSample[]) {
    const cursor = this.nativeLast?.cursor;
    for (const packet of packets) {
      if (packet.cursor === cursor) {
        this.unread.push(packet);
      }
    }
  }

  hasPositionGap(next: TabletPoint) {
    const previous = this.previousPoint;
    if (!this.isPen && next.pointerType !== 'mouse') return false;
    if (!this.isPen) {
      return next.timeStamp - previous.timeStamp >= 64 &&
        Math.hypot(next.clientX - previous.clientX, next.clientY - previous.clientY) > 24;
    }
    // Only split pen strokes on severe missed-release teleports so brief frame hitches never punch holes in fast strokes.
    return next.timeStamp - previous.timeStamp >= 250 &&
      Math.hypot(next.clientX - previous.clientX, next.clientY - previous.clientY) > 250;
  }

  private splitMotion(points: TabletPoint[], freshRun = false) {
    const runs: TabletPoint[][] = freshRun ? [[]] : [];
    let run: TabletPoint[] = [];
    for (const next of points) {
      if (next.gapBefore || this.hasPositionGap(next)) {
        runs.push(run);
        run = [];
      }
      run.push(next);
      this.previousPoint = next;
    }
    runs.push(run);
    return runs;
  }

  private nativePoint(packet: WinTabSample, event: TabletPoint): TabletPoint {
    return {
      pointerId: event.pointerId, pointerType: event.pointerType, buttons: event.buttons, button: event.button,
      clientX: packet.x, clientY: packet.y, timeStamp: packet.time - performance.timeOrigin,
      pressure: packet.pressure, nativePressure: packet.pressure, gapBefore: packet.gapBefore,
      tiltX: event.tiltX, tiltY: event.tiltY, twist: event.twist,
    };
  }

  finish() {
    if (typeof window !== 'undefined') window.removeEventListener?.('pointerrawupdate', this.onRawPointer, true);
    this.onMotionAvailable = undefined;
    this.unread = [];
    this.rawPoints = [];
    if (active.delete(this)) {
      if (!active.size && this.generation !== generation) publish({ mode: pointerMode, nativeSource: null });
      configureDriver();
    }
  }
}

export function startTabletStroke(event: TabletPoint, trackMotion = true) {
  let sample: WinTabSample | undefined;
  let source: NativeSource | undefined;
  const pendingNative: NativeSource[] = [];
  const penHasPressure = reportsInkPressure(event) || (event.pointerType === 'pen' && inkDevices.has(deviceId(event)));
  if (bridge && snapshot.driver === 'ready' && snapshot.preference !== 'ink' &&
      (snapshot.preference === 'wintab' || !penHasPressure) && event.pointerType !== 'touch' &&
      (hasDrawingContact(event) || (event.pointerType === 'pen' && event.button === PEN_ERASER_BUTTON))) {
    sample = matchedSample(event);
    if (!sample && (event.pointerType === 'pen' || snapshot.preference === 'wintab')) pendingNative.push('wintab');
    if (sample) source = 'wintab';
  }
  if (bridge && !sample && event.pointerType === 'pen' &&
      (snapshot.preference === 'ink' || snapshot.preference === 'auto' && !penHasPressure ||
        snapshot.preference === 'wintab' && snapshot.driver !== 'ready' && !penHasPressure)) {
    sample = matchedSample(event, undefined, nativeInk);
    if (sample) source = 'ink';
    else pendingNative.push('ink');
  }
  if (!sample && trackMotion && mouseCapture && event.pointerType === 'mouse' && 'isTrusted' in event && event.isTrusted) {
    sample = matchedMouseDown(event);
    if (sample) source = 'mouse';
    else pendingNative.push('mouse');
  }
  const stroke = new TabletStroke(event, sample, source, pendingNative, trackMotion);
  if (hasNativeTabletModes) {
    active.add(stroke);
    if (trackMotion) publish({ mode: stroke.mode, nativeSource: source ?? null });
  }
  return stroke;
}
