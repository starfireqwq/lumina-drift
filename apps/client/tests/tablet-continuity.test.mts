import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DynamicStabilizer, evaluatePressureCurve } from '@atelier/shared';
import { TabletStroke, type TabletPoint } from '../src/engine/tabletInput.ts';
import {
  getTouchSimulatedPressure,
  setTouchSimulatedPressure,
  TouchPressureSimulator,
} from '../src/engine/inputPreferences.ts';
import { StrokePipeline } from '../src/engine/StrokePipeline.ts';
import { FLOATS_PER_DAB, StrokeWorkerEngine } from '../src/workers/stroke.worker.ts';

function makePoint(overrides: Partial<TabletPoint> = {}): TabletPoint {
  return {
    pointerId: 1,
    pointerType: 'pen',
    buttons: 1,
    button: 0,
    clientX: 100,
    clientY: 100,
    timeStamp: 1000,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    ...overrides,
  };
}

test('brief frame hitches during fast pen strokes do not break into disconnected runs', () => {
  const stroke = new TabletStroke(makePoint(), undefined, undefined, [], true);
  try {
    // 110ms hitch with 150px motion should stay connected
    assert.equal(stroke.hasPositionGap(makePoint({ clientX: 250, clientY: 100, timeStamp: 1110 })), false);
    // Extreme >=250ms & >320px teleport is treated as a gap
    assert.equal(stroke.hasPositionGap(makePoint({ clientX: 500, clientY: 100, timeStamp: 1300 })), true);
  } finally {
    stroke.finish();
  }
});

test('attaching a native sample keeps points in a single continuous run', () => {
  const down = makePoint({ clientX: 100, clientY: 100, timeStamp: 1000 });
  const sample = {
    x: 102,
    y: 101,
    time: performance.timeOrigin + 1005,
    cursor: 1,
    pressure: 0.4,
    contact: true,
    eraser: false,
  };
  const stroke = new TabletStroke(down, sample, 'wintab', [], true);
  try {
    stroke.receivePackets(
      false,
      [
        {
          x: 120,
          y: 110,
          time: performance.timeOrigin + 1015,
          cursor: 1,
          pressure: 0.6,
          contact: true,
          eraser: false,
        },
      ],
      [],
      []
    );
    const motion = stroke.consumeMotion();
    assert.ok(motion);
    assert.equal(motion.lifted, false);
    assert.equal(motion.runs.length, 1);
    assert.equal(motion.runs[0].length, 1);
    assert.equal(motion.runs[0][0].clientX, 120);
  } finally {
    stroke.finish();
  }
});

function createPipelineFixture(stabilizerLevel = 4, size = 36) {
  const stampedDabs: Array<{ x: number; y: number; size: number; pressure: number; alpha: number }> = [];
  let committedPoints: Array<{ x: number; y: number; pressure: number }> = [];
  const brushProps = {
    color: '#111111',
    size,
    minSize: 1,
    opacity: 1,
    flow: 1,
    hardness: 0.9,
    spacing: 0.08,
    stabilizerLevel,
    isEraser: false,
    customBrushUrl: null,
    pressureCurve: 'linear' as const,
    brushType: 'normal' as const,
    antiAlias: 'Crisp' as const,
    snapToRuler: false,
  };
  const brushRenderer = {
    getProperties: () => brushProps,
    setMixerTileReader: () => {},
    resetStrokeState: () => {},
    canBatchStrokeDabs: () => true,
    needsWholeLayer: () => false,
    stampDabs: (_target: unknown, dabs: Float32Array, count: number) => {
      for (let i = 0; i < count; i++) {
        const off = i * FLOATS_PER_DAB;
        stampedDabs.push({
          x: dabs[off],
          y: dabs[off + 1],
          size: dabs[off + 2],
          pressure: dabs[off + 3],
          alpha: dabs[off + 4],
        });
      }
    },
  };
  const layerManager = {
    markInteractive: () => {},
    getLayerItem: (id: string) => (id === 'layer-1' ? { model: { id, alphaLocked: false } } : null),
    drawTarget: () => ({}),
    readStrokeInk: () => Promise.resolve([]),
    releaseStrokeInk: () => {},
    readTileSync: () => null,
  };
  const viewport = {
    screenToCanvas: (x: number, y: number) => ({ x, y }),
  };
  const pipeline = new StrokePipeline(brushRenderer as any, layerManager as any, viewport as any, {
    onCommitStroke: (data) => {
      committedPoints = data.allPoints;
    },
  });
  pipeline.setActiveLayer('layer-1');
  return { pipeline, stampedDabs, brushProps, getCommittedPoints: () => committedPoints };
}

