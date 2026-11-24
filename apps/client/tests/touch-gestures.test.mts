import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyMultiFingerTap,
  computeLoupePosition,
  DEFAULT_TOUCH_GESTURE_SETTINGS,
  detectThreeFingerSwipeDown,
  getCanvasFullscreen,
  getTouchGestureSettings,
  MAX_LONG_PRESS_DELAY_MS,
  MIN_LONG_PRESS_DELAY_MS,
  normalizeTouchGestureSettings,
  QuickPinchTracker,
  resetTouchGestureSettings,
  setCanvasFullscreen,
  subscribeCanvasFullscreen,
  subscribeTouchGestureSettings,
  toggleCanvasFullscreen,
  TOUCH_GESTURES_KEY,
  updateTouchGestureSettings,
} from '../src/engine/touchGestures.ts';

function installLocalStorageMock(initial: Record<string, string> = {}) {
  const prev = (globalThis as any).localStorage;
  const store = new Map<string, string>(Object.entries(initial));
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  return {
    store,
    restore: () => {
      if (prev === undefined) delete (globalThis as any).localStorage;
      else (globalThis as any).localStorage = prev;
    },
  };
}

test('normalizeTouchGestureSettings enforces defaults, valid enums, and delay bounds', () => {
  assert.deepEqual(normalizeTouchGestureSettings(null), DEFAULT_TOUCH_GESTURE_SETTINGS);
  assert.equal(DEFAULT_TOUCH_GESTURE_SETTINGS.longPressAction, 'radial');
  assert.equal(DEFAULT_TOUCH_GESTURE_SETTINGS.singleFingerMode, 'draw');

  const clamped = normalizeTouchGestureSettings({
    longPressAction: 'invalid' as any,
    singleFingerMode: 'bogus' as any,
    longPressDelayMs: 50,
    quickPinchToFit: false,
  });
  assert.equal(clamped.longPressAction, 'radial');
  assert.equal(clamped.singleFingerMode, 'draw');
  assert.equal(clamped.longPressDelayMs, MIN_LONG_PRESS_DELAY_MS);
  assert.equal(clamped.quickPinchToFit, false);

  const high = normalizeTouchGestureSettings({
    longPressAction: 'eyedropper',
    singleFingerMode: 'pan',
    longPressDelayMs: 9999,
  });
  assert.equal(high.longPressAction, 'eyedropper');
  assert.equal(high.singleFingerMode, 'pan');
  assert.equal(high.longPressDelayMs, MAX_LONG_PRESS_DELAY_MS);
});

test('touch gesture store persists updates, notifies subscribers, and resets cleanly', () => {
  const mock = installLocalStorageMock();
  try {
    resetTouchGestureSettings();
    let notifications = 0;
    const unsub = subscribeTouchGestureSettings(() => { notifications++; });

    updateTouchGestureSettings({ longPressAction: 'eyedropper', singleFingerMode: 'pan', longPressDelayMs: 350 });
    assert.equal(notifications, 1);
    assert.equal(getTouchGestureSettings().longPressAction, 'eyedropper');
    assert.equal(getTouchGestureSettings().singleFingerMode, 'pan');
    assert.equal(getTouchGestureSettings().longPressDelayMs, 350);

    const saved = JSON.parse(mock.store.get(TOUCH_GESTURES_KEY) ?? '{}');
    assert.equal(saved.longPressAction, 'eyedropper');
    assert.equal(saved.singleFingerMode, 'pan');

    // No-op patch should not fire subscribers
    updateTouchGestureSettings({ longPressAction: 'eyedropper' });
    assert.equal(notifications, 1);

    resetTouchGestureSettings();
    assert.equal(notifications, 2);
    assert.deepEqual(getTouchGestureSettings(), DEFAULT_TOUCH_GESTURE_SETTINGS);
    unsub();
  } finally {
    resetTouchGestureSettings();
    mock.restore();
  }
});

test('canvas fullscreen store toggles and notifies subscribers without redundant events', () => {
  setCanvasFullscreen(false);
  let calls = 0;
  const unsub = subscribeCanvasFullscreen(() => { calls++; });
  try {
    assert.equal(getCanvasFullscreen(), false);
    assert.equal(toggleCanvasFullscreen(), true);
    assert.equal(getCanvasFullscreen(), true);
    assert.equal(calls, 1);

    // Setting same value is a no-op
    assert.equal(setCanvasFullscreen(true), true);
    assert.equal(calls, 1);

    assert.equal(toggleCanvasFullscreen(), false);
    assert.equal(calls, 2);
  } finally {
    setCanvasFullscreen(false);
    unsub();
  }
});

