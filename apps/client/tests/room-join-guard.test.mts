import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { LayerModel } from '@atelier/shared';
import {
  LOCAL_ARTIST_USER_ID,
  filterVisibleOfflineCanvases,
  getLayerDrawGuidanceState,
  hasAnyDrawableLayerForUser,
  isBlockedOnlineGuestName,
  isCanvasViewerForUser,
  isLayerClaimableByUser,
  isLayerDrawableForUser,
  ownsDrawableLayerForUser,
  parseClosedOfflineCanvasIds,
  pickBestInitialLayer,
  resolveAutoSelectCanvasId,
  resolveInitialActiveCanvasId,
  resolveLayerOwnerDisplay,
  resolveNextCanvasAfterClose,
  resolveTargetCanvasId,
  sanitizeOnlineGuestName,
  shouldCommitCanvasFetch,
  shouldCommitGatewayResolve,
  shouldSkipAutoAssign,
} from '../src/utils/roomJoinGuard.ts';
import { OfflineSessionStore, isLocalOfflineCanvasId } from '../src/services/offlineStore.ts';

function makeLayer(overrides: Partial<LayerModel> & { id: string }): LayerModel {
  return {
    id: overrides.id,
    canvasId: overrides.canvasId ?? 'canvas-1',
    name: overrides.name ?? overrides.id,
    ownerId: overrides.ownerId === undefined ? null : overrides.ownerId,
    ownerDisplayName: overrides.ownerDisplayName,
    isPublic: overrides.isPublic ?? false,
    aclMode: overrides.aclMode ?? 'owner_only',
    isLocked: overrides.isLocked ?? false,
    alphaLocked: overrides.alphaLocked ?? false,
    isVisible: overrides.isVisible ?? true,
    opacity: overrides.opacity ?? 1,
    blendMode: overrides.blendMode ?? 'normal',
    layerType: overrides.layerType ?? 'raster',
    parentId: overrides.parentId ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    clipToBelow: overrides.clipToBelow ?? false,
    meta: overrides.meta ?? null,
  } as LayerModel;
}

const LABELS = {
  myLayer: '私有專屬圖層',
  publicLayer: '公開',
  painterPrefix: '畫師',
};

test('D1 resolveInitialActiveCanvasId isolates offline local_* and online UUIDs', () => {
  assert.equal(
    resolveInitialActiveCanvasId({
      isOfflineMode: true,
      sharedRoomId: 'room-online-1',
      savedCanvasId: 'room-online-2',
    }),
    null
  );
  assert.equal(
    resolveInitialActiveCanvasId({
      isOfflineMode: true,
      sharedRoomId: 'room-online-1',
      savedCanvasId: 'local_abc123',
    }),
    'local_abc123'
  );
  assert.equal(
    resolveInitialActiveCanvasId({
      isOfflineMode: false,
      sharedRoomId: null,
      savedCanvasId: 'local_abc123',
    }),
    null
  );
  assert.equal(
    resolveInitialActiveCanvasId({
      isOfflineMode: false,
      sharedRoomId: 'room-shared',
      savedCanvasId: 'room-saved',
    }),
    'room-shared'
  );
});