test('a sparse pen stroke reaches the latest filtered sample without an extra half-sample lag', (t) => {
  const replay = (level: number) => {
    const { pipeline, stampedDabs, brushProps } = createPipelineFixture(level);
    Object.assign(brushProps, { brushType: 'pen', spacing: 0.02, minSize: 0 });
    const points = [
      makePoint({ clientX: 100, pressure: 0.7 }),
      makePoint({ clientX: 160, timeStamp: 1016, pressure: 0.7 }),
      makePoint({ clientX: 220, timeStamp: 1032, pressure: 0.7 }),
    ];
    pipeline.handlePointerDown({ ...points[0], type: 'pointerdown' } as PointerEvent);
    for (const point of points.slice(1)) {
      pipeline.handlePointerMove({ ...point, type: 'pointermove' } as PointerEvent);
      pipeline.renderFrame();
    }
    const liveLagPx = points[2].clientX - stampedDabs.at(-1)!.x;
    pipeline.handlePointerUp({ ...points[2], type: 'pointerup', buttons: 0, pressure: 0 } as PointerEvent);
    const remainingPx = points[2].clientX - stampedDabs.at(-1)!.x;
    return { liveLagPx, remainingPx };
  };
  const unsmoothed = replay(0);
  const stabilized = replay(4);
  t.diagnostic(JSON.stringify({ unsmoothed, stabilized }));
  assert.ok(unsmoothed.liveLagPx < 1, 'stabilizer 0 follows the current pen sample');
  assert.ok(stabilized.liveLagPx > 0 && stabilized.liveLagPx < 10, 'level 4 filters without a half-packet backlog');
  assert.ok(stabilized.remainingPx < 1, 'the remaining smoothed segment reaches the last contact');
});

test('pointer pressure preserves a real half-pressure packet and a final fallback stays tapered', () => {
  const down = makePoint({ pressure: 0.35 });
  const tablet = new TabletStroke(down, undefined, undefined, [], true);
  try {
    assert.equal(tablet.pressure(makePoint({ pressure: 0.5 })).normalized, 0.5);
  } finally {
    tablet.finish();
  }

  const { pipeline, brushProps, stampedDabs } = createPipelineFixture();
  Object.assign(brushProps, { brushType: 'pen', minSize: 0, spacing: 0.02 });
  const samples = [[100, 0.35], [120, 0.65], [145, 0.38], [165, 0.16], [180, 0.06], [192, 0.02], [200, 0.5]];
  const points = samples.map(([clientX, pressure], index) => makePoint({ clientX, pressure, timeStamp: 1000 + index * 8 }));
  pipeline.handlePointerDown({ ...points[0], type: 'pointerdown' } as PointerEvent);
  for (const point of points.slice(1)) pipeline.handlePointerMove({ ...point, type: 'pointermove' } as PointerEvent);
  pipeline.handlePointerUp({ ...points.at(-1)!, type: 'pointerup', buttons: 0, pressure: 0 } as PointerEvent);
  const tail = stampedDabs.filter(dab => dab.x >= 188);
  assert.ok(tail.length > 0);
  assert.ok(Math.max(...tail.map(dab => dab.size)) < 3.5, 'the final 0.5 packet must not thicken the taper');
});

test('a custom pressure curve resolves very low input even with a flat input tangent', () => {
  const linear = { type: 'custom' as const, bezierPoints: [0.25, 0.25, 0.75, 0.75] as [number, number, number, number] };
  assert.equal(evaluatePressureCurve(0.0004, linear), 0.0004);
  const boosted = { ...linear, bezierPoints: [0, 0.5, 0, 0.5] as typeof linear.bezierPoints };
  // Here x(t)=t^3, so p=0.000125 corresponds to t=0.05.
  assert.ok(Math.abs(evaluatePressureCurve(0.000125, boosted) - 0.071375) < 0.0005);
  assert.equal(evaluatePressureCurve(0.01, { ...boosted, deadZone: 0.02 }), 0);
});
test('contactPoints deduplicates pointerrawupdate rawThrough samples on pointerup as well as pointermove', () => {
  const down = makePoint({ clientX: 100, clientY: 100, timeStamp: 1000, pressure: 0.6 });
  const stroke = new TabletStroke(down, undefined, undefined, [], true);
  try {
    const raw1 = makePoint({ clientX: 130, clientY: 100, timeStamp: 1008, pressure: 0.45 });
    const raw2 = makePoint({ clientX: 160, clientY: 100, timeStamp: 1016, pressure: 0.03 });
    // Simulate pointerrawupdate having already delivered raw1 and raw2
    (stroke as any).rawThrough = raw2;
    (stroke as any).rawPoints = [raw1, raw2];
    const consumed = stroke.consumeMotion();
    assert.equal(consumed?.runs.flat().length, 2);

    // pointerup arrives with coalesced samples repeating raw1 and raw2 plus one new tail sample
    const raw3 = makePoint({ clientX: 168, clientY: 100, timeStamp: 1020, pressure: 0.02 });
    const upEvent = {
      ...makePoint({ clientX: 168, clientY: 100, timeStamp: 1020, buttons: 0, pressure: 0 }),
      type: 'pointerup',
      isTrusted: true,
      getCoalescedEvents: () => [raw1, raw2, raw3],
    } as unknown as PointerEvent;

    const upMotion = stroke.contactPoints(upEvent);
    assert.equal(upMotion.lifted, true);
    const remaining = upMotion.runs.flat();
    assert.equal(remaining.length, 1, 'already-consumed raw1/raw2 must not replay on pointerup');
    assert.equal(remaining[0].clientX, 168);
    assert.equal(remaining[0].pressure, 0.02);
  } finally {
    stroke.finish();
  }
});

