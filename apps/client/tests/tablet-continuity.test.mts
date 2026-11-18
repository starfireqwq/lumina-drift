import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TabletStroke, type TabletPoint } from '../src/engine/tabletInput.ts';

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
