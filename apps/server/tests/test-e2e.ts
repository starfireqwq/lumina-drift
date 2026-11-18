import { io as ClientSocket, Socket } from 'socket.io-client';
import { buildApp } from '../src/app';
import {
  AuthResponse,
  decodePacket,
  encodePacket,
  OpBroadcastPacket,
  OpCommitPacket,
  OpRejectedPacket,
  RoomStatePacket,
} from '@atelier/shared';

async function runTests() {
  console.log('====================================================');
  console.log('🚀 Starting AtelierSync Phase 1 Automated E2E Tests');
  console.log('====================================================');

  const app = await buildApp();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[Test Server] Running on ${baseUrl}`);

  try {
    // ----------------------------------------------------------------
    // 1. Health check & DB seed verification
    // ----------------------------------------------------------------
    console.log('\n--- 1. Testing Health & DB Seed ---');
    const healthRes = await fetch(`${baseUrl}/health`);
    const health = await healthRes.json();
    console.log('✓ Health check status:', health.status);
    if (health.status !== 'ok') throw new Error('Health check failed');

    // ----------------------------------------------------------------
    // 2. Auth: Admin Login & Regular User Registration
    // ----------------------------------------------------------------
    console.log('\n--- 2. Testing Auth System (Argon2 + JWT) ---');

    // Admin login
    const adminLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const adminAuth: AuthResponse = await adminLoginRes.json();
    if (!adminAuth.token || adminAuth.user.serverRole !== 'admin') {
      throw new Error(`Admin login failed: ${JSON.stringify(adminAuth)}`);
    }
    console.log(`✓ Admin logged in: ${adminAuth.user.displayName} (Role: ${adminAuth.user.serverRole})`);

    // Register User Alice with unique username for idempotency
    const runId = Date.now().toString().slice(-4);
    const aliceUsername = `alice_${runId}`;
    const bobUsername = `bob_${runId}`;

    const aliceRegRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: aliceUsername,
        password: 'password123',
        displayName: '愛麗絲畫師',
      }),
    });
    const aliceAuth: AuthResponse = await aliceRegRes.json();
    if (!aliceAuth.token || aliceAuth.user.serverRole !== 'member') {
      throw new Error(`Alice registration failed: ${JSON.stringify(aliceAuth)}`);
    }
    console.log(`✓ Alice registered: ${aliceAuth.user.displayName} (${aliceUsername})`);

    // Register User Bob
    const bobRegRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: bobUsername,
        password: 'password123',
        displayName: '小鮑伯畫師',
      }),
    });
    const bobAuth: AuthResponse = await bobRegRes.json();
    console.log(`✓ Bob registered: ${bobAuth.user.displayName} (${bobUsername})`);

    // Verify /api/auth/me
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${aliceAuth.token}` },
    });
    const meData = await meRes.json();
    if (meData.user.username !== aliceUsername) throw new Error('/me verification failed');
    console.log('✓ /api/auth/me verified for Alice');

    // ----------------------------------------------------------------
    // 3. Canvas REST APIs: Creation, Multi-Canvas, Invite Code
    // ----------------------------------------------------------------
    console.log('\n--- 3. Testing Canvas Management & Tabs ---');

    // List canvases
    const listRes1 = await fetch(`${baseUrl}/api/canvases`);
    const { canvases: initialCanvases } = await listRes1.json();
    console.log(`✓ Initial canvas count: ${initialCanvases.length}`);

    // Alice creates Canvas 1: "Alice's Studio"
    const createRes1 = await fetch(`${baseUrl}/api/canvases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceAuth.token}`,
      },
      body: JSON.stringify({
        title: '愛麗絲的創作畫布',
        width: 3000,
        height: 2000,
        bgColor: '#FFFBF0',
      }),
    });
    const canvas1Data = await createRes1.json();
    const canvas1 = canvas1Data.canvas;
    console.log(`✓ Canvas created: '${canvas1.title}' (ID: ${canvas1.id}, Invite: ${canvas1.inviteCode})`);

    // Alice creates Canvas 2: "Quick Sketch"
    const createRes2 = await fetch(`${baseUrl}/api/canvases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceAuth.token}`,
      },
      body: JSON.stringify({
        title: '速寫練習本 (Sketch Tab)',
        width: 2048,
        height: 2048,
      }),
    });
    const canvas2Data = await createRes2.json();
    console.log(`✓ Second canvas created: '${canvas2Data.canvas.title}'`);

    // Verify multi-canvas list
    const listRes2 = await fetch(`${baseUrl}/api/canvases`);
    const { canvases: updatedCanvases } = await listRes2.json();
    console.log(`✓ Total canvases available in tabs bar: ${updatedCanvases.length}`);
    if (updatedCanvases.length !== initialCanvases.length + 2) {
      throw new Error('Multi-canvas tab list count mismatch');
    }

    // Bob joins Canvas 1 via invite code
    const joinRes = await fetch(`${baseUrl}/api/canvases/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bobAuth.token}`,
      },
      body: JSON.stringify({ inviteCode: canvas1.inviteCode }),
    });
    const joinData = await joinRes.json();
    console.log(`✓ Bob joined canvas via invite code. Role: ${joinData.myMembership.role}`);

    // ----------------------------------------------------------------
    // 4. Layer & ACL Permissions REST API
    // ----------------------------------------------------------------
    console.log('\n--- 4. Testing Layer CRUD & Fine-Grained ACL ---');

    // Alice creates an 'owner_only' Layer
    const layerRes1 = await fetch(`${baseUrl}/api/canvases/${canvas1.id}/layers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceAuth.token}`,
      },
      body: JSON.stringify({
        name: '愛麗絲私有線稿層 (Owner Only)',
        aclMode: 'owner_only',
      }),
    });
    const { layer: privateLayer } = await layerRes1.json();
    console.log(`✓ Layer created: '${privateLayer.name}', ACL: ${privateLayer.aclMode}`);

    // Alice creates a 'custom' Layer
    const layerRes2 = await fetch(`${baseUrl}/api/canvases/${canvas1.id}/layers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceAuth.token}`,
      },
      body: JSON.stringify({
        name: '雙人協作圖層 (Custom ACL)',
        aclMode: 'custom',
      }),
    });
    const { layer: customLayer } = await layerRes2.json();
    console.log(`✓ Layer created: '${customLayer.name}', ACL: ${customLayer.aclMode}`);

    // Alice grants Bob drawing permissions on customLayer
    const permRes = await fetch(
      `${baseUrl}/api/canvases/${canvas1.id}/layers/${customLayer.id}/permissions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceAuth.token}`,
        },
        body: JSON.stringify({
          userId: bobAuth.user.id,
          canDraw: true,
          canErase: true,
          canFilter: false,
          canModifyProps: false,
        }),
      }
    );
    const permData = await permRes.json();
    console.log(`✓ Custom permissions assigned to Bob on layer '${customLayer.id}': canDraw=${permData.permission.canDraw}`);

    // ----------------------------------------------------------------
    // 5. Realtime WebSocket / Socket.io Room & Permission Gateway
    // ----------------------------------------------------------------
    console.log('\n--- 5. Testing Realtime WebSocket / Socket.io Room Gateway ---');

    // Connect Client 1: Alice (Authenticated Owner)
    const socketAlice: Socket = ClientSocket(baseUrl, {
      auth: { token: aliceAuth.token },
      transports: ['websocket'],
    });

    // Connect Client 2: Bob (Authenticated Member)
    const socketBob: Socket = ClientSocket(baseUrl, {
      auth: { token: bobAuth.token },
      transports: ['websocket'],
    });

    // Connect Client 3: Guest (Unauthenticated Anonymous Viewer)
    const socketGuest: Socket = ClientSocket(baseUrl, {
      auth: { displayName: '匿名參觀畫友' },
      transports: ['websocket'],
    });

    // Await auth_ack for all
    await Promise.all([
      new Promise<void>((resolve) => socketAlice.once('auth_ack', (data) => {
        if (data.isGuest !== false) throw new Error('Alice should not be guest');
        console.log(`✓ Socket Alice authenticated: ${data.user.displayName}`);
        resolve();
      })),
      new Promise<void>((resolve) => socketBob.once('auth_ack', (data) => {
        if (data.isGuest !== false) throw new Error('Bob should not be guest');
        console.log(`✓ Socket Bob authenticated: ${data.user.displayName}`);
        resolve();
      })),
      new Promise<void>((resolve) => socketGuest.once('auth_ack', (data) => {
        if (data.isGuest !== true) throw new Error('Guest must be flagged isGuest=true');
        console.log(`✓ Socket Guest authenticated as anonymous viewer: ${data.user.displayName}`);
        resolve();
      })),
    ]);

    // Join Canvas 1
    socketAlice.emit('join_canvas', { canvasId: canvas1.id });
    socketBob.emit('join_canvas', { canvasId: canvas1.id });
    socketGuest.emit('join_canvas', { canvasId: canvas1.id });

    // Wait for room_state with all 3 participants
    await new Promise<void>((resolve) => {
      socketAlice.on('room_state', (state: RoomStatePacket) => {
        if (state.canvasId === canvas1.id && state.members.length === 3) {
          console.log(`✓ Room state synced: ${state.members.length} members connected in Canvas`);
          const guestMember = state.members.find((m) => m.isGuest);
          if (!guestMember) throw new Error('Guest not found in room members');
          console.log(`  - Members: ${state.members.map((m) => `${m.displayName} (${m.isGuest ? 'Guest-ReadOnly' : m.serverRole})`).join(', ')}`);
          resolve();
        }
      });
    });

    // Test Transient Cursor Streaming
    console.log('\n--- 6. Testing Transient Cursor Streaming ---');
    await new Promise<void>((resolve) => {
      socketBob.once('cursor', (cursor) => {
        if (cursor.displayName === aliceAuth.user.displayName && cursor.x === 150 && cursor.y === 250) {
          console.log(`✓ Bob received transient cursor from Alice at (${cursor.x}, ${cursor.y})`);
          resolve();
        }
      });
      socketAlice.emit('cursor', {
        canvasId: canvas1.id,
        x: 150,
        y: 250,
        pressure: 0.85,
        isDrawing: true,
      });
    });

    // ----------------------------------------------------------------
    // 7. Authoritative Op Commit & Layer ACL Enforcement
    // ----------------------------------------------------------------
    console.log('\n--- 7. Testing Authoritative Op Commit & ACL Enforcement ---');

    // Case A: Alice draws on her 'owner_only' layer -> MUST SUCCEED & BROADCAST
    console.log('[Test 7A] Alice commits stroke on her owner_only layer...');
    await new Promise<void>((resolve) => {
      socketBob.once('op_broadcast', (op: OpBroadcastPacket) => {
        if (op.layerId === privateLayer.id && op.userId === aliceAuth.user.id) {
          console.log(`✓ Op broadcast received by Bob: Seq #${op.seq}, OpType=${op.opType}, User=${op.displayName}`);
          resolve();
        }
      });

      socketAlice.emit('op_commit', {
        canvasId: canvas1.id,
        layerId: privateLayer.id,
        opType: 'STROKE',
        payload: { brushId: 'gpen', points: [100, 100, 105, 105] },
        clientSeq: 1,
      });
    });

    // Case B: Bob tries to draw on Alice's 'owner_only' layer -> MUST BE REJECTED!
    console.log('[Test 7B] Bob tries to draw on Alice\'s owner_only layer...');
    await new Promise<void>((resolve) => {
      socketBob.once('op_rejected', (rej: OpRejectedPacket) => {
        console.log(`✓ Bob's Op was correctly rejected by Layer ACL: "${rej.reason}"`);
        resolve();
      });

      socketBob.emit('op_commit', {
        canvasId: canvas1.id,
        layerId: privateLayer.id,
        opType: 'STROKE',
        payload: { brushId: 'pencil', points: [200, 200] },
        clientSeq: 2,
      });
    });

    // Case C: Bob draws on 'custom' layer where Alice granted him permission -> MUST SUCCEED
    console.log('[Test 7C] Bob commits stroke on granted custom layer...');
    await new Promise<void>((resolve) => {
      socketAlice.once('op_broadcast', (op: OpBroadcastPacket) => {
        if (op.layerId === customLayer.id && op.userId === bobAuth.user.id) {
          console.log(`✓ Bob's Op succeeded on granted layer: Seq #${op.seq}, User=${op.displayName}`);
          resolve();
        }
      });

      socketBob.emit('op_commit', {
        canvasId: canvas1.id,
        layerId: customLayer.id,
        opType: 'STROKE',
        payload: { brushId: 'watercolor', points: [300, 300] },
        clientSeq: 3,
      });
    });

    // Case D: Guest (Anonymous) tries to draw -> MUST BE REJECTED!
    console.log('[Test 7D] Anonymous Guest tries to commit a stroke...');
    await new Promise<void>((resolve) => {
      socketGuest.once('op_rejected', (rej: OpRejectedPacket) => {
        console.log(`✓ Guest's Op was correctly blocked: "${rej.reason}"`);
        resolve();
      });

      socketGuest.emit('op_commit', {
        canvasId: canvas1.id,
        layerId: customLayer.id,
        opType: 'STROKE',
        payload: { points: [0, 0] },
      });
    });

    // Case E: MessagePack Binary Packet Test
    console.log('\n--- 8. Testing MessagePack Binary Protocol ---');
    await new Promise<void>((resolve) => {
      socketGuest.once('op_broadcast', (op: OpBroadcastPacket) => {
        if (op.seq > 0) {
          console.log(`✓ Guest received binary-committed Op broadcast: Seq #${op.seq}`);
          resolve();
        }
      });

      const commitPacket: OpCommitPacket = {
        type: 'OP_COMMIT',
        canvasId: canvas1.id,
        layerId: customLayer.id,
        opType: 'STROKE',
        payload: { brush: 'binary-airbrush', count: 42 },
        clientSeq: 99,
      };

      const binaryBytes = encodePacket(commitPacket);
      socketAlice.emit('binary_packet', binaryBytes);
    });

    // ----------------------------------------------------------------
    // 9. Admin Superuser Override
    // ----------------------------------------------------------------
    console.log('\n--- 9. Testing Admin Superuser Privilege ---');
    const socketAdmin = ClientSocket(baseUrl, {
      auth: { token: adminAuth.token },
      transports: ['websocket'],
    });

    await new Promise<void>((resolve) => socketAdmin.once('auth_ack', () => resolve()));
    socketAdmin.emit('join_canvas', { canvasId: canvas1.id });

    // Admin draws on Alice's private owner_only layer -> MUST BE ALLOWED!
    await new Promise<void>((resolve) => {
      socketAlice.once('op_broadcast', (op: OpBroadcastPacket) => {
        if (op.userId === adminAuth.user.id && op.layerId === privateLayer.id) {
          console.log(`✓ Admin successfully performed Op on private layer: Seq #${op.seq}, User=${op.displayName}`);
          resolve();
        }
      });

      socketAdmin.emit('op_commit', {
        canvasId: canvas1.id,
        layerId: privateLayer.id,
        opType: 'STROKE',
        payload: { action: 'admin-mod-stroke' },
      });
    });

    // Cleanup sockets
    socketAlice.disconnect();
    socketBob.disconnect();
    socketGuest.disconnect();
    socketAdmin.disconnect();

    console.log('\n====================================================');
    console.log('🎉 ALL PHASE 1 BACKEND & GATEWAY TESTS PASSED SUCCESSFULLY!');
    console.log('====================================================');
  } finally {
    await app.close();
  }
}

runTests().catch((err) => {
  console.error('\n❌ TEST RUN FAILED:', err);
  process.exit(1);
});