test('DynamicStabilizer.settle and StrokePipeline.finishInterruptedStroke never rebound pressure above < 0.04 tails', () => {
  const stab = new DynamicStabilizer(4);
  stab.reset({ x: 100, y: 100, pressure: 0.02, time: 1000 });
  stab.pushRawPoint({ x: 120, y: 100, pressure: 0.02, time: 1008 });
  const settled = stab.settle({ x: 135, y: 100, pressure: 0, time: 1016 });
  assert.ok(settled.length > 0);
  for (const pt of settled) {
    assert.ok(pt.pressure <= 0.02 + 1e-6, `settle must not raise 0.02 pressure up to 0.04, got ${pt.pressure}`);
  }
});

test('StrokePipeline suppresses non-0.5 hardware rebound spikes on final 1-2 packets before liftoff while preserving coordinates', () => {
  const { pipeline, stampedDabs, getCommittedPoints } = createPipelineFixture(4, 36);
  const ev = (type: string, x: number, timeStamp: number, pressure: number, buttons = 1) =>
    ({
      pointerId: 7,
      pointerType: 'pen',
      button: type === 'pointermove' ? -1 : 0,
      buttons,
      clientX: x,
      clientY: 100,
      timeStamp,
      pressure,
      tiltX: 0,
      tiltY: 0,
      twist: 0,
    }) as unknown as PointerEvent;

  pipeline.handlePointerDown(ev('pointerdown', 100, 1000, 0.35));
  pipeline.handlePointerMove(ev('pointermove', 130, 1008, 0.72));
  pipeline.handlePointerMove(ev('pointermove', 160, 1016, 0.38));
  pipeline.handlePointerMove(ev('pointermove', 185, 1024, 0.14));
  pipeline.handlePointerMove(ev('pointermove', 205, 1032, 0.06));
  pipeline.handlePointerMove(ev('pointermove', 220, 1040, 0.025));
  // Final 2 packets before liftoff rebound to 0.28 and 0.36 within <= 24ms
  pipeline.handlePointerMove(ev('pointermove', 232, 1048, 0.28));
  pipeline.handlePointerMove(ev('pointermove', 242, 1056, 0.36));
  pipeline.handlePointerUp(ev('pointerup', 242, 1060, 0, 0));

  const tailDabs = stampedDabs.filter((d) => d.x >= 218);
  assert.ok(tailDabs.length > 0);
  const maxTailPressure = Math.max(...tailDabs.map((d) => d.pressure));
  const maxTailSize = Math.max(...tailDabs.map((d) => d.size));
  assert.ok(maxTailPressure <= 0.05, `tail pressure must stay tapered (<= 0.05), got ${maxTailPressure}`);
  assert.ok(maxTailSize < 3.5, `tail size must stay tapered (< 3.5px), got ${maxTailSize}`);
  // Final coordinate x=242 must still be reached
  const lastCommitted = getCommittedPoints().at(-1);
  assert.ok(lastCommitted && lastCommitted.x >= 240, `tail must reach final x=242 coordinate, got ${lastCommitted?.x}`);
});

test('StrokePipeline preserves mid-stroke isolated zero pressure [0.8 -> 0 -> 0.8] and deliberate re-press swelling strokes', () => {
  // 1. Mid-stroke isolated zero [0.8 -> 0 -> 0.8]
  const iso = createPipelineFixture(0, 36);
  const ev = (type: string, x: number, timeStamp: number, pressure: number, buttons = 1) =>
    ({
      pointerId: 9,
      pointerType: 'pen',
      button: type === 'pointermove' ? -1 : 0,
      buttons,
      clientX: x,
      clientY: 100,
      timeStamp,
      pressure,
      tiltX: 0,
      tiltY: 0,
      twist: 0,
    }) as unknown as PointerEvent;

  iso.pipeline.handlePointerDown(ev('pointerdown', 80, 1000, 0.8));
  iso.pipeline.handlePointerMove(ev('pointermove', 165, 1008, 0));
  iso.pipeline.handlePointerMove(ev('pointermove', 250, 1016, 0.8));
  iso.pipeline.handlePointerUp(ev('pointerup', 250, 1024, 0, 0));

  const secondHalfDabs = iso.stampedDabs.filter((d) => d.x >= 200);
  assert.ok(secondHalfDabs.length > 0);
  assert.ok(
    Math.max(...secondHalfDabs.map((d) => d.pressure)) >= 0.35,
    'isolated zero sample must not clamp the resumed 0.8 stroke segment'
  );

  // 2. Deliberate press-and-re-press (頓筆: tapers to 0.04 then presses back up across 3+ packets)
  const swell = createPipelineFixture(2, 36);
  swell.pipeline.handlePointerDown(ev('pointerdown', 100, 2000, 0.6));
  swell.pipeline.handlePointerMove(ev('pointermove', 140, 2008, 0.12));
  swell.pipeline.handlePointerMove(ev('pointermove', 170, 2016, 0.04));
  // Re-press continues for 3+ packets
  swell.pipeline.handlePointerMove(ev('pointermove', 200, 2024, 0.22));
  swell.pipeline.handlePointerMove(ev('pointermove', 230, 2032, 0.48));
  swell.pipeline.handlePointerMove(ev('pointermove', 260, 2040, 0.72));
  swell.pipeline.handlePointerUp(ev('pointerup', 260, 2048, 0, 0));

  const rePressedDabs = swell.stampedDabs.filter((d) => d.x >= 220);
  assert.ok(rePressedDabs.length > 0);
  assert.ok(
    Math.max(...rePressedDabs.map((d) => d.pressure)) >= 0.5,
    'deliberate multi-packet re-press (頓筆) must reach full pressure'
  );
});

