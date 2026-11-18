import { io as ClientSocket, Socket } from 'socket.io-client';
import * as socketParser from 'socket.io-parser';
import { buildApp } from '../src/app';
import {
  tileSocketParser,
  AuthResponse,
  CanvasSnapshotBundle,
  compressTileBuffer,
  decompressTileBuffer,
  getDirtyTilesForBoundingBox,
  getDirtyTilesForPoints,
  getTileBounds,
  LayerModel,
  OpBroadcastPacket,
  OpRejectedPacket,
  pointToTile,
  TileData,
  TilePatchPacket,
} from '@atelier/shared';
import fs from 'node:fs';
import path from 'node:path';

async function runPhase3Tests() {
  console.log('====================================================');
  console.log('🚀 Starting AtelierSync Phase 3 Tile Engine & Scoped Undo Tests');
  console.log('====================================================');

  // ----------------------------------------------------------------
  // 1. Tile Math & Compression Pipeline Unit Tests
  // ----------------------------------------------------------------
  console.log('\n--- 1. Testing Tile Grid Math & LZ4 Compression ---');

  // 1.1 Tile Bounds
  const b1 = getTileBounds(0, 0, 256, 1000, 1000);
  if (b1.x !== 0 || b1.y !== 0 || b1.width !== 256 || b1.height !== 256) {
    throw new Error(`Tile bounds failed: ${JSON.stringify(b1)}`);
  }
  const bEdge = getTileBounds(3, 3, 256, 1000, 1000);
  // x = 768, y = 768, width = 1000 - 768 = 232, height = 232
  if (bEdge.width !== 232 || bEdge.height !== 232) {
    throw new Error(`Edge tile bounds failed: ${JSON.stringify(bEdge)}`);
  }
  console.log('✓ Tile bounds calculation verified');

  // 1.2 Point to Tile
  const pTile = pointToTile(300, 520, 256);
  if (pTile.col !== 1 || pTile.row !== 2) {
    throw new Error(`Point to tile failed: ${JSON.stringify(pTile)}`);
  }
  console.log('✓ Point to tile mapping verified');

  // 1.3 Dirty Tiles for Bounding Box
  const dirtyBox = getDirtyTilesForBoundingBox(250, 250, 260, 260, 256, 1000, 1000);
  // (250, 250) is in col 0, row 0; (260, 260) is in col 1, row 1 -> 4 dirty tiles
  if (dirtyBox.length !== 4) {
    throw new Error(`Expected 4 dirty tiles crossing boundary, got ${dirtyBox.length}`);
  }
  console.log(`✓ Dirty tiles for bounding box verified (${dirtyBox.length} tiles)`);

  // 1.4 Dirty Tiles for Points with Radius
  const dirtyPts = getDirtyTilesForPoints(
    [
      { x: 100, y: 100, radius: 10 },
      { x: 500, y: 500, radius: 20 },
    ],
    10,
    256,
    1000,
    1000
  );
  if (dirtyPts.length < 2) {
    throw new Error(`Expected at least 2 dirty tiles, got ${dirtyPts.length}`);
  }
  console.log(`✓ Dirty tiles for stroke points verified (${dirtyPts.length} tiles)`);

  // 1.5 LZ4 Buffer Compression & Decompression
  const samplePixels = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < samplePixels.length; i += 4) {
    samplePixels[i] = (i * 7) % 256; // R
    samplePixels[i + 1] = (i * 13) % 256; // G
    samplePixels[i + 2] = (i * 17) % 256; // B
    samplePixels[i + 3] = 255; // A
  }

  const { compression, data: compressed } = compressTileBuffer(samplePixels, 'lz4');
  if (compression !== 'lz4' || compressed.byteLength >= samplePixels.byteLength) {
    console.warn(`Compressed size: ${compressed.byteLength} vs original ${samplePixels.byteLength}`);
  }
  const decompressed = decompressTileBuffer(compressed, 'lz4', samplePixels.byteLength);
  if (decompressed.byteLength !== samplePixels.byteLength) {
    throw new Error(`Decompressed size mismatch: ${decompressed.byteLength} vs ${samplePixels.byteLength}`);
  }

  let match = true;
  for (let i = 0; i < samplePixels.length; i += 64) {
    if (decompressed[i] !== samplePixels[i]) {
      match = false;
      break;
    }
  }
  if (!match) throw new Error('Decompressed pixel data does not match original!');
  console.log(`✓ LZ4 round-trip compression verified (${samplePixels.byteLength} bytes -> ${compressed.byteLength} bytes)`);

  // ----------------------------------------------------------------
  // 2. Server API & Snapshot Checkpoint Tests
  // ----------------------------------------------------------------
  console.log('\n--- 2. Testing Server REST APIs & Snapshot Checkpoint Storage ---');

  const app = await buildApp();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const runId = Date.now().toString().slice(-4);
    const aliceUser = `alice_p3_${runId}`;
    const bobUser = `bob_p3_${runId}`;

    // Register Alice
    const aliceRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: aliceUser, password: 'password123', displayName: '愛麗絲P3' }),
    });
    const aliceAuth: AuthResponse = await aliceRes.json();

    // Register Bob
    const bobRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: bobUser, password: 'password123', displayName: '小鮑伯P3' }),
    });
    const bobAuth: AuthResponse = await bobRes.json();

    // Alice creates canvas
    const canvasRes = await fetch(`${baseUrl}/api/canvases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceAuth.token}`,
      },
      body: JSON.stringify({ title: 'Phase 3 Tile 畫布', width: 2048, height: 2048 }),
    });
    const { canvas } = await canvasRes.json();
    console.log(`✓ Canvas created: ${canvas.title} (${canvas.width}x${canvas.height})`);

    // Bob joins canvas via invite
    await fetch(`${baseUrl}/api/canvases/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bobAuth.token}`,
      },
      body: JSON.stringify({ inviteCode: canvas.inviteCode }),
    });

    // Alice creates Layer A
    const layerARes = await fetch(`${baseUrl}/api/canvases/${canvas.id}/layers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceAuth.token}`,
      },
      body: JSON.stringify({ name: '愛麗絲圖層A' }),
    });
    const { layer: layerA }: { layer: LayerModel } = await layerARes.json();

    // Bob creates Layer B
    const layerBRes = await fetch(`${baseUrl}/api/canvases/${canvas.id}/layers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bobAuth.token}`,
      },
      body: JSON.stringify({ name: '鮑伯圖層B' }),
    });
    const { layer: layerB }: { layer: LayerModel } = await layerBRes.json();
    console.log(`✓ Created Layer A (${layerA.name}, owner=${layerA.ownerId}) and Layer B (${layerB.name}, owner=${layerB.ownerId})`);

    // 2.1 Test Canvas Resize Endpoint
    console.log('\n--- 2.1 Testing Canvas Resize API ---');
    const resizeRes = await fetch(`${baseUrl}/api/canvases/${canvas.id}/resize`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceAuth.token}`,
      },
      body: JSON.stringify({ width: 3000, height: 2500 }),
    });
    const resizedData = await resizeRes.json();
    if (resizedData.canvas.width !== 3000 || resizedData.canvas.height !== 2500) {
      throw new Error(`Resize canvas failed: ${JSON.stringify(resizedData)}`);
    }
    console.log(`✓ Canvas resized to ${resizedData.canvas.width}x${resizedData.canvas.height}`);

    // 2.2 Test Snapshot Storage & Download
    console.log('\n--- 2.2 Testing Snapshot Storage API ---');
    const sampleTileData: TileData = {
      col: 0,
      row: 0,
      width: 256,
      height: 256,
      compression: 'lz4',
      data: compressed,
    };

    // A snapshot may only claim a seq that has really been committed (0 here: nothing drawn yet)
    const bundleToSave: CanvasSnapshotBundle = {
      canvasId: canvas.id,
      seq: 0,
      tileSize: 256,
      width: 3000,
      height: 2500,
      layers: [
        {
          layerId: layerA.id,
          name: layerA.name,
          tiles: [sampleTileData],
        },
      ],
      createdAt: Date.now(),
    };

    const saveSnapRes = await fetch(`${baseUrl}/api/canvases/${canvas.id}/snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceAuth.token}`,
      },
      body: JSON.stringify({ bundle: bundleToSave, seq: 0 }),
    });
    const snapSaved = await saveSnapRes.json();
    if (!snapSaved.snapshot || snapSaved.snapshot.seq !== 0) {
      throw new Error(`Save snapshot failed: ${JSON.stringify(snapSaved)}`);
    }

    // A seq ahead of the op log would make clients skip ops that have not happened yet
    const futureSnapRes = await fetch(`${baseUrl}/api/canvases/${canvas.id}/snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceAuth.token}`,
      },
      body: JSON.stringify({ bundle: bundleToSave, seq: 10 }),
    });
    if (futureSnapRes.status !== 400) {
      throw new Error(`Snapshot with uncommitted seq must be rejected, got ${futureSnapRes.status}`);
    }
    console.log('✓ Snapshot claiming an uncommitted seq correctly rejected');
    console.log(`✓ Checkpoint snapshot saved at seq #${snapSaved.snapshot.seq}, file: ${snapSaved.snapshot.storagePath}`);

    // Verify snapshot file exists on disk
    if (!fs.existsSync(snapSaved.snapshot.storagePath)) {
      throw new Error(`Snapshot file does not exist on disk: ${snapSaved.snapshot.storagePath}`);
    }
    console.log('✓ Snapshot file physically verified on disk');

    // Download latest snapshot via GET
    const getSnapRes = await fetch(`${baseUrl}/api/canvases/${canvas.id}/snapshot`);
    const snapLoaded = await getSnapRes.json();
    if (!snapLoaded.snapshot || snapLoaded.bundle.layers.length !== 1) {
      throw new Error(`Get snapshot failed: ${JSON.stringify(snapLoaded)}`);
    }
    console.log(`✓ Latest snapshot retrieved via GET: seq #${snapLoaded.snapshot.seq}, layer count: ${snapLoaded.bundle.layers.length}`);

    // ----------------------------------------------------------------
    // 3. Realtime Socket Tests: Tile Patch & Scoped Undo/Redo
    // ----------------------------------------------------------------
    console.log('\n--- 3. Testing Real-time Tile Patch & Per-User Scoped Undo ---');

    // Same parser as the real client: the stock one caps an op at 10 tiles (see 3.2b)
    const socketAlice: Socket = ClientSocket(baseUrl, {
      auth: { token: aliceAuth.token },
      transports: ['websocket'],
      parser: tileSocketParser(socketParser),
    });
    const socketBob: Socket = ClientSocket(baseUrl, {
      auth: { token: bobAuth.token },
      transports: ['websocket'],
      parser: tileSocketParser(socketParser),
    });

    await new Promise<void>((resolve) => {
      let count = 0;
      socketAlice.on('connect', () => { if (++count === 2) resolve(); });
      socketBob.on('connect', () => { if (++count === 2) resolve(); });
    });

    socketAlice.emit('join_canvas', { canvasId: canvas.id });
    socketBob.emit('join_canvas', { canvasId: canvas.id });
    await new Promise((r) => setTimeout(r, 200));

    // 3.1 Alice draws on Layer A via tile_patch
    const bobReceivedOps: OpBroadcastPacket[] = [];
    socketBob.on('op_broadcast', (pkt: OpBroadcastPacket) => {
      bobReceivedOps.push(pkt);
    });

    const aliceTilePatch: TilePatchPacket = {
      type: 'TILE_PATCH',
      canvasId: canvas.id,
      layerId: layerA.id,
      tiles: [sampleTileData],
      isUndo: false,
      actionDesc: '愛麗絲落筆繪畫',
    };

    socketAlice.emit('tile_patch', aliceTilePatch);
    await new Promise((r) => setTimeout(r, 250));

    if (bobReceivedOps.length === 0 || bobReceivedOps[0].opType !== 'TILE_PATCH') {
      throw new Error('Bob did not receive Alice tile_patch broadcast');
    }
    console.log(`✓ Alice tile_patch successfully sequenced & broadcast to Bob (Seq #${bobReceivedOps[0].seq})`);

    // 3.2 Alice performs Scoped Undo on Layer A
    const aliceUndoPatch: TilePatchPacket = {
      type: 'TILE_PATCH',
      canvasId: canvas.id,
      layerId: layerA.id,
      tiles: [sampleTileData], // reverse diff restored
      isUndo: true,
      actionDesc: '愛麗絲按下 Ctrl+Z 局部復原',
    };

    socketAlice.emit('tile_patch', aliceUndoPatch);
    await new Promise((r) => setTimeout(r, 250));

    const latestBobOp = bobReceivedOps[bobReceivedOps.length - 1];
    if (latestBobOp.layerId !== layerA.id || (latestBobOp.payload as any).isUndo !== true) {
      throw new Error('Scoped undo broadcast verification failed');
    }
    console.log(`✓ Alice Scoped Undo successfully broadcast: restored Layer A, Layer B left completely untouched!`);

    // 3.2b An op touching more than 10 tiles (long stroke, fill, transform). socket.io's stock
    // parser drops the connection above 10 binary attachments, which silently lost these ops.
    const wideTiles: TileData[] = Array.from({ length: 12 }, (_, i) => ({
      ...sampleTileData,
      col: i % 4,
      row: 2 + Math.floor(i / 4),
    }));
    socketAlice.emit('tile_patch', {
      type: 'TILE_PATCH',
      canvasId: canvas.id,
      layerId: layerA.id,
      tiles: wideTiles,
      actionDesc: '愛麗絲的大範圍操作 (12 tiles)',
    } as TilePatchPacket);
    await new Promise((r) => setTimeout(r, 400));

    const wideTileCount = (bobReceivedOps[bobReceivedOps.length - 1].payload as any).tiles?.length;
    if (!socketAlice.connected || !socketBob.connected || wideTileCount !== 12) {
      throw new Error(
        `A 12-tile op must sync without dropping the connection (alice=${socketAlice.connected}, bob=${socketBob.connected}, tiles received=${wideTileCount})`
      );
    }
    console.log('✓ 12-tile op synced to Bob with both connections intact');

    // 3.2b2 A resize reaches everyone in the room, so their canvases rebuild at the new size live
    const bobResized = new Promise<{ canvasId: string; width: number; height: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bob never received canvas_resized')), 2000);
      socketBob.once('canvas_resized', (data) => { clearTimeout(timer); resolve(data); });
    });
    await fetch(`${baseUrl}/api/canvases/${canvas.id}/resize`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceAuth.token}` },
      body: JSON.stringify({ width: 2048, height: 1536 }),
    });
    const resizedEvent = await bobResized;
    if (resizedEvent.canvasId !== canvas.id || resizedEvent.width !== 2048 || resizedEvent.height !== 1536) {
      throw new Error(`canvas_resized carried the wrong size: ${JSON.stringify(resizedEvent)}`);
    }
    console.log('✓ Canvas resize broadcast to Bob (2048x1536)');

    // 3.2c A reconnecting client flushes the ops it buffered while offline BEFORE its own
    // join_canvas. It names the canvas in the handshake so the room gate does not drop them.
    const socketRejoin: Socket = ClientSocket(baseUrl, {
      auth: { token: aliceAuth.token, canvasId: canvas.id },
      transports: ['websocket'],
      parser: tileSocketParser(socketParser),
    });
    socketRejoin.emit('tile_patch', { ...aliceTilePatch, actionDesc: '離線期間暫存的操作' });
    await new Promise((r) => setTimeout(r, 500));

    const rejoinDesc = (bobReceivedOps[bobReceivedOps.length - 1].payload as any).actionDesc;
    socketRejoin.disconnect();
    if (rejoinDesc !== '離線期間暫存的操作') {
      throw new Error(`An op sent right after (re)connecting, before join_canvas, must reach the room; last op was "${rejoinDesc}"`);
    }
    console.log('✓ Op buffered across a reconnect accepted via handshake join');

    // 3.3 Security: Bob tries to modify Alice's private Layer A without permission
    let rejectedCount = 0;
    socketBob.on('op_rejected', (rej: OpRejectedPacket) => {
      rejectedCount++;
      console.log(`✓ Correctly rejected unauthorized tile patch from Bob on Alice's layer: ${rej.reason}`);
    });

    const unauthorizedPatch: TilePatchPacket = {
      type: 'TILE_PATCH',
      canvasId: canvas.id,
      layerId: layerA.id, // Alice's private layer!
      tiles: [sampleTileData],
    };
    socketBob.emit('tile_patch', unauthorizedPatch);
    await new Promise((r) => setTimeout(r, 200));

    if (rejectedCount === 0) {
      throw new Error('Server failed to reject unauthorized tile patch on another user layer!');
    }

    // 3.4 Auto Checkpoint Generation (simulate reaching seq % 50 === 0)
    console.log('\n--- 3.4 Testing Automatic Checkpoint Snapshot Generation ---');
    const checkpointPromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Checkpoint creation timeout')), 5000);
      socketAlice.once('checkpoint_created', (data: any) => {
        clearTimeout(timeout);
        resolve(data);
      });
    });

    const currentSeq = bobReceivedOps[bobReceivedOps.length - 1].seq;
    const opsNeeded = 50 - (currentSeq % 50);
    console.log(`Emitting ${opsNeeded} ops to trigger auto checkpoint at next multiple of 50...`);

    for (let i = 0; i < opsNeeded; i++) {
      socketAlice.emit('op_commit', {
        canvasId: canvas.id,
        layerId: layerA.id,
        opType: 'STROKE',
        // Real clients always attach the resulting tiles; the checkpoint is folded from them
        payload: {
          samplePoints: [{ x: 10 + i, y: 10 + i, pressure: 0.5 }],
          tiles: [{ ...sampleTileData, col: i % 3, row: 1 }],
        },
      });
      await new Promise((r) => setTimeout(r, 8));
    }

    const checkpointData = await checkpointPromise;
    console.log(`✓ Received checkpoint_created event: seq #${checkpointData.seq}, snapshotId=${checkpointData.snapshotId}`);

    // The checkpoint must hold real pixels: latest tile per (layer, col, row), not an empty shell
    const foldedSnap = await fetch(`${baseUrl}/api/canvases/${canvas.id}/snapshot`).then((r) => r.json());
    const foldedLayerA = foldedSnap.bundle.layers.find((l: any) => l.layerId === layerA.id);
    // (0,0) from the patches, 12 from the wide op in rows 2-4, 3 from this loop in row 1
    if (foldedSnap.snapshot.seq !== checkpointData.seq || !foldedLayerA || foldedLayerA.tiles.length !== 16) {
      throw new Error(
        `Checkpoint must fold the op log into 16 distinct tiles on Layer A, got seq #${foldedSnap.snapshot?.seq} with ${foldedLayerA?.tiles.length} tiles`
      );
    }
    console.log(`✓ Checkpoint #${foldedSnap.snapshot.seq} folded from op log: ${foldedLayerA.tiles.length} tiles on Layer A`);

    // 3.5 Replay Ops Since Checkpoint API
    console.log('\n--- 3.5 Testing Incremental Ops Replay API ---');
    const replayRes = await fetch(`${baseUrl}/api/canvases/${canvas.id}/ops?sinceSeq=10`);
    const replayData = await replayRes.json();
    if (!replayData.ops || replayData.ops.length === 0) {
      throw new Error('Failed to retrieve incremental ops');
    }
    console.log(`✓ Replay API returned ${replayData.ops.length} ops since seq #10 for quick reconnect loading`);

    socketAlice.disconnect();
    socketBob.disconnect();
  } finally {
    await app.close();
  }

  console.log('\n====================================================');
  console.log('🎉 ALL ATELIERSYNC PHASE 3 AUTOMATED TESTS PASSED!');
  console.log('====================================================\n');
}

runPhase3Tests().catch((err) => {
  console.error('\n❌ Phase 3 Tests Failed:', err);
  process.exit(1);
});
