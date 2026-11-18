import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CanvasViewport } from '../src/engine/Viewport.ts';
import { projectTransformBox } from '../src/utils/transformProjection.ts';

test('zoom keeps the pointer over the same canvas point inside an offset workspace', () => {
  const viewport = new CanvasViewport(2048, 1024);
  const left = 90;
  const top = 88;
  viewport.setDomElement({
    getBoundingClientRect: () => ({ left, top }),
  } as HTMLElement);
  const pointer = { x: 413, y: 271 };

  for (const rotation of [0, Math.PI / 7]) {
    for (const mirror of [false, true]) {
      viewport.centerInView(720, 590);
      viewport.panBy(37, -24);
      viewport.setRotation(rotation);
      viewport.setMirrorX(mirror);
      const anchor = viewport.screenToCanvas(pointer.x, pointer.y);

      for (const [factor, count, limit] of [[1.12, 70, 32], [1 / 1.12, 80, 0.05]]) {
        for (let step = 0; step < count; step++) {
          viewport.zoomAt(pointer.x, pointer.y, factor);
          const projected = viewport.canvasToScreen(anchor.x, anchor.y);
          assert.ok(Math.abs(projected.x - (pointer.x - left)) < 1e-7);
          assert.ok(Math.abs(projected.y - (pointer.y - top)) < 1e-7);
        }
        assert.equal(viewport.getState().zoom, limit);
      }
    }
  }
});

test('fit centers a large drawing in a narrow viewport', () => {
  const viewport = new CanvasViewport(16384, 8192);
  viewport.centerInView(375, 420);
  const topLeft = viewport.canvasToScreen(0, 0);
  const bottomRight = viewport.canvasToScreen(16384, 8192);

  assert.deepEqual(viewport.canvasToScreen(8192, 4096), { x: 187.5, y: 210 });
  assert.ok(topLeft.x >= 0 && topLeft.y >= 0);
  assert.ok(bottomRight.x <= 375 && bottomRight.y <= 420);
});

test('free-transform handles project the same corners as the applied pixels in rotated and mirrored views', () => {
  const viewport = new CanvasViewport(512, 512);
  viewport.centerInView(640, 480);
  viewport.setRotation(Math.PI / 6);
  viewport.panBy(25, -40);
  const project = viewport.canvasToScreen.bind(viewport);

  for (const mirrorX of [false, true]) {
    viewport.setMirrorX(mirrorX);
    for (const width of [170, -170]) {
      for (const height of [80, -80]) {
        const box = { x: 100, y: 130, width, height, rotation: Math.PI / 5 };
        const screen = projectTransformBox(box, viewport.getState().zoom, project);
        const [a, b, c, d] = screen.matrix;
        for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
          const localX = (u - 0.5) * width;
          const localY = (v - 0.5) * height;
          const expected = project(
            box.x + width / 2 + localX * Math.cos(box.rotation) - localY * Math.sin(box.rotation),
            box.y + height / 2 + localX * Math.sin(box.rotation) + localY * Math.cos(box.rotation),
          );
          const x = (u - 0.5) * screen.width;
          const y = (v - 0.5) * screen.height;
          assert.ok(Math.abs(expected.x - (screen.left + screen.width / 2 + a * x + c * y)) < 1e-7);
          assert.ok(Math.abs(expected.y - (screen.top + screen.height / 2 + b * x + d * y)) < 1e-7);
        }
      }
    }
  }
});