test('D1 shouldCommitCanvasFetch & shouldCommitGatewayResolve reject stale races and target switches', () => {
  const targetA = { serverOrigin: 'http://127.0.0.1:3000', isOfflineMode: false };
  const targetB = { serverOrigin: 'http://192.168.1.9:3000', isOfflineMode: false };
  const targetOffline = { serverOrigin: 'http://127.0.0.1:3000', isOfflineMode: true };

  // Background fetchCanvases must NOT commit while gateway is resolving (150ms race guard)
  assert.equal(
    shouldCommitCanvasFetch({
      requestSeq: 2,
      latestSeq: 2,
      requestTarget: targetA,
      currentTarget: targetA,
      gatewayResolving: true,
    }),
    false
  );
  // Stale sequence rejected
  assert.equal(
    shouldCommitCanvasFetch({
      requestSeq: 1,
      latestSeq: 2,
      requestTarget: targetA,
      currentTarget: targetA,
      gatewayResolving: false,
    }),
    false
  );
  // Server/mode switch rejected
  assert.equal(
    shouldCommitCanvasFetch({
      requestSeq: 2,
      latestSeq: 2,
      requestTarget: targetA,
      currentTarget: targetB,
      gatewayResolving: false,
    }),
    false
  );
  assert.equal(
    shouldCommitCanvasFetch({
      requestSeq: 2,
      latestSeq: 2,
      requestTarget: targetA,
      currentTarget: targetOffline,
      gatewayResolving: false,
    }),
    false
  );
  assert.equal(
    shouldCommitCanvasFetch({
      requestSeq: 3,
      latestSeq: 3,
      requestTarget: targetA,
      currentTarget: targetA,
      gatewayResolving: false,
    }),
    true
  );

  // Gateway resolve sequence & target guard
  assert.equal(
    shouldCommitGatewayResolve({
      resolveSeq: 1,
      latestResolveSeq: 2,
      requestTarget: targetA,
      currentTarget: targetA,
    }),
    false
  );
  assert.equal(
    shouldCommitGatewayResolve({
      resolveSeq: 2,
      latestResolveSeq: 2,
      requestTarget: targetA,
      currentTarget: targetOffline,
    }),
    false
  );
  assert.equal(
    shouldCommitGatewayResolve({
      resolveSeq: 2,
      latestResolveSeq: 2,
      requestTarget: targetA,
      currentTarget: targetA,
    }),
    true
  );
});

test('D1 resolveTargetCanvasId strictly matches by id even with duplicate room titles and honors priority', () => {
  const sameNameRooms = [
    { id: 'room-first', title: '深夜繪茶' },
    { id: 'room-second', title: '深夜繪茶' },
    { id: 'room-third', title: '深夜繪茶' },
  ];

  // Picking second same-name room from gateway never gets overwritten by room-first
  assert.equal(
    resolveTargetCanvasId({
      canvases: sameNameRooms,
      pendingGatewayCanvasId: 'room-second',
      liveActiveCanvasId: 'room-first',
      sharedRoomId: 'room-first',
      savedCanvasId: 'room-first',
    }),
    'room-second'
  );

  // Live activeCanvasIdRef beats stale savedCanvasId and canvases[0]
  assert.equal(
    resolveTargetCanvasId({
      canvases: sameNameRooms,
      pendingGatewayCanvasId: null,
      liveActiveCanvasId: 'room-third',
      sharedRoomId: null,
      savedCanvasId: 'room-first',
    }),
    'room-third'
  );

  // Deleted pending room falls back cleanly to live/saved/first
  assert.equal(
    resolveTargetCanvasId({
      canvases: sameNameRooms,
      pendingGatewayCanvasId: 'room-deleted',
      liveActiveCanvasId: null,
      sharedRoomId: null,
      savedCanvasId: 'room-second',
    }),
    'room-second'
  );
  assert.equal(
    resolveTargetCanvasId({
      canvases: sameNameRooms,
      pendingGatewayCanvasId: 'room-deleted',
      liveActiveCanvasId: 'room-gone',
      sharedRoomId: null,
      savedCanvasId: 'room-also-gone',
    }),
    'room-first'
  );
});

