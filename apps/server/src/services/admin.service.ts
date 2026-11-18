import { eq, desc, isNull } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { hashPassword, isTemporaryGuest } from './auth.service';
import { ServerRole } from '@atelier/shared';

export interface AdminUserListItem {
  id: string;
  username: string;
  displayName: string;
  serverRole: ServerRole;
  isActive: boolean;
  isTemporaryGuest: boolean;
  createdAt: number;
  updatedAt: number;
}

export function listAllUsers(): AdminUserListItem[] {
  const rows = db.select({
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    serverRole: users.serverRole,
    passwordHash: users.passwordHash,
    isActive: users.isActive,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  })
    .from(users)
    .where(isNull(users.guestRemovedAt))
    .orderBy(desc(users.createdAt))
    .all();

  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.displayName,
    serverRole: r.serverRole as ServerRole,
    isActive: Boolean(r.isActive),
    isTemporaryGuest: isTemporaryGuest(r),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function adminResetUserPassword(userId: string, newPassword: string):Promise<{ id: string; username: string }> {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('新密碼長度至少需 6 個字元');
  }

  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.guestRemovedAt) {
    throw new Error('查無此使用者');
  }

  const passwordHash = await hashPassword(newPassword);
  db.update(users)
    .set({
      passwordHash,
      updatedAt: Date.now(),
    })
    .where(eq(users.id, userId))
    .run();

  return { id: user.id, username: user.username };
}

export async function adminResetPasswordByUsername(username: string, newPassword: string): Promise<{ id: string; username: string }> {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('新密碼長度至少需 6 個字元');
  }

  const normalized = username.trim().toLowerCase();
  const user = db.select().from(users).where(eq(users.username, normalized)).get();
  if (!user || user.guestRemovedAt) {
    throw new Error(`查無使用者帳號 '${username}'`);
  }

  const passwordHash = await hashPassword(newPassword);
  db.update(users)
    .set({
      passwordHash,
      updatedAt: Date.now(),
    })
    .where(eq(users.id, user.id))
    .run();

  return { id: user.id, username: user.username };
}

export function adminUpdateUserRole(userId: string, newRole: ServerRole): void {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.guestRemovedAt) throw new Error('查無此使用者');

  db.update(users)
    .set({ serverRole: newRole, updatedAt: Date.now() })
    .where(eq(users.id, userId))
    .run();
}

export function adminToggleUserStatus(userId: string, isActive: boolean): void {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.guestRemovedAt) throw new Error('查無此使用者');

  db.update(users)
    .set({ isActive: isActive ? 1 : 0, updatedAt: Date.now() })
    .where(eq(users.id, userId))
    .run();
}
