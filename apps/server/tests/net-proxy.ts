/**
 * A TCP proxy that behaves like a slower network, for latency tests against a throwaway server:
 *
 *   npx tsx tests/net-proxy.ts <listenPort> <targetPort> <oneWayMs> [downKbps] [upKbps] [jitterMs]
 *
 * Every chunk is held for oneWayMs (± jitter) in each direction, and each direction is limited to
 * its bandwidth (kilobits per second, 0 = unlimited). HTTP and WebSocket traffic both pass, in order.
 * Point the browsers / load tests at http://127.0.0.1:<listenPort>.
 */
import net from 'node:net';

const [listenPort, targetPort, oneWay, downKbps = '0', upKbps = '0', jitter = '0'] = process.argv.slice(2);
if (!listenPort || !targetPort || oneWay === undefined) {
  console.error('usage: net-proxy.ts <listenPort> <targetPort> <oneWayMs> [downKbps] [upKbps] [jitterMs]');
  process.exit(1);
}

// Busiest connection per direction over the last 5 s (shows what one painter really needs)
const traffic = { down: new Map<net.Socket, number>(), up: new Map<net.Socket, number>() };
setInterval(() => {
  const peak = (m: Map<net.Socket, number>) => Math.max(0, ...m.values()) * 8 / 5 / 1000;
  if (traffic.down.size) console.log(`busiest connection: down ${peak(traffic.down).toFixed(0)} kbps, up ${peak(traffic.up).toFixed(0)} kbps (${traffic.down.size} connections)`);
  traffic.down.clear();
  traffic.up.clear();
}, 5000).unref();

/** Delays and paces one direction of one connection, keeping the byte order */
function pipeSlow(from: net.Socket, to: net.Socket, kbps: number, count: Map<net.Socket, number>) {
  const bytesPerMs = kbps > 0 ? (kbps * 1000) / 8 / 1000 : Infinity;
  let lineFreeAt = 0; // when the simulated link has sent everything queued so far
  let lastDue = 0;
  // One FIFO and one timer per direction: a timer per chunk can fire out of order and corrupt the stream
  const queue: Array<{ due: number; chunk: Buffer | null }> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const drain = () => {
    timer = null;
    const now = Date.now();
    while (queue.length && queue[0].due <= now) {
      const { chunk } = queue.shift()!;
      if (to.destroyed) return;
      if (chunk) to.write(chunk);
      else to.end();
    }
    if (queue.length) timer = setTimeout(drain, Math.max(0, queue[0].due - now));
  };
  const push = (due: number, chunk: Buffer | null) => {
    queue.push({ due, chunk });
    if (!timer) timer = setTimeout(drain, Math.max(0, queue[0].due - Date.now()));
  };
  from.on('data', (chunk) => {
    count.set(from, (count.get(from) ?? 0) + chunk.length);
    const now = Date.now();
    const sendDone = Math.max(now, lineFreeAt) + (bytesPerMs === Infinity ? 0 : chunk.length / bytesPerMs);
    lineFreeAt = sendDone;
    const j = Number(jitter) ? (Math.random() * 2 - 1) * Number(jitter) : 0;
    lastDue = Math.max(lastDue, sendDone + Number(oneWay) + j); // never reorder
    push(lastDue, chunk);
  });
  from.on('end', () => push(lastDue, null));
}

net.createServer((client) => {
  const upstream = net.connect(Number(targetPort), '127.0.0.1');
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  pipeSlow(client, upstream, Number(upKbps), traffic.up);
  pipeSlow(upstream, client, Number(downKbps), traffic.down);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on('error', close);
  upstream.on('error', close);
  client.on('close', close);
  upstream.on('close', close);
}).listen(Number(listenPort), () => {
  console.log(`net-proxy :${listenPort} → :${targetPort}, ${oneWay} ms each way (RTT ${2 * Number(oneWay)} ms), down ${downKbps || '∞'} kbps / up ${upKbps || '∞'} kbps, jitter ±${jitter} ms`);
});
