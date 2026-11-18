import assert from 'node:assert';
import { io as socketIO, Socket } from 'socket.io-client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  calculatePainterLevel,
  computeSmartEncloseFillMask,
  computeSha256,
  decryptTimeCapsule,
  encryptTimeCapsule,
  CAPSULE_MAGIC,
  CapsuleContent,
  PAINTER_LEVEL_TIERS,
} from '@atelier/shared';

async function runPhase7Tests() {
  const testData = mkdtempSync(join(tmpdir(), 'lumina-phase7-'));
  process.env.DATA_DIR = testData;
  process.env.DATABASE_PATH = join(testData, 'test.db');
  process.env.PORT = '0';
  const { buildApp } = await import('../src/app');
  console.log('\n================================================================');
  console.log('🚀 Starting AtelierSync Phase 7: AI Smart Fill, Capsule & P2P Tests');
  console.log('================================================================\n');

  // ==========================================================================
  // Test 1: AI 智能閉合線稿填色 (Enclose & Fill with Gap-Closing & Tuck-Under)
  // ==========================================================================
  console.log('--- 1. Testing AI Smart Enclose & Fill (Auto-Flatting) ---');

  const width = 64;
  const height = 64;
  const refPixels = new Uint8Array(width * height * 4);

  // Draw a synthetic circular lineart outline centered at (32, 32) with radius 16
  // Intentionally leave a 3-pixel gap at the top (x around 32, y = 16)
  const centerX = 32;
  const centerY = 32;
  const radius = 16;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dist = Math.hypot(x - centerX, y - centerY);
      // Line is at radius ~16
      if (Math.abs(dist - radius) <= 1.2) {
        // Leave a 3px gap at the top
        if (Math.abs(x - centerX) <= 1.5 && y < centerY) {
          // Gap! (transparent)
          continue;
        }
        const idx = (y * width + x) * 4;
        refPixels[idx] = 20; // R
        refPixels[idx + 1] = 20; // G
        refPixels[idx + 2] = 20; // B
        refPixels[idx + 3] = 255; // A (opaque ink line)
      }
    }
  }

  // Draw an enclosing lasso path around the circle (e.g. from (8,8) to (56,8) to (56,56) to (8,56))
  const lassoPoints = [
    { x: 10, y: 10 },
    { x: 54, y: 10 },
    { x: 54, y: 54 },
    { x: 10, y: 54 },
  ];

  // Run Smart Fill with gap closing enabled (radius = 4px) and tuck-under expansion (2px)
  const resultClosed = computeSmartEncloseFillMask(
    lassoPoints,
    refPixels,
    width,
    height,
    {
      gapClosingRadius: 4,
      expandRadius: 2,
      lineThreshold: 180,
    }
  );

  assert.ok(resultClosed.activePixelCount > 0, 'Smart fill should successfully find enclosed region');
  // Check that center pixel (32, 32) is filled
  const centerIdx = 32 * width + 32;
  assert.strictEqual(
    resultClosed.data[centerIdx],
    255,
    'Center of enclosed lineart must be filled'
  );

  // Check that an exterior point (e.g. at (12, 12)) outside the lineart is NOT filled
  const exteriorIdx = 12 * width + 12;
  assert.strictEqual(
    resultClosed.data[exteriorIdx],
    0,
    'Exterior background outside the circle must remain unfilled (gap did not leak)'
  );

  // Check under-lineart expansion: pixels under the line boundary should be filled
  const linePointIdx = (centerY * width + (centerX + radius)) * 4;
  assert.ok(
    resultClosed.data[centerY * width + (centerX + radius)] === 255,
    'Tuck-under expansion should extend fill under lineart boundary'
  );

  console.log(`✓ AI Smart Fill successfully enclosed region: ${resultClosed.activePixelCount} pixels filled without leaking through 3px gap`);

  // ==========================================================================
  // Test 2: 繪茶勳章與筆數體系 (Non-Geometric Level Formula)
  // ==========================================================================
  console.log('\n--- 2. Testing Painter Level Gamification Formula ---');

  // Verify tier thresholds
  assert.strictEqual(calculatePainterLevel(0).level, 1);
  assert.strictEqual(calculatePainterLevel(499).level, 1);
  assert.strictEqual(calculatePainterLevel(500).level, 2);
  assert.strictEqual(calculatePainterLevel(2200).level, 3);
  assert.strictEqual(calculatePainterLevel(6500).level, 4);
  assert.strictEqual(calculatePainterLevel(14000).level, 5);
  assert.strictEqual(calculatePainterLevel(26000).level, 6);
  assert.strictEqual(calculatePainterLevel(43000).level, 7);
  assert.strictEqual(calculatePainterLevel(65000).level, 8);
  assert.strictEqual(calculatePainterLevel(85000).level, 9);
  assert.strictEqual(calculatePainterLevel(100000).level, 10);

  // Test stroke count exceeding 100,000
  const maxPlus = calculatePainterLevel(124500);
  assert.strictEqual(maxPlus.level, 10, 'Level 10 is max tier');
  assert.strictEqual(maxPlus.strokes, 124500, 'Strokes must track and exceed 100,000 without cap');
  assert.strictEqual(maxPlus.isMaxLevel, true);
  assert.strictEqual(maxPlus.progressPercent, 100);

  // Test progress percentage calculation
  const midLevel4 = calculatePainterLevel(10250); // halfway between 6500 and 14000
  assert.strictEqual(midLevel4.level, 4);
  assert.ok(midLevel4.progressPercent >= 48 && midLevel4.progressPercent <= 52);

  console.log('✓ Painter Leveling formula validated: non-geometric curve reaches Lv.10 at 100k, strokes exceed 100k smoothly');

  // ==========================================================================
  // Test 3: 畫布時光膠囊 (.ateliersync-capsule) 打包與 AES-256-GCM 加密還原
  // ==========================================================================
  console.log('\n--- 3. Testing Canvas Time Capsule (.ateliersync-capsule) Crypto ---');

  const mockContent: CapsuleContent = {
    manifest: {
      magic: CAPSULE_MAGIC,
      version: '1.0',
      createdAt: Date.now(),
      canvas: {
        id: 'canvas_capsule_test',
        title: '幻想浮空島 (Sky Island)',
        width: 2048,
        height: 2048,
        bgColor: '#FFFFFF',
        latestSeq: 42,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      layers: [
        {
          id: 'layer_1',
          canvasId: 'canvas_capsule_test',
          name: '線稿層 (Lineart)',
          opacity: 1.0,
          blendMode: 'normal',
          isVisible: true,
          isLocked: false,
          sortOrder: 1,
          ownerId: 'user_alice',
          createdAt: Date.now(),
        },
      ],
      totalOps: 42,
      totalStrokes: 1580,
      hasReplayLog: true,
      isEncrypted: true,
      checksum: '',
    },
    layerSnapshots: {
      layer_1: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    },
    historyOps: [{ seq: 1, opType: 'STROKE' }, { seq: 2, opType: 'SMART_FILL' }],
    thumbnailUrl: 'data:image/jpeg;base64,testthumb',
  };

  const passphrase = 'MySecretAtelierPassword2026!';

  // Encrypt
  const encryptedEnvelope = await encryptTimeCapsule(mockContent, passphrase);
  assert.ok('ciphertext' in encryptedEnvelope, 'Encrypted envelope must contain ciphertext');
  assert.ok('salt' in encryptedEnvelope, 'Encrypted envelope must contain salt');
  assert.ok('iv' in encryptedEnvelope, 'Encrypted envelope must contain iv');
  assert.strictEqual(encryptedEnvelope.magic, CAPSULE_MAGIC);

  // Decrypt with correct password
  const decrypted = await decryptTimeCapsule(encryptedEnvelope, passphrase);
  assert.strictEqual(decrypted.manifest.canvas.title, '幻想浮空島 (Sky Island)');
  assert.strictEqual(decrypted.manifest.layers.length, 1);
  assert.strictEqual(decrypted.historyOps.length, 2);
  console.log('✓ Time Capsule successfully encrypted with AES-256-GCM and decrypted with verified integrity');

  // Decrypt with incorrect password
  await assert.rejects(
    async () => {
      await decryptTimeCapsule(encryptedEnvelope, 'WrongPassword!');
    },
    /解密失敗/,
    'Decryption with wrong password must throw error'
  );
  console.log('✓ Rejected decryption with wrong passphrase');

  // ==========================================================================
  // Test 4: Real-time Socket P2P Signaling & Stroke Stats Broadcast
  // ==========================================================================
  console.log('\n--- 4. Testing Real-time P2P Signal & Stroke Counter Broadcast ---');

  const app = await buildApp();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Register user Alice
  const authRes = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      username: `alice_${Date.now()}`,
      password: 'password123',
      displayName: '愛麗絲 (Alice)',
    },
  });
  const aliceToken = JSON.parse(authRes.body).token;
  const aliceUser = JSON.parse(authRes.body).user;

  // Create canvas
  const canvasRes = await app.inject({
    method: 'POST',
    url: '/api/canvases',
    headers: { authorization: `Bearer ${aliceToken}` },
    payload: { title: 'P2P 萬筆畫布', width: 2048, height: 2048 },
  });
  const canvasData = JSON.parse(canvasRes.body);
  const canvas = canvasData.canvas;
  const layerId = canvasData.layers.find((l: any) => !l.isLocked)?.id || canvasData.layers[1]?.id;

  // Connect Socket 1 (Alice)
  const client1: Socket = socketIO(baseUrl, {
    auth: { token: aliceToken },
    transports: ['websocket'],
  });

  // Connect Socket 2 (Guest Bob)
  const client2: Socket = socketIO(baseUrl, {
    auth: { displayName: '鮑伯 (Bob)' },
    transports: ['websocket'],
  });

  await new Promise<void>((resolve) => {
    let connected = 0;
    const check = () => {
      connected++;
      if (connected === 2) resolve();
    };
    client1.on('connect', check);
    client2.on('connect', check);
  });

  client1.emit('join_canvas', { canvasId: canvas.id });
  client2.emit('join_canvas', { canvasId: canvas.id });

  // Test WebRTC P2P DataChannel Signaling Relay
  const signalPromise = new Promise<any>((resolve) => {
    client2.on('p2p_signal', (payload) => {
      resolve(payload);
    });
  });

  client1.emit('p2p_signal', {
    canvasId: canvas.id,
    targetSocketId: client2.id,
    signal: { sdp: { type: 'offer', sdp: 'v=0...' } },
  });

  const receivedSignal = await signalPromise;
  assert.strictEqual(receivedSignal.canvasId, canvas.id);
  assert.strictEqual(receivedSignal.signal.sdp.type, 'offer');
  console.log('✓ WebRTC P2P DataChannel signal relayed successfully between peers');

  // Test Stroke Stats Update on Op Commit
  const strokeStatsPromise = new Promise<any>((resolve) => {
    client2.on('stroke_stats_update', (data) => {
      resolve(data);
    });
  });

  client1.emit('op_commit', {
    canvasId: canvas.id,
    layerId,
    opType: 'SMART_FILL',
    payload: { fillCount: 250 },
  });

  const stats = await strokeStatsPromise;
  assert.strictEqual(stats.canvasId, canvas.id);
  assert.strictEqual(stats.userId, aliceUser.id);
  assert.strictEqual(stats.strokeCount, 1);
  assert.strictEqual(stats.totalCanvasStrokes, 1);
  assert.strictEqual(stats.level, 1);
  console.log('✓ Stroke count incremented for smart fill and broadcasted in real-time');

  client1.disconnect();
  client2.disconnect();
  await app.close();

  console.log('\n================================================================');
  console.log('🎉 All Phase 7 Tests Passed Successfully!');
  console.log('================================================================\n');
}

runPhase7Tests().catch((err) => {
  console.error('Phase 7 Tests failed:', err);
  process.exit(1);
});
