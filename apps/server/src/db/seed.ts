import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from './index';
import { users, canvases, canvasMembers, layers } from './schema';
import { hashPassword } from '../services/auth.service';
import { config } from '../config';

export async function seedDatabase() {
  const existingUsers = db.select().from(users).all();

  let adminId: string;

  if (existingUsers.length === 0) {
    adminId = crypto.randomUUID();
    const now = Date.now();
    const password = config.adminDefaultPassword || crypto.randomBytes(24).toString('base64url');
    const adminPassHash = await hashPassword(password);
    if (!config.adminDefaultPassword) {
      const setupFile = join(config.dataDir, 'initial-admin-password');
      writeFileSync(setupFile, password + '\n', { mode: 0o600 });
      console.log(`[Seed] Read the initial admin password from ${setupFile}.`);
    }

    db.insert(users).values({
      id: adminId,
      username: config.adminDefaultUsername,
      displayName: config.adminDefaultDisplayName,
      passwordHash: adminPassHash,
      serverRole: 'admin',
      isActive: 1,
      createdAt: now,
      updatedAt: now,
    }).run();

    console.log(`[Seed] Created the administrator account '${config.adminDefaultUsername}'.`);
  } else {
    const admin = existingUsers.find((u) => u.serverRole === 'admin') || existingUsers[0];
    adminId = admin.id;
  }

  // Check if any canvas exists
  const existingCanvases = db.select().from(canvases).all();
  if (existingCanvases.length === 0) {
    const canvasId = crypto.randomUUID();
    const now = Date.now();

    db.insert(canvases).values({
      id: canvasId,
      ownerId: adminId,
      title: '歡迎來到 Lumina Drift 流光畫室',
      width: 2048,
      height: 2048,
      dpi: 300,
      bgColor: '#FFFFFF',
      accessMode: 'invite',
      inviteCode: 'ATELIER-WELCOME',
      latestSeq: 0,
      createdAt: now,
      updatedAt: now,
    }).run();

    db.insert(canvasMembers).values({
      canvasId,
      userId: adminId,
      role: 'owner',
      canCreateLayer: 1,
      canDeleteOtherLayer: 1,
      canExport: 1,
      canManageMembers: 1,
      joinedAt: now,
    }).run();

    // Default Background Layer
    const bgLayerId = crypto.randomUUID();
    db.insert(layers).values({
      id: bgLayerId,
      canvasId,
      ownerId: adminId,
      name: '背景層 (Background)',
      layerType: 'raster',
      blendMode: 'normal',
      opacity: 1.0,
      isVisible: 1,
      isLocked: 1,
      alphaLocked: 0,
      clipToBelow: 0,
      sortOrder: 0,
      aclMode: 'shared_all',
      createdAt: now,
      updatedAt: now,
    }).run();

    // Default Draw Layer 1
    const layer1Id = crypto.randomUUID();
    db.insert(layers).values({
      id: layer1Id,
      canvasId,
      ownerId: adminId,
      name: '圖層 1 (Layer 1)',
      layerType: 'raster',
      blendMode: 'normal',
      opacity: 1.0,
      isVisible: 1,
      isLocked: 0,
      alphaLocked: 0,
      clipToBelow: 0,
      sortOrder: 1,
      aclMode: 'shared_all',
      createdAt: now,
      updatedAt: now,
    }).run();

    console.log(`[Seed] Created initial canvas '${canvasId}' with default layers`);
  }
}