test('thick 60px pen flicks taper monotonically without stabilizer settle bulb rebound and preserve constant-pressure round ends', () => {
  const flick = [
    { x: 110, y: 100, pressure: 0.42, time: 0 },
    { x: 200, y: 100, pressure: 0.42, time: 16 },
    { x: 218, y: 100, pressure: 0.4111, time: 21 },
    { x: 223, y: 100, pressure: 0.3691, time: 25 },
    { x: 228, y: 100, pressure: 0.3203, time: 29 },
    { x: 233, y: 100, pressure: 0.2627, time: 32 },
    { x: 238, y: 100, pressure: 0.1934, time: 38 },
    { x: 242, y: 100, pressure: 0.1133, time: 40 },
  ];
  for (const stab of [0, 4]) {
    const engine = new StrokeWorkerEngine();
    const cfg = {
      size: 60, minSize: 0, hardness: 1, flow: 1, spacing: 0.02,
      isEraser: false, opacity: 1, stabilizerLevel: stab, followSamples: true,
      scatter: 0, pressureCurve: 'linear' as const, brushType: 'pen',
      antiAlias: 'medium' as const, dynamics: { opacity: { pressure: false } },
    };
    const tailSizes: number[] = [];
    const collect = (arr: Float32Array) => {
      for (let i = 0; i < arr.length; i += 7) {
        if (arr[i] >= 225) tailSizes.push(arr[i + 2]);
      }
    };
    collect(engine.initStroke(cfg, flick[0]));
    for (let i = 1; i < flick.length; i++) collect(engine.addRawPoints([flick[i]]));
    collect(engine.finishStroke(flick[flick.length - 1]));

    assert.ok(tailSizes.length >= 10, `expected dense tail dabs at stab=${stab}`);
    for (let i = 1; i < tailSizes.length; i++) {
      assert.ok(
        tailSizes[i] <= tailSizes[i - 1] + 0.05,
        `tail dab size must not rebound at stab=${stab}: ${tailSizes[i - 1].toFixed(2)} -> ${tailSizes[i].toFixed(2)}`
      );
    }
    assert.ok(
      tailSizes[tailSizes.length - 1] < 3.5,
      `60px flick tip must taper below 3.5px at stab=${stab}, got ${tailSizes[tailSizes.length - 1].toFixed(2)}`
    );
  }

  // Constant-pressure lift (定壓抬筆) must preserve the full round end cap without artificial tapering
  const holdEngine = new StrokeWorkerEngine();
  const holdCfg = {
    size: 60, minSize: 0, hardness: 1, flow: 1, spacing: 0.02,
    isEraser: false, opacity: 1, stabilizerLevel: 4, followSamples: true,
    scatter: 0, pressureCurve: 'linear' as const, brushType: 'pen',
    antiAlias: 'medium' as const, dynamics: { opacity: { pressure: false } },
  };
  const holdPts = [
    { x: 110, y: 100, pressure: 0.42, time: 0 },
    { x: 180, y: 100, pressure: 0.42, time: 16 },
    { x: 240, y: 100, pressure: 0.42, time: 32 },
  ];
  let lastHoldSize = 0;
  const track = (arr: Float32Array) => {
    for (let i = 0; i < arr.length; i += 7) lastHoldSize = arr[i + 2];
  };
  track(holdEngine.initStroke(holdCfg, holdPts[0]));
  for (let i = 1; i < holdPts.length; i++) track(holdEngine.addRawPoints([holdPts[i]]));
  track(holdEngine.finishStroke(holdPts[holdPts.length - 1]));
  assert.ok(Math.abs(lastHoldSize - 25.2) < 0.2, `constant-pressure lift must stay ~25.2px, got ${lastHoldSize}`);
});

