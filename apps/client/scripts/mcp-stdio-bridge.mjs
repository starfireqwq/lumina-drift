#!/usr/bin/env node
/**
 * Lightweight zero-dependency stdio-to-HTTP JSON-RPC 2.0 bridge for Lumina Drift Local MCP Server.
 * Usage:
 *   LUMINA_MCP_URL=http://127.0.0.1:<port>/mcp LUMINA_MCP_TOKEN=<token> node mcp-stdio-bridge.mjs
 *
 * Security: Strictly refuses non-loopback URLs and never spawns a shell.
 */
import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';

const rawUrl = (process.env.LUMINA_MCP_URL || '').trim();
const token = (process.env.LUMINA_MCP_TOKEN || '').trim();

if (!rawUrl || !token) {
  process.stderr.write('LUMINA_MCP_URL and LUMINA_MCP_TOKEN environment variables are required.\n');
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(rawUrl);
} catch {
  process.stderr.write('Invalid LUMINA_MCP_URL.\n');
  process.exit(1);
}

const host = parsed.hostname.toLowerCase();
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
  process.stderr.write('Refusing non-loopback LUMINA_MCP_URL.\n');
  process.exit(1);
}

const transport = parsed.protocol === 'https:' ? https : http;

function forwardJsonRpc(line) {
  return new Promise((resolve) => {
    const body = Buffer.from(line, 'utf8');
    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.byteLength,
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').trim();
          if (text) process.stdout.write(`${text}\n`);
          resolve();
        });
      },
    );
    req.on('error', (err) => {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: err.message } })}\n`,
      );
      resolve();
    });
    req.write(body);
    req.end();
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  void forwardJsonRpc(trimmed);
});
