import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SelectionEngine } from '../src/engine/SelectionEngine.ts';

test('magic wand draws the pixel contour and keeps holes and separate islands', () => {
  const previousRequest = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const engine = new SelectionEngine(7, 5);
  try {
    const points = [[1, 1], [2, 1], [3, 1], [1, 2], [3, 2], [1, 3], [2, 3], [3, 3], [5, 2]];
    const pixels = new Uint8Array(7 * 5 * 4);
    for (const [x, y] of points) pixels.set([255, 0, 0, 255], (y * 7 + x) * 4);

    engine.selectWand(pixels, 1, 1, 0, true);
    assert.equal(engine.getMaskData()?.activePixelCount, 8);
    assert.equal(engine.getMaskArray()?.[2 * 7 + 2], 0);
    assert.equal(engine.getMaskGraphic()?.containsPoint({ x: 2.5, y: 2.5 }), false);
    assert.equal(engine.getMaskGraphic()?.containsPoint({ x: 1.5, y: 2.5 }), true);
    assert.equal(engine.getMaskGraphic()?.containsPoint({ x: 5.5, y: 2.5 }), false);

    engine.selectWand(pixels, 1, 1, 0, false);
    assert.equal(engine.getMaskData()?.activePixelCount, 9);
    assert.equal(engine.getMaskGraphic()?.containsPoint({ x: 5.5, y: 2.5 }), true);
    assert.equal(engine.getMaskGraphic()?.containsPoint({ x: 4.5, y: 2.5 }), false);
  } finally {
    engine.destroy();
    globalThis.requestAnimationFrame = previousRequest;
    globalThis.cancelAnimationFrame = previousCancel;
  }
});