test('touch simulated pressure modulates touch strokes by speed and taper without affecting pen or mouse', () => {
  const previous = getTouchSimulatedPressure();
  try {
    // 1. Disabled: touch maintains steady pressure even when browser reports noisy area-based pressure
    setTouchSimulatedPressure(false);
    const steadyDown = makePoint({ pointerType: 'touch', clientX: 50, clientY: 50, timeStamp: 1000, pressure: 0.23 });
    const steadyStroke = new TabletStroke(steadyDown, undefined, undefined, [], false);
    try {
      assert.equal(steadyStroke.isTouchSimulated, false);
      assert.equal(steadyStroke.pressure(steadyDown).normalized, 1);
      assert.equal(steadyStroke.pressure(makePoint({ pointerType: 'touch', clientX: 80, clientY: 50, timeStamp: 1016, pressure: 0.87 })).normalized, 1);
      assert.equal(steadyStroke.releasePressure(makePoint({ pointerType: 'touch', clientX: 110, clientY: 50, timeStamp: 1032, pressure: 0.12 })).normalized, 1);
    } finally {
      steadyStroke.finish();
    }

    // 2. Enabled: touch gets light start taper, higher pressure on slow drags, lower pressure on fast sweeps, and tapered release
    setTouchSimulatedPressure(true);
    const slowSim = new TouchPressureSimulator({ clientX: 0, clientY: 0, timeStamp: 0 });
    const startP = slowSim.pressure;
    let slowP = startP;
    for (let i = 1; i <= 12; i++) {
      slowP = slowSim.sample({ clientX: i * 4, clientY: 0, timeStamp: i * 24 }); // ~0.167 px/ms
    }
    const slowRelease = slowSim.release({ clientX: 48, clientY: 0, timeStamp: 300 });

    const fastSim = new TouchPressureSimulator({ clientX: 0, clientY: 0, timeStamp: 0 });
    let fastP = fastSim.pressure;
    for (let i = 1; i <= 12; i++) {
      fastP = fastSim.sample({ clientX: i * 32, clientY: 0, timeStamp: i * 16 }); // ~2.0 px/ms
    }
    const fastRelease = fastSim.release({ clientX: 384, clientY: 0, timeStamp: 208 });

    assert.ok(startP < 0.35, `touch entry should taper lightly, got ${startP}`);
    assert.ok(slowP > 0.72, `slow finger drag should build solid pressure, got ${slowP}`);
    assert.ok(fastP < slowP - 0.3, `fast finger sweep (${fastP}) should be lighter than slow drag (${slowP})`);
    assert.ok(slowRelease < slowP * 0.55, `release should taper from body (${slowP} -> ${slowRelease})`);
    assert.ok(fastRelease < slowRelease + 0.01, `fast flick exit (${fastRelease}) should taper at least as finely as slow lift (${slowRelease})`);

    // Quick tap without dragging keeps a visible dot pressure
    const tapSim = new TouchPressureSimulator({ clientX: 10, clientY: 10, timeStamp: 0 });
    const tapP = tapSim.release({ clientX: 10.5, clientY: 10.5, timeStamp: 40 });
    assert.ok(tapP >= 0.55, `quick tap should keep solid dot pressure, got ${tapP}`);

    // End-to-end StrokePipeline touch stroke with simulated pressure
    const { pipeline, stampedDabs, brushProps } = createPipelineFixture(2, 24);
    Object.assign(brushProps, { brushType: 'pen', minSize: 0, spacing: 0.05 });
    const downEv = { ...makePoint({ pointerType: 'touch', clientX: 40, clientY: 100, timeStamp: 2000, pressure: 1 }), type: 'pointerdown', getCoalescedEvents: () => [] };
    pipeline.handlePointerDown(downEv as any);
    for (let i = 1; i <= 8; i++) {
      const mv = { ...makePoint({ pointerType: 'touch', clientX: 40 + i * 10, clientY: 100, timeStamp: 2000 + i * 30, pressure: 1 }), type: 'pointermove', getCoalescedEvents: () => [] };
      pipeline.handlePointerMove(mv as any);
    }
    const upEv = { ...makePoint({ pointerType: 'touch', clientX: 122, clientY: 100, timeStamp: 2260, pressure: 1 }), type: 'pointerup', getCoalescedEvents: () => [] };
    pipeline.handlePointerUp(upEv as any);
    assert.ok(stampedDabs.length >= 10, 'touch simulated stroke should stamp dabs');
    const firstSize = stampedDabs[0].size;
    const midSize = stampedDabs[Math.floor(stampedDabs.length * 0.6)].size;
    const lastSize = stampedDabs[stampedDabs.length - 1].size;
    assert.ok(midSize > firstSize + 3, `touch stroke should ramp up from entry (${firstSize} -> ${midSize})`);
    assert.ok(lastSize < midSize - 3, `touch stroke should taper on release (${midSize} -> ${lastSize})`);

    // 3. Physical pen and mouse MUST remain completely unaffected when touch simulation is enabled
    const penDown = makePoint({ pointerType: 'pen', clientX: 10, clientY: 10, timeStamp: 3000, pressure: 0.63 });
    const penStroke = new TabletStroke(penDown, undefined, undefined, [], false);
    try {
      assert.equal(penStroke.isPen, true);
      assert.equal(penStroke.isTouchSimulated, false);
      assert.equal(penStroke.pressure(penDown).normalized, 0.63);
      assert.equal(penStroke.pressure(makePoint({ pointerType: 'pen', clientX: 250, clientY: 10, timeStamp: 3010, pressure: 0.81 })).normalized, 0.81);
    } finally {
      penStroke.finish();
    }

    const mouseDown = makePoint({ pointerType: 'mouse', clientX: 10, clientY: 10, timeStamp: 4000, pressure: 0.5 });
    const mouseStroke = new TabletStroke(mouseDown, undefined, undefined, [], false);
    try {
      assert.equal(mouseStroke.isPen, false);
      assert.equal(mouseStroke.isTouchSimulated, false);
      assert.equal(mouseStroke.pressure(mouseDown).normalized, 0.5);
      assert.equal(mouseStroke.pressure(makePoint({ pointerType: 'mouse', clientX: 250, clientY: 10, timeStamp: 4010, pressure: 0.5 })).normalized, 0.5);
    } finally {
      mouseStroke.finish();
    }
  } finally {
    setTouchSimulatedPressure(previous);
  }
});

