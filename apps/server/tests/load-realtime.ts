/**
 * Real-time load test: N painters in one room, all drawing at once.
 *
 *   PORT=3101 DATA_DIR=<throwaway> node dist/server.js        (in another terminal)
 *   npx tsx tests/load-realtime.ts http://127.0.0.1:3101 15 15
 *
 * Every painter streams live previews (~40/s) and cursors (~30/s) and commits a stroke (2 tiles)
 * every 1.2 s, like a real stroke. Reports how long a preview / a committed stroke takes to reach
 * the other painters (sender clock = receiver clock: one process) and how many previews arrive.
 * Never point it at the real server: it creates accounts and a canvas.
 */
import { io as ClientSocket, Socket } from 'socket.io-client';
import * as socketParser from 'socket.io-parser';
import { compressTileBuffer, tileSocketParser, TileData } from '@atelier/shared';

const BASE = process.argv[2] || 'http://127.0.0.1:3101';
const PAINTERS = Number(process.argv[3] || 15);
const SECONDS = Number(process.argv[4] || 15);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(token: string | null, method: string, url: string, body?: unknown) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(data)}`);
  return data as any;
}

function tile(col: number, row: number, seed: number): TileData {
  const px = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < px.length; i += 4) {
    const on = ((i / 4) % 256) % 17 === seed % 17;
    px[i] = 200; px[i + 1] = 40; px[i + 2] = 40; px[i + 3] = on ? 255 : 0;
  }
  const { compression, data } = compressTileBuffer(px, 'lz4');
  return { col, row, width: 256, height: 256, compression, data };
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
// Not Math.max(...xs): 15 painters × 15 s is ~130 000 samples, past the argument limit
const report = (name: string, xs: number[]) =>
  console.log(`${name.padEnd(10)} n=${String(xs.length).padStart(6)}  p50=${pct(xs, 50)}ms  p95=${pct(xs, 95)}ms  p99=${pct(xs, 99)}ms  max=${xs.reduce((m, x) => Math.max(m, x), -Infinity)}ms`);
const DABS_PER_PREVIEW = 6;

async function main() {
  console.log(`Load test: ${PAINTERS} painters, ${SECONDS}s, ${BASE}`);
  const run = Date.now().toString(36);
  const users: Array<{ token: string; id: string }> = [];
  for (let i = 0; i < PAINTERS; i++) {
    const r = await api(null, 'POST', '/api/auth/register', { username: `load_${run}_${i}`, password: 'password123', displayName: `壓測${i + 1}` });
    users.push({ token: r.token, id: r.user.id });
  }
  const { canvas } = await api(users[0].token, 'POST', '/api/canvases', { title: `load ${run}`, width: 2048, height: 2048 });
  const layers: string[] = [];
  for (const u of users) {
    await api(u.token, 'POST', '/api/canvases/join', { canvasId: canvas.id }).catch(() => null);
    layers.push((await api(u.token, 'POST', `/api/canvases/${canvas.id}/layers`, { name: 'load' })).layer.id);
  }

  const previewLatency: number[] = [];
  const opLatency: number[] = [];
  const opSentAt = new Map<string, number>();
  const opDeliveries = new Set<string>();
  let previewsSent = 0;
  let previewsReceived = 0;

  const sockets: Socket[] = await Promise.all(users.map((u) => new Promise<Socket>((resolve) => {
    const s = ClientSocket(BASE, { auth: { token: u.token, canvasId: canvas.id }, transports: ['websocket'], parser: tileSocketParser(socketParser) });
    s.on('connect', () => resolve(s));
  })));
  sockets.forEach((s) => s.emit('join_canvas', { canvasId: canvas.id }));
  await sleep(500);

  for (const s of sockets) {
    // Counted in dabs: a busy link gets several previews merged into one packet / one preview_batch
    const onPreview = (p: any) => {
      previewsReceived += (p.dabs?.length ?? 0) / DABS_PER_PREVIEW;
      if (typeof p.sentAt === 'number') previewLatency.push(Date.now() - p.sentAt);
    };
    s.on('preview_dab', onPreview);
    s.on('preview_batch', (ps: any[]) => ps.forEach(onPreview));
    s.on('op_broadcast', (op: any) => {
      if (op.socketId === s.id) return;
      const key = `${op.socketId}:${op.payload?.clientSeq}`;
      const sent = opSentAt.get(key);
      const delivery = `${s.id}:${key}`;
      if (sent !== undefined && !opDeliveries.has(delivery)) {
        opDeliveries.add(delivery);
        opLatency.push(Date.now() - sent);
      }
    });
  }

  const timers: NodeJS.Timeout[] = [];
  sockets.forEach((s, i) => {
    let t = 0;
    let seq = 0;
    timers.push(setInterval(() => {
      t += 1;
      const dabs = Array.from({ length: DABS_PER_PREVIEW }, (_, k) => ({ x: 200 + i * 100 + ((t * 6 + k) % 600), y: 300 + Math.sin((t * 6 + k) / 20) * 80, pressure: 0.6 }));
      s.emit('preview_dab', { canvasId: canvas.id, layerId: layers[i], color: '#cc2222', brushSize: 12, opacity: 1, isEraser: false, sentAt: Date.now(), dabs });
      previewsSent++;
    }, 24));
    timers.push(setInterval(() => {
      s.volatile.emit('cursor', { canvasId: canvas.id, x: 200 + i * 100, y: 300, isDrawing: true, brushSize: 12 });
    }, 35));
    timers.push(setInterval(() => {
      seq += 1;
      opSentAt.set(`${s.id}:${seq}`, Date.now());
      s.emit('tile_patch', { type: 'TILE_PATCH', canvasId: canvas.id, layerId: layers[i], tiles: [tile(i % 8, 1, seq), tile((i + 1) % 8, 1, seq + 3)], clientSeq: seq });
    }, 1200 + i * 7));
  });

  await sleep(SECONDS * 1000);
  timers.forEach(clearInterval);
  const expectedOps = opSentAt.size * (PAINTERS - 1);
  const deadline = Date.now() + 10000;
  while (opDeliveries.size < expectedOps && Date.now() < deadline) await sleep(100);

  console.log(`previews: sent ${previewsSent}, delivered ${previewsReceived} of ${previewsSent * (PAINTERS - 1)} expected (${((previewsReceived / Math.max(1, previewsSent * (PAINTERS - 1))) * 100).toFixed(1)}%)`);
  report('preview', previewLatency);
  report('stroke op', opLatency);
  console.log(`stroke ops: delivered ${opDeliveries.size} of ${expectedOps} expected`);
  sockets.forEach((s) => s.close());
  process.exit(expectedOps > 0 && opDeliveries.size === expectedOps ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
