import assert from 'node:assert';
import { buildApp } from '../src/app';

async function runTest() {
  console.log('🚀 Testing Profile Updates & Canvas Deletion...\n');
  const app = await buildApp();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Guest Login
    const guestRes = await fetch(`${baseUrl}/api/auth/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '測試畫師' }),
    });
    const guestData = await guestRes.json();
    const token = guestData.token;
    assert.ok(token, 'Token should be returned');
    assert.strictEqual(guestData.user.displayName, '測試畫師');
    console.log('✓ Guest login verified:', guestData.user.displayName);

    // 2. Profile Update: Update Name & Avatar
    const customAvatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const profileRes = await fetch(`${baseUrl}/api/auth/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        displayName: '夜櫻超可愛畫師',
        avatarUrl: customAvatar,
      }),
    });
    assert.strictEqual(profileRes.status, 200, 'Profile update should return 200');
    const profileData = await profileRes.json();
    assert.strictEqual(profileData.user.displayName, '夜櫻超可愛畫師');
    assert.strictEqual(profileData.user.avatarUrl, customAvatar);
    console.log('✓ Profile update (displayName + custom avatar) verified!');

    // 3. Create Canvas by user
    const createRes = await fetch(`${baseUrl}/api/canvases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: '即將刪除的測試畫布',
        width: 1024,
        height: 1024,
      }),
    });
    assert.strictEqual(createRes.status, 201, 'Canvas creation should return 201');
    const createData = await createRes.json();
    const canvasId = createData.canvas.id;
    console.log('✓ Canvas created:', canvasId, createData.canvas.title);

    // 4. Test DELETE Canvas without body (ensure NO Bad Request 400 error!)
    const deleteRes = await fetch(`${baseUrl}/api/canvases/${canvasId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      // Note: intentionally NO body and NO Content-Type header
    });
    assert.strictEqual(deleteRes.status, 200, 'DELETE canvas without body should return 200 OK');
    const deleteData = await deleteRes.json();
    assert.strictEqual(deleteData.success, true);
    console.log('✓ Canvas successfully deleted without 400 Bad Request!');

    // 5. Verify Canvas is gone
    const getRes = await fetch(`${baseUrl}/api/canvases/${canvasId}`, {
      method: 'GET',
    });
    assert.strictEqual(getRes.status, 404, 'Canvas should be gone (404)');
    console.log('✓ Canvas deletion verified: 404 Not Found');

    console.log('\n🎉 All Profile & Canvas Deletion Tests Passed Successfully!');
  } finally {
    await app.close();
  }
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