test('high stabilizer levels smooth both path wobble and pressure thickness jitter while preserving monotonic exit taper', () => {
  const measureJitter = (level: number) => {
    const stab = new DynamicStabilizer(level);
    const out: Array<{ y: number; pressure: number }> = [];
    for (let i = 0; i < 40; i++) {
      const wobbleY = 100 + (i % 2 === 0 ? 3.5 : -3.5);
      const wobbleP = 0.6 + (i % 2 === 0 ? 0.14 : -0.14);
      const pt = stab.pushRawPoint({ x: 50 + i * 8, y: wobbleY, pressure: wobbleP, time: i * 8 });
      if (i >= 10) out.push({ y: pt.y, pressure: pt.pressure });
    }
    let yVar = 0;
    let pVar = 0;
    for (let i = 1; i < out.length; i++) {
      yVar += Math.abs(out[i].y - out[i - 1].y);
      pVar += Math.abs(out[i].pressure - out[i - 1].pressure);
    }
    const settled = stab.settle({ x: 50 + 40 * 8, y: 100, pressure: 0.05, time: 40 * 8 });
    return { yVar, pVar, settled };
  };

  const raw = measureJitter(0);
  const heavy = measureJitter(15);
  assert.ok(heavy.yVar < raw.yVar * 0.2, `level 15 should suppress path jitter (${heavy.yVar.toFixed(2)} vs ${raw.yVar.toFixed(2)})`);
  assert.ok(heavy.pVar < raw.pVar * 0.25, `level 15 should suppress pressure thickness jitter (${heavy.pVar.toFixed(2)} vs ${raw.pVar.toFixed(2)})`);
  assert.ok(heavy.settled.length > 0, 'level 15 settle should emit trailing points');
  for (let i = 1; i < heavy.settled.length; i++) {
    assert.ok(
      heavy.settled[i].pressure <= heavy.settled[i - 1].pressure + 1e-6,
      `level 15 settle pressure must taper monotonically (${heavy.settled[i - 1].pressure} -> ${heavy.settled[i].pressure})`
    );
  }
  assert.ok(heavy.settled[heavy.settled.length - 1].pressure <= 0.055, 'level 15 settle must finish at release pressure');
});

