import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canUserPerformLayerAction, type LayerModel } from '@atelier/shared';
import { LayerManager } from '../src/engine/LayerManager.ts';
import type { Renderer } from 'pixi.js';

test('folders retain management permissions and reject pixel operations even for admins', () => {
  const folder = { id: 'folder', layerType: 'group', ownerId: 'admin', isLocked: false } as LayerModel;
  const context = { user: { id: 'admin', serverRole: 'admin' as const }, layer: folder };
  for (const action of ['draw', 'erase', 'filter'] as const) {
    assert.equal(canUserPerformLayerAction(context, action).allowed, false);
  }
  assert.equal(canUserPerformLayerAction(context, 'modify_props').allowed, true);
  assert.equal(canUserPerformLayerAction({ ...context, layer: { ...folder, layerType: 'raster' } }, 'draw').allowed, true);
});

test('duplicate layer responses cannot create duplicate Pixi children or folder textures', () => {
  const manager = new LayerManager({ render() {} } as Renderer, 64, 64);
  const raster = { id: 'a', name: 'A', sortOrder: 10, layerType: 'raster', opacity: 1, isVisible: true, blendMode: 'normal' } as LayerModel;
  const folder = { ...raster, id: 'folder', layerType: 'group' as const, sortOrder: 20, opacity: 0.5 };
  const child = { ...raster, id: 'b', sortOrder: 30, parentId: folder.id };
  try {
    manager.syncLayers([raster, folder, child, child]);
    assert.equal(manager.layersContainer.children.length, 2);
    assert.equal(manager.getLayerItem(folder.id), undefined);
    assert.equal(manager.getLayerItem(child.id)?.display.alpha, 0.5);
  } finally {
    manager.destroy();
  }
});
