import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { io as ClientSocket, Socket } from 'socket.io-client';
import * as socketParser from 'socket.io-parser';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { createCheckpointInBackground, getLatestSnapshot } from '../src/services/snapshot.service';
import { compressTileBuffer, decodePacket, getDirtyTilesForPoints, tileSocketParser, TileData } from '@atelier/shared';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function solidTile(col: number, row: number, rgba: [number, number, number, number]): TileData {
  const px = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < px.length; i += 4) px.set(rgba, i);
  const { compression, data } = compressTileBuffer(px, 'lz4');
  return { col, row, width: 256, height: 256, compression, data };
}

/**
 * Phase 15: animation timeline (cel holds, reused cels, shared folders, moving cels between
 * tracks), group / inverted masks, preview clock sync, the checkpoint worker, and the dirty tiles
 * of a long stroke.
 */
async function runTest() {
  console.log('🚀 Phase 15: timeline, group masks, clock sync, checkpoint worker\n');

  // --- 0. A stroke's dirty tiles follow its path, not its bounding box ---
  const diagonal = Array.from({ length: 121 }, (_, i) => ({ x: 500 + 9000 * (i / 120), y: 500 + 7000 * (i / 120) }));
  const tiles = getDirtyTilesForPoints(diagonal, 36, 256, 10000, 8000);
  assert.ok(tiles.length < 150, `a diagonal across 10000×8000 touches few tiles (got ${tiles.length}, box would be 1280)`);
  const jump = getDirtyTilesForPoints([{ x: 10, y: 10 }, { x: 2550, y: 10 }], 5, 256, 4096, 4096).map((t) => t.col).sort((a, b) => a - b);
  assert.deepStrictEqual(jump, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'every tile under a long segment is included');
  console.log(`✓ Dirty tiles follow the stroke path (${tiles.length} tiles for a full diagonal)`);

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  const api = async (token: string, method: string, url: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
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
        body: JSON.stringify({ username: `${name}_p15_${runId}`, password: 'password123', displayName: name }),
      });
      return (await res.json()) as { token: string; user: { id: string } };
    };
    const alice = await register('alice');
    const bob = await register('bob');
    const { data: canvasData } = await api(alice.token, 'POST', '/api/canvases', { title: 'P15', width: 512, height: 512 });
    const canvasId = canvasData.canvas.id as string;
    const layersUrl = `/api/canvases/${canvasId}/layers`;
    const getLayers = async () => (await api(alice.token, 'GET', layersUrl)).data.layers as any[];
    await api(bob.token, 'POST', '/api/canvases/join', { canvasId });

    // --- 1. Timeline: holds and reused cels are meta of the cel layers ---
    const folder = (await api(alice.token, 'POST', layersUrl, { name: '動畫', layerType: 'group', meta: { animation: { fps: 12 } } })).data.layer;
    const cel1 = (await api(alice.token, 'POST', layersUrl, { name: '1', parentId: folder.id, meta: { cel: { hold: 3 } } })).data.layer;
    const reuse = (await api(alice.token, 'POST', layersUrl, { name: '↻ 1', layerType: 'group', parentId: folder.id, meta: { cel: { ref: cel1.id } } })).data.layer;
    assert.deepStrictEqual(cel1.meta, { cel: { hold: 3 } });
    assert.deepStrictEqual(reuse.meta, { cel: { ref: cel1.id } });
    const held = await api(alice.token, 'PATCH', `${layersUrl}/${cel1.id}`, { meta: { cel: { hold: 5 } } });
    assert.strictEqual(held.data.layer.meta.cel.hold, 5);
    console.log('✓ Cel hold and reuse are saved as layer meta');

    // --- 2. After folder approval, painters can add and time their own cels ---
    await api(alice.token, 'PATCH', `${layersUrl}/${folder.id}`, { meta: { animation: { fps: 12, shared: true } } });
    const access = `${layersUrl}/${folder.id}/folder-access`;
    assert.strictEqual((await api(bob.token, 'POST', layersUrl, { name: 'Denied', parentId: folder.id })).status, 403);
    assert.ok((await api(bob.token, 'POST', access, {})).status < 300);
    assert.ok((await api(alice.token, 'PATCH', `${access}/${bob.user.id}`, { approved: true })).status < 300);
    const bobCel = await api(bob.token, 'POST', layersUrl, { name: '2', parentId: folder.id });
    assert.strictEqual(bobCel.status, 201, 'bob adds a cel to the shared folder');
    assert.strictEqual(bobCel.data.layer.ownerId, bob.user.id, "the cel is bob's");
    assert.strictEqual((await api(bob.token, 'PATCH', `${layersUrl}/${cel1.id}`, { meta: { cel: { hold: 1 } } })).status, 403, "bob cannot retime alice's cel");
    assert.strictEqual((await api(bob.token, 'PATCH', `${layersUrl}/${bobCel.data.layer.id}`, { meta: { cel: { hold: 2 } } })).status, 200, 'bob times his own cel');
    // Bob's own track, and his cel dragged onto it (parent change + order)
    const bobFolder = (await api(bob.token, 'POST', layersUrl, { name: '動畫 2', layerType: 'group', meta: { animation: { fps: 12 } } })).data.layer;
    assert.strictEqual((await api(bob.token, 'PATCH', `${layersUrl}/${bobCel.data.layer.id}`, { parentId: bobFolder.id })).status, 200);
    let all = await getLayers();
    assert.strictEqual(all.find((l) => l.id === bobCel.data.layer.id).parentId, bobFolder.id, 'the cel moved to the other track');
    assert.strictEqual(all.find((l) => l.id === bobCel.data.layer.id).meta.cel.hold, 2, 'and kept its timing');
    console.log('✓ Shared folders, own cels, moving a cel between tracks');

    // --- 3. Group masks and inverted masks ---
    const group = (await api(alice.token, 'POST', layersUrl, { name: '組', layerType: 'group' })).data.layer;
    const groupMask = await api(alice.token, 'POST', layersUrl, { name: '組的蒙版', layerType: 'mask', parentId: group.id });
    assert.strictEqual(groupMask.status, 201, 'a group takes a mask');
    const inverted = await api(alice.token, 'PATCH', `${layersUrl}/${groupMask.data.layer.id}`, { meta: { maskInverted: true } });
    assert.strictEqual(inverted.data.layer.meta.maskInverted, true, 'inversion is saved');
    assert.strictEqual((await api(bob.token, 'POST', layersUrl, { name: 'x', layerType: 'mask', parentId: bobFolder.id })).status, 201, 'bob masks his own folder');

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
    const aliceRejected: any[] = [];
    const bobRejected: any[] = [];
    sa.on('op_rejected', (r) => aliceRejected.push(r));
    sb.on('op_rejected', (r) => bobRejected.push(r));
    const bobSaw: string[] = [];
    sb.on('op_broadcast', (op) => bobSaw.push(op.layerId));
    // Painting a group's mask is allowed for the group's owner (the group itself has no pixels)
    sa.emit('tile_patch', { type: 'TILE_PATCH', canvasId, layerId: groupMask.data.layer.id, tiles: [solidTile(0, 0, [255, 255, 255, 255])] });
    await sleep(300);
    assert.strictEqual(aliceRejected.length, 0, "alice paints her group's mask");
    assert.ok(bobSaw.includes(groupMask.data.layer.id), 'the group mask edit reaches the room');
    sb.emit('tile_patch', { type: 'TILE_PATCH', canvasId, layerId: groupMask.data.layer.id, tiles: [solidTile(0, 0, [0, 0, 0, 255])] });
    await sleep(250);
    assert.strictEqual(bobRejected.length, 1, "bob cannot paint alice's group mask");
    console.log('✓ Group masks, inverted masks, painting a group mask is ACL-checked');

    // --- 4. Clock sync for preview latency ---
    const t0 = Date.now();
    const serverNow = await new Promise<number>((resolve) => sa.timeout(2000).emit('time_sync', null, (_e: unknown, now: number) => resolve(now)));
    assert.ok(Math.abs(serverNow - (t0 + Date.now()) / 2) < 1000, 'time_sync answers with the server clock');
    console.log('✓ time_sync returns the server clock');

    // --- 5. Checkpoints: folding in the worker gives the same tiles as the op log ---
    const cel1Tile = solidTile(1, 1, [10, 200, 30, 255]);
    sa.emit('tile_patch', { type: 'TILE_PATCH', canvasId, layerId: cel1.id, tiles: [cel1Tile] });
    await sleep(300);
    const snap = await createCheckpointInBackground(canvasId, (await api(alice.token, 'GET', `/api/canvases/${canvasId}`)).data.canvas.latestSeq);
    assert.ok(snap, 'a checkpoint was made');
    const latest = getLatestSnapshot(canvasId)!;
    assert.strictEqual(latest.bundle.layers.find((l) => l.layerId === cel1.id)?.tiles.length, 1, 'cel pixels are in the checkpoint');
    assert.strictEqual(latest.bundle.layers.find((l) => l.layerId === groupMask.data.layer.id)?.tiles.length, 1, 'group mask pixels are in the checkpoint');

    // The compiled worker itself (dist), on this same database
    const workerFile = path.join(__dirname, '../dist/services/checkpoint.worker.js');
    if (fs.existsSync(workerFile)) {
      const worker = new Worker(workerFile, { workerData: { dbPath: config.dbPath, snapshotsDir: config.snapshotsDir } });
      const seq = latest.model.seq;
      const layerList = (await getLayers()).map((l) => ({ id: l.id, name: l.name }));
      const result = await new Promise<any>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.postMessage({ id: 1, canvasId, seq, width: 512, height: 512, layers: layerList });
      }).finally(() => worker.terminate());
      assert.ok(result.ok && result.filePath, `worker wrote a snapshot (${result.error ?? ''})`);
      const bundle = decodePacket(fs.readFileSync(result.filePath)) as any;
      assert.strictEqual(bundle.layers.find((l: any) => l.layerId === cel1.id)?.tiles.length, 1, 'the worker folds the same tiles');
      console.log('✓ Checkpoint folding in the worker thread matches the op log');
    } else {
      console.log('… dist/services/checkpoint.worker.js not built yet: worker run skipped (pnpm -r build first)');
    }

    console.log('\n🎉 Phase 15 passed');
  } finally {
    sockets.forEach((s) => s.close());
    await app.close();
  }
}

runTest().catch((err) => {
  console.error('❌ Phase 15 failed:', err);
  process.exit(1);
});