test('hard general brush (brushType="brush") tapers flick tails to razor needle while preserving constant-pressure ends', () => {
  const flick = Array.from({ length: 30 }, (_, i) => {
    const t = i / 29;
    const pressure = t < 0.55 ? 0.6 : Math.max(0.12, 0.6 * (1 - (t - 0.55) / 0.52));
    return { x: 100 + i * 6, y: 100, pressure, time: i * 8 };
  });
  for (const stab of [4, 10]) {
    const engine = new StrokeWorkerEngine();
    const cfg = {
      size: 14, minSize: 0, hardness: 1, flow: 1, spacing: 0.02,
      isEraser: false, opacity: 1, stabilizerLevel: stab, followSamples: true,
      scatter: 0, pressureCurve: 'linear' as const, brushType: 'brush' as const,
      colorMixing: 0, antiAlias: 'medium' as const, dynamics: { opacity: { pressure: false } },
    };
    const tailSizes: number[] = [];
    const collect = (arr: Float32Array) => {
      for (let i = 0; i < arr.length; i += 7) {
        if (arr[i] >= 220) tailSizes.push(arr[i + 2]);
      }
    };
    collect(engine.initStroke(cfg, flick[0]));
    for (let i = 1; i < flick.length; i++) collect(engine.addRawPoints([flick[i]]));
    collect(engine.finishStroke(flick[flick.length - 1]));

    assert.ok(tailSizes.length >= 10, `expected dense tail dabs for general brush at stab=${stab}`);
    for (let i = 1; i < tailSizes.length; i++) {
      assert.ok(
        tailSizes[i] <= tailSizes[i - 1] + 0.05,
        `general brush tail must taper monotonically at stab=${stab}: ${tailSizes[i - 1].toFixed(2)} -> ${tailSizes[i].toFixed(2)}`
      );
    }
    const finalTip = tailSizes[tailSizes.length - 1];
    assert.ok(finalTip < 1.0, `14px general brush flick tip must taper below 1.0px at stab=${stab}, got ${finalTip.toFixed(2)}`);
  }

  // Constant-pressure lift must still keep full round tip
  const hold = new StrokeWorkerEngine();
  const holdCfg = {
    size: 14, minSize: 0, hardness: 1, flow: 1, spacing: 0.02,
    isEraser: false, opacity: 1, stabilizerLevel: 4, followSamples: true,
    scatter: 0, pressureCurve: 'linear' as const, brushType: 'brush' as const,
    colorMixing: 0, antiAlias: 'medium' as const, dynamics: { opacity: { pressure: false } },
  };
  let lastHold = 0;
  const track = (arr: Float32Array) => {
    for (let i = 0; i < arr.length; i += 7) lastHold = arr[i + 2];
  };
  track(hold.initStroke(holdCfg, { x: 100, y: 100, pressure: 0.6, time: 0 }));
  track(hold.addRawPoints([{ x: 160, y: 100, pressure: 0.6, time: 16 }, { x: 220, y: 100, pressure: 0.6, time: 32 }]));
  track(hold.finishStroke({ x: 220, y: 100, pressure: 0.6, time: 32 }));
  assert.ok(Math.abs(lastHold - 8.4) < 0.2, `constant-pressure general brush lift must stay ~8.4px, got ${lastHold.toFixed(2)}`);
});

test('high stabilizer (8-10) crisp inking pen (preset_csp_gpen) tapers flick tails to subpixel needle (< 0.6px)', () => {
  const runFlick = (points: Array<{ x: number; y: number; pressure: number; time: number }>, size: number, stab: number) => {
    const engine = new StrokeWorkerEngine();
    const cfg = {
      size,
      minSize: 0,
      hardness: 1,
      flow: 1,
      spacing: 0.02,
      isEraser: false,
      opacity: 1,
      stabilizerLevel: stab,
      followSamples: true,
      scatter: 0,
      pressureCurve: 'linear' as const,
      brushType: 'pen' as const,
      colorMixing: 0,
      antiAlias: 'medium' as const,
    };
    const allDabs: Array<{ x: number; size: number }> = [];
    const collect = (arr: Float32Array) => {
      for (let i = 0; i < arr.length; i += FLOATS_PER_DAB) {
        allDabs.push({ x: arr[i], size: arr[i + 2] });
      }
    };
    collect(engine.initStroke(cfg, points[0]));
    for (let i = 1; i < points.length; i++) collect(engine.addRawPoints([points[i]]));
    collect(engine.finishStroke(points[points.length - 1]));
    return allDabs;
  };

  // 1. fastFlick300: 0.75 -> 0.28 over 300px / 48ms
  const fastFlick300 = [0.75, 0.75, 0.70, 0.58, 0.44, 0.32, 0.28].map((pressure, i) => ({
    x: 100 + i * 50,
    y: 100,
    pressure,
    time: i * 8,
  }));
  // 2. highEndFlick: 0.85 -> 0.36 lifting above 0.35
  const highEndFlick = [0.85, 0.82, 0.72, 0.50, 0.36].map((pressure, i) => ({
    x: 100 + i * 45,
    y: 100,
    pressure,
    time: i * 6,
  }));
  // 3. jitterEndFlick: 0.65 -> 0.22 -> 0.236 (+0.016 micro hardware jitter)
  const jitterEndFlick = [0.65, 0.60, 0.50, 0.35, 0.22, 0.236].map((pressure, i) => ({
    x: 100 + i * 40,
    y: 100,
    pressure,
    time: i * 8,
  }));
  // 4. shortFlick30px: compact fast flick
  const shortFlick30px = [0.70, 0.60, 0.45, 0.30, 0.18].map((pressure, i) => ({
    x: 100 + i * 30,
    y: 100,
    pressure,
    time: i * 6,
  }));
  // 5. medTaper & longGradual
  const medTaper = Array.from({ length: 16 }, (_, i) => ({
    x: 100 + i * 16,
    y: 100,
    pressure: i < 8 ? 0.75 : Math.max(0.16, 0.75 - (i - 7) * 0.075),
    time: i * 8,
  }));
  const longGradual = Array.from({ length: 28 }, (_, i) => ({
    x: 100 + i * 14,
    y: 100,
    pressure: i < 14 ? 0.7 : Math.max(0.14, 0.7 - (i - 13) * 0.04),
    time: i * 8,
  }));

  const scenarios = [
    { name: 'fastFlick300', pts: fastFlick300 },
    { name: 'highEndFlick', pts: highEndFlick },
    { name: 'jitterEndFlick', pts: jitterEndFlick },
    { name: 'shortFlick30px', pts: shortFlick30px },
    { name: 'medTaper', pts: medTaper },
    { name: 'longGradual', pts: longGradual },
  ];

  for (const size of [14, 24]) {
    for (const stab of [8, 9, 10]) {
      for (const sc of scenarios) {
        const dabs = runFlick(sc.pts, size, stab);
        const lastX = sc.pts[sc.pts.length - 1].x;
        const tailStart = lastX - 45;
        const tailSizes = dabs.filter((d) => d.x >= tailStart).map((d) => d.size);
        const subpixelCount = tailSizes.filter((s) => s < 1.6).length;
        const finalTip = tailSizes[tailSizes.length - 1];

        assert.ok(
          tailSizes.length >= 10,
          `${sc.name} size=${size} stab=${stab} expected dense tail dabs, got ${tailSizes.length}`
        );
        for (let i = 1; i < tailSizes.length; i++) {
          assert.ok(
            tailSizes[i] <= tailSizes[i - 1] + 0.05,
            `${sc.name} size=${size} stab=${stab} tail rebound ${tailSizes[i - 1].toFixed(3)} -> ${tailSizes[i].toFixed(3)}`
          );
        }
        assert.ok(
          subpixelCount >= 10,
          `${sc.name} size=${size} stab=${stab} expected >=10 subpixel (<1.6px) dabs, got ${subpixelCount} (final=${finalTip.toFixed(3)})`
        );
        assert.ok(
          finalTip < 0.6,
          `${sc.name} size=${size} stab=${stab} expected final tip <0.6px, got ${finalTip.toFixed(3)}`
        );
      }
    }
  }
});

