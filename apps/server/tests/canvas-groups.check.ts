import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasModel, CreateCanvasDto } from '@atelier/shared';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-canvas-groups-'));
  process.env.DATA_DIR = dir;
  process.env.DATABASE_PATH = join(dir, 'groups.db');
  process.env.ADMIN_PASSWORD = 'local-group-test-admin';
  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  const credentials = (token: string) => ({ authorization: `Bearer ${token}` });

  try {
    const register = async (username: string) => {
      const response = await app.inject({ method: 'POST', url: '/api/auth/register',
        payload: { username, displayName: username, password: 'local-canvas-group-test' } });
      assert.equal(response.statusCode, 201, response.body);
      return credentials(response.json().token);
    };
    const owner = await register('group-owner');
    const invited = await register('group-guest');
    const stranger = await register('group-stranger');
    const create = async (payload: CreateCanvasDto) => {
      const response = await app.inject({ method: 'POST', url: '/api/canvases/grouped', headers: owner, payload });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<{ canvas: CanvasModel }>().canvas;
    };
    const first = await create({ title: 'First', newGroupTitle: 'Collaborative sketchbook', roomPassword: '小組 pass' });
    assert.ok(first.group);
    const second = await create({ title: 'Second', groupId: first.group.id });
    const other = await create({ title: 'Unrelated', newGroupTitle: 'Separate group', roomPassword: 'different' });
    assert.deepEqual(second.group, first.group);
    assert.equal(second.hasPassword, true);
    assert.equal(second.roomPassHash, null);
    assert.equal(Object.hasOwn(second.group!, 'roomPassHash'), false);

    const read = (canvas: CanvasModel, headers?: Record<string, string>) =>
      app.inject({ method: 'GET', url: `/api/canvases/${canvas.id}/layers`, headers });
    const joinCanvas = (canvas: CanvasModel, password?: string) =>
      app.inject({ method: 'POST', url: '/api/canvases/join', headers: invited, payload: { canvasId: canvas.id, roomPassword: password } });

    assert.equal((await read(first, invited)).statusCode, 403);
    assert.equal((await read(second, invited)).statusCode, 403);
    assert.ok((await joinCanvas(first, 'wrong')).statusCode >= 400);
    assert.equal((await read(second, invited)).statusCode, 403);
    assert.equal((await joinCanvas(first, '小組 pass')).statusCode, 200);
    assert.equal((await read(second, invited)).statusCode, 200);
    assert.equal((await joinCanvas(second)).statusCode, 200);
    assert.equal((await read(second, stranger)).statusCode, 403);
    assert.equal((await read(other, invited)).statusCode, 403);
    assert.equal((await read(second, { 'x-room-password': encodeURIComponent('小組 pass') })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/canvases/grouped', headers: invited,
      payload: { title: 'Unauthorized', groupId: first.group.id } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/canvases/${second.id}`, headers: owner,
      payload: { roomPassword: '' } })).statusCode, 400);
    console.log('Canvas groups share password authorization without granting access to unrelated canvases.');
  } finally {
    await app.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
