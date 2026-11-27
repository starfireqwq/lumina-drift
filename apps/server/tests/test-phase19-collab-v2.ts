import assert from 'node:assert/strict';
import { io, type Socket } from 'socket.io-client';
import * as socketParser from 'socket.io-parser';
import {
  tileSocketParser,
  type CanvasGridConfig,
  type FollowStatePacket,
  type MemberToolUpdatePacket,
  type MemberViewportPacket,
  type RoomCollabStateSnapshot,
  type RoomReferenceBoardState,
  type RoomSwatch,
} from '@atelier/shared';

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2YAAAAASUVORK5CYII=';

function nextEvent<T>(socket: Socket, event: string, predicate?: (data: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const receive = (data: T) => {
      if (predicate && !predicate(data)) return;
      clearTimeout(timeout);
      socket.off(event, receive);
      resolve(data);
    };
    const timeout = setTimeout(() => {
      socket.off(event, receive);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 5000);
    socket.on(event, receive);
  });
}

async function runTest() {
  assert(process.env.DATA_DIR && process.env.PORT === '0', 'Run with the isolated test runner');
  const app = await (await import('../src/app')).buildApp();
  const sockets: Socket[] = [];
  try {
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const api = async (token: string, method: string, url: string, body?: unknown) => {
      const headers = new Headers();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      if (body !== undefined) headers.set('Content-Type', 'application/json');
      const response = await fetch(`${baseUrl}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      return { status: response.status, data: await response.json() };
    };
    const register = async (username: string) => {
      const result = await api('', 'POST', '/api/auth/register', { username, password: 'password123', displayName: username });
      assert.equal(result.status, 201);
      return { token: result.data.token as string, userId: result.data.user.id as string };
    };

    const alice = await register('alice_p19');
    const bob = await register('bob_p19');
    const carol = await register('carol_p19');

    const canvasRes = await api(alice.token, 'POST', '/api/canvases', { title: 'CollabV2', width: 1200, height: 800 });
    assert.equal(canvasRes.status, 201);
    const canvasId = canvasRes.data.canvas.id as string;

    assert.equal((await api(bob.token, 'POST', '/api/canvases/join', { canvasId })).status, 200);
    assert.equal((await api(carol.token, 'POST', '/api/canvases/join', { canvasId })).status, 200);
    // Demote carol to viewer so we can test read-only permissions
    const roleRes = await api(alice.token, 'PATCH', `/api/canvases/${canvasId}/members/${carol.userId}/role`, { role: 'viewer' });
    assert.equal(roleRes.status, 200);

    const connect = async (token: string) => {
      const socket = io(baseUrl, {
        auth: { token, canvasId },
        transports: ['websocket'],
        parser: tileSocketParser(socketParser),
      });
      sockets.push(socket);
      const syncPromise = nextEvent<RoomCollabStateSnapshot>(socket, 'collab_state_sync');
      await nextEvent(socket, 'connect');
      const snapshot = await syncPromise;
      return { socket, snapshot };
    };

    const connA = await connect(alice.token);
    const connB = await connect(bob.token);
    const connC = await connect(carol.token);

    assert.equal(connA.snapshot.grid.enabled, false);
    assert.deepEqual(connA.snapshot.swatches, []);
    assert.deepEqual(connA.snapshot.referenceBoard.items, []);

    // ------------------------------------------------------------------------
    // 5.1 Follow Camera & Online Tool Presence
    // ------------------------------------------------------------------------
    const toolWait = nextEvent<MemberToolUpdatePacket>(connB.socket, 'member_tool_update', (p) => p.userId === alice.userId);
    connA.socket.emit('member_tool', { canvasId, activeTool: 'lasso' });
    const toolPkt = await toolWait;
    assert.equal(toolPkt.activeTool, 'lasso');

    const vpWait = nextEvent<MemberViewportPacket>(connB.socket, 'member_viewport', (p) => p.userId === alice.userId);
    connA.socket.emit('viewport_sync', {
      canvasId,
      camera: { centerX: 420, centerY: 310, zoom: 1.75, rotation: 0.25, mirrorX: false, updatedAt: Date.now() },
      activeTool: 'eraser',
    });
    const vpPkt = await vpWait;
    assert.equal(vpPkt.camera.centerX, 420);
    assert.equal(vpPkt.camera.centerY, 310);
    assert.equal(vpPkt.camera.zoom, 1.75);
    assert.equal(vpPkt.activeTool, 'eraser');

    // Bob follows Alice: both receive follow_state AND Bob receives Alice's cached camera immediately
    const followStateWaitA = nextEvent<FollowStatePacket>(
      connA.socket,
      'follow_state',
      (f) => (f.followersByTarget[alice.userId] ?? []).includes(bob.userId)
    );
    const snapCameraWaitB = nextEvent<MemberViewportPacket>(
      connB.socket,
      'member_viewport',
      (p) => p.userId === alice.userId && p.camera.centerX === 420
    );
    connB.socket.emit('follow_target', { canvasId, targetUserId: alice.userId });
    const followState1 = await followStateWaitA;
    assert.deepEqual(followState1.followersByTarget[alice.userId], [bob.userId]);
    const snapCam = await snapCameraWaitB;
    assert.equal(snapCam.camera.zoom, 1.75);

    // Bob stops following Alice
    const unfollowWait = nextEvent<FollowStatePacket>(
      connA.socket,
      'follow_state',
      (f) => !(f.followersByTarget[alice.userId] ?? []).includes(bob.userId)
    );
    connB.socket.emit('follow_target', { canvasId, targetUserId: null });
    await unfollowWait;

    // ------------------------------------------------------------------------
    // 5.2 Canvas Grid Slots & Claiming
    // ------------------------------------------------------------------------
    // Editor (Bob) cannot toggle grid config
    const bobGridDenied = nextEvent<{ code: string; scope: string }>(connB.socket, 'collab_error');
    connB.socket.emit('grid_config_update', { canvasId, enabled: true, rows: 2, cols: 3 });
    assert.equal((await bobGridDenied).code, 'PERMISSION_DENIED');

    // Owner (Alice) enables 2x3 grid
    const gridEnabledWait = nextEvent<{ canvasId: string; grid: CanvasGridConfig }>(
      connB.socket,
      'grid_state_updated',
      (d) => d.grid.enabled && d.grid.rows === 2 && d.grid.cols === 3
    );
    connA.socket.emit('grid_config_update', { canvasId, enabled: true, rows: 2, cols: 3, showLabels: true });
    const gridState1 = await gridEnabledWait;
    assert.equal(gridState1.grid.rows, 2);
    assert.equal(gridState1.grid.cols, 3);

    // Viewer (Carol) cannot claim slot
    const carolClaimDenied = nextEvent<{ code: string }>(connC.socket, 'collab_error');
    connC.socket.emit('grid_slot_claim', { canvasId, slotIndex: 0 });
    assert.equal((await carolClaimDenied).code, 'PERMISSION_DENIED');

    // Bob claims slot 1
    const bobClaimWait = nextEvent<{ canvasId: string; grid: CanvasGridConfig }>(
      connA.socket,
      'grid_state_updated',
      (d) => d.grid.slots.some((s) => s.slotIndex === 1 && s.userId === bob.userId)
    );
    connB.socket.emit('grid_slot_claim', { canvasId, slotIndex: 1, label: 'Lineart' });
    const gridState2 = await bobClaimWait;
    assert.equal(gridState2.grid.slots[0].label, 'Lineart');

    // Alice (without force) gets ALREADY_CLAIMED on slot 1, then Alice claims slot 0
    const aliceConflict = nextEvent<{ code: string }>(connA.socket, 'collab_error');
    connA.socket.emit('grid_slot_claim', { canvasId, slotIndex: 1 });
    assert.equal((await aliceConflict).code, 'ALREADY_CLAIMED');

    const aliceClaimWait = nextEvent<{ canvasId: string; grid: CanvasGridConfig }>(
      connB.socket,
      'grid_state_updated',
      (d) => d.grid.slots.some((s) => s.slotIndex === 0 && s.userId === alice.userId)
    );
    connA.socket.emit('grid_slot_claim', { canvasId, slotIndex: 0 });
    await aliceClaimWait;

    // Bob cannot release Alice's slot 0
    const bobReleaseDenied = nextEvent<{ code: string }>(connB.socket, 'collab_error');
    connB.socket.emit('grid_slot_release', { canvasId, slotIndex: 0 });
    assert.equal((await bobReleaseDenied).code, 'NOT_OWNER');

    // Owner (Alice) force-releases Bob's slot 1
    const aliceReleaseBobWait = nextEvent<{ canvasId: string; grid: CanvasGridConfig }>(
      connB.socket,
      'grid_state_updated',
      (d) => !d.grid.slots.some((s) => s.slotIndex === 1)
    );
    connA.socket.emit('grid_slot_release', { canvasId, slotIndex: 1 });
    await aliceReleaseBobWait;

    // ------------------------------------------------------------------------
    // 5.3 Shared Room Swatches & Reference Board
    // ------------------------------------------------------------------------
    const viewerSwatchDenied = nextEvent<{ code: string }>(connC.socket, 'collab_error');
    connC.socket.emit('room_swatch_add', { canvasId, hex: '#ff6600' });
    assert.equal((await viewerSwatchDenied).code, 'PERMISSION_DENIED');

    const swatchWait1 = nextEvent<{ canvasId: string; swatches: RoomSwatch[] }>(
      connB.socket,
      'room_swatches_updated',
      (d) => d.swatches.some((s) => s.hex === '#FF6600')
    );
    connA.socket.emit('room_swatch_add', { canvasId, hex: '#f60', name: 'Sunset' });
    const swatchRes1 = await swatchWait1;
    assert.equal(swatchRes1.swatches.length, 1);
    assert.equal(swatchRes1.swatches[0].hex, '#FF6600');
    assert.equal(swatchRes1.swatches[0].name, 'Sunset');

    // Duplicate hex rejected
    const dupSwatchErr = nextEvent<{ code: string }>(connB.socket, 'collab_error');
    connB.socket.emit('room_swatch_add', { canvasId, hex: '#FF6600' });
    assert.equal((await dupSwatchErr).code, 'DUPLICATE');

    // Bob cannot remove Alice's swatch, but Bob can add & remove his own
    const bobRemoveForbidden = nextEvent<{ code: string }>(connB.socket, 'collab_error');
    connB.socket.emit('room_swatch_remove', { canvasId, swatchId: swatchRes1.swatches[0].id });
    assert.equal((await bobRemoveForbidden).code, 'FORBIDDEN');

    const swatchWait2 = nextEvent<{ canvasId: string; swatches: RoomSwatch[] }>(
      connA.socket,
      'room_swatches_updated',
      (d) => d.swatches.length === 2
    );
    connB.socket.emit('room_swatch_add', { canvasId, hex: '#22CC88', name: 'Mint' });
    const swatchRes2 = await swatchWait2;
    const bobSwatch = swatchRes2.swatches.find((s) => s.hex === '#22CC88')!;
    assert.ok(bobSwatch);

    const swatchWait3 = nextEvent<{ canvasId: string; swatches: RoomSwatch[] }>(
      connA.socket,
      'room_swatches_updated',
      (d) => d.swatches.length === 1
    );
    connB.socket.emit('room_swatch_remove', { canvasId, swatchId: bobSwatch.id });
    await swatchWait3;

    // Reference Board: invalid image rejected
    const badImgErr = nextEvent<{ code: string }>(connA.socket, 'collab_error');
    connA.socket.emit('room_ref_add', { canvasId, title: 'Bad', imageDataUrl: 'javascript:alert(1)' });
    assert.equal((await badImgErr).code, 'INVALID_IMAGE');

    // Alice adds reference image; Bob moves & scales it
    const refAddWait = nextEvent<{ canvasId: string; board: RoomReferenceBoardState }>(
      connB.socket,
      'room_ref_board_updated',
      (d) => d.board.items.length === 1
    );
    connA.socket.emit('room_ref_add', {
      canvasId,
      title: 'Pose Sheet',
      imageDataUrl: TINY_PNG_DATA_URL,
      x: 32,
      y: 48,
      width: 240,
      height: 180,
      scale: 1,
    });
    const refBoard1 = (await refAddWait).board;
    const refItemId = refBoard1.items[0].id;
    assert.equal(refBoard1.items[0].title, 'Pose Sheet');

    const refMoveWait = nextEvent<{ canvasId: string; board: RoomReferenceBoardState }>(
      connA.socket,
      'room_ref_board_updated',
      (d) => d.board.items[0]?.x === 120 && d.board.items[0]?.scale === 1.5
    );
    connB.socket.emit('room_ref_update', { canvasId, itemId: refItemId, updates: { x: 120, y: 90, scale: 1.5 } });
    const refBoard2 = (await refMoveWait).board;
    assert.equal(refBoard2.items[0].y, 90);

    // Owner locks board -> Bob blocked from editing/adding
    const lockWait = nextEvent<{ canvasId: string; board: RoomReferenceBoardState }>(
      connB.socket,
      'room_ref_board_updated',
      (d) => d.board.lockedByAdmin === true
    );
    connA.socket.emit('room_ref_lock', { canvasId, lockedByAdmin: true });
    await lockWait;

    const lockedErr = nextEvent<{ code: string }>(connB.socket, 'collab_error');
    connB.socket.emit('room_ref_update', { canvasId, itemId: refItemId, updates: { x: 200 } });
    assert.equal((await lockedErr).code, 'BOARD_LOCKED');

    // Verify REST endpoint & reconnect persistence
    const restRes = await api(bob.token, 'GET', `/api/canvases/${canvasId}/collab-state`);
    assert.equal(restRes.status, 200);
    assert.equal(restRes.data.grid.enabled, true);
    assert.equal(restRes.data.grid.rows, 2);
    assert.equal(restRes.data.grid.cols, 3);
    assert.equal(restRes.data.grid.slots.length, 1);
    assert.equal(restRes.data.grid.slots[0].slotIndex, 0);
    assert.equal(restRes.data.swatches.length, 1);
    assert.equal(restRes.data.swatches[0].hex, '#FF6600');
    assert.equal(restRes.data.referenceBoard.lockedByAdmin, true);
    assert.equal(restRes.data.referenceBoard.items.length, 1);
    assert.equal(restRes.data.referenceBoard.items[0].x, 120);

    // Reconnect a new socket and confirm collab_state_sync restores everything
    const connB2 = await connect(bob.token);
    assert.equal(connB2.snapshot.grid.enabled, true);
    assert.equal(connB2.snapshot.swatches[0].hex, '#FF6600');
    assert.equal(connB2.snapshot.referenceBoard.items[0].scale, 1.5);

    // Disconnect Alice while Carol follows her -> auto-unfollow
    const carolFollowWait = nextEvent<FollowStatePacket>(
      connC.socket,
      'follow_state',
      (f) => (f.followersByTarget[alice.userId] ?? []).includes(carol.userId)
    );
    connC.socket.emit('follow_target', { canvasId, targetUserId: alice.userId });
    await carolFollowWait;

    const autoUnfollowWait = nextEvent<FollowStatePacket>(
      connC.socket,
      'follow_state',
      (f) => !(f.followersByTarget[alice.userId] ?? []).length
    );
    connA.socket.disconnect();
    await autoUnfollowWait;

    console.log('✅ Phase 19 Collab 2.0 (follow camera, grid slots, room swatches, reference board) passed!');
  } finally {
    for (const s of sockets) s.disconnect();
    await app.close();
  }
}

runTest().catch((err) => {
  console.error('❌ Phase 19 Collab 2.0 test failed:', err);
  process.exit(1);
});