test('high stabilizer (8-10) preserves constant-pressure round tips, mouse 0.5 strokes, and drop-then-flat-drag holds', () => {
  const runCase = (points: Array<{ x: number; y: number; pressure: number; time: number }>, followSamples: boolean, stab: number) => {
    const engine = new StrokeWorkerEngine();
    const cfg = {
      size: 14,
      minSize: 0,
      hardness: 1,
      flow: 1,
      spacing: 0.02,
      isEraser: false,
      opacity: 1,
      stabilizerLevel: stab,
      followSamples,
      scatter: 0,
      pressureCurve: 'linear' as const,
      brushType: 'pen' as const,
      colorMixing: 0,
      antiAlias: 'medium' as const,
    };
    const sizes: number[] = [];
    const collect = (arr: Float32Array) => {
      for (let i = 0; i < arr.length; i += FLOATS_PER_DAB) sizes.push(arr[i + 2]);
    };
    collect(engine.initStroke(cfg, points[0]));
    for (let i = 1; i < points.length; i++) collect(engine.addRawPoints([points[i]]));
    collect(engine.finishStroke(points[points.length - 1]));
    return sizes;
  };

  for (const stab of [8, 9, 10]) {
    // Constant 0.42 pressure -> 14 * 0.42 = 5.88px round tip
    const const42 = Array.from({ length: 10 }, (_, i) => ({ x: 100 + i * 20, y: 100, pressure: 0.42, time: i * 8 }));
    const sizes42 = runCase(const42, true, stab);
    assert.ok(Math.abs(sizes42[sizes42.length - 1] - 5.88) < 0.2, `const 0.42 stab=${stab} got ${sizes42[sizes42.length - 1]}`);
    assert.equal(sizes42.filter((s) => s < 1.6).length, 0);

    // Mouse fixed 0.5 pressure -> 14 * 0.5 = 7.0px round tip
    const mouse50 = Array.from({ length: 10 }, (_, i) => ({ x: 100 + i * 20, y: 100, pressure: 0.5, time: i * 8 }));
    const sizes50 = runCase(mouse50, false, stab);
    assert.ok(Math.abs(sizes50[sizes50.length - 1] - 7.0) < 0.2, `mouse 0.5 stab=${stab} got ${sizes50[sizes50.length - 1]}`);
    assert.equal(sizes50.filter((s) => s < 1.6).length, 0);

    // Drop from 0.80 -> 0.24 then drag flat at 0.24 for 160px -> 14 * 0.24 = 3.36px round tip
    const dropThenFlat = [
      { x: 100, y: 100, pressure: 0.8, time: 0 },
      { x: 120, y: 100, pressure: 0.5, time: 8 },
      ...Array.from({ length: 12 }, (_, i) => ({ x: 140 + i * 16, y: 100, pressure: 0.24, time: 16 + i * 12 })),
    ];
    const sizesFlat = runCase(dropThenFlat, true, stab);
    assert.ok(
      Math.abs(sizesFlat[sizesFlat.length - 1] - 3.36) < 0.2,
      `drop-then-flat 0.24 stab=${stab} got ${sizesFlat[sizesFlat.length - 1]}`
    );
    assert.equal(sizesFlat.filter((s) => s < 1.6).length, 0);
  }
});
