import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LuminaProjectEngine, type UnpackedLuminaProject } from '../src/engine/LuminaProjectEngine.ts';
import { ApiService } from '../src/services/api.ts';
import { OfflineSessionStore } from '../src/services/offlineStore.ts';

const canvasDto = { title: 'Offline restore', width: 128, height: 128 };
const importedNames = ['First root', 'Second root', 'Third root', 'Fourth root'];

test('offline canvas creation, listing and reordering return detached layer snapshots', async (t) => {
  t.mock.method(OfflineSessionStore, 'persistRecordNow', async () => {});
  const { canvas, layers: defaults } = await OfflineSessionStore.createCanvas(canvasDto);
  t.after(() => OfflineSessionStore.deleteCanvas(canvas.id));
  assert.equal(defaults.length, 1);
  const defaultName = defaults[0].name;
  canvas.title = 'Changed returned canvas';
  defaults[0].name = 'Changed returned default layer';
  assert.equal((await OfflineSessionStore.getCanvas(canvas.id)).canvas.title, canvasDto.title);
  assert.equal((await OfflineSessionStore.listLayers(canvas.id))[0].name, defaultName);

  const importedIds: string[] = [];
  for (const name of importedNames) {
    const layer = await OfflineSessionStore.createLayer(canvas.id, { name });
    importedIds.push(layer.id);
  }
  assert.equal(defaults.length, 1);
  for (const layer of defaults) await OfflineSessionStore.deleteLayer(canvas.id, layer.id);

  const listed = await OfflineSessionStore.listLayers(canvas.id);
  assert.deepEqual(listed.map((l) => l.id), importedIds);
  listed[0].name = 'Changed listed layer';
  const reordered = await OfflineSessionStore.reorderLayers(canvas.id, importedIds);
  assert.deepEqual(reordered.map((l) => l.name), importedNames);
  reordered[0].name = 'Changed reordered layer';
  assert.deepEqual((await OfflineSessionStore.listLayers(canvas.id)).map((l) => l.name), importedNames);
});

test('project restore snapshots its default layers before createLayer mutates the API response', async (t) => {
  t.mock.method(OfflineSessionStore, 'persistRecordNow', async () => {});
  const { canvas, layers: defaults } = await OfflineSessionStore.createCanvas(canvasDto);
  t.after(() => OfflineSessionStore.deleteCanvas(canvas.id));
  const [defaultLayer] = defaults;
  const project: UnpackedLuminaProject = {
    meta: {
      schemaVersion: 1,
      appVersion: '1.0.0',
      format: 'lumina-drift-project',
      createdAt: 0,
      updatedAt: 0,
      canvas,
      layerCount: importedNames.length,
      checksum: '',
    },
    layers: importedNames.map((name, i) => ({
      ...defaultLayer,
      id: `source-${i}`,
      name,
      sortOrder: (i + 1) * 10,
    })),
    layerPngDataUrls: {},
    vectorStrokes: {},
    previewDataUrl: null,
  };

  t.mock.method(ApiService, 'createCanvas', async () => ({ canvas, layers: defaults }));
  t.mock.method(ApiService, 'createLayer', async (...args: Parameters<typeof ApiService.createLayer>) => {
    const layer = await OfflineSessionStore.createLayer(...args);
    // Replace the defaults entry with the first imported layer to exercise the ID snapshot.
    if (defaults[0] === defaultLayer) defaults.splice(0, 1, layer);
    return layer;
  });
  // The normal API routes these operations to the offline store for a local canvas.
  const update = t.mock.method(ApiService, 'updateLayer');
  const remove = t.mock.method(ApiService, 'deleteLayer');

  assert.equal((await LuminaProjectEngine.restoreToCanvas(project)).id, canvas.id);
  assert.equal(defaults[0].name, importedNames[0]);
  assert.deepEqual(update.mock.calls.map(({ arguments: args }) => args[1]), [defaultLayer.id]);
  assert.deepEqual(remove.mock.calls.map(({ arguments: args }) => args[1]), [defaultLayer.id]);
  assert.deepEqual((await OfflineSessionStore.listLayers(canvas.id)).map((l) => l.name), importedNames);
});
