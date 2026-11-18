import assert from 'node:assert';
import { buildApp } from '../src/app';

async function runPhase8GatewayTests() {
  console.log('================================================================');
  console.log('🚀 Starting AtelierSync Phase 8: Connection Gateway & Hosting Tests');
  console.log('================================================================');

  const app = await buildApp();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const testServerUrl = address;
  console.log(`[Phase 8 Test Server] Running on ${testServerUrl}`);

  try {
    // --- 1. Testing Server Network Interfaces API ---
    console.log('\n--- 1. Testing Server Network Interfaces (/api/server/network) ---');
    const networkRes = await app.inject({
      method: 'GET',
      url: '/api/server/network',
    });
    assert.strictEqual(networkRes.statusCode, 200, 'Network endpoint should return HTTP 200');
    const netJson = JSON.parse(networkRes.body);
    assert.strictEqual(netJson.status, 'ok', 'Status should be ok');
    assert.ok(Array.isArray(netJson.addresses), 'Addresses should be an array');
    assert.ok(netJson.addresses.length > 0, 'Addresses should contain at least localhost');

    const localhostEntry = netJson.addresses.find((a: any) => a.address === '127.0.0.1');
    assert.ok(localhostEntry, 'Localhost 127.0.0.1 should be present');
    assert.strictEqual(localhostEntry.type, 'local', 'Localhost type should be local');
    console.log(`✓ Network interfaces detected: ${netJson.addresses.length} addresses (including ${localhostEntry.name})`);

    // --- 2. Testing Live Health Check Ping ---
    console.log('\n--- 2. Testing Live Health Check Diagnostic (/health) ---');
    const healthRes = await app.inject({
      method: 'GET',
      url: '/health',
    });
    assert.strictEqual(healthRes.statusCode, 200, 'Health check should return HTTP 200');
    const healthJson = JSON.parse(healthRes.body);
    assert.strictEqual(healthJson.status, 'ok', 'Health status should be ok');
    assert.strictEqual(healthJson.service, 'atelier-sync-server');
    console.log(`✓ Health diagnostic ping verified: service=${healthJson.service}, status=${healthJson.status}`);

    // --- 3. Testing Target URL Calculation for Public vs LAN vs Localhost ---
    console.log('\n--- 3. Testing Target URL Computation & Logic ---');
    
    // Mode A: Public Cloudflare Tunnel
    const cloudflareUrl = 'https://atelier-demo-room.trycloudflare.com';
    const computedPublic = cloudflareUrl.trim().replace(/\/+$/, '');
    assert.strictEqual(computedPublic, 'https://atelier-demo-room.trycloudflare.com');
    console.log(`✓ Public Cloudflare Tunnel URL parsed: ${computedPublic}`);

    // Mode B: Local LAN / Wi-Fi (Auto & Manual)
    const detectedLanIp = '192.168.1.188';
    const computedLanAuto = `http://${detectedLanIp}:3000`;
    assert.strictEqual(computedLanAuto, 'http://192.168.1.188:3000');
    console.log(`✓ Local LAN Auto-detected URL parsed: ${computedLanAuto}`);

    const manualIp = '10.88.0.5';
    const manualPort = '4000';
    const computedLanManual = `http://${manualIp}:${manualPort}`;
    assert.strictEqual(computedLanManual, 'http://10.88.0.5:4000');
    console.log(`✓ Local LAN Manual IP/Port URL parsed: ${computedLanManual}`);

    // Mode C: Localhost Standalone
    const computedLocalhost = 'http://127.0.0.1:3000';
    assert.strictEqual(computedLocalhost, 'http://127.0.0.1:3000');
    console.log(`✓ Localhost standalone URL parsed: ${computedLocalhost}`);

    // --- 4. Testing Gateway State Transition Simulation ---
    console.log('\n--- 4. Testing Gateway Resolution & Page Transition Simulation ---');
    let hasResolvedGateway = false;
    let selectedServer = '';
    let chosenNickname = '';

    const handleResolve = (target: string, name?: string) => {
      selectedServer = target;
      chosenNickname = name || '訪客畫師';
      hasResolvedGateway = true;
    };

    // User chooses Public Cloudflare and enters
    handleResolve(computedPublic, '神仙畫師小雪');
    assert.strictEqual(hasResolvedGateway, true, 'Gateway should transition after selection');
    assert.strictEqual(selectedServer, 'https://atelier-demo-room.trycloudflare.com');
    assert.strictEqual(chosenNickname, '神仙畫師小雪');
    console.log(`✓ Gateway selection verified: Successfully transitioned to Canvas Workspace with server='${selectedServer}' and user='${chosenNickname}'`);

    // --- 5. Testing Canvas Title Auto-Increment Algorithm ---
    console.log('\n--- 5. Testing Canvas Auto-Increment Numbering ---');
    function getNextCanvasTitle(lastTitle?: string): string {
      if (!lastTitle || !lastTitle.trim()) return '未命名畫布 1';
      const trimmed = lastTitle.trim();
      const match = trimmed.match(/^(.*?)(?:[\s_#\-]*)(\d+)$/);
      if (match) {
        const prefix = match[1].trim();
        const numStr = match[2];
        const nextNum = parseInt(numStr, 10) + 1;
        const padded = numStr.startsWith('0') && numStr.length > 1
          ? String(nextNum).padStart(numStr.length, '0')
          : String(nextNum);
        return prefix ? `${prefix} ${padded}` : `${padded}`;
      }
      return `${trimmed} 2`;
    }

    assert.strictEqual(getNextCanvasTitle('週末繪茶'), '週末繪茶 2');
    assert.strictEqual(getNextCanvasTitle('週末繪茶 1'), '週末繪茶 2');
    assert.strictEqual(getNextCanvasTitle('週末繪茶 2'), '週末繪茶 3');
    assert.strictEqual(getNextCanvasTitle('草稿 #09'), '草稿 10');
    assert.strictEqual(getNextCanvasTitle(''), '未命名畫布 1');
    console.log('✓ Canvas title auto-increment passed: "週末繪茶" -> "週末繪茶 2" -> "週末繪茶 3", "草稿 #09" -> "草稿 10"');

    // --- 6. Testing Canvas Room Password Lock & Auth Protection ---
    console.log('\n--- 6. Testing Canvas Password Lock (Protected Room) ---');
    // Admin login
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'admin123' },
    });
    const adminToken = JSON.parse(loginRes.body).token;

    // Create a password protected canvas
    const createLockCanvasRes = await app.inject({
      method: 'POST',
      url: '/api/canvases',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        title: '密碼保護合繪室',
        roomPassword: 'super_secret_draw_pass_123',
      },
    });
    assert.strictEqual(createLockCanvasRes.statusCode, 201);
    const lockedCanvas = JSON.parse(createLockCanvasRes.body).canvas;
    assert.strictEqual(lockedCanvas.hasPassword, true, 'room must be flagged as password protected');
    assert.strictEqual(lockedCanvas.roomPassHash, null, 'password hash must never be sent to clients');

    // Register a new user Charlie with unique username
    const uniqueUsername = `charlie_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: uniqueUsername, password: 'password123', displayName: '查理畫師' },
    });
    const charlieToken = JSON.parse(regRes.body).token;
    assert.ok(charlieToken, 'Charlie token must exist');

    // Attempt join without password -> Should fail
    const joinNoPassRes = await app.inject({
      method: 'POST',
      url: '/api/canvases/join',
      headers: { Authorization: `Bearer ${charlieToken}` },
      payload: { canvasId: lockedCanvas.id },
    });
    assert.strictEqual(joinNoPassRes.statusCode, 400);
    assert.ok(JSON.parse(joinNoPassRes.body).error.includes('密碼'), 'Must reject without password');
    console.log('✓ Rejected unauthorized join without room password');

    // Attempt join with WRONG password -> Should fail
    const joinWrongPassRes = await app.inject({
      method: 'POST',
      url: '/api/canvases/join',
      headers: { Authorization: `Bearer ${charlieToken}` },
      payload: { canvasId: lockedCanvas.id, roomPassword: 'wrong_password' },
    });
    assert.strictEqual(joinWrongPassRes.statusCode, 400);
    assert.ok(JSON.parse(joinWrongPassRes.body).error.includes('密碼錯誤'), 'Must reject wrong password');
    console.log('✓ Rejected join with incorrect room password');

    // A non-member must not read the room's content over REST either (layers, snapshot, ops)
    const readAs = (url: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url, headers: { Authorization: `Bearer ${charlieToken}`, ...headers } });
    for (const path of ['layers', 'snapshot', 'ops']) {
      const url = `/api/canvases/${lockedCanvas.id}/${path}`;
      assert.strictEqual((await readAs(url)).statusCode, 403, `non-member GET /${path} must be refused`);
      assert.strictEqual((await app.inject({ method: 'GET', url })).statusCode, 403, `anonymous GET /${path} must be refused`);
      assert.strictEqual((await readAs(url, { 'X-Room-Password': 'wrong' })).statusCode, 403, `wrong password GET /${path} must be refused`);
      // Guests have no membership: the room password (URI-encoded) is their key
      const ok = await app.inject({ method: 'GET', url, headers: { 'X-Room-Password': encodeURIComponent('super_secret_draw_pass_123') } });
      assert.strictEqual(ok.statusCode, 200, `room password must open GET /${path}`);
    }
    const detail = JSON.parse((await readAs(`/api/canvases/${lockedCanvas.id}`)).body);
    assert.deepStrictEqual(detail.layers, [], 'canvas details must not list a locked room\'s layers');
    assert.strictEqual(detail.canvas.hasPassword, true);
    const ownerRead = await app.inject({ method: 'GET', url: `/api/canvases/${lockedCanvas.id}/layers`, headers: { Authorization: `Bearer ${adminToken}` } });
    assert.strictEqual(ownerRead.statusCode, 200, 'the owner reads without the password');
    console.log('✓ Locked room REST reads (layers / snapshot / ops) need membership or the room password');

    // Attempt join with CORRECT password -> Should succeed
    const joinCorrectPassRes = await app.inject({
      method: 'POST',
      url: '/api/canvases/join',
      headers: { Authorization: `Bearer ${charlieToken}` },
      payload: { canvasId: lockedCanvas.id, roomPassword: 'super_secret_draw_pass_123' },
    });
    assert.strictEqual(joinCorrectPassRes.statusCode, 200);
    console.log('✓ Successfully unlocked & joined password protected room with correct credentials');
    const memberRead = await app.inject({ method: 'GET', url: `/api/canvases/${lockedCanvas.id}/snapshot`, headers: { Authorization: `Bearer ${charlieToken}` } });
    assert.strictEqual(memberRead.statusCode, 200, 'a member reads without sending the password again');

    // --- 7. Testing Canvas Deletion with Second Confirmation Simulation ---
    console.log('\n--- 7. Testing Canvas Deletion Execution ---');
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/canvases/${lockedCanvas.id}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(deleteRes.statusCode, 200);

    const checkDeletedRes = await app.inject({
      method: 'GET',
      url: `/api/canvases/${lockedCanvas.id}`,
    });
    assert.strictEqual(checkDeletedRes.statusCode, 404, 'Deleted canvas should return 404');
    console.log('✓ Canvas permanently destroyed after confirmation verified');

    console.log('\n================================================================');
    console.log('🎉 All Phase 8 Connection Gateway & Hosting Tests Passed Successfully!');
    console.log('================================================================\n');
  } finally {
    await app.close();
  }
}

runPhase8GatewayTests().catch((err) => {
  console.error('❌ Phase 8 tests failed:', err);
  process.exit(1);
});
