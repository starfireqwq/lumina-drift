import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePlugin,
  isV3HighRiskPermission,
  hasV3Permissions,
  type PluginManifestV3,
} from '../src/plugins/pluginApi';
import { assertPluginRpcAllowed } from '../src/plugins/pluginRpc';
import {
  assertMcpToolAllowed,
  assertNoStabilizerMutation,
  assertSafeExecutablePath,
  buildSafeBridgeArgv,
  evaluateV3RuntimePolicy,
  isPathInsideRoot,
  sanitizeChildProcessEnv,
  validateBridgeArgValue,
  validateBridgeFlatFileName,
  validateLoopbackMcpUrl,
  validateMcpHttpHeaders,
} from '../src/plugins/pluginV3Policy';
import { LocalMcpServer } from '../electron/mcpServer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    });
}

async function httpPostRaw(
  port: number,
  urlPath: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.write(body, 'utf8');
    req.end();
  });
}

async function main() {
  console.log('Running Plugin API v3.0 security unit checks...');

  await test('Demo v3 plugin manifest parses cleanly and flags high-risk permissions', () => {
    const demoPath = path.resolve(__dirname, '../public/plugins/lumina-v3-bridge-demo.lumina-plugin');
    const raw = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
    const parsed = parsePlugin(raw) as PluginManifestV3;
    assert.equal(parsed.apiVersion, 3);
    assert.equal(hasV3Permissions(parsed), true);
    assert.equal(isV3HighRiskPermission('bridge:local'), true);
    assert.equal(isV3HighRiskPermission('mcp:server'), true);
    assert.equal(isV3HighRiskPermission('mcp:client'), true);
    assert.equal(isV3HighRiskPermission('layers:read'), false);
    assert.equal(parsed.bridgeTools?.length, 1);
    assert.equal(parsed.mcpClients?.length, 1);
  });

  await test('Manifest rejects embedded executable paths, shell commands, or raw MCP URLs', () => {
    assert.throws(() =>
      parsePlugin({
        apiVersion: 3,
        id: 'bad.embed-exe',
        name: 'Bad',
        version: '1.0.0',
        author: 'Test',
        description: '',
        permissions: ['commands', 'bridge:local'],
        commands: [{ id: 'run', label: 'Run' }],
        filters: [],
        panels: [],
        bridgeTools: [{ id: 't1', label: 'T1', exePath: 'C:/Windows/System32/cmd.exe' }],
        script: 'async function onCommand(){}',
      }),
    );

    assert.throws(() =>
      parsePlugin({
        apiVersion: 3,
        id: 'bad.embed-url',
        name: 'Bad',
        version: '1.0.0',
        author: 'Test',
        description: '',
        permissions: ['commands', 'mcp:client'],
        commands: [{ id: 'run', label: 'Run' }],
        filters: [],
        panels: [],
        mcpClients: [{ id: 's1', label: 'S1', url: 'https://evil.example/mcp' }],
        script: 'async function onCommand(){}',
      }),
    );
  });

  await test('v2 manifest cannot call v3 RPC methods even if method name is valid', () => {
    const v2 = parsePlugin({
      apiVersion: 2,
      id: 'legacy.v2',
      name: 'Legacy',
      version: '1.0.0',
      author: 'Test',
      description: '',
      permissions: ['commands'],
      commands: [{ id: 'go', label: 'Go' }],
      filters: [],
      panels: [],
      script: 'async function onCommand(){}',
    });
    assert.equal(v2.apiVersion, 2);
    assert.throws(() => assertPluginRpcAllowed(v2, 'bridge.invoke', {}), /requires Plugin API v3/);
    assert.throws(() => assertPluginRpcAllowed(v2, 'mcp.serverStatus', {}), /requires Plugin API v3/);
  });

  await test('Runtime policy blocks Web, mobile, and collaborative rooms; allows desktop offline only', () => {
    const web = evaluateV3RuntimePolicy({ isElectron: false, isMobile: false, isCollaborativeRoom: false });
    assert.equal(web.allowed, false);
    assert.equal(web.reason, 'UNSUPPORTED_WEB');

    const mobile = evaluateV3RuntimePolicy({ isElectron: false, isMobile: true, isCollaborativeRoom: false });
    assert.equal(mobile.allowed, false);
    assert.equal(mobile.reason, 'UNSUPPORTED_MOBILE');

    const collab = evaluateV3RuntimePolicy({ isElectron: true, isMobile: false, isCollaborativeRoom: true });
    assert.equal(collab.allowed, false);
    assert.equal(collab.reason, 'BLOCKED_COLLAB_ROOM');

    const desktopOffline = evaluateV3RuntimePolicy({ isElectron: true, isMobile: false, isCollaborativeRoom: false });
    assert.equal(desktopOffline.allowed, true);
  });

  await test('Anti-shell-injection & anti-argument-injection block metacharacters, flags, and shells', () => {
    for (const exe of ['cmd.exe', 'C:\\Windows\\System32\\powershell.exe', '/bin/sh', '/usr/bin/bash', 'pwsh.exe']) {
      assert.throws(() => assertSafeExecutablePath(exe), /not permitted/);
    }
    assert.doesNotThrow(() => assertSafeExecutablePath('C:\\Tools\\image-opt.exe'));

    for (const payload of [
      'ok; rm -rf /',
      'a && calc.exe',
      'a | whoami',
      '$(whoami)',
      '`id`',
      'foo\nbar',
      '--eval=evil',
      '-e',
      '../secret',
      'dir/file',
    ]) {
      assert.throws(() => validateBridgeArgValue('msg', payload));
    }

    const argv = buildSafeBridgeArgv(['--mode', '{{arg:mode}}', '--in={{inputFile}}', '{{outputFile}}'], {
      inputFile: 'C:/tmp/s1/in.png',
      outputFile: 'C:/tmp/s1/out.png',
      args: { mode: 'fast' },
      argSpecs: [{ key: 'mode', label: 'Mode', kind: 'enum', options: ['fast', 'high'] }],
    });
    assert.deepEqual(argv, ['--mode', 'fast', '--in=C:/tmp/s1/in.png', 'C:/tmp/s1/out.png']);

    assert.throws(() =>
      buildSafeBridgeArgv(['{{arg:mode}}'], {
        args: { mode: 'fast', extra: 'sneaky' },
        argSpecs: [{ key: 'mode', label: 'Mode', kind: 'enum', options: ['fast'] }],
      }),
    );
  });

  await test('Anti-path-traversal blocks .., slashes, Windows reserved names, and root escape', () => {
    for (const bad of ['..', '../a.png', 'a/b.png', 'a\\b.png', 'C:evil.png', 'CON', 'nul.txt', 'a\0b.png']) {
      assert.throws(() => validateBridgeFlatFileName(bad));
    }
    assert.equal(validateBridgeFlatFileName('frame_001.png'), 'frame_001.png');

    assert.equal(isPathInsideRoot('C:\\tmp\\sandbox\\out.png', 'C:\\tmp\\sandbox'), true);
    assert.equal(isPathInsideRoot('C:\\tmp\\sandbox-other\\out.png', 'C:\\tmp\\sandbox'), false);
    assert.equal(isPathInsideRoot('/tmp/other/a', '/tmp/sandbox'), false);
  });

  await test('Child process env sanitization strips secrets and redirects temp dir', () => {
    const clean = sanitizeChildProcessEnv(
      {
        PATH: '/usr/bin',
        SECRET_API_KEY: 'top-secret',
        ELECTRON_RUN_AS_NODE: '1',
        TEMP: '/old',
      },
      '/sandbox/tmp',
    );
    assert.equal(clean.PATH, '/usr/bin');
    assert.equal(clean.SECRET_API_KEY, undefined);
    assert.equal(clean.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(clean.TEMP, '/sandbox/tmp');
    assert.equal(clean.TMP, '/sandbox/tmp');
  });

  await test('MCP loopback URL & HTTP Host/Origin/Bearer checks block SSRF, DNS rebinding, and CSRF', () => {
    assert.doesNotThrow(() => validateLoopbackMcpUrl('http://127.0.0.1:4321/mcp'));
    assert.doesNotThrow(() => validateLoopbackMcpUrl('http://localhost:4321/mcp'));
    for (const bad of [
      'https://example.com/mcp',
      'http://192.168.1.50:4321/mcp',
      'http://10.0.0.1:4321/mcp',
      'http://user:pass@127.0.0.1:4321/mcp',
      'file:///etc/passwd',
    ]) {
      assert.throws(() => validateLoopbackMcpUrl(bad));
    }

    const rebind = validateMcpHttpHeaders({ host: 'evil.com:4321', authorization: 'Bearer abcdef1234567890' }, 4321);
    assert.equal(rebind.ok, false);
    assert.equal(!rebind.ok && rebind.statusCode, 403);

    const csrf = validateMcpHttpHeaders(
      { host: '127.0.0.1:4321', origin: 'https://evil.com', authorization: 'Bearer abcdef1234567890' },
      4321,
    );
    assert.equal(csrf.ok, false);
    assert.equal(!csrf.ok && csrf.statusCode, 403);

    const unauth = validateMcpHttpHeaders({ host: '127.0.0.1:4321' }, 4321);
    assert.equal(unauth.ok, false);
    assert.equal(!unauth.ok && unauth.statusCode, 401);

    const valid = validateMcpHttpHeaders(
      { host: '127.0.0.1:4321', authorization: 'Bearer abcdef1234567890' },
      4321,
    );
    assert.equal(valid.ok, true);
  });

  await test('Stabilizer immutability and MCP read-only default guards', () => {
    assert.throws(() => assertNoStabilizerMutation({ stabilizerLevel: 8 }));
    assert.throws(() => assertNoStabilizerMutation({ stabilizer: 'off' }));
    assert.doesNotThrow(() => assertNoStabilizerMutation({ size: 12, opacity: 0.8 }));

    assert.doesNotThrow(() => assertMcpToolAllowed('layers.list', false));
    assert.throws(() => assertMcpToolAllowed('layers.create', false), /read-only/);
    assert.doesNotThrow(() => assertMcpToolAllowed('layers.create', true));
  });

  await test('Live LocalMcpServer enforces 401/403, read-only default, token rotation, and write opt-in', async () => {
    const calls: string[] = [];
    const srv = new LocalMcpServer(async (toolName, args) => {
      calls.push(toolName);
      return { echoedTool: toolName, args };
    });
    const status = await srv.start({ allowWrite: false });
    try {
      assert.equal(status.running, true);
      assert.ok(status.port && status.token);

      // 1. Missing token -> 401
      const r401 = await httpPostRaw(
        status.port,
        '/mcp',
        { Host: `127.0.0.1:${status.port}` },
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      );
      assert.equal(r401.status, 401);

      // 2. Evil Origin -> 403
      const rOrigin = await httpPostRaw(
        status.port,
        '/mcp',
        {
          Host: `127.0.0.1:${status.port}`,
          Origin: 'https://attacker.test',
          Authorization: `Bearer ${status.token}`,
        },
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      );
      assert.equal(rOrigin.status, 403);

      // 3. DNS rebinding Host -> 403
      const rHost = await httpPostRaw(
        status.port,
        '/mcp',
        {
          Host: `rebind.attacker:${status.port}`,
          Authorization: `Bearer ${status.token}`,
        },
        JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      );
      assert.equal(rHost.status, 403);

      // 4. Valid read call -> 200
      const rOk = await httpPostRaw(
        status.port,
        '/mcp',
        {
          Host: `127.0.0.1:${status.port}`,
          Authorization: `Bearer ${status.token}`,
        },
        JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'layers.list', arguments: {} },
        }),
      );
      assert.equal(rOk.status, 200);
      const parsedOk = JSON.parse(rOk.body);
      assert.equal(parsedOk.result.structuredContent.echoedTool, 'layers.list');

      // 5. Write call in read-only mode -> JSON-RPC error, executor not invoked
      const rReadOnly = await httpPostRaw(
        status.port,
        '/mcp',
        {
          Host: `127.0.0.1:${status.port}`,
          Authorization: `Bearer ${status.token}`,
        },
        JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'layers.create', arguments: { name: 'Blocked' } },
        }),
      );
      assert.equal(rReadOnly.status, 200);
      assert.match(JSON.parse(rReadOnly.body).error.message, /read-only/);
      assert.deepEqual(calls, ['layers.list']);

      // 6. Enable write + rotate token -> old token fails 401, new token succeeds
      srv.setAllowWrite(true);
      const rotated = srv.rotateToken();
      assert.ok(rotated.token && rotated.token !== status.token);

      const rOld = await httpPostRaw(
        status.port,
        '/mcp',
        {
          Host: `127.0.0.1:${status.port}`,
          Authorization: `Bearer ${status.token}`,
        },
        JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' }),
      );
      assert.equal(rOld.status, 401);

      const rWrite = await httpPostRaw(
        status.port,
        '/mcp',
        {
          Host: `127.0.0.1:${status.port}`,
          Authorization: `Bearer ${rotated.token}`,
        },
        JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'layers.create', arguments: { name: 'Allowed' } },
        }),
      );
      assert.equal(rWrite.status, 200);
      assert.equal(JSON.parse(rWrite.body).result.structuredContent.echoedTool, 'layers.create');
      assert.deepEqual(calls, ['layers.list', 'layers.create']);
    } finally {
      await srv.stop();
    }
  });

  console.log(`\nAll ${passed} Plugin API v3.0 security checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
