import assert from 'node:assert';
import { io as socketIO, Socket } from 'socket.io-client';
import { buildApp } from '../src/app';
import {
  AbrParser,
  AtelierBrushPreset,
  BrushPackageManager,
  CanvasSticker,
  SutParser,
} from '@atelier/shared';

async function runPhase6Tests() {
  console.log('\n====================================================');
  console.log('🚀 Starting AtelierSync Phase 6 Voice, Stickers & Brush Tests');
  console.log('====================================================\n');

  // --- 1. Testing Photoshop ABR Brush Tip Parser ---
  console.log('--- 1. Testing Photoshop ABR Brush Tip Parser ---');

  // Construct a valid synthetic ABR v1/v2 sampled brush buffer
  const width = 32;
  const height = 32;
  const pixelCount = width * height;
  const abrBufferSize = 2 + 2 + 2 + 4 + 4 + 8 + 2 + pixelCount;
  const abrBuffer = new ArrayBuffer(abrBufferSize);
  const abrView = new DataView(abrBuffer);
  const abrBytes = new Uint8Array(abrBuffer);

  // Version 2 (Big Endian)
  abrView.setInt16(0, 2, false);
  // Count: 1 brush
  abrView.setInt16(2, 1, false);
  // Brush 1: type 2 (sampled)
  abrView.setInt16(4, 2, false);
  // Brush 1: size in bytes
  abrView.setInt32(6, 4 + 8 + 2 + pixelCount, false);
  // Misc 4 bytes (offset 10)
  // Bounds: top=0, left=0, bottom=32, right=32 (offset 14)
  abrView.setInt16(14, 0, false);
  abrView.setInt16(16, 0, false);
  abrView.setInt16(18, 32, false);
  abrView.setInt16(20, 32, false);
  // Depth: 8-bit (offset 22)
  abrView.setInt16(22, 8, false);

  // Pixels: circle pattern with 0 (black/ink) in center and 255 (white/background) outside
  let offset = 24;
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const dist = Math.hypot(x - 16, y - 16);
      abrBytes[offset++] = dist < 12 ? 0 : 255;
    }
  }

  const abrParser = new AbrParser(abrBuffer);
  const parsedAbrTips = abrParser.parse();
  assert.strictEqual(parsedAbrTips.length, 1, 'Should parse exactly 1 ABR sampled brush');
  assert.strictEqual(parsedAbrTips[0].width, 32, 'ABR tip width should be 32');
  assert.strictEqual(parsedAbrTips[0].height, 32, 'ABR tip height should be 32');
  assert.ok(parsedAbrTips[0].dataUrl.startsWith('data:image/'), 'DataURL must be generated');
  console.log(`✓ Photoshop ABR parser successfully extracted tip: ${parsedAbrTips[0].name} (${parsedAbrTips[0].width}x${parsedAbrTips[0].height})`);

  // --- 2. Testing Clip Studio Paint (.sut) Brush Parser ---
  console.log('\n--- 2. Testing Clip Studio Paint (.sut) Brush Parser ---');

  // Build synthetic SUT binary buffer containing valid embedded PNG chunk
  // Minimal valid 1x1 PNG bytes
  const minimalPng = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG Signature
    0x00, 0x00, 0x00, 0x0d, // IHDR length
    0x49, 0x48, 0x44, 0x52, // 'IHDR'
    0x00, 0x00, 0x00, 0x40, // width: 64
    0x00, 0x00, 0x00, 0x40, // height: 64
    0x08, 0x06, 0x00, 0x00, 0x00, // 8-bit RGBA
    0xe0, 0x3d, 0x4f, 0x24, // CRC
    0x00, 0x00, 0x00, 0x0a, // IDAT length
    0x49, 0x44, 0x41, 0x54, // 'IDAT'
    0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, // compressed zlib data
    0x0d, 0x0a, 0x2d, 0xb4, // CRC
    0x00, 0x00, 0x00, 0x00, // IEND length
    0x49, 0x45, 0x4e, 0x44, // 'IEND'
    0xae, 0x42, 0x60, 0x82, // CRC
  ]);

  const sutBuffer = new ArrayBuffer(256 + minimalPng.length);
  const sutBytes = new Uint8Array(sutBuffer);

  // Write a tool name string into header
  const toolName = Buffer.from('CSP濃淡水彩筆Brush');
  sutBytes.set(toolName, 10);
  // Put PNG image at offset 100
  sutBytes.set(minimalPng, 100);

  const sutParser = new SutParser(sutBuffer);
  const parsedSutTips = sutParser.parse();
  assert.ok(parsedSutTips.length >= 1, 'Should extract at least 1 brush texture from SUT');
  assert.strictEqual(parsedSutTips[0].width, 64, 'Extracted tip width should be 64');
  assert.strictEqual(parsedSutTips[0].height, 64, 'Extracted tip height should be 64');
  assert.ok(parsedSutTips[0].dataUrl.startsWith('data:image/png;base64,'), 'Should produce valid PNG DataURL');
  console.log(`✓ Clip Studio Paint SUT parser successfully extracted texture: ${parsedSutTips[0].name}`);

  // --- 3. Testing AtelierSync Brush Preset & Pack Package System ---
  console.log('\n--- 3. Testing AtelierSync Brush Preset Packaging (.asbrush) ---');

  const customPreset: AtelierBrushPreset = {
    id: 'test_oil_impasto',
    name: '自訂極限厚塗筆 (Custom Impasto)',
    category: '厚塗創作',
    author: 'Alice',
    version: '1.0',
    description: '測試用真實混色厚塗筆刷',
    properties: {
      size: 48,
      minSize: 4,
      color: '#ff4400',
      opacity: 0.9,
      flow: 0.85,
      hardness: 0.8,
      spacing: 0.05,
      isEraser: false,
      stabilizerLevel: 3,
      scatter: 0.05,
      colorMixing: 0.65,
      paintAmount: 0.8,
      pressureCurve: 's-curve',
    },
    tipDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    tags: ['Oil', 'Impasto'],
    createdAt: Date.now(),
  };

  const exportedJson = BrushPackageManager.exportPresetToJson(customPreset);
  assert.ok(exportedJson.includes('自訂極限厚塗筆'), 'Exported JSON must contain preset name');

  const jsonBuf = Buffer.from(exportedJson, 'utf-8');
  const exactArrayBuffer = jsonBuf.buffer.slice(
    jsonBuf.byteOffset,
    jsonBuf.byteOffset + jsonBuf.byteLength
  );
  const reimported = await BrushPackageManager.parseBrushFile(
    exactArrayBuffer,
    'custom_impasto.asbrush'
  );
  assert.strictEqual(reimported.length, 1);
  assert.strictEqual(reimported[0].name, customPreset.name);
  assert.strictEqual(reimported[0].properties.colorMixing, 0.65);
  assert.strictEqual(reimported[0].properties.paintAmount, 0.8);
  console.log(`✓ Brush preset export/import round-trip verified: ${reimported[0].name}`);

  // --- 4. Testing Real-time WebRTC Voice Signaling & Floating Stickers Gateway ---
  console.log('\n--- 4. Testing Real-time WebRTC Voice Signaling Gateway ---');

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const serverPort = (app.server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${serverPort}`;

  // Login Admin to create canvas
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then((r) => r.json());

  const canvasRes = await fetch(`${baseUrl}/api/canvases`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${loginRes.token}`,
    },
    body: JSON.stringify({
      title: 'Phase 6 語音繪茶與貼圖測試畫布',
      width: 1920,
      height: 1080,
    }),
  }).then((r) => r.json());

  const canvasId = canvasRes.canvas.id;

  // Connect Alice & Bob sockets
  const socketAlice: Socket = socketIO(baseUrl, {
    auth: { displayName: '愛麗絲畫師' },
    transports: ['websocket'],
  });

  const socketBob: Socket = socketIO(baseUrl, {
    auth: { displayName: '小鮑伯畫師' },
    transports: ['websocket'],
  });

  await Promise.all([
    new Promise((resolve) => socketAlice.on('connect', resolve)),
    new Promise((resolve) => socketBob.on('connect', resolve)),
  ]);

  const aliceJoinedPromise = new Promise((resolve) => socketAlice.once('room_state', resolve));
  const bobJoinedPromise = new Promise((resolve) => socketBob.once('room_state', resolve));

  socketAlice.emit('join_canvas', { canvasId });
  socketBob.emit('join_canvas', { canvasId });

  await Promise.all([aliceJoinedPromise, bobJoinedPromise]);

  // Test 4A: Alice joins voice channel, Bob receives notification
  const bobHeardVoiceJoinPromise = new Promise<{ displayName: string }>((resolve) => {
    socketBob.on('voice_user_joined', (data) => {
      resolve(data);
    });
  });

  socketAlice.emit('voice_join', { canvasId });
  const voiceJoinData = await bobHeardVoiceJoinPromise;
  assert.strictEqual(voiceJoinData.displayName, '愛麗絲畫師');
  console.log(`✓ WebRTC voice room join broadcast verified: ${voiceJoinData.displayName} entered voice`);

  // Test 4B: WebRTC SDP Signal forwarding
  const bobHeardSignalPromise = new Promise<{ signalType: string; signalData: any }>((resolve) => {
    socketBob.on('voice_signal', (data) => {
      resolve(data);
    });
  });

  socketAlice.emit('voice_signal', {
    canvasId,
    signalType: 'offer',
    signalData: { type: 'offer', sdp: 'v=0\r\no=alice 1234 2 IN IP4 127.0.0.1' },
  });

  const signalData = await bobHeardSignalPromise;
  assert.strictEqual(signalData.signalType, 'offer');
  assert.ok(signalData.signalData.sdp.includes('alice'));
  console.log(`✓ WebRTC SDP offer signal successfully routed across mesh peers`);

  // Test 4C: Voice Speaking state broadcasting
  const bobHeardVoiceStatePromise = new Promise<{ isSpeaking: boolean; isMuted: boolean }>((resolve) => {
    socketBob.on('voice_state', (data) => {
      resolve(data);
    });
  });

  socketAlice.emit('voice_state', {
    canvasId,
    isMuted: false,
    isSpeaking: true,
  });

  const voiceStateData = await bobHeardVoiceStatePromise;
  assert.strictEqual(voiceStateData.isSpeaking, true);
  console.log(`✓ Voice Activity Detection (VAD) speaking indicator broadcast verified`);

  // Test 4D: Voice Leave
  const bobHeardVoiceLeavePromise = new Promise<void>((resolve) => {
    socketBob.on('voice_user_left', () => {
      resolve();
    });
  });

  socketAlice.emit('voice_leave', { canvasId });
  await bobHeardVoiceLeavePromise;
  console.log(`✓ Voice leave event successfully propagated`);

  // --- 5. Testing Canvas Floating Stickers & Reference Pins Sync ---
  console.log('\n--- 5. Testing Canvas Floating Stickers & Reference Pins Sync ---');

  const testSticker: CanvasSticker = {
    id: 'stk_test_101',
    canvasId,
    ownerId: 'alice_1',
    ownerName: '愛麗絲畫師',
    title: '摸魚中貼圖',
    imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    x: 150,
    y: 200,
    width: 180,
    height: 120,
    opacity: 0.95,
    isLocked: false,
    isFlippedH: false,
    isGrayscale: false,
    isShared: true,
    createdAt: Date.now(),
  };

  // 5A: Add sticker
  const bobHeardStickerAddPromise = new Promise<CanvasSticker>((resolve) => {
    socketBob.on('sticker_added', (data: { canvasId: string; sticker: CanvasSticker }) => {
      resolve(data.sticker);
    });
  });

  socketAlice.emit('sticker_add', { canvasId, sticker: testSticker });
  const addedSticker = await bobHeardStickerAddPromise;
  assert.strictEqual(addedSticker.id, testSticker.id);
  assert.strictEqual(addedSticker.x, 150);
  assert.strictEqual(addedSticker.y, 200);
  console.log(`✓ Floating sticker added & broadcast to canvas:「${addedSticker.title}」at (${addedSticker.x}, ${addedSticker.y})`);

  // 5B: Update sticker
  const bobHeardStickerUpdatePromise = new Promise<Partial<CanvasSticker>>((resolve) => {
    socketBob.on('sticker_updated', (data: { stickerId: string; updates: Partial<CanvasSticker> }) => {
      resolve(data.updates);
    });
  });

  socketAlice.emit('sticker_update', {
    canvasId,
    stickerId: testSticker.id,
    updates: { x: 300, y: 400, opacity: 0.8 },
  });

  const updatedUpdates = await bobHeardStickerUpdatePromise;
  assert.strictEqual(updatedUpdates.x, 300);
  assert.strictEqual(updatedUpdates.y, 400);
  assert.strictEqual(updatedUpdates.opacity, 0.8);
  console.log(`✓ Floating sticker moved & resized smoothly: new coords (${updatedUpdates.x}, ${updatedUpdates.y})`);

  // 5C: Remove sticker
  const bobHeardStickerRemovePromise = new Promise<string>((resolve) => {
    socketBob.on('sticker_removed', (data: { stickerId: string }) => {
      resolve(data.stickerId);
    });
  });

  socketAlice.emit('sticker_remove', { canvasId, stickerId: testSticker.id });
  const removedId = await bobHeardStickerRemovePromise;
  assert.strictEqual(removedId, testSticker.id);
  console.log(`✓ Floating sticker removed cleanly`);

  // Cleanup sockets and server
  socketAlice.disconnect();
  socketBob.disconnect();
  await app.close();

  console.log('\n====================================================');
  console.log('🎉 ALL ATELIERSYNC PHASE 6 TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================\n');
}

runPhase6Tests().catch((err) => {
  console.error('Fatal error during Phase 6 tests:', err);
  process.exit(1);
});