test('D1 resolveAutoSelectCanvasId does not overwrite room during gateway or resolve transition', () => {
  const canvases = [{ id: 'room-1' }, { id: 'room-2' }];
  assert.equal(
    resolveAutoSelectCanvasId({
      showGateway: true,
      gatewayResolving: false,
      canvases,
      activeCanvasId: null,
      savedCanvasId: 'room-2',
    }),
    null
  );
  assert.equal(
    resolveAutoSelectCanvasId({
      showGateway: false,
      gatewayResolving: true,
      canvases,
      activeCanvasId: null,
      pendingGatewayCanvasId: 'room-2',
    }),
    null
  );
  // Active room already valid -> do nothing
  assert.equal(
    resolveAutoSelectCanvasId({
      showGateway: false,
      gatewayResolving: false,
      canvases,
      activeCanvasId: 'room-2',
      savedCanvasId: 'room-1',
    }),
    null
  );
  // Active room invalid & settled -> resolve using priority (pending > saved > first)
  assert.equal(
    resolveAutoSelectCanvasId({
      showGateway: false,
      gatewayResolving: false,
      canvases,
      activeCanvasId: 'room-stale',
      pendingGatewayCanvasId: 'room-2',
      savedCanvasId: 'room-1',
    }),
    'room-2'
  );
});

test('D2 online guest name and layer owner display sanitize polluted local-artist / 本機畫師 labels', () => {
  assert.equal(isBlockedOnlineGuestName('本機畫師'), true);
  assert.equal(isBlockedOnlineGuestName('local-artist'), true);
  assert.equal(isBlockedOnlineGuestName('LOCAL_ARTIST'), true);
  assert.equal(isBlockedOnlineGuestName('小流光'), false);

  assert.equal(sanitizeOnlineGuestName('本機畫師', '訪客畫師'), '訪客畫師');
  assert.equal(sanitizeOnlineGuestName('  local-artist  ', '訪客'), '訪客');
  assert.equal(sanitizeOnlineGuestName('  ', '訪客畫師'), '訪客畫師');
  assert.equal(sanitizeOnlineGuestName('  小流光  ', '訪客畫師'), '小流光');

  const pollutedOnlineLayer = makeLayer({
    id: 'l-polluted',
    ownerId: LOCAL_ARTIST_USER_ID,
    ownerDisplayName: '本機畫師',
    isPublic: false,
    meta: { originalAuthor: '本機畫師' } as any,
  });

  const onlineDisplay = resolveLayerOwnerDisplay(pollutedOnlineLayer, {
    currentUserId: 'user-alice',
    roomMembers: [{ userId: LOCAL_ARTIST_USER_ID, displayName: '本機畫師' }],
    isOfflineCanvas: false,
    labels: LABELS,
  });
  assert.equal(onlineDisplay.isOwner, false);
  assert.equal(onlineDisplay.wasSanitizedLocalArtist, true);
  assert.equal(onlineDisplay.label, '畫師 #tist');
  assert.equal(onlineDisplay.label.includes('本機畫師'), false);

  // Offline canvas keeps local display name when viewing another/local entry
  const offlineDisplay = resolveLayerOwnerDisplay(pollutedOnlineLayer, {
    currentUserId: 'other-id',
    roomMembers: [{ userId: LOCAL_ARTIST_USER_ID, displayName: '本機畫師' }],
    isOfflineCanvas: true,
    labels: LABELS,
  });
  assert.equal(offlineDisplay.label, '本機畫師');
  assert.equal(offlineDisplay.wasSanitizedLocalArtist, false);
});

