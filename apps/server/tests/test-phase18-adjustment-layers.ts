import assert from 'node:assert/strict';
import { io, type Socket } from 'socket.io-client';
import * as socketParser from 'socket.io-parser';
import {
  tileSocketParser,
  type AdjustmentKind,
  type LayerModel,
  type OpBroadcastPacket,
  type OpRejectedPacket,
} from '@atelier/shared';

function nextEvent<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const receive = (data: T) => {
      clearTimeout(timeout);
      resolve(data);
    };
    const timeout = setTimeout(() => {
      socket.off(event, receive);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 5000);
    socket.once(event, receive);
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
      const response = await fetch(`${baseUrl}${url}`, { method, headers, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    const register = async (username: string) => {
      const result = await api('', 'POST', '/api/auth/register', { username, password: 'password123', displayName: username });
      assert.equal(result.status, 201);
      return result.data.token as string;
    };
    const alice = await register('alice_p18');
    const bob = await register('bob_p18');
    const canvas = await api(alice, 'POST', '/api/canvases', { title: 'P18', width: 256, height: 256 });
    assert.equal(canvas.status, 201);
    const canvasId = canvas.data.canvas.id as string;
    assert.equal((await api(bob, 'POST', '/api/canvases/join', { canvasId })).status, 200);
    const url = `/api/canvases/${canvasId}/layers`;
    const getLayers = async (): Promise<LayerModel[]> => {
      const result = await api(alice, 'GET', url);
      assert.equal(result.status, 200);
      return result.data.layers;
    };
    const connect = async (token: string) => {
      const socket = io(baseUrl, {
        auth: { token, canvasId },
        transports: ['websocket'],
        parser: tileSocketParser(socketParser),
        autoConnect: false,
      });
      sockets.push(socket);
      const joined = nextEvent<{ canvasId: string }>(socket, 'room_state');
      socket.connect();
      assert.equal((await joined).canvasId, canvasId);
      return socket;
    };
    const sa = await connect(alice);
    const sb = await connect(bob);

    const cases = {
      hsl: [{ hue: 999, saturation: -999 }, { hue: 180, saturation: -100, lightness: 0, colorize: false }],
      levels: [{ master: { inBlack: 255, inWhite: 10, gamma: 99 } },
        { master: { inBlack: 253, inWhite: 255, gamma: 9.99, outBlack: 0, outWhite: 255 } }],
      curves: [{ master: [{ x: 255, y: -5 }, { x: 0, y: 300 }] },
        { master: [{ x: 0, y: 255 }, { x: 255, y: 0 }] }],
      color_balance: [{ shadows: { cyanRed: -999 }, preserveLuminosity: 'false' },
        { shadows: { cyanRed: -100, magentaGreen: 0, yellowBlue: 0 }, preserveLuminosity: true }],
      gradient_map: [{ stops: [{ offset: 0, color: '#ABC' }, { offset: 2, color: '#DEF' }] },
        { stops: [{ offset: 0, color: '#aabbcc' }, { offset: 1, color: '#ddeeff' }], reverse: false }],
      brightness_contrast: [{ brightness: 1500, contrast: -1000 }, { brightness: 150, contrast: -50 }],
    } satisfies Record<AdjustmentKind, [object, object]>;
    let adjustmentId = '';
    for (const [kind, [params, expected]] of Object.entries(cases)) {
      const [result, creation] = await Promise.all([
        api(alice, 'POST', url, { name: kind, layerType: 'adjustment', meta: { adjustment: { kind, params }, originalAuthor: 'Artist' } }),
        nextEvent<{ action: string; layer: LayerModel }>(sb, 'layer_updated'),
      ]);
      assert.equal(result.status, 201);
      const layer = result.data.layer as LayerModel;
      assert.equal(layer.layerType, 'adjustment');
      assert.equal(layer.meta?.originalAuthor, 'Artist');
      assert.equal(layer.meta?.adjustment?.kind, kind);
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual((layer.meta!.adjustment!.params as unknown as Record<string, unknown>)[key], value);
      }
      assert.equal(creation.action, 'create');
      assert.deepEqual(creation.layer, layer);
      if (kind === 'hsl') adjustmentId = layer.id;
    }
    const adjustmentUrl = `${url}/${adjustmentId}`;
    assert.equal((await getLayers()).filter((layer) => layer.layerType === 'adjustment').length, 6);

    const invalidAdjustment = { error: '調整圖層參數無效' };
    for (const meta of [undefined, { adjustment: { kind: 'unknown' } }]) {
      const result = await api(alice, 'POST', url, { name: 'Invalid', layerType: 'adjustment', meta });
      assert.equal(result.status, 400);
      assert.deepEqual(result.data, invalidAdjustment);
    }
    const invalidType = await api(alice, 'POST', url, { name: 'Invalid', layerType: 'unknown' });
    assert.equal(invalidType.status, 400);
    assert.deepEqual(invalidType.data, { error: '圖層類型無效' });

    const meta = { adjustment: { kind: 'hsl', params: { hue: 60, saturation: 25, lightness: 0, colorize: true } }, keyframes: [] };
    const [patch, update] = await Promise.all([
      api(alice, 'PATCH', adjustmentUrl, { meta, layerType: 'raster' }),
      nextEvent<{ action: string; layer: LayerModel }>(sb, 'layer_updated'),
    ]);
    assert.equal(patch.status, 200);
    assert.equal(update.action, 'update');
    assert.equal(update.layer.layerType, 'adjustment');
    assert.deepEqual(update.layer.meta, meta);
    assert.deepEqual((await getLayers()).find((layer) => layer.id === adjustmentId), update.layer);
    for (const replacement of [null, { keyframes: [] }]) {
      const result = await api(alice, 'PATCH', adjustmentUrl, { name: 'Rejected rename', meta: replacement });
      assert.equal(result.status, 400);
      assert.deepEqual(result.data, invalidAdjustment);
    }
    assert.deepEqual((await getLayers()).find((layer) => layer.id === adjustmentId), update.layer);

    const raster = await api(alice, 'POST', url, { name: 'Raster', layerType: 'raster', meta });
    assert.equal(raster.status, 201);
    assert.deepEqual(raster.data.layer.meta, { keyframes: [] });
    const rasterPatch = await api(alice, 'PATCH', `${url}/${raster.data.layer.id}`, { layerType: 'adjustment', meta });
    assert.equal(rasterPatch.status, 200);
    assert.equal(rasterPatch.data.layer.layerType, 'raster');
    assert.deepEqual(rasterPatch.data.layer.meta, { keyframes: [] });

    const rasterUrl = `${url}/${raster.data.layer.id}`;
    const colors = { paletteColor: '#AABBCC', layerColor: { enabled: true, mainColor: '#112233', subColor: '#DDEEFF' } };
    const colorPatch = await api(alice, 'PATCH', rasterUrl, {
      meta: { paletteColor: ' #abc ', layerColor: { enabled: true, mainColor: '#123', subColor: '#def' } },
    });
    assert.equal(colorPatch.status, 200);
    assert.deepEqual(colorPatch.data.layer.meta, colors);
    for (const [invalid, error] of [
      [{ paletteColor: '#xyz' }, '圖層標籤色格式無效'],
      [{ layerColor: { enabled: true, mainColor: '#1234' } }, '圖層顯示顏色格式無效'],
      [{ layerColor: { enabled: true, mainColor: '#123', subColor: '#xyz' } }, '圖層顯示顏色格式無效'],
    ] as const) {
      const rejected = await api(alice, 'PATCH', rasterUrl, { meta: invalid });
      assert.equal(rejected.status, 400);
      assert.deepEqual(rejected.data, { error });
    }
    assert.deepEqual((await getLayers()).find((layer) => layer.id === raster.data.layer.id)?.meta, colors);
    const cleared = await api(alice, 'PATCH', rasterUrl, { meta: { paletteColor: '', layerColor: null } });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.data.layer.meta, {});

    // v1.5 Phase 4: Layer & Folder Effects persistence, normalization, validation, and realtime sync
    const effectsPayload = {
      enabled: true,
      border: { enabled: true, mode: 'watercolor', width: 6, color: ' #123 ', opacity: 0.9, antiAlias: true, watercolorDarkness: 0.6, watercolorBlur: 4 },
      dropShadow: { enabled: true, color: '#000', opacity: 0.5, offsetX: 8, offsetY: 10, blur: 12, spread: 2 },
      outerGlow: { enabled: true, color: '#0af', opacity: 0.7, radius: 10, spread: 1 },
      colorOverlay: { enabled: true, color: '#f0a', opacity: 0.4, blendMode: 'multiply' },
    };
    const expectedEffects = {
      enabled: true,
      border: { enabled: true, mode: 'watercolor', width: 6, color: '#112233', opacity: 0.9, antiAlias: true, watercolorDarkness: 0.6, watercolorBlur: 4 },
      dropShadow: { enabled: true, color: '#000000', opacity: 0.5, offsetX: 8, offsetY: 10, blur: 12, spread: 2 },
      outerGlow: { enabled: true, color: '#00AAFF', opacity: 0.7, radius: 10, spread: 1 },
      colorOverlay: { enabled: true, color: '#FF00AA', opacity: 0.4, blendMode: 'multiply' },
    };
    const [fxPatch, fxBroadcast] = await Promise.all([
      api(alice, 'PATCH', rasterUrl, { meta: { effects: effectsPayload } }),
      nextEvent<{ canvasId: string; layer: { id: string; meta?: { effects?: unknown } } }>(sb, 'layer_updated'),
    ]);
    assert.equal(fxPatch.status, 200);
    assert.deepEqual(fxPatch.data.layer.meta, { effects: expectedEffects });
    assert.equal(fxBroadcast.layer.id, raster.data.layer.id);
    assert.deepEqual(fxBroadcast.layer.meta, { effects: expectedEffects });

    const groupWithEffects = await api(alice, 'POST', url, {
      name: 'Styled Folder',
      layerType: 'group',
      meta: { effects: { enabled: true, border: { enabled: true, mode: 'edge', width: 3, color: '#fff', opacity: 1 } } },
    });
    assert.equal(groupWithEffects.status, 201);
    assert.equal(groupWithEffects.data.layer.meta.effects.border.color, '#FFFFFF');

    for (const badEffects of [
      { effects: { enabled: 'yes' } },
      { effects: { enabled: true, border: { enabled: true, mode: 'invalid', width: 3, color: '#fff', opacity: 1 } } },
      { effects: { enabled: true, dropShadow: { enabled: true, color: '#zzzzzz', opacity: 0.5, offsetX: 2, offsetY: 2, blur: 4 } } },
      { effects: { enabled: true, colorOverlay: { enabled: true, color: '#112233', opacity: 0.5, blendMode: 'bad' } } },
    ]) {
      const badRes = await api(alice, 'PATCH', rasterUrl, { meta: badEffects });
      assert.equal(badRes.status, 400);
      assert.deepEqual(badRes.data, { error: '圖層樣式參數無效' });
    }
    const fxCleared = await api(alice, 'PATCH', rasterUrl, { meta: { effects: null } });
    assert.equal(fxCleared.status, 200);
    assert.deepEqual(fxCleared.data.layer.meta, {});
    assert.equal((await api(alice, 'DELETE', `${url}/${groupWithEffects.data.layer.id}`)).status, 200);

    const canvasUrl = `/api/canvases/${canvasId}`;
    const [canvasPatch, canvasEvent] = await Promise.all([
      api(alice, 'PATCH', canvasUrl, { bgColor: ' #a3d ' }),
      nextEvent(sb, 'canvas_updated'),
    ]);
    assert.equal(canvasPatch.status, 200);
    const { title, bgColor, accessMode, updatedAt, ownerId } = canvasPatch.data.canvas;
    assert.equal(bgColor, '#AA33DD');
    assert.deepEqual(canvasEvent, { canvasId, title, bgColor, accessMode, updatedAt, byUser: ownerId });
    const badBackground = await api(alice, 'PATCH', canvasUrl, { bgColor: 'transparent' });
    assert.equal(badBackground.status, 400);
    assert.deepEqual(badBackground.data, { error: '背景色格式無效' });
    assert.equal((await api(alice, 'GET', canvasUrl)).data.canvas.bgColor, bgColor);

    const reason = '調整圖層沒有像素，無法直接繪製';
    const pixels = Uint8Array.of(255, 255, 255, 255);
    const tile = { col: 0, row: 0, width: 1, height: 1, compression: 'raw' };
    const tileBody = { tiles: [{ ...tile, data: Buffer.from(pixels).toString('base64') }] };
    for (const body of [tileBody, { vectorAdded: [{ id: 'stroke' }] }]) {
      const result = await api(alice, 'POST', `${adjustmentUrl}/tiles`, body);
      assert.equal(result.status, 400);
      assert.deepEqual(result.data, { error: reason });
    }
    const ops: [string, object][] = [
      ['STROKE', { points: [] }],
      ['TILE_PATCH', { tiles: [{ ...tile, data: pixels }] }],
      ['LAYER_OP', { vectorAdded: [{ id: 'stroke' }] }],
      ['RENAME', { tiles: [{ ...tile, data: pixels }] }],
    ];
    for (const [index, [opType, payload]] of ops.entries()) {
      const clientSeq = index + 1;
      const rejected = nextEvent<OpRejectedPacket>(sa, 'op_rejected');
      sa.emit('op_commit', { canvasId, layerId: adjustmentId, opType, payload, clientSeq });
      assert.deepEqual(await rejected, { type: 'OP_REJECTED', canvasId, clientSeq, reason });
    }
    const nonPixel = nextEvent<OpBroadcastPacket>(sb, 'op_broadcast');
    sa.emit('op_commit', { canvasId, layerId: adjustmentId, opType: 'LAYER_OP', payload: { name: 'HSL' } });
    assert.equal((await nonPixel).opType, 'LAYER_OP');

    const mask = await api(alice, 'POST', url, { name: 'Mask', layerType: 'mask', parentId: adjustmentId, meta: colors });
    assert.equal(mask.status, 201);
    const maskId = mask.data.layer.id;
    assert.equal(mask.data.layer.parentId, adjustmentId);
    assert.deepEqual(mask.data.layer.meta, { paletteColor: colors.paletteColor });
    assert.equal((await api(alice, 'POST', `${url}/${maskId}/tiles`, tileBody)).status, 201);
    assert.equal((await api(alice, 'DELETE', adjustmentUrl)).status, 200);
    assert.ok(!(await getLayers()).some((layer) => layer.id === adjustmentId || layer.id === maskId));
    console.log('Phase 18 adjustment layer checks passed');
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await app.close();
  }
}

runTest().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