test('QuickPinchTracker triggers fit on rapid inward pinch and rejects slow zoom or zoom-out-then-in', () => {
  // Fast inward pinch: 240px -> 120px in 130ms
  const fast = new QuickPinchTracker(240, 1000);
  fast.record(210, 1040);
  fast.record(170, 1085);
  fast.record(120, 1130);
  assert.equal(fast.shouldFitOnRelease(1135), true);

  // Slow intentional zoom out: 240px -> 140px over 650ms
  const slow = new QuickPinchTracker(240, 2000);
  slow.record(200, 2250);
  slow.record(170, 2450);
  slow.record(140, 2650);
  assert.equal(slow.shouldFitOnRelease(2660), false);

  // Expanded significantly first, then pulled back
  const bounce = new QuickPinchTracker(180, 3000);
  bounce.record(240, 3050);
  bounce.record(120, 3140);
  assert.equal(bounce.shouldFitOnRelease(3150), false);

  // Tiny initial finger distance rejected
  const tiny = new QuickPinchTracker(40, 4000);
  tiny.record(15, 4090);
  assert.equal(tiny.shouldFitOnRelease(4100), false);
});

test('detectThreeFingerSwipeDown triggers on decisive downward 3-finger swipe and rejects horizontal or 2-finger', () => {
  const starts = new Map([
    [1, { x: 100, y: 200 }],
    [2, { x: 150, y: 205 }],
    [3, { x: 200, y: 198 }],
  ]);

  const good = new Map([
    [1, { x: 106, y: 286 }],
    [2, { x: 154, y: 290 }],
    [3, { x: 208, y: 280 }],
  ]);
  const res = detectThreeFingerSwipeDown(starts, good);
  assert.equal(res.triggered, true);
  assert.ok(res.centroid.x > 140 && res.centroid.x < 170);
  assert.ok(res.centroid.y > 275);

  // Horizontal 3-finger drag rejected
  const horizontal = new Map([
    [1, { x: 220, y: 250 }],
    [2, { x: 270, y: 255 }],
    [3, { x: 320, y: 248 }],
  ]);
  assert.equal(detectThreeFingerSwipeDown(starts, horizontal).triggered, false);

  // Only 2 fingers rejected
  const twoFingers = new Map([
    [1, { x: 100, y: 310 }],
    [2, { x: 150, y: 315 }],
  ]);
  assert.equal(detectThreeFingerSwipeDown(starts, twoFingers).triggered, false);
});

test('classifyMultiFingerTap cleanly distinguishes 2-finger undo, 3-finger redo, 4-finger fullscreen, and suppresses conflicts', () => {
  const base = {
    hasMoved: false,
    durationMs: 180,
    cancelled: false,
    rapidTriggered: false,
    swipeTriggered: false,
    quickPinchTriggered: false,
    fourFingerFullscreenEnabled: true,
  };

  assert.equal(classifyMultiFingerTap({ ...base, maxPointers: 2 }), 'undo');
  assert.equal(classifyMultiFingerTap({ ...base, maxPointers: 3 }), 'redo');
  assert.equal(classifyMultiFingerTap({ ...base, maxPointers: 4 }), 'fullscreen');
  assert.equal(classifyMultiFingerTap({ ...base, maxPointers: 4, fourFingerFullscreenEnabled: false }), null);

  // Suppressed if rapid hold, quick pinch, swipe, movement, cancel, or timeout happened
  assert.equal(classifyMultiFingerTap({ ...base, maxPointers: 2, rapidTriggered: true }), null);
  assert.equal(classifyMultiFingerTap({ ...base, maxPointers: 2, quickPinchTriggered: true }), null);
  assert.equal(classifyMultiFingerTap({ ...base, maxPointers: 3, swipeTriggered: true }), null);
  assert.equal(classifyMultiFingerTap({ ...base, maxPointers: 4, hasMoved: true }), null);
  assert.equal(classifyMultiFingerTap({ ...base, maxPointers: 2, durationMs: 520 }), null);
  assert.equal(classifyMultiFingerTap({ ...base, maxPointers: 2, cancelled: true }), null);
});

test('computeLoupePosition lifts above finger and flips below near the top edge without leaving viewport', () => {
  const mid = computeLoupePosition(200, 300, 390, 844, 68, 48);
  assert.equal(mid.x, 200);
  assert.equal(mid.y, 232);

  // Near top edge: flips below fingertip so it never clips off top
  const top = computeLoupePosition(200, 40, 390, 844, 68, 48);
  assert.equal(top.y, 108);

  // Near left/right edges: clamped safely inside viewport
  const left = computeLoupePosition(10, 300, 390, 844, 68, 48);
  assert.equal(left.x, 58);
  const right = computeLoupePosition(385, 300, 390, 844, 68, 48);
  assert.equal(right.x, 332);
});
