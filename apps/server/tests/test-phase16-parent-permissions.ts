import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions } from 'fastify';
import { compressTileBuffer, decompressTileBuffer } from '@atelier/shared';

/**
 * Phase 16: adding to an ordinary or animation folder requires ownership or explicit approval.
 */
async function runTest() {
  console.log('🚀 Phase 16: parent (group / animation folder) permissions\n');
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'lumina-folder-acl-'));
  const app = await (await import('../src/app')).buildApp();
  const api = async (token: string, method: InjectOptions['method'], url: string, body?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.statusCode, data: res.json() as any };
  };

  try {
    const runId = Date.now().toString().slice(-6);
    const register = async (name: string) => {
      const res = await api('', 'POST', '/api/auth/register', { username: `${name}_p16_${runId}`, password: 'password123', displayName: name });
      assert.strictEqual(res.status, 201);
      return res.data as { token: string; user: { id: string } };
    };
    const alice = await register('alice');
    const bob = await register('bob');
    const canvasId = (await api(alice.token, 'POST', '/api/canvases', { title: 'P16', width: 512, height: 512 })).data.canvas.id as string;
    await api(bob.token, 'POST', '/api/canvases/join', { canvasId });
    const url = `/api/canvases/${canvasId}/layers`;

    const folder = (await api(alice.token, 'POST', url, { name: '動畫', layerType: 'group', meta: { animation: { fps: 12 } } })).data.layer;
    const group = (await api(alice.token, 'POST', url, { name: '組', layerType: 'group' })).data.layer;
    const bobLayer = (await api(bob.token, 'POST', url, { name: 'bob 的圖層' })).data.layer;

    // Not shared: no new cels, no moving in
    assert.strictEqual((await api(bob.token, 'POST', url, { name: 'x', parentId: folder.id })).status, 403, 'no child in an unshared animation folder');
    assert.strictEqual((await api(bob.token, 'PATCH', `${url}/${bobLayer.id}`, { parentId: folder.id })).status, 403, 'no moving into an unshared animation folder');
    // Someone else's plain group
    assert.strictEqual((await api(bob.token, 'POST', url, { name: 'x', parentId: group.id })).status, 403, "no child in someone else's group");
    assert.strictEqual((await api(bob.token, 'PATCH', `${url}/${bobLayer.id}`, { parentId: group.id })).status, 403, "no moving into someone else's group");
    // A rejected move leaves the layer where it was
    let layers = (await api(alice.token, 'GET', url)).data.layers as any[];
    assert.strictEqual(layers.find((l) => l.id === bobLayer.id).parentId, null, 'the layer did not move');
    console.log('✓ Unshared animation folders and other painters\' groups are closed (403)');

    // The owner of the group and the canvas owner may
    assert.strictEqual((await api(alice.token, 'POST', url, { name: 'a', parentId: group.id })).status, 201, 'alice adds to her own group');
    const bobGroup = (await api(bob.token, 'POST', url, { name: 'bob 組', layerType: 'group' })).data.layer;
    assert.strictEqual((await api(alice.token, 'POST', url, { name: 'host', parentId: bobGroup.id })).status, 403, 'the canvas owner also needs approval');
    const normalAccess = `${url}/${bobGroup.id}/folder-access`;
    assert.strictEqual((await api(alice.token, 'POST', normalAccess)).data.requests[0].status, 'pending');
    assert.strictEqual((await api(alice.token, 'PATCH', `${normalAccess}/${alice.user.id}`, { approved: true })).status, 403, 'cannot approve own request');
    assert.strictEqual((await api(bob.token, 'PATCH', `${normalAccess}/${alice.user.id}`, { approved: true })).status, 200);
    assert.strictEqual((await api(alice.token, 'POST', url, { name: 'host', parentId: bobGroup.id })).status, 201, 'approved canvas owner can add to normal group');
    assert.strictEqual((await api(bob.token, 'PATCH', `${url}/${bobLayer.id}`, { parentId: bobGroup.id })).status, 200, 'bob moves into his own group');
    console.log('✓ Ordinary folders require owner approval, including for the canvas owner');

    // Shared folder: own cels go in, but a cel folder inside it is still its owner's group
    await api(alice.token, 'PATCH', `${url}/${folder.id}`, { meta: { animation: { fps: 12, shared: true } } });
    assert.strictEqual((await api(bob.token, 'POST', url, { name: '2', parentId: folder.id })).status, 403, 'visible timeline still requires approval');
    const animAccess = `${url}/${folder.id}/folder-access`;
    await api(bob.token, 'POST', animAccess);
    assert.strictEqual((await api(alice.token, 'PATCH', `${animAccess}/${bob.user.id}`, { approved: true })).status, 200);
    assert.strictEqual((await api(bob.token, 'POST', url, { name: '2', parentId: folder.id })).status, 201, 'approved animator can add a cel');
    assert.strictEqual((await api(bob.token, 'PATCH', `${url}/${bobLayer.id}`, { parentId: folder.id })).status, 200, 'and his layer moved in');
    const celFolder = (await api(alice.token, 'POST', url, { name: 'cel 資料夾', layerType: 'group', parentId: folder.id })).data.layer;
    assert.strictEqual((await api(bob.token, 'POST', url, { name: 'x', parentId: celFolder.id })).status, 403, "alice's cel folder stays hers");
    // Moving out to the top level is always fine for your own layer
    assert.strictEqual((await api(bob.token, 'PATCH', `${url}/${bobLayer.id}`, { parentId: null })).status, 200, 'moving out is allowed');
    layers = (await api(alice.token, 'GET', url)).data.layers as any[];
    assert.strictEqual(layers.find((l) => l.id === bobLayer.id).parentId, null, 'moved out');
    // Unsharing closes it again
    await api(alice.token, 'PATCH', `${animAccess}/${bob.user.id}`, { approved: false });
    assert.strictEqual((await api(bob.token, 'POST', url, { name: '3', parentId: folder.id })).status, 403, 'unshared again');
    // Masks still follow the target layer's rights, not the group rule
    assert.strictEqual((await api(bob.token, 'POST', url, { name: 'm', layerType: 'mask', parentId: group.id })).status, 403, "no mask on alice's group");
    console.log('✓ Animation approval, nested folder isolation, moving out, revocation and mask ACL');

    // --- Pixels over REST (capsule restore fills a canvas nobody has open) ---
    const px = new Uint8Array(256 * 256 * 4);
    for (let i = 0; i < px.length; i += 4) px.set([30, 60, 90, 255], i);
    const lz = compressTileBuffer(px, 'lz4');
    const tileJson = (col: number, row: number) => ({ col, row, width: 256, height: 256, compression: lz.compression, data: Buffer.from(lz.data).toString('base64') });
    const aliceLayer = (await api(alice.token, 'POST', url, { name: '還原用' })).data.layer;
    const wrote = await api(alice.token, 'POST', `${url}/${aliceLayer.id}/tiles`, { tiles: [tileJson(0, 0), tileJson(1, 1)], actionDesc: '時光膠囊還原' });
    assert.strictEqual(wrote.status, 201, 'the owner writes tiles');
    assert.ok(wrote.data.seq > 0, 'as a sequenced op');
    const ops = (await api(alice.token, 'GET', `/api/canvases/${canvasId}/ops?sinceSeq=0`)).data.ops as any[];
    const op = ops.find((o) => o.seq === wrote.data.seq);
    assert.ok(op && op.layerId === aliceLayer.id && op.opType === 'TILE_PATCH', 'the op is in the log');
    assert.strictEqual(op.payload.tiles.length, 2, 'with both tiles');
    const back = decompressTileBuffer(new Uint8Array(op.payload.tiles[0].data.data ?? op.payload.tiles[0].data), 'lz4', px.length);
    assert.deepStrictEqual([...back.subarray(0, 8)], [30, 60, 90, 255, 30, 60, 90, 255], 'pixels come back intact');
    assert.strictEqual((await api(bob.token, 'POST', `${url}/${aliceLayer.id}/tiles`, { tiles: [tileJson(0, 0)] })).status, 403, "bob cannot write alice's layer");
    const admin = (await api('', 'POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).data;
    assert.strictEqual((await api(admin.token, 'POST', `${url}/${aliceLayer.id}/tiles`, { tiles: [tileJson(0, 0)] })).status, 403, 'admin cannot draw on a foreign layer');
    assert.strictEqual((await api(admin.token, 'PATCH', `${url}/${aliceLayer.id}`, { opacity: 0.4 })).status, 403, 'admin cannot change foreign layer opacity');
    assert.strictEqual((await api(admin.token, 'PATCH', `${url}/${folder.id}`, { meta: { animation: { fps: 12, shared: false } } })).status, 403, 'admin cannot change folder sharing');
    assert.strictEqual((await api(admin.token, 'POST', `${url}/${aliceLayer.id}/claim`, { force: true })).status, 200);
    assert.strictEqual((await api(admin.token, 'PATCH', `${url}/${aliceLayer.id}`, { opacity: 0.4 })).status, 200, 'admin who takes ownership can edit opacity');
    assert.strictEqual((await api(admin.token, 'POST', `${url}/${aliceLayer.id}/tiles`, { tiles: [tileJson(0, 0)] })).status, 201, 'admin who takes ownership can draw');
    assert.strictEqual((await api(alice.token, 'POST', `${url}/${aliceLayer.id}/tiles`, { tiles: [{ col: 0, row: 0, width: 999, height: 256, compression: 'lz4', data: '' }] })).status, 400, 'bad tile rejected');
    assert.strictEqual((await api(alice.token, 'POST', `${url}/${aliceLayer.id}/tiles`, { tiles: [] })).status, 400, 'no tiles rejected');
    assert.strictEqual((await api(alice.token, 'POST', `${url}/00000000-0000-0000-0000-000000000000/tiles`, { tiles: [tileJson(0, 0)] })).status, 404, 'unknown layer');
    console.log('✓ REST tiles were validated and logged; admins can edit pixels and opacity after taking ownership');

    console.log('\n✅ Phase 16 passed');
  } finally {
    await app.close();
  }
}

runTest().catch((err) => {
  console.error('❌ Phase 16 failed:', err);
  process.exit(1);
});
