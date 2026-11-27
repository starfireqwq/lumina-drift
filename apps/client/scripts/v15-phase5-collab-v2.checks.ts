import assert from 'node:assert/strict';
import {
  addRoomSwatch,
  cameraToViewportState,
  canEditRoomCollab,
  canManageRoomCollab,
  claimGridSlot,
  createDefaultGridConfig,
  getGridSlotCamera,
  getGridSlotLabel,
  getGridSlotRect,
  isAllowedReferenceImageDataUrl,
  normalizeGridConfig,
  normalizeReferenceBoard,
  normalizeRoomHexColor,
  releaseGridSlot,
  removeRoomSwatch,
  sanitizeViewportCamera,
  viewportStateToCamera,
} from '@atelier/shared';
import { getToolDisplayLabel } from '../src/utils/collabLocalStore';
import { enUS } from '../src/locales/en-US';
import { jaJP } from '../src/locales/ja-JP';
import { zhCN } from '../src/locales/zh-CN';
import { zhTW } from '../src/locales/zh-TW';

export async function runV15Phase5CollabV2Checks() {
  // 1. Follow Camera coordinate round-trip (pan, zoom, rotation, mirrorX, DPI scale)
  const cases = [
    { panX: 520, panY: 360, zoom: 1.5, rotation: 0, mirrorX: false, dpr: 1 },
    { panX: 310, panY: 440, zoom: 2.25, rotation: Math.PI / 4, mirrorX: false, dpr: 2 },
    { panX: 640, panY: 280, zoom: 0.75, rotation: -Math.PI / 3, mirrorX: true, dpr: 1.5 },
  ];
  for (const c of cases) {
    const cam = viewportStateToCamera(c, 1280, 720, 2000, 1500, c.dpr, 1000);
    const back = cameraToViewportState(cam, 1280, 720, 2000, 1500, c.dpr);
    assert.ok(Math.abs(back.panX - c.panX) < 1e-4, `panX mismatch: ${back.panX} vs ${c.panX}`);
    assert.ok(Math.abs(back.panY - c.panY) < 1e-4, `panY mismatch: ${back.panY} vs ${c.panY}`);
    assert.ok(Math.abs(back.zoom - c.zoom) < 1e-4, `zoom mismatch: ${back.zoom} vs ${c.zoom}`);
    assert.ok(Math.abs(back.rotation - c.rotation) < 1e-4, `rotation mismatch`);
    assert.equal(back.mirrorX, c.mirrorX);
  }
  assert.equal(sanitizeViewportCamera({ centerX: Number.NaN, centerY: 0, zoom: 1, rotation: 0 }), null);
  const clampedCam = sanitizeViewportCamera({ centerX: 100, centerY: 200, zoom: 999, rotation: Math.PI * 3 });
  assert.ok(clampedCam);
  assert.equal(clampedCam.zoom, 32);

  // 2. Grid Slots & Claiming
  const defGrid = createDefaultGridConfig(100);
  assert.equal(defGrid.enabled, false);
  assert.equal(defGrid.rows, 2);
  assert.equal(defGrid.cols, 2);
  assert.equal(getGridSlotLabel(0, 0), 'A1');
  assert.equal(getGridSlotLabel(1, 2), 'B3');

  const enabledGrid = normalizeGridConfig({ ...defGrid, enabled: true, rows: 2, cols: 3 });
  const rect = getGridSlotRect(enabledGrid, 4, 1200, 800);
  assert.deepEqual(rect, { slotIndex: 4, row: 1, col: 1, x: 400, y: 400, width: 400, height: 400 });

  const slotCam = getGridSlotCamera(enabledGrid, 4, 1200, 800, 1000, 600, 1);
  assert.ok(slotCam);
  assert.equal(slotCam.centerX, 600);
  assert.equal(slotCam.centerY, 600);
  assert.ok(slotCam.zoom > 1);

  const c1 = claimGridSlot(enabledGrid, 1, { userId: 'u1', displayName: 'Alice', color: '#ff0000' });
  assert.equal(c1.ok, true);
  assert.equal(c1.config.slots.length, 1);

  const c2 = claimGridSlot(c1.config, 1, { userId: 'u2', displayName: 'Bob', color: '#00ff00' });
  assert.equal(c2.ok, false);
  assert.equal(c2.reason, 'already_claimed');

  const rDenied = releaseGridSlot(c1.config, 1, { userId: 'u2', canForce: false });
  assert.equal(rDenied.ok, false);
  assert.equal(rDenied.reason, 'not_owner');

  const rForced = releaseGridSlot(c1.config, 1, { userId: 'admin', canForce: true });
  assert.equal(rForced.ok, true);
  assert.equal(rForced.config.slots.length, 0);

  // Shrinking grid drops out-of-range slots
  const shrunk = normalizeGridConfig({ ...c1.config, rows: 1, cols: 1 });
  assert.equal(shrunk.slots.length, 0);

  // 3. Shared Room Swatches & Reference Board validation + RBAC
  assert.equal(normalizeRoomHexColor('#abc'), '#AABBCC');
  assert.equal(normalizeRoomHexColor('3b82f6'), '#3B82F6');
  assert.equal(normalizeRoomHexColor('not-a-color'), null);

  const sw1 = addRoomSwatch([], { id: 's1', hex: '#f0a', addedBy: 'u1', addedByName: 'Alice' });
  assert.equal(sw1.ok, true);
  assert.equal(sw1.swatches[0].hex, '#FF00AA');

  const swDup = addRoomSwatch(sw1.swatches, { id: 's2', hex: '#FF00AA', addedBy: 'u2', addedByName: 'Bob' });
  assert.equal(swDup.ok, false);
  assert.equal(swDup.reason, 'duplicate');

  const swRemDenied = removeRoomSwatch(sw1.swatches, 's1', { userId: 'u2', canForce: false });
  assert.equal(swRemDenied.ok, false);
  assert.equal(swRemDenied.reason, 'forbidden');

  const swRemOk = removeRoomSwatch(sw1.swatches, 's1', { userId: 'u1', canForce: false });
  assert.equal(swRemOk.ok, true);
  assert.equal(swRemOk.swatches.length, 0);

  const validPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2YAAAAASUVORK5CYII=';
  assert.equal(isAllowedReferenceImageDataUrl(validPng), true);
  assert.equal(isAllowedReferenceImageDataUrl('https://evil.example/img.png'), false);
  assert.equal(isAllowedReferenceImageDataUrl('data:image/svg+xml;base64,PHN2Zz4='), false);

  const board = normalizeReferenceBoard({
    lockedByAdmin: true,
    items: [
      { id: 'r1', title: 'Pose', imageDataUrl: validPng, x: 20, y: 30, width: 200, height: 150, scale: 1.5, addedBy: 'u1', addedByName: 'Alice' },
      { id: 'r2', title: 'Invalid', imageDataUrl: 'javascript:alert(1)', x: 0, y: 0, width: 100, height: 100, scale: 1, addedBy: 'u1', addedByName: 'Alice' },
    ],
  });
  assert.equal(board.lockedByAdmin, true);
  assert.equal(board.items.length, 1);
  assert.equal(board.items[0].scale, 1.5);

  assert.equal(canManageRoomCollab({ isCanvasOwner: true }), true);
  assert.equal(canManageRoomCollab({ canvasRole: 'admin' }), true);
  assert.equal(canManageRoomCollab({ canvasRole: 'editor' }), false);
  assert.equal(canEditRoomCollab({ canvasRole: 'editor' }), true);
  assert.equal(canEditRoomCollab({ canvasRole: 'viewer' }), false);
  assert.equal(canEditRoomCollab({ isGuest: true }), false);

  // 4. Active tool display label & 4-locale coverage sanity check
  for (const locale of [zhTW, zhCN, enUS, jaJP]) {
    assert.ok(locale.collab.followCamera.length > 0);
    assert.ok(locale.collab.followingBanner.includes('{name}'));
    assert.ok(locale.collab.gridSlotCount.includes('{claimed}') && locale.collab.gridSlotCount.includes('{total}'));
    assert.ok(locale.collab.roomSwatchesTitle.length > 0);
    assert.ok(locale.collab.subViewTabPersonal.length > 0);
    assert.ok(locale.collab.subViewTabRoomBoard.length > 0);
    assert.ok(getToolDisplayLabel('brush', locale.tools as unknown as Record<string, unknown>).length > 0);
    assert.ok(getToolDisplayLabel('eraser', locale.tools as unknown as Record<string, unknown>).length > 0);
  }
}
