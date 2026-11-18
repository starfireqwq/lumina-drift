import assert from 'node:assert';
import { buildApp } from '../src/app';
import { db, sqlite } from '../src/db';
import { canvases } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { compressTileBuffer, decodePacket, decompressTileBuffer, encodePacket } from '@atelier/shared';

async function runPhase17Tests() {
  console.log('\n====================================================');
  console.log('🚀 Starting Phase 17: High-Volume Time-Lapse Replay & Participants Tests');
  console.log('====================================================\n');

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Login admin + register 6 collaborators with custom avatars & names
    const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    }).then((r) => r.json());
    assert.ok(adminLogin.token, 'Admin token required');

    const collaborators: Array<{ id: string; token: string; displayName: string; avatarUrl: string }> = [];
    for (let i = 1; i <= 6; i++) {
      const reg = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: `collab_${i}_${Date.now().toString().slice(-4)}`,
          password: 'password123',
          displayName: `協作者 ${i} 號`,
        }),
      }).then((r) => r.json());
      assert.ok(reg.token && reg.user?.id, `Collaborator ${i} should register`);
      const avatarUrl = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==`;
      const prof = await fetch(`${baseUrl}/api/auth/profile`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${reg.token}`,
        },
        body: JSON.stringify({ displayName: `繪師_${i}`, avatarUrl }),
      }).then((r) => r.json());
      assert.strictEqual(prof.user.displayName, `繪師_${i}`);
      collaborators.push({
        id: reg.user.id,
        token: reg.token,
        displayName: `繪師_${i}`,
        avatarUrl,
      });
    }

    // 2. Create a 1920x1080 canvas (produces non-256-multiple edge tiles: 128x56 at col 7, row 4)
    const createRes = await fetch(`${baseUrl}/api/canvases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminLogin.token}`,
      },
      body: JSON.stringify({
        title: '8483 筆劃協作縮時測試畫布',
        width: 1920,
        height: 1080,
        bgColor: '#FFFFFF',
      }),
    }).then((r) => r.json());

    const canvasId = createRes.canvas.id as string;
    const layerId = createRes.layers[1].id as string;

    // 3. Seed 8,483 realistic ops across the 7 painters (4,636 by admin + 3,847 across 6 offline collaborators)
    const fullRaw = new Uint8Array(256 * 256 * 4);
    for (let i = 0; i < 16000; i++) fullRaw[(i * 17) % fullRaw.length] = (i * 29) & 0xff;
    const fullComp = compressTileBuffer(fullRaw, 'lz4');

    const edgeRaw = new Uint8Array(128 * 56 * 4);
    for (let i = 0; i < edgeRaw.length; i += 4) edgeRaw.set([200, 100, 50, 200], i);
    const edgeComp = compressTileBuffer(edgeRaw, 'lz4');

    const allPoints = Array.from({ length: 120 }, (_, idx) => ({
      x: 50 + idx * 12,
      y: 80 + (idx % 10) * 15,
      pressure: 0.7,
    }));

    const standardBlob = Buffer.from(
      encodePacket({
        type: 'OP_COMMIT',
        canvasId,
        layerId,
        opType: 'STROKE',
        payload: {
          color: '#3B82F6',
          size: 18,
          opacity: 0.9,
          isEraser: false,
          samplePoints: allPoints,
          allPoints,
          tiles: [
            { col: 0, row: 0, width: 256, height: 256, compression: fullComp.compression, data: fullComp.data },
            { col: 1, row: 0, width: 256, height: 256, compression: fullComp.compression, data: fullComp.data },
          ],
          inkTiles: [
            { col: 0, row: 0, width: 256, height: 256, compression: fullComp.compression, data: fullComp.data },
          ],
          historyTiles: [
            {
              from: { col: 0, row: 0, width: 256, height: 256, compression: fullComp.compression, data: fullComp.data },
              to: { col: 0, row: 0, width: 256, height: 256, compression: fullComp.compression, data: fullComp.data },
            },
          ],
        },
      } as any)
    );

    const edgeBlob = Buffer.from(
      encodePacket({
        type: 'OP_COMMIT',
        canvasId,
        layerId,
        opType: 'TILE_PATCH',
        payload: {
          actionDesc: '邊緣瓦片測試',
          tiles: [
            { col: 7, row: 4, width: 128, height: 56, compression: edgeComp.compression, data: edgeComp.data },
          ],
        },
      } as any)
    );

    const insertStmt = sqlite.prepare(
      'INSERT INTO canvas_ops (canvas_id, seq, user_id, layer_id, op_type, payload_blob, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const totalOps = 8483;
    const now = Date.now();
    sqlite.transaction(() => {
      for (let seq = 1; seq <= totalOps; seq++) {
        const uid = seq <= 4636 ? adminLogin.user.id : collaborators[(seq - 4637) % collaborators.length].id;
        const isEdge = seq === totalOps;
        insertStmt.run(
          canvasId,
          seq,
          uid,
          layerId,
          isEdge ? 'TILE_PATCH' : 'STROKE',
          isEdge ? edgeBlob : standardBlob,
          now + seq * 10
        );
      }
      db.update(canvases).set({ latestSeq: totalOps }).where(eq(canvases.id, canvasId)).run();
    })();

    // 4. Paginated MessagePack fetch (view=timelapse&format=msgpack) across all 8,483 ops
    let cursor = 0;
    let pages = 0;
    const loadedOps: any[] = [];
    const participants: Record<string, any> = {};

    while (true) {
      const inc = cursor === 0 ? '&includeParticipants=1' : '';
      const res = await fetch(
        `${baseUrl}/api/canvases/${canvasId}/ops?sinceSeq=${cursor}&limit=300&view=timelapse&format=msgpack${inc}`,
        { headers: { Authorization: `Bearer ${adminLogin.token}` } }
      );
      assert.strictEqual(res.status, 200, 'Paginated msgpack ops fetch must return 200');
      assert.ok((res.headers.get('content-type') || '').includes('msgpack'), 'Response must be msgpack');
      const decoded = decodePacket(new Uint8Array(await res.arrayBuffer())) as any;
      pages++;
      if (decoded.participants) Object.assign(participants, decoded.participants);
      loadedOps.push(...decoded.ops);
      if (!decoded.hasMore) break;
      assert.ok(decoded.nextSeq > cursor, 'nextSeq must advance monotonically');
      cursor = decoded.nextSeq;
    }

    assert.strictEqual(loadedOps.length, totalOps, 'All 8,483 operations must load cleanly');
    assert.ok(pages >= 20, `Expected paginated chunks (>= 20 pages), got ${pages}`);
    assert.strictEqual(loadedOps[0].seq, 1);
    assert.strictEqual(loadedOps[totalOps - 1].seq, totalOps);

    // Verify slimming stripped heavy live-only fields & preserved edge tile
    const firstPayload = loadedOps[0].payload;
    assert.strictEqual(firstPayload.inkTiles, undefined, 'inkTiles must be stripped in timelapse view');
    assert.strictEqual(firstPayload.historyTiles, undefined, 'historyTiles must be stripped in timelapse view');
    assert.strictEqual(firstPayload.allPoints, undefined, 'allPoints must be stripped in timelapse view');
    assert.ok(firstPayload.samplePoints.length <= 32, 'samplePoints should be compacted when tiles exist');

    const lastTile = loadedOps[totalOps - 1].payload.tiles[0];
    assert.strictEqual(lastTile.col, 7);
    assert.strictEqual(lastTile.row, 4);
    assert.strictEqual(lastTile.width, 128);
    assert.strictEqual(lastTile.height, 56);
    const decodedEdge = decompressTileBuffer(new Uint8Array(lastTile.data), 'lz4', 128 * 56 * 4);
    assert.deepStrictEqual(Array.from(decodedEdge.subarray(0, 4)), [200, 100, 50, 200]);

    // Verify all 7 participants (admin + 6 offline collaborators) with avatars & display names
    assert.strictEqual(Object.keys(participants).length, 7, 'All 7 contributors must be returned');
    for (const c of collaborators) {
      assert.strictEqual(participants[c.id]?.displayName, c.displayName);
      assert.strictEqual(participants[c.id]?.avatarUrl, c.avatarUrl);
    }
    console.log(`✓ Loaded all ${loadedOps.length} ops across ${pages} msgpack pages with 7 participants & avatars`);

    // 5. Verify JSON view=timelapse uses base64 tiles (not raw Uint8Array JSON objects)
    const jsonPage = await fetch(
      `${baseUrl}/api/canvases/${canvasId}/ops?sinceSeq=8480&limit=10&view=timelapse`,
      { headers: { Authorization: `Bearer ${adminLogin.token}` } }
    ).then((r) => r.json());
    assert.strictEqual(jsonPage.ops.length, 3);
    assert.strictEqual(typeof jsonPage.ops[2].payload.tiles[0].data, 'string', 'JSON timelapse view must encode tile data as base64 string');
    console.log('✓ JSON view=timelapse compact base64 encoding verified');

    // 6. Verify legacy GET /api/canvases/:id/ops?sinceSeq=8480 still works unchanged
    const legacyPage = await fetch(`${baseUrl}/api/canvases/${canvasId}/ops?sinceSeq=8480`, {
      headers: { Authorization: `Bearer ${adminLogin.token}` },
    }).then((r) => r.json());
    assert.strictEqual(legacyPage.ops.length, 3);
    assert.ok(legacyPage.ops[0].payload.inkTiles, 'Legacy incremental sync preserves full payload');
    console.log('✓ Legacy incremental /ops compatibility verified');

    // 7. Verify password-locked canvas enforcement on timelapse endpoint
    const pwRes = await fetch(`${baseUrl}/api/canvases/${canvasId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminLogin.token}`,
      },
      body: JSON.stringify({ roomPassword: 'secret-room-pw' }),
    });
    assert.strictEqual(pwRes.status, 200);

    const denied = await fetch(`${baseUrl}/api/canvases/${canvasId}/ops?sinceSeq=0&limit=10&view=timelapse&format=msgpack`);
    assert.strictEqual(denied.status, 403, 'Locked room must reject unauthenticated timelapse fetch');

    const unlocked = await fetch(`${baseUrl}/api/canvases/${canvasId}/ops?sinceSeq=0&limit=10&view=timelapse&format=msgpack`, {
      headers: { 'X-Room-Password': encodeURIComponent('secret-room-pw') },
    });
    assert.strictEqual(unlocked.status, 200, 'Locked room must allow X-Room-Password timelapse fetch');
    console.log('✓ Password-locked room access control verified on timelapse endpoint');

    console.log('\n====================================================');
    console.log('🎉 ALL PHASE 17 TIME-LAPSE REPLAY TESTS PASSED!');
    console.log('====================================================\n');
  } finally {
    await app.close();
  }
}

runPhase17Tests().catch((err) => {
  console.error('\n❌ Phase 17 Tests Failed:', err);
  process.exit(1);
});
