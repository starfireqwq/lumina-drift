import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PIXEL_FILTER_RUNNERS, runPixelFilter } from '@atelier/shared';
import { BUILTIN_FILTERS, normalizeFilterValues } from '../src/utils/filterRegistry.ts';

test('negative preview output keeps premultiplied alpha and preserves unselected pixels', () => {
  const source = new Uint8Array([128, 32, 0, 128, 20, 30, 40, 255, 0, 0, 0, 0]);
  const filtered = runPixelFilter(PIXEL_FILTER_RUNNERS.invert, source, 3, 1, {}, new Uint8Array([255, 0, 255]));
  assert.deepEqual(Array.from(filtered), [0, 96, 128, 128, 20, 30, 40, 255, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(source), [128, 32, 0, 128, 20, 30, 40, 255, 0, 0, 0, 0]);
});

test('all built-in pixel filters have matching runners and execute without mutating source', () => {
  const width = 32;
  const height = 32;
  const source = new Uint8Array(width * height * 4);
  for (let i = 0; i < source.length; i += 4) {
    source.set([(i * 3) % 251, (i * 5) % 251, (i * 7) % 251, 255], i);
  }
  const snapshot = new Uint8Array(source);

  const nonIdentityIds = new Set(['invert', 'grayscale', 'monoTint', 'threshold', 'posterize', 'gaussian', 'mosaic', 'noise']);
  for (const def of BUILTIN_FILTERS) {
    if (def.tool) continue;
    const runner = PIXEL_FILTER_RUNNERS[def.id];
    assert.ok(runner, `missing pixel runner for built-in filter: ${def.id}`);
    const values = normalizeFilterValues(def, {});
    const filtered = runPixelFilter(runner, source, width, height, values);
    assert.equal(filtered.length, source.length, def.id);
    assert.deepEqual(source, snapshot, `filter mutated source pixels: ${def.id}`);
    if (nonIdentityIds.has(def.id)) {
      assert.ok(filtered.some((value, i) => value !== source[i]), `expected pixels to change: ${def.id}`);
    }
  }
});

test('curve adjustment produces a repeatable preview from the original layer', () => {
  const source = new Uint8Array([128, 128, 128, 255]);
  const options = { masterCurve: [{ x: 0, y: 0 }, { x: 128, y: 64 }, { x: 255, y: 255 }] };
  const preview = runPixelFilter(PIXEL_FILTER_RUNNERS.curves, source, 1, 1, { options });
  const apply = runPixelFilter(PIXEL_FILTER_RUNNERS.curves, source, 1, 1, { options });
  assert.deepEqual(Array.from(preview), [64, 64, 64, 255]);
  assert.deepEqual(preview, apply);
  assert.equal(source[0], 128);
});
