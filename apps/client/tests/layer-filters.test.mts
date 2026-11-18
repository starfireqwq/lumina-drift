import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LAYER_FILTERS, renderLayerFilter, type LayerFilterId } from '../src/utils/layerFilters.ts';

test('negative preview output keeps premultiplied alpha and preserves unselected pixels', () => {
  const source = new Uint8Array([128, 32, 0, 128, 20, 30, 40, 255, 0, 0, 0, 0]);
  const filtered = renderLayerFilter(source, 3, 1, { id: 'invert', values: [] }, new Uint8Array([255, 0, 255]));
  assert.deepEqual(Array.from(filtered), [0, 96, 128, 128, 20, 30, 40, 255, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(source), [128, 32, 0, 128, 20, 30, 40, 255, 0, 0, 0, 0]);
});

test('adjustable layer filters produce pixels at their defaults', () => {
  const width = 32;
  const height = 32;
  const source = new Uint8Array(width * height * 4);
  for (let i = 0; i < source.length; i += 4) {
    source.set([(i * 3) % 251, (i * 5) % 251, (i * 7) % 251, 255], i);
  }

  for (const id of Object.keys(LAYER_FILTERS) as LayerFilterId[]) {
    const values = LAYER_FILTERS[id].controls.map((control) => control.initial);
    const filtered = renderLayerFilter(source, width, height, { id, values });
    assert.equal(filtered.length, source.length, id);
    assert.ok(filtered.some((value, i) => value !== source[i]), id);
  }
});

test('curve adjustment produces a repeatable preview from the original layer', () => {
  const source = new Uint8Array([128, 128, 128, 255]);
  const filter = { id: 'curves', options: { masterCurve: [{ x: 0, y: 0 }, { x: 128, y: 64 }, { x: 255, y: 255 }] } } as const;
  const options = { masterCurve: [...filter.options.masterCurve] };
  const preview = renderLayerFilter(source, 1, 1, { id: filter.id, options });
  const apply = renderLayerFilter(source, 1, 1, { id: filter.id, options });
  assert.deepEqual(Array.from(preview), [64, 64, 64, 255]);
  assert.deepEqual(preview, apply);
  assert.equal(source[0], 128);
});
