import { io as ClientSocket, Socket } from 'socket.io-client';
import { buildApp } from '../src/app';
import { AuthResponse, LayerModel } from '@atelier/shared';

async function runPhase2Tests() {
  console.log('====================================================');
  console.log('🚀 Starting AtelierSync Phase 2 Layer ACL & Takeover Tests');
  console.log('====================================================');

  const app = await buildApp();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[Test Server] Running on ${baseUrl}`);

  try {
    // 1. Auth Admin, Alice, Bob
    const runId = Date.now().toString().slice(-4);
    const aliceUser = `alice_p2_${runId}`;
    const bobUser = `bob_p2_${runId}`;

    // Admin login
    const adminLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const adminAuth: AuthResponse = await adminLoginRes.json();

    // Alice
    const aliceRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: aliceUser, password: 'password123', displayName: '愛麗絲P2' }),
    });
    const aliceAuth: AuthResponse = await aliceRes.json();

    // Bob
    const bobRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: bobUser, password: 'password123', displayName: '小鮑伯P2' }),
    });
    const bobAuth: AuthResponse = await bobRes.json();

    // 2. Alice creates a canvas
    const canvasRes = await fetch(`${baseUrl}/api/canvases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceAuth.token}`,
      },
      body: JSON.stringify({ title: 'Phase 2 繪茶房間' }),
    });
    const { canvas } = await canvasRes.json();

    // Bob joins canvas via invite
    await fetch(`${baseUrl}/api/canvases/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bobAuth.token}`,
      },
      body: JSON.stringify({ inviteCode: canvas.inviteCode }),
    });

    // 3. Alice creates a layer (default owned by Alice, isPublic: false)
    const layerRes = await fetch(`${baseUrl}/api/canvases/${canvas.id}/layers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceAuth.token}`,
      },
      body: JSON.stringify({ name: '愛麗絲的繪製層' }),
    });
    const { layer }: { layer: LayerModel } = await layerRes.json();
    console.log(`✓ Layer created by Alice: ${layer.name}, ownerId=${layer.ownerId}, isPublic=${layer.isPublic}`);
    if (layer.ownerId !== aliceAuth.user.id || layer.isPublic !== false) {
      throw new Error('Default layer ownership or isPublic check failed');
    }

    // Connect Sockets for Alice and Bob
    const socketAlice: Socket = ClientSocket(baseUrl, {
      auth: { token: aliceAuth.token },
      transports: ['websocket'],
    });
    const socketBob: Socket = ClientSocket(baseUrl, {
      auth: { token: bobAuth.token },
      transports: ['websocket'],
    });

    await new Promise<void>((resolve) => {
      let count = 0;
      socketAlice.on('connect', () => { if (++count === 2) resolve(); });
      socketBob.on('connect', () => { if (++count === 2) resolve(); });
    });

    socketAlice.emit('join_canvas', { canvasId: canvas.id });
    socketBob.emit('join_canvas', { canvasId: canvas.id });
    await new Promise((r) => setTimeout(r, 200));

    // 4. Bob tries to draw on Alice's layer -> should be rejected!
    console.log('\n--- Test: Bob attempts to draw on Alice\'s layer (should be rejected) ---');
    const rejPromise = new Promise<string>((resolve) => {
      socketBob.once('op_rejected', (data) => resolve(data.reason));
    });
    socketBob.emit('op_commit', {
      canvasId: canvas.id,
      layerId: layer.id,
      opType: 'STROKE',
      payload: { x: 10, y: 10 },
    });
    const rejReason = await rejPromise;
    console.log(`✓ Bob was rejected as expected: "${rejReason}"`);

    // 5. Bob tries to reorder Alice's layer -> should fail
    console.log('\n--- Test: Bob attempts to reorder Alice\'s layer (should fail) ---');
    const reorderFailRes = await fetch(`${baseUrl}/api/canvases/${canvas.id}/layers/${layer.id}/reorder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bobAuth.token}`,
      },
      body: JSON.stringify({ newSortOrder: 99 }),
    });
    if (reorderFailRes.status === 403) {
      console.log('✓ Bob reorder rejected with 403 Forbidden as expected');
    } else {
      throw new Error(`Expected 403 for Bob reorder, got ${reorderFailRes.status}`);
    }

    // 6. Alice releases the layer (所有人皆可拿取)
    console.log('\n--- Test: Alice releases her layer ---');
    const updateEventPromise = new Promise<any>((resolve) => {
      socketBob.once('layer_updated', (data) => resolve(data));
    });

    socketAlice.emit('release_layer', { canvasId: canvas.id, layerId: layer.id });
    const updateEvent = await updateEventPromise;
    console.log(`✓ Bob received layer_updated event: action=${updateEvent.action}, isPublic=${updateEvent.layer.isPublic}`);
    if (!updateEvent.layer.isPublic) {
      throw new Error('Layer isPublic was not set to true on release');
    }

    // 7. Bob claims the released layer
    console.log('\n--- Test: Bob claims the released layer ---');
    const claimEventPromise = new Promise<any>((resolve) => {
      const onClaim = (data: any) => {
        if (data.layer.id !== layer.id || data.action !== 'claim') return;
        socketAlice.off('layer_updated', onClaim);
        resolve(data);
      };
      socketAlice.on('layer_updated', onClaim);
    });

    socketBob.emit('claim_layer', { canvasId: canvas.id, layerId: layer.id });
    const claimEvent = await claimEventPromise;
    console.log(`✓ Layer claimed: new owner=${claimEvent.layer.ownerId}, isPublic=${claimEvent.layer.isPublic}`);
    if (claimEvent.layer.ownerId !== bobAuth.user.id || claimEvent.layer.isPublic !== false) {
      throw new Error('Bob did not become the owner or isPublic was not reset to false');
    }

    // 8. Now Bob draws on the claimed layer -> should succeed!
    console.log('\n--- Test: Bob draws on the claimed layer (should succeed) ---');
    const broadcastPromise = new Promise<any>((resolve) => {
      socketAlice.once('op_broadcast', (data) => resolve(data));
    });
    socketBob.emit('op_commit', {
      canvasId: canvas.id,
      layerId: layer.id,
      opType: 'STROKE',
      payload: { x: 50, y: 50 },
    });
    const broadcast = await broadcastPromise;
    console.log(`✓ Op broadcast received: user=${broadcast.displayName}, seq=#${broadcast.seq}`);

    // 9. Admin Force Claim
    console.log('\n--- Test: Admin performs Force Claim on Bob\'s layer ---');
    const adminClaimRes = await fetch(`${baseUrl}/api/canvases/${canvas.id}/layers/${layer.id}/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({ force: true }),
    });
    const adminClaimData = await adminClaimRes.json();
    console.log(`✓ Admin force claimed layer: new owner=${adminClaimData.layer.ownerId} (Admin)`);
    if (adminClaimData.layer.ownerId !== adminAuth.user.id) {
      throw new Error('Admin force claim failed');
    }

    socketAlice.disconnect();
    socketBob.disconnect();
    await app.close();
    console.log('\n====================================================');
    console.log('🎉 ALL PHASE 2 LAYER PERMISSION TESTS PASSED!');
    console.log('====================================================');
  } catch (err) {
    console.error('Test failed:', err);
    await app.close();
    process.exit(1);
  }
}

runPhase2Tests();
