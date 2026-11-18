import assert from 'node:assert/strict';
import type { WinTabSample, WinTabUpdate } from '../../client/electron/tabletProtocol';
import type { TabletPoint } from '../../client/src/engine/tabletInput';

async function main() {
  let report!: (update: WinTabUpdate) => void;
  let preference = 'wintab';
  Object.defineProperties(globalThis, {
    atelierDesktop: { value: {
      isElectron: true, platform: 'win32',
      tablet: { configure() {}, subscribe(callback: typeof report) { report = callback; return () => {}; } },
    } },
    localStorage: { value: { getItem: () => preference, setItem: (_key: string, value: string) => { preference = value; } } },
  });
  const { startTabletStroke, setTabletPreference } = await import('../../client/src/engine/tabletInput');
  let generation = 1;

  for (const source of ['wintab', 'ink'] as const) {
    setTabletPreference(source);
    const update = (packets: WinTabSample[]) => report({
      generation, status: source === 'wintab' ? 'ready' : 'disabled',
      samples: source === 'wintab' ? packets : [],
      inkSamples: source === 'ink' ? packets : [],
    });
    update([]);
    const timeStamp = performance.now() - 180;
    const down: TabletPoint = {
      pointerId: 4, pointerType: 'pen', buttons: 1, button: 0, clientX: 20, clientY: 30,
      pressure: 0.5, tiltX: 0, tiltY: 0, twist: 0, timeStamp,
    };
    const packet = (x: number, y: number, pressure: number, time = timeStamp): WinTabSample =>
      ({ x, y, pressure, time: performance.timeOrigin + time, cursor: 7, contact: true });
    const stroke = startTabletStroke(down);
    let notified = 0;
    stroke.onMotionAvailable = () => notified++;
    assert.equal(stroke.awaitingNativeStart, true);
    assert.equal(stroke.nativeMotion(), undefined);

    // The renderer hasn't rendered a frame since pointerdown. A batch larger
    // than both old sample limits must arrive intact, even at equal timestamps.
    const start = packet(21, 31, 0.21);
    const turn = Array.from({ length: 200 }, (_, i) => packet(22 + i, 44 + i % 11, (i + 1) / 250));
    update([start, ...turn]);
    assert.equal(notified, 1, source + ' starts from IPC without a DOM move or a 150 ms deadline');
    assert.equal(stroke.hasNativeMotion, true);
    const motion = stroke.nativeMotion()!;
    assert.equal(motion.lifted, false);
    assert.deepEqual(motion.runs.flat().map(point => [point.clientX, point.clientY, stroke.pressure(point).raw]),
      [start, ...turn].map(point => [point.x, point.y, point.pressure]), source + ' preserves all raw positions and pressures');

    const lost = { ...packet(260, 52, 0.36), gapBefore: true };
    const jump = packet(360, 52, 0.02, timeStamp + 40);
    update([lost, jump]);
    const gaps = stroke.nativeMotion()!;
    assert.deepEqual(gaps.runs.map(run => run.map(point => point.clientX)), [[], [260, 360]],
      'reported loss still splits the run, while a short interval with no reported loss is continuous');
    assert.equal(gaps.runs.at(-1)?.at(-1)?.nativePressure, 0.02);

    update([packet(720, 53, 0.06, timeStamp + 300)]);
    assert.deepEqual(stroke.nativeMotion()?.runs.map(run => run.map(point => point.clientX)), [[], [720]],
      'a large inferred gap in native pen history still splits the run');

    update([packet(722, 53, 0.03, timeStamp + 302)]);
    generation++;
    update([]);
    update([packet(724, 54, 0.98, timeStamp + 304)]);
    const interrupted = stroke.nativeMotion()!;
    assert.equal(interrupted.lifted, true);
    assert.deepEqual(interrupted.runs.flat().map(point => point.nativePressure), [0.03]);
    stroke.finish();

    const nextTime = performance.now();
    const next = packet(20, 30, 0.41, nextTime);
    update([next]);
    const nextStroke = startTabletStroke({ ...down, timeStamp: nextTime });
    assert.equal(nextStroke.initialPoint.nativePressure, 0.41);
    update([packet(22, 33, 0.17, nextTime), { ...next, contact: false }, { ...next, eraser: true }]);
    const lifted = nextStroke.nativeMotion()!;
    assert.deepEqual(lifted.runs.flat().map(point => point.nativePressure), [0.17]);
    assert.equal(lifted.lifted, true);
    nextStroke.finish();
    generation++;
  }
  const reportMouse = (mouseSamples: WinTabSample[]) => report({
    generation, status: 'disabled', samples: [], mouseCapture: 'ready', mouseSamples,
  });
  reportMouse([]);
  const start = performance.now();
  const down = {
    pointerId: 1, pointerType: 'mouse', buttons: 1, button: 0, clientX: 30, clientY: 40,
    pressure: 0.5, tiltX: 0, tiltY: 0, twist: 0, timeStamp: start, isTrusted: true,
  };
  const mousePacket = (x: number, y: number, offset: number): WinTabSample => ({
    x, y, time: performance.timeOrigin + start + offset, cursor: 11, pressure: 0.5, contact: true,
  });
  const mouseStroke = startTabletStroke(down);
  reportMouse([mousePacket(30, 40, 0)]);
  assert.equal(mouseStroke.hasNativeMotion, false, 'movement alone cannot claim a renderer stroke');
  reportMouse([{ ...mousePacket(30, 40, 0), down: true }, mousePacket(80, 40, 8), mousePacket(80, 90, 16)]);
  assert.equal(mouseStroke.hasNativeMotion, true);
  assert.equal(mouseStroke.isPen, false);
  assert.deepEqual(mouseStroke.consumeMotion()?.runs.flat().map(p => [p.clientX, p.clientY]),
    [[30, 40], [80, 40], [80, 90]], 'native mouse moves draw without any DOM moves');
  reportMouse([
    mousePacket(450, 90, 280), { ...mousePacket(5, 5, 286), contact: false }, mousePacket(150, 150, 290),
  ]);
  const finalMouseMotion = mouseStroke.consumeMotion();
  assert.equal(finalMouseMotion?.lifted, true);
  assert.deepEqual(finalMouseMotion?.runs.map(run => run.map(p => p.clientX)), [[], [450]],
    'a missing interval breaks the path and release discards later coordinates');
  mouseStroke.finish();
  const handover = startTabletStroke({ ...down, timeStamp: start + 250 });
  const domMove = { ...down, type: 'pointermove', clientX: 40, timeStamp: start + 260 } as PointerEvent;
  handover.contactPoints(domMove);
  reportMouse([
    { ...mousePacket(30, 40, 250), down: true }, mousePacket(41, 40, 260), mousePacket(55, 40, 265),
  ]);
  assert.deepEqual(handover.consumeMotion()?.runs.map(run => run.map(point => point.clientX)), [[55]],
    'a matched native continuation does not restart a path that Chromium already drew');
  handover.finish();
  const synthetic = startTabletStroke({ ...down, isTrusted: false });
  assert.equal(synthetic.hasNativeMotion, false, 'synthetic pointers stay on the DOM stream');
  synthetic.finish();
  setTabletPreference('auto');
  const autoTime = performance.now();
  const automatic = startTabletStroke({ ...down, pointerType: 'pen', pressure: 0.72, timeStamp: autoTime });
  report({ generation, status: 'disabled', samples: [], inkSamples: [
    { ...mousePacket(30, 40, 0), time: performance.timeOrigin + autoTime, pressure: 0.18 },
  ] });
  assert.equal(automatic.hasNativeMotion, false, 'auto keeps Chromium coordinates when the pen already supplies pressure');
  assert.equal(automatic.awaitingNativeStart, false);
  automatic.finish();
  console.log('WinTab and Windows Ink: delayed batches, packet loss, generation change and lift. Mouse: source matching, motion without DOM moves, gap and release.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