test('D2 drawability, auto-assign, and initial layer selection stay aligned with CanvasWorkspace.canEditPixels', () => {
  const userAlice = { id: 'user-alice', serverRole: 'admin', displayName: 'Alice' };
  const ctxAlice = { user: userAlice, isGuest: false, isCanvasViewer: false };

  const pollutedOther = makeLayer({
    id: 'l-other',
    ownerId: LOCAL_ARTIST_USER_ID,
    ownerDisplayName: '本機畫師',
    isPublic: false,
    aclMode: 'owner_only',
    sortOrder: 3,
  });
  const unclaimedPublic = makeLayer({
    id: 'l-public',
    ownerId: null,
    isPublic: true,
    sortOrder: 2,
  });
  const sharedOwned = makeLayer({
    id: 'l-shared',
    ownerId: 'user-bob',
    isPublic: false,
    aclMode: 'shared_all',
    sortOrder: 1,
  });
  const lockedOwn = makeLayer({
    id: 'l-locked-own',
    ownerId: 'user-alice',
    isPublic: false,
    isLocked: true,
    sortOrder: 4,
  });

  // Admin still CANNOT draw directly on another owner's owner_only layer or unclaimed public layer
  assert.equal(isLayerDrawableForUser(pollutedOther, ctxAlice), false);
  assert.equal(isLayerDrawableForUser(unclaimedPublic, ctxAlice), false);
  assert.equal(isLayerClaimableByUser(unclaimedPublic, ctxAlice), true);
  assert.equal(isLayerDrawableForUser(sharedOwned, ctxAlice), true);
  assert.equal(isLayerDrawableForUser(lockedOwn, ctxAlice), false);

  // Locked own layer must NOT count as owning a drawable layer
  assert.equal(ownsDrawableLayerForUser([lockedOwn, pollutedOther], ctxAlice), false);
  assert.equal(
    shouldSkipAutoAssign({
      autoAssign: true,
      isOfflineCanvas: false,
      authLoading: false,
      layers: [lockedOwn, pollutedOther],
      hintLayerId: null,
      alreadyTried: false,
      ctx: ctxAlice,
    }),
    false
  );

  // Stale local-artist identity on an online canvas MUST skip auto-assign
  assert.equal(
    shouldSkipAutoAssign({
      autoAssign: true,
      isOfflineCanvas: false,
      authLoading: false,
      layers: [pollutedOther],
      hintLayerId: null,
      alreadyTried: false,
      ctx: { user: { id: LOCAL_ARTIST_USER_ID, serverRole: 'admin' }, isGuest: false, isCanvasViewer: false },
    }),
    true
  );

  // Viewer detection respects serverRole=admin exemption
  assert.equal(
    isCanvasViewerForUser({
      user: { id: 'u1', serverRole: 'user' },
      isGuest: false,
      members: [{ userId: 'u1', canvasRole: 'viewer' }],
    }),
    true
  );
  assert.equal(
    isCanvasViewerForUser({
      user: { id: 'u1', serverRole: 'admin' },
      isGuest: false,
      members: [{ userId: 'u1', canvasRole: 'viewer' }],
    }),
    false
  );

  // pickBestInitialLayer prefers drawable shared_all over unclaimed public or polluted other-owner
  const picked = pickBestInitialLayer([pollutedOther, unclaimedPublic, sharedOwned, lockedOwn], ctxAlice, pollutedOther.id);
  assert.equal(picked?.id, 'l-shared');
});

