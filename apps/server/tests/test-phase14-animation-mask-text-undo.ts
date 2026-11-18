import assert from 'node:assert';
import { io as ClientSocket, Socket } from 'socket.io-client';
import * as socketParser from 'socket.io-parser';
import { buildApp } from '../src/app';
import { autoCreateCheckpoint, getLatestSnapshot } from '../src/services/snapshot.service';
import { compressTileBuffer, mergeUndoPixels, mergeUndoTile, tileToRgba, tileSocketParser, TileData } from '@atelier/shared';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function solidTile(col: number, row: number, rgba: [number, number, number, number]): TileData {
  const px = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < px.length; i += 4) px.set(rgba, i);
  const { compression, data } = compressTileBuffer(px, 'lz4');
  return { col, row, width: 256, height: 256, compression, data };
}

async function runTest() {
  console.log('🚀 Phase 14: animation folders, layer masks, text layers & three-way undo\n');

  // --- 0. Three-way undo merge (pure) ---
  const before = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 9]);
  const mine = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 9, 9, 9, 9]);
  // pixel 0 still mine, pixel 1 painted over by someone else, pixel 2 untouched by me
  const current = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255, 1, 2, 3, 4]);
  const undo = mergeUndoPixels(before, mine, current);
  assert.deepStrictEqual(Array.from(undo.pixels), [0, 0, 0, 0, 0, 0, 255, 255, 1, 2, 3, 4]);
  assert.strictEqual(undo.conflicts, 1, 'the pixel another painter changed is a conflict');
  // redo is the same merge the other way round
  const redo = mergeUndoPixels(mine, before, undo.pixels);
  assert.deepStrictEqual(Array.from(redo.pixels), [255, 0, 0, 255, 0, 0, 255, 255, 1, 2, 3, 4]);
  // Same colour painted over mine by someone else: the footprint keeps it
  const sameColour = mergeUndoPixels(before, mine, mine, new Uint8Array([1, 0, 0]));
  assert.deepStrictEqual(Array.from(sameColour.pixels), [255, 0, 0, 255, 0, 0, 0, 0, 9, 9, 9, 9]);
  assert.strictEqual(sameColour.conflicts, 1);
  const merged = mergeUndoTile(solidTile(0, 0, [0, 0, 0, 0]), solidTile(0, 0, [10, 20, 30, 255]), tileToRgba(solidTile(0, 0, [10, 20, 30, 255])));
  assert.strictEqual(merged.conflicts, 0);
  assert.strictEqual(tileToRgba(merged.tile)[3], 0, 'an untouched tile is fully reverted');
  console.log("✓ mergeUndoPixels keeps other painters' later pixels and counts conflicts");

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];

  const api = async (token: string, method: string, url: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      // Fastify rejects an empty body sent as JSON (DELETE)
      headers: body === undefined ? { Authorization: `Bearer ${token}` } : { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  try {
    const runId = Date.now().toString().slice(-5);
    const register = async (name: string) => {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `${name}_p14_${runId}`, password: 'password123', displayName: name }),
      });
      return (await res.json()) as { token: string; user: { id: string } };
    };
    const alice = await register('alice');
    const bob = await register('bob');

    const { data: canvasData } = await api(alice.token, 'POST', '/api/canvases', { title: 'P14', width: 512, height: 512 });
    const canvasId = canvasData.canvas.id as string;
    const layersUrl = `/api/canvases/${canvasId}/layers`;
    const getLayers = async () => (await api(alice.token, 'GET', layersUrl)).data.layers as any[];
    await api(bob.token, 'POST', '/api/canvases/join', { canvasId });

    // --- 1. Animation folder: frames are child layers, saved and ordered on the server ---
    const folder = await api(alice.token, 'POST', layersUrl, { name: '動畫', layerType: 'group', meta: { animation: { fps: 8 } } });
    assert.strictEqual(folder.status, 201);
    assert.deepStrictEqual(folder.data.layer.meta, { animation: { fps: 8 } });
    const frames: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const f = await api(alice.token, 'POST', layersUrl, { name: `${i}`, parentId: folder.data.layer.id });
      assert.strictEqual(f.status, 201);
      frames.push(f.data.layer.id);
    }
    let all = await getLayers();
    assert.strictEqual(all.filter((l) => l.parentId === folder.data.layer.id).length, 3);
    assert.deepStrictEqual(all.find((l) => l.id === folder.data.layer.id).meta, { animation: { fps: 8 } }, 'folder meta survives a reload');

    const fpsPatch = await api(alice.token, 'PATCH', `${layersUrl}/${folder.data.layer.id}`, { meta: { animation: { fps: 24 } } });
    assert.strictEqual(fpsPatch.data.layer.meta.animation.fps, 24);

    // Move frame 3 to the front
    const ids = all.sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.id).filter((id) => !frames.includes(id));
    const reordered = [...ids, frames[2], frames[0], frames[1]];
    assert.strictEqual((await api(alice.token, 'POST', `${layersUrl}/reorder`, { layerIds: reordered })).status, 200);
    all = await getLayers();
    const order = all.filter((l) => frames.includes(l.id)).sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.id);
    assert.deepStrictEqual(order, [frames[2], frames[0], frames[1]]);
    console.log('✓ Animation folder meta, frame layers and frame order persist');

    // --- 2. Layer mask rules ---
    const art = (await api(alice.token, 'POST', layersUrl, { name: '上色' })).data.layer;
    const mask = await api(alice.token, 'POST', layersUrl, { name: '蒙版', layerType: 'mask', parentId: art.id });
    assert.strictEqual(mask.status, 201);
    assert.strictEqual((await api(alice.token, 'POST', layersUrl, { name: 'x', layerType: 'mask', parentId: art.id })).status, 400, 'one mask per layer');
    assert.strictEqual((await api(alice.token, 'POST', layersUrl, { name: 'x', layerType: 'mask', parentId: 'nope' })).status, 400);
    assert.strictEqual((await api(alice.token, 'POST', layersUrl, { name: 'x', layerType: 'mask', parentId: folder.data.layer.id })).status, 201, 'groups take a mask too');
    assert.strictEqual((await api(alice.token, 'POST', layersUrl, { name: 'x', layerType: 'mask', parentId: mask.data.layer.id })).status, 400, 'no mask on a mask');
    assert.strictEqual((await api(bob.token, 'POST', layersUrl, { name: 'x', layerType: 'mask', parentId: frames[0] })).status, 403, "bob cannot mask alice's layer");
    const bobArt = (await api(bob.token, 'POST', layersUrl, { name: 'bob 的圖層' })).data.layer;
    assert.strictEqual((await api(bob.token, 'POST', layersUrl, { name: 'x', layerType: 'mask', parentId: bobArt.id })).status, 201, 'bob masks his own layer');
    assert.strictEqual((await api(bob.token, 'PATCH', `${layersUrl}/${mask.data.layer.id}`, { isVisible: false })).status, 403, 'mask props follow the layer owner');
    assert.strictEqual((await api(alice.token, 'PATCH', `${layersUrl}/${mask.data.layer.id}`, { isVisible: false })).status, 200, 'owner can disable her mask');
    console.log('✓ Mask creation rules and owner-only mask properties');

    // --- 3. Pixels on frames and masks go through the op log, ACL'd like their layer ---
    const connect = (token: string) => {
      const s = ClientSocket(baseUrl, { auth: { token, canvasId }, transports: ['websocket'], parser: tileSocketParser(socketParser) });
      sockets.push(s);
      return new Promise<Socket>((resolve) => s.on('connect', () => resolve(s)));
    };
    const sa = await connect(alice.token);
    const sb = await connect(bob.token);
    sa.emit('join_canvas', { canvasId });
    sb.emit('join_canvas', { canvasId });
    await sleep(250);

    const bobSaw: any[] = [];
    sb.on('op_broadcast', (op) => bobSaw.push(op));
    const bobRejected: any[] = [];
    sb.on('op_rejected', (r) => bobRejected.push(r));

    sa.emit('tile_patch', { type: 'TILE_PATCH', canvasId, layerId: frames[0], tiles: [solidTile(0, 0, [255, 0, 0, 255])] });
    sa.emit('tile_patch', { type: 'TILE_PATCH', canvasId, layerId: mask.data.layer.id, tiles: [solidTile(1, 0, [255, 255, 255, 255])] });
    await sleep(300);
    assert.deepStrictEqual(bobSaw.map((o) => o.layerId), [frames[0], mask.data.layer.id], 'frame and mask edits reach the room');

    sb.emit('tile_patch', { type: 'TILE_PATCH', canvasId, layerId: mask.data.layer.id, tiles: [solidTile(0, 0, [0, 0, 0, 255])] });
    await sleep(250);
    assert.strictEqual(bobRejected.length, 1, "bob cannot paint alice's mask");

    autoCreateCheckpoint(canvasId);
    const snap = getLatestSnapshot(canvasId)!;
    assert.strictEqual(snap.bundle.layers.find((l) => l.layerId === frames[0])?.tiles.length, 1, 'frame tiles are in the checkpoint');
    assert.strictEqual(snap.bundle.layers.find((l) => l.layerId === mask.data.layer.id)?.tiles.length, 1, 'mask tiles are in the checkpoint');
    console.log('✓ Frame and mask pixels sync, are ACL-checked, and land in checkpoints');

    // Deleting a frame / a masked layer
    assert.strictEqual((await api(alice.token, 'DELETE', `${layersUrl}/${frames[1]}`)).status, 200);
    assert.strictEqual((await api(alice.token, 'DELETE', `${layersUrl}/${art.id}`)).status, 200);
    all = await getLayers();
    assert.ok(!all.some((l) => l.id === frames[1]), 'deleted frame is gone');
    assert.ok(!all.some((l) => l.id === mask.data.layer.id), 'a mask is deleted with its layer');
    console.log('✓ Frame delete and mask cascade');

    // --- 4. Text layers keep an editable source ---
    const textMeta = { content: '你好\n世界', x: 10, y: 20, vertical: true, fontFamily: 'serif', fontSize: 32, color: '#000000', strokeColor: '#ffffff', strokeWidth: 3, lineHeight: 1.4 };
    const text = await api(alice.token, 'POST', layersUrl, { name: '台詞', layerType: 'text', meta: { text: textMeta } });
    assert.strictEqual(text.status, 201);
    assert.deepStrictEqual(text.data.layer.meta.text, textMeta);
    const edited = await api(alice.token, 'PATCH', `${layersUrl}/${text.data.layer.id}`, { meta: { text: { ...textMeta, content: '改過了' } } });
    assert.strictEqual(edited.data.layer.meta.text.content, '改過了');
    assert.strictEqual((await api(alice.token, 'PATCH', `${layersUrl}/${text.data.layer.id}`, { meta: [1] })).status, 400, 'meta must be an object');
    assert.strictEqual((await api(alice.token, 'PATCH', `${layersUrl}/${text.data.layer.id}`, { meta: { text: { content: 'x'.repeat(40000) } } })).status, 400, 'meta is size-capped');
    assert.strictEqual((await api(bob.token, 'PATCH', `${layersUrl}/${text.data.layer.id}`, { meta: { text: textMeta } })).status, 403);
    const raster = await api(alice.token, 'PATCH', `${layersUrl}/${text.data.layer.id}`, { layerType: 'raster' });
    assert.strictEqual(raster.data.layer.layerType, 'raster');
    assert.strictEqual(raster.data.layer.meta, null, 'rasterize drops the text source');
    console.log('✓ Text layer meta create / edit / validate / rasterize');

    console.log('\n🎉 Phase 14 passed');
  } finally {
    sockets.forEach((s) => s.close());
    await app.close();
  }
}

runTest().catch((err) => {
  console.error('❌ Phase 14 failed:', err);
  process.exit(1);
});
