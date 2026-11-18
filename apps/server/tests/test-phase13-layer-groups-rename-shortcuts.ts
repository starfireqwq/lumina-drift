import assert from 'node:assert';
import { buildApp } from '../src/app';

async function runTest() {
  console.log('🚀 Starting Phase 13: Layer Groups, Rename & Clipping Mask API Tests...\n');
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Login user
    const guestRes = await fetch(`${baseUrl}/api/auth/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '圖層架構師' }),
    });
    const guestData = await guestRes.json();
    const token = guestData.token;
    assert.ok(token, 'Token should be returned');
    console.log('✓ User authenticated:', guestData.user.displayName);

    // 2. Create Canvas
    const createRes = await fetch(`${baseUrl}/api/canvases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: 'Phase 13 圖層組與快捷鍵測試畫布',
        width: 1200,
        height: 800,
      }),
    });
    const createData = await createRes.json();
    const canvasId = createData.canvas.id;
    console.log('✓ Canvas created:', canvasId);

    // 3. Create Layer Group
    const groupRes = await fetch(`${baseUrl}/api/canvases/${canvasId}/layers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: '角色線稿組',
        layerType: 'group',
        blendMode: 'normal',
      }),
    });
    assert.strictEqual(groupRes.status, 201);
    const groupData = await groupRes.json();
    const groupId = groupData.layer.id;
    assert.strictEqual(groupData.layer.layerType, 'group');
    assert.strictEqual(groupData.layer.name, '角色線稿組');
    console.log('✓ Layer group created successfully:', groupId, groupData.layer.name);

    // 4. Create child layer inside group
    const childRes = await fetch(`${baseUrl}/api/canvases/${canvasId}/layers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: '五官線稿',
        layerType: 'vector',
        parentId: groupId,
      }),
    });
    assert.strictEqual(childRes.status, 201);
    const childData = await childRes.json();
    const childId = childData.layer.id;
    assert.strictEqual(childData.layer.parentId, groupId);
    console.log('✓ Child vector layer created inside group:', childId, 'parentId:', childData.layer.parentId);

    // 5. Test Inline Rename (F2 / Double-Tap)
    const renameRes = await fetch(`${baseUrl}/api/canvases/${canvasId}/layers/${childId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: '精修睫毛與眼瞳向量線',
      }),
    });
    assert.strictEqual(renameRes.status, 200);
    const renameData = await renameRes.json();
    assert.strictEqual(renameData.layer.name, '精修睫毛與眼瞳向量線');
    console.log('✓ Layer rename verified (F2 / Double-Tap persistence):', renameData.layer.name);

    // 6. Test Prominent Clipping Mask (clipToBelow)
    const clipRes = await fetch(`${baseUrl}/api/canvases/${canvasId}/layers/${childId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        clipToBelow: true,
      }),
    });
    assert.strictEqual(clipRes.status, 200);
    const clipData = await clipRes.json();
    assert.strictEqual(clipData.layer.clipToBelow, true);
    console.log('✓ Clipping Mask (clipToBelow) toggled and persisted:', clipData.layer.clipToBelow);

    // 7. Test Moving Layer Out of Group (parentId = null)
    const unparentRes = await fetch(`${baseUrl}/api/canvases/${canvasId}/layers/${childId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        parentId: null,
      }),
    });
    assert.strictEqual(unparentRes.status, 200);
    const unparentData = await unparentRes.json();
    assert.strictEqual(unparentData.layer.parentId, null);
    console.log('✓ Layer moved out of group (parentId=null) verified');

    console.log('\n================================================================');
    console.log('🎉 All Phase 13 Layer Groups & Shortcuts Tests Passed Successfully!');
    console.log('================================================================\n');
  } finally {
    await app.close();
  }
}

runTest().catch((err) => {
  console.error('Phase 13 Test failed:', err);
  process.exit(1);
});