test('D2 getLayerDrawGuidanceState covers switch, safe claim, create, guest, and viewer guidance', () => {
  const userAlice = { id: 'user-alice', serverRole: 'user', displayName: 'Alice' };
  const otherLayer = makeLayer({ id: 'l-other', name: '他人圖層', ownerId: LOCAL_ARTIST_USER_ID, ownerDisplayName: '本機畫師', sortOrder: 3 });
  const myLayer = makeLayer({ id: 'l-mine', name: 'Alice 的圖層', ownerId: 'user-alice', sortOrder: 2 });
  const publicLayer = makeLayer({ id: 'l-pub', name: '公共草稿', ownerId: null, isPublic: true, sortOrder: 1 });

  // Case C: active is another owner's layer, Alice has a drawable layer -> one-click switch
  const switchState = getLayerDrawGuidanceState({
    layers: [otherLayer, myLayer, publicLayer],
    activeLayerId: otherLayer.id,
    user: userAlice,
    isGuest: false,
    isCanvasViewer: false,
    canCreateLayer: true,
  });
  assert.equal(switchState.kind, 'switch_to_drawable');
  assert.equal(switchState.reason, 'other_owner');
  assert.equal(switchState.switchTargetLayerId, myLayer.id);
  assert.equal(switchState.switchTargetLayerName, 'Alice 的圖層');

  // Case D: active is public unclaimed -> safe claim (and also exposes switchTargetLayerId)
  const claimState = getLayerDrawGuidanceState({
    layers: [otherLayer, myLayer, publicLayer],
    activeLayerId: publicLayer.id,
    user: userAlice,
    isGuest: false,
    isCanvasViewer: false,
    canCreateLayer: true,
  });
  assert.equal(claimState.kind, 'claim_public_layer');
  assert.equal(claimState.claimTargetLayerId, publicLayer.id);
  assert.equal(claimState.switchTargetLayerId, myLayer.id);

  // Case E: no drawable layer at all -> create my layer
  const createState = getLayerDrawGuidanceState({
    layers: [otherLayer],
    activeLayerId: otherLayer.id,
    user: userAlice,
    isGuest: false,
    isCanvasViewer: false,
    canCreateLayer: true,
  });
  assert.equal(createState.kind, 'create_my_layer');
  assert.equal(createState.canCreateLayer, true);
  assert.equal(hasAnyDrawableLayerForUser([otherLayer, publicLayer], { user: userAlice, isGuest: false, isCanvasViewer: false }), false);

  // Case A: guest -> guest_login_required
  const guestState = getLayerDrawGuidanceState({
    layers: [publicLayer],
    activeLayerId: publicLayer.id,
    user: { id: 'guest_1', serverRole: 'guest' },
    isGuest: true,
    isCanvasViewer: false,
    canCreateLayer: false,
  });
  assert.equal(guestState.kind, 'guest_login_required');

  // Case B: viewer -> viewer_readonly
  const viewerState = getLayerDrawGuidanceState({
    layers: [myLayer],
    activeLayerId: myLayer.id,
    user: userAlice,
    isGuest: false,
    isCanvasViewer: true,
    canCreateLayer: false,
  });
  assert.equal(viewerState.kind, 'viewer_readonly');

  // Drawable active layer -> no banner
  const drawableState = getLayerDrawGuidanceState({
    layers: [otherLayer, myLayer],
    activeLayerId: myLayer.id,
    user: userAlice,
    isGuest: false,
    isCanvasViewer: false,
    canCreateLayer: true,
  });
  assert.equal(drawableState.kind, 'drawable');
});

test('D1/D2 source wiring contract: App, LayerPanel, AuthContext, and SocketContext use roomJoinGuard safely', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const appSrc = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
  const layerPanelSrc = fs.readFileSync(path.join(root, 'src/components/LayerPanel.tsx'), 'utf8');
  const socketSrc = fs.readFileSync(path.join(root, 'src/context/SocketContext.tsx'), 'utf8');
  const authSrc = fs.readFileSync(path.join(root, 'src/context/AuthContext.tsx'), 'utf8');

  assert.match(appSrc, /shouldCommitCanvasFetch/);
  assert.match(appSrc, /shouldCommitGatewayResolve/);
  assert.match(appSrc, /resolveTargetCanvasId/);
  assert.match(appSrc, /resolveAutoSelectCanvasId/);
  assert.match(appSrc, /getActiveCanvasId/);
  assert.match(appSrc, /clearActiveCanvas/);
  assert.match(appSrc, /shouldSkipAutoAssign/);
  assert.match(appSrc, /pickBestInitialLayer/);

  assert.match(layerPanelSrc, /resolveLayerOwnerDisplay/);
  assert.match(layerPanelSrc, /getLayerDrawGuidanceState/);
  assert.match(layerPanelSrc, /data-layer-draw-guidance/);
  assert.match(layerPanelSrc, /onClaimLayer\(guidance\.claimTargetLayerId!, false\)/);

  assert.match(socketSrc, /resolveInitialActiveCanvasId/);
  assert.match(socketSrc, /sanitizeOnlineGuestName/);
  assert.match(authSrc, /sanitizeOnlineGuestName/);
});

