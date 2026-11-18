import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { PNG } from 'pngjs';

const work = mkdtempSync(join(tmpdir(), 'lumina-share-preview-'));
process.env.DATA_DIR = work;
process.env.DATABASE_PATH = join(work, 'test.db');
process.env.CLIENT_DIST_PATH = resolve(__dirname, '../../client/dist');

async function main() {
  // Use the built server so the check also exercises the production thumbnail worker.
  const { buildApp } = await import('../dist/app');
  const app = await buildApp();
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const crawler = { 'user-agent': 'Discordbot/2.0' };
  let token = '';
  const room = (id: string) => `${origin}/?room=${id}`;
  async function json(path: string, method: string, payload: object) {
    const response = await fetch(origin + path, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  }
  try {
    token = (await json('/api/auth/register', 'POST', { username: 'previewtest', password: 'share-preview-pass' })).token;
    async function create(title: string, extra: object = {}) {
      const { canvas } = await json('/api/canvases', 'POST', { title, width: 256, height: 256, ...extra });
      const { layer } = await json(`/api/canvases/${canvas.id}/layers`, 'POST', { name: 'Artwork' });
      return { id: canvas.id as string, paint: async (rgba: number[]) => {
        const bytes = Buffer.alloc(256 * 256 * 4);
        bytes.fill(Buffer.from(rgba));
        await json(`/api/canvases/${canvas.id}/layers/${layer.id}/tiles`, 'POST', {
          tiles: [{ col: 0, row: 0, width: 256, height: 256, compression: 'raw', data: bytes.toString('base64') }],
        });
      }, layer: layer.id as string, groupId: canvas.group?.id };
    }
    async function meta(url: string) {
      const response = await fetch(url, { headers: crawler });
      assert.equal(response.status, 200);
      const body = await response.text();
      const property = (name: string) => body.match(new RegExp(`<meta property="${name}" content="([^"]*)"`))?.[1];
      return { title: property('og:title'), url: property('og:url'), image: property('og:image')!, description: property('og:description') };
    }
    async function imageAt(url: string) {
      const response = await fetch(url, { headers: crawler });
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
      assert.equal(png.width, 1200);
      assert.equal(png.height, 630);
      const index = (300 * png.width + 600) * 4;
      const mark = (579 * png.width + 56) * 4;
      assert.notDeepEqual([...png.data.subarray(mark, mark + 4)], [20, 19, 41, 255], 'The brand mark area should contain the logo');
      return [...png.data.subarray(index, index + 4)];
    }

    const brand = await meta(origin);
    assert.equal(brand.image, `${origin}/share-preview.png`);
    const a = await create('紅 & "角"');
    const b = await create('藍色');
    assert.equal((await meta(room(a.id))).image, brand.image, 'an empty room falls back to brand');
    await a.paint([245, 16, 32, 255]);
    await b.paint([8, 41, 230, 255]);
    const [first, second] = await Promise.all([meta(room(a.id)), meta(room(b.id))]);
    const proxyHost = 'paint.example.test:58632';
    const proxied = await fetch(room(a.id), {
      headers: { ...crawler, 'X-Forwarded-Host': proxyHost, 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(proxied.status, 200);
    const proxiedHtml = await proxied.text();
    const proxyImage = `https://${proxyHost}${new URL(first.image).pathname}${new URL(first.image).search}`;
    assert.ok(proxiedHtml.includes(`property="og:image" content="${proxyImage}"`));
    assert.ok(proxiedHtml.includes(`name="twitter:image" content="${proxyImage}"`));
    assert.equal(first.title, '紅 &amp; &quot;角&quot;');
    assert.equal(second.title, '藍色');
    assert.equal(first.url, room(a.id));
    assert.equal(second.url, room(b.id));
    assert.equal(first.description, brand.description);
    assert.notEqual(first.image, second.image);
    assert.deepEqual(await imageAt(first.image), [245, 16, 32, 255]);
    assert.deepEqual(await imageAt(second.image), [8, 41, 230, 255]);
    await a.paint([12, 220, 51, 255]);
    const refreshed = await meta(room(a.id));
    assert.notEqual(refreshed.image, first.image);
    assert.deepEqual(await imageAt(refreshed.image), [12, 220, 51, 255]);
    assert.equal((await meta(room(b.id))).image, second.image);

    const vector = await create('向量筆跡');
    const { layer: outline } = await json(`/api/canvases/${vector.id}/layers`, 'POST', { name: 'Vector', layerType: 'vector' });
    await json(`/api/canvases/${vector.id}/layers/${outline.id}/tiles`, 'POST', { vectorAdded: [{
      id: 'vector-stroke', color: '#4621A3', opacity: 1, baseWidth: 24, createdAt: 1,
      bounds: { minX: 28, minY: 116, maxX: 228, maxY: 140 },
      anchors: [{ x: 40, y: 128, pressure: 1, width: 24 }, { x: 216, y: 128, pressure: 1, width: 24 }],
    }] });
    assert.deepEqual(await imageAt((await meta(room(vector.id))).image), [70, 33, 163, 255]);

    await json(`/api/canvases/${a.id}/layers/${a.layer}`, 'PATCH', { isVisible: false });
    assert.equal((await meta(room(a.id))).image, brand.image);
    await json(`/api/canvases/${a.id}/layers/${a.layer}`, 'PATCH', { isVisible: true });
    const beforeLock = await meta(room(a.id));
    await json(`/api/canvases/${a.id}`, 'PATCH', { roomPassword: 'lock-this-room' });
    await json(`/api/canvases/${b.id}`, 'PATCH', { accessMode: 'whitelist' });
    const grouped = await create('受保護畫布組', { newGroupTitle: '封閉畫布組', roomPassword: 'group-secret' });
    assert.ok(grouped.groupId);
    await grouped.paint([210, 80, 55, 255]);
    for (const id of [a.id, b.id, grouped.id]) {
      const result = await meta(room(id));
      assert.equal(result.title, brand.title);
      assert.equal(result.image, brand.image);
    }
    for (const url of [first.image, beforeLock.image, second.image, `${origin}/api/share-preview/${grouped.id}`]) {
      const response = await fetch(url, { headers: { ...crawler, authorization: `Bearer ${token}` } });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    console.log(`Share previews verified at ${origin}: room images, revisions, hidden layer, brand fallbacks, and image access.`);
  } finally {
    await app.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
