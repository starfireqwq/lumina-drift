import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compressTileBuffer, DEFAULT_TILE_SIZE } from '@atelier/shared';
import {
  computeSeekReplayPlan,
  extractOpCursorTarget,
  normalizeReplayTileBytes,
  resolveTileDimensions,
  unpremultiplyRgba,
} from '../src/engine/timeLapseHelpers.ts';
import { LOCAL_ARTIST_ID, OfflineSessionStore } from '../src/services/offlineStore.ts';

test('normalizeReplayTileBytes decodes Uint8Array, base64, Buffer JSON, and indexed objects', () => {
  const sample = new Uint8Array([10, 20, 30, 255]);
  assert.deepEqual(Array.from(normalizeReplayTileBytes(sample)), [10, 20, 30, 255]);

  const b64 = Buffer.from(sample).toString('base64');
  assert.deepEqual(Array.from(normalizeReplayTileBytes(b64)), [10, 20, 30, 255]);

  assert.deepEqual(
    Array.from(normalizeReplayTileBytes({ type: 'Buffer', data: [10, 20, 30, 255] })),
    [10, 20, 30, 255]
  );

  assert.deepEqual(
    Array.from(normalizeReplayTileBytes({ '0': 10, '1': 20, '2': 30, '3': 255 })),
    [10, 20, 30, 255]
  );
});

test('unpremultiplyRgba restores straight alpha for Canvas 2D ImageData without dark halos', () => {
  // Premultiplied 50%-ish white: [128, 128, 128, 128], transparent: [0, 0, 0, 0], opaque red: [255, 0, 0, 255]
  const src = new Uint8Array([128, 128, 128, 128, 0, 0, 0, 0, 255, 0, 0, 255]);
  const dst = new Uint8ClampedArray(12);
  // Pre-seed dst with garbage to ensure transparent pixels are explicitly zeroed (safe for pooled ImageData)
  dst.fill(99);
  unpremultiplyRgba(src, dst);
  assert.deepEqual(Array.from(dst), [255, 255, 255, 128, 0, 0, 0, 0, 255, 0, 0, 255]);
});

test('resolveTileDimensions handles non-256-multiple edge tiles without throwing', () => {
  // 1920x1080 canvas: col 7 has width 128, row 4 has height 56
  const edge = resolveTileDimensions({ col: 7, row: 4, width: 128, height: 56 }, 1920, 1080);
  assert.deepEqual(edge, { x: 7 * DEFAULT_TILE_SIZE, y: 4 * DEFAULT_TILE_SIZE, width: 128, height: 56 });

  const inferred = resolveTileDimensions({ col: 7, row: 4 }, 1920, 1080);
  assert.deepEqual(inferred, { x: 1792, y: 1024, width: 128, height: 56 });

  assert.equal(resolveTileDimensions({ col: 8, row: 0 }, 1920, 1080), null);
});

test('extractOpCursorTarget resolves painter coordinates from stroke, vector, bounds, and tiles', () => {
  const strokeTarget = extractOpCursorTarget(
    {
      opType: 'STROKE',
      payload: {
        size: 24,
        color: '#FF0066',
        samplePoints: [{ x: 10, y: 20 }, { x: 300, y: 400 }],
      },
    },
    1920,
    1080
  );
  assert.equal(strokeTarget?.x, 300);
  assert.equal(strokeTarget?.y, 400);
  assert.equal(strokeTarget?.brushSize, 24);
  assert.equal(strokeTarget?.isEraser, false);

  const boundsTarget = extractOpCursorTarget(
    {
      opType: 'SMART_FILL',
      payload: { bounds: { minX: 100, maxX: 200, minY: 300, maxY: 500 }, color: '#00AAFF' },
    },
    1920,
    1080
  );
  assert.equal(boundsTarget?.x, 150);
  assert.equal(boundsTarget?.y, 400);

  const tileTarget = extractOpCursorTarget(
    {
      opType: 'TILE_PATCH',
      payload: {
        tiles: [{ col: 1, row: 2, width: 256, height: 256 }],
      },
    },
    1920,
    1080
  );
  assert.equal(tileTarget?.x, 256 + 128);
  assert.equal(tileTarget?.y, 512 + 128);
});

test('computeSeekReplayPlan deduplicates overwritten tiles across 8,483 ops and respects LAYER_CLEAR', () => {
  const ops: any[] = [];
  for (let i = 1; i <= 8483; i++) {
    ops.push({
      seq: i,
      layerId: 'layer_a',
      opType: 'STROKE',
      payload: {
        tiles: [{ col: i % 4, row: 0, width: 256, height: 256, compression: 'lz4', data: new Uint8Array([i & 255]) }],
      },
    });
  }
  const plan = computeSeekReplayPlan(ops, 8483);
  assert.equal(plan.sequentialOps.length, 0);
  assert.equal(plan.latestTiles.length, 4);
  const cols = plan.latestTiles.map((t) => t.tile.col).sort();
  assert.deepEqual(cols, [0, 1, 2, 3]);
  // Seq 8483 % 4 === 3, so col 3 should hold byte 8483 & 255
  const col3 = plan.latestTiles.find((t) => t.tile.col === 3)!;
  assert.equal((col3.tile.data as Uint8Array)[0], 8483 & 255);

  // Respect LAYER_CLEAR: tiles before clear are ignored
  const clearedOps = [
    { seq: 1, layerId: 'layer_a', opType: 'STROKE', payload: { tiles: [{ col: 2, row: 2, width: 256, height: 256 }] } },
    { seq: 2, layerId: 'layer_a', opType: 'LAYER_CLEAR', payload: {} },
    { seq: 3, layerId: 'layer_a', opType: 'STROKE', payload: { tiles: [{ col: 0, row: 0, width: 256, height: 256 }] } },
  ];
  const clearedPlan = computeSeekReplayPlan(clearedOps, 3);
  assert.equal(clearedPlan.latestTiles.length, 1);
  assert.equal(clearedPlan.latestTiles[0].tile.col, 0);
});

test('OfflineSessionStore records local ops for Time-Lapse Replay without breaking snapshot catchup', async () => {
  const canvasId = `local_unit_${Date.now()}`;
  const layerId = 'layer_unit_1';
  const lz = compressTileBuffer(new Uint8Array(256 * 256 * 4), 'lz4');
  const tile = { col: 0, row: 0, width: 256, height: 256, compression: lz.compression, data: lz.data };

  const seq1 = OfflineSessionStore.commitLocalOp(canvasId, layerId, 'STROKE', {
    color: '#EF4444',
    size: 16,
    samplePoints: [{ x: 20, y: 30, pressure: 0.5 }],
    tiles: [tile],
  });
  const seq2 = OfflineSessionStore.commitLocalTilePatch(canvasId, layerId, [tile]);
  assert.equal(seq2, seq1 + 1);

  // Normal workspace load fetches snapshot at seq 2 then opsSince(2) -> 0 incremental ops
  const catchup = await OfflineSessionStore.getOpsSince(canvasId, seq2);
  assert.equal(catchup.ops.length, 0);

  // Time-Lapse Replay loads from seq 0 and sees both ops with LOCAL_ARTIST_ID
  const replay = await OfflineSessionStore.getTimeLapseOps(canvasId);
  assert.equal(replay.ops.length, 2);
  assert.equal(replay.ops[0].userId, LOCAL_ARTIST_ID);
  assert.equal(replay.ops[0].opType, 'STROKE');
  assert.equal(replay.ops[1].opType, 'TILE_PATCH');
  assert.ok(replay.participants[LOCAL_ARTIST_ID]);

  await OfflineSessionStore.deleteCanvas(canvasId);
});
