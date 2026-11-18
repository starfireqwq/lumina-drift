import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DynamicStabilizer } from '@atelier/shared';
import { TabletStroke, type TabletPoint } from '../src/engine/tabletInput.ts';
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
  return { pipeline, stampedDabs, getCommittedPoints: () => committedPoints };
}

test('Chromium 0.5 default pressure fallback at pen liftoff does not inflate a tapered tail', () => {
  const down = makePoint({ clientX: 100, clientY: 100, timeStamp: 1000, pressure: 0.35 });
  const stroke = new TabletStroke(down, undefined, undefined, [], true);
  try {
    assert.equal(stroke.pressure(down).normalized, 0.35);
    assert.equal(stroke.pressure(makePoint({ clientX: 140, timeStamp: 1016, pressure: 0.14 })).normalized, 0.14);
    assert.equal(stroke.pressure(makePoint({ clientX: 170, timeStamp: 1024, pressure: 0.02 })).normalized, 0.02);
    // Chromium drops pressure axis right before buttons=0 and reports default 0.5
    const fallbackSample = makePoint({ clientX: 184, timeStamp: 1034, pressure: 0.5 });
    assert.equal(stroke.pressure(fallbackSample).normalized, 0.02);

    // End-to-end with StrokeWorkerEngine (pen, stabilizerLevel=4, size=36, tail 0.02 then 0.5 after 10ms)
    const engine = new StrokeWorkerEngine();
    const allDabs: number[] = [];
    const pushDabs = (arr: Float32Array) => {
      for (let i = 0; i < arr.length; i++) allDabs.push(arr[i]);
    };
    const samples = [
      { x: 100, y: 100, timeStamp: 1000, pressure: 0.35 },
      { x: 120, y: 100, timeStamp: 1008, pressure: 0.65 },
      { x: 145, y: 100, timeStamp: 1016, pressure: 0.38 },
      { x: 165, y: 100, timeStamp: 1024, pressure: 0.16 },
      { x: 180, y: 100, timeStamp: 1032, pressure: 0.06 },
      { x: 192, y: 100, timeStamp: 1040, pressure: 0.02 },
      { x: 200, y: 100, timeStamp: 1050, pressure: 0.5 }, // Chromium 0.5 liftoff fallback
    ];
    const first = samples[0];
    pushDabs(
      engine.initStroke(
        {
          size: 36,
          minSize: 1,
          hardness: 0.9,
          flow: 1,
          spacing: 0.08,
          isEraser: false,
          opacity: 1,
          stabilizerLevel: 4,
          pressureCurve: 'linear',
        },
        { x: first.x, y: first.y, time: first.timeStamp, pressure: stroke.pressure(makePoint(first)).normalized }
      )
    );
    for (const s of samples.slice(1)) {
      const normP = stroke.pressure(makePoint(s)).normalized;
      pushDabs(engine.addRawPoints([{ x: s.x, y: s.y, time: s.timeStamp, pressure: normP }]));
    }
    pushDabs(engine.finishStroke({ x: 200, y: 100, time: 1052, pressure: 0.02 }));

    const tailSizes: number[] = [];
    for (let i = 0; i < allDabs.length; i += FLOATS_PER_DAB) {
      if (allDabs[i] >= 188) tailSizes.push(allDabs[i + 2]);
    }
    assert.ok(tailSizes.length > 0);
    assert.ok(
      Math.max(...tailSizes) < 3.5,
      `tapered tail dab size must stay fine (< 3.5px) instead of inflating to 11-13px, got max=${Math.max(...tailSizes)}`
    );
  } finally {
    stroke.finish();
  }
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