test('D3 OfflineSessionStore strictly rejects online room UUIDs and never hijacks them as offline canvases', async () => {
  const onlineUuid = '9a8b7c6d-1234-4abc-9def-001122334455';
  const localId = `local_guard_${Date.now()}`;

  assert.equal(isLocalOfflineCanvasId(onlineUuid), false);
  assert.equal(isLocalOfflineCanvasId(localId), true);
  assert.equal(isLocalOfflineCanvasId(null), false);

  // Even when an online UUID is passed, isOfflineCanvas MUST return false (never hijacked by records or mode)
  assert.equal(OfflineSessionStore.isOfflineCanvas(onlineUuid), false);
  assert.equal(OfflineSessionStore.isOfflineCanvas(localId), true);

  // Attempting to create a layer or list layers for a non-local online UUID must reject rather than create a ghost record
  await assert.rejects(() => OfflineSessionStore.createLayer(onlineUuid, { name: '圖層 1' }), /non-local id/);
  await assert.rejects(() => OfflineSessionStore.listLayers(onlineUuid), /non-local id/);

  // Side-effecting write helpers safely no-op for non-local online UUIDs
  assert.equal(OfflineSessionStore.commitLocalOp(onlineUuid, 'l1', 'STROKE', { tiles: [] }), 0);
  assert.equal(OfflineSessionStore.commitLocalTilePatch(onlineUuid, 'l1', []), 0);
  assert.equal(OfflineSessionStore.isOfflineCanvas(onlineUuid), false);

  // Legitimate local_* canvases continue to work normally
  const created = await OfflineSessionStore.createLayer(localId, { name: '單機圖層' });
  assert.equal(created.canvasId, localId);
  await OfflineSessionStore.deleteCanvas(localId);
});

test('D3 offline canvas tab close helpers filter closed/poisoned tabs and choose adjacent next tab', () => {
  const closed = parseClosedOfflineCanvasIds(JSON.stringify(['local_2', 'online-uuid-poison', 123]));
  assert.deepEqual(Array.from(closed), ['local_2']);

  const allCanvases = [
    { id: 'local_1' },
    { id: 'local_2' },
    { id: 'local_3' },
    { id: 'online-uuid-poison' },
  ];
  const visible = filterVisibleOfflineCanvases(allCanvases, closed);
  assert.deepEqual(
    visible.map((c) => c.id),
    ['local_1', 'local_3']
  );

  assert.equal(resolveNextCanvasAfterClose([{ id: 'local_1' }, { id: 'local_2' }, { id: 'local_3' }], 'local_2'), 'local_3');
  assert.equal(resolveNextCanvasAfterClose([{ id: 'local_1' }, { id: 'local_2' }], 'local_2'), 'local_1');
  assert.equal(resolveNextCanvasAfterClose([{ id: 'local_1' }], 'local_1'), null);
});

test('D3 source wiring contract: CanvasWorkspace undo layer creation, CanvasTabsBar offline close, and OfflineSessionStore self-heal', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const workspaceSrc = fs.readFileSync(path.join(root, 'src/components/CanvasWorkspace.tsx'), 'utf8');
  const tabsSrc = fs.readFileSync(path.join(root, 'src/components/CanvasTabsBar.tsx'), 'utf8');
  const offlineSrc = fs.readFileSync(path.join(root, 'src/services/offlineStore.ts'), 'utf8');
  const appSrc = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');

  assert.match(workspaceSrc, /onCreateLayer=\{onCreateLayer \? createLayerWithUndo : \(\(\) => \{\}\)\}/);
  assert.match(workspaceSrc, /onRegisterRecordLayerCreation/);
  assert.match(workspaceSrc, /candidate\?\.layerCreated\?\.model/);
  assert.match(appSrc, /handleCloseOfflineCanvas/);
  assert.match(appSrc, /onRegisterRecordLayerCreation=\{registerRecordLayerCreation\}/);
  assert.match(tabsSrc, /data-close-offline-canvas/);
  assert.match(offlineSrc, /isLocalOfflineCanvasId/);
  assert.match(offlineSrc, /poisonedIds/);
});
