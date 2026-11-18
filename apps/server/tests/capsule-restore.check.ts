import assert from 'node:assert/strict';
import { CAPSULE_MAGIC, type CapsuleContent, type VectorStroke } from '@atelier/shared';
import { TimeCapsuleEngine } from '../../client/src/engine/TimeCapsuleEngine';
import { ApiService } from '../../client/src/services/api';
import { buildApp } from '../src/app';

async function main() {
  const app = await buildApp();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers)),
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode });
  };

  try {
    const username = `capsule_${Date.now()}`;
    const auth = await ApiService.register({ username, password: 'password123', displayName: '還原者' });
    ApiService.setToken(auth.token);
    const { canvas: source } = await ApiService.createCanvas({ title: '膠囊測試', width: 256, height: 256 });
    const layer = await ApiService.createLayer(source.id, { name: '向量墨線', layerType: 'vector' });
    const stroke: VectorStroke = {
      id: 'ink-line', layerId: layer.id, color: '#442233', opacity: 1, baseWidth: 3,
      anchors: [{ x: 2, y: 3, width: 3, pressure: 1 }, { x: 44, y: 66, width: 3, pressure: 1 }],
      bounds: { minX: 0, minY: 1, maxX: 46, maxY: 68 }, createdAt: Date.now(),
    };
    const manifest: CapsuleContent['manifest'] = {
      magic: CAPSULE_MAGIC, version: '1.0', createdAt: Date.now(), canvas: source,
      layers: [{ ...layer, ownerDisplayName: '初始畫師', isLocked: true }],
      totalOps: 0, totalStrokes: 1, hasReplayLog: false, isEncrypted: false, checksum: '',
    };
    const legacy = { manifest, layerSnapshots: {}, historyOps: [] };
    const content = { ...legacy, manifest: { ...manifest, vectorStrokes: { [layer.id]: [stroke] } } };

    const restored = await TimeCapsuleEngine.restoreToNewCanvas(content, undefined, true);
    const [restoredLayer] = await ApiService.getLayers(restored.id);
    assert.equal(restoredLayer.layerType, 'vector');
    assert.equal(restoredLayer.meta?.originalAuthor, '初始畫師');
    assert.equal(restoredLayer.ownerId, auth.user.id);
    assert.equal(restoredLayer.isLocked, true);
    const { ops } = await ApiService.getCanvasOps(restored.id);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].opType, 'VECTOR_EDIT');
    assert.deepEqual(ops[0].payload.vectorAdded, [{ ...stroke, layerId: restoredLayer.id }]);

    const older = await TimeCapsuleEngine.restoreToNewCanvas(legacy);
    const [olderLayer] = await ApiService.getLayers(older.id);
    assert.equal(olderLayer.layerType, 'vector');
    assert.equal(olderLayer.meta?.originalAuthor, undefined);
    assert.equal((await ApiService.getCanvasOps(older.id)).ops.length, 0);
    console.log('膠囊還原檢查通過（向量操作、圖層權限、原作者、舊格式）');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
