import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import {
  LoginDto,
  RegisterDto,
  UserModel,
  UserPayload,
} from '@atelier/shared';

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    memoryCost: 19456,
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  });
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function findUserByUsername(username: string): UserModel | null {
  const row = db.select().from(users).where(eq(users.username, username.trim().toLowerCase())).get();
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    passwordHash: row.passwordHash,
    avatarUrl: row.avatarUrl,
    serverRole: row.serverRole as 'admin' | 'member' | 'guest',
    isActive: Boolean(row.isActive),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function findUserById(id: string): UserModel | null {
  const row = db.select().from(users).where(eq(users.id, id)).get();
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    passwordHash: row.passwordHash,
    avatarUrl: row.avatarUrl,
    serverRole: row.serverRole as 'admin' | 'member' | 'guest',
    isActive: Boolean(row.isActive),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function registerUser(dto: RegisterDto): Promise<UserPayload> {
  const normalizedUsername = dto.username.trim().toLowerCase();
  const existing = findUserByUsername(normalizedUsername);
  if (existing) {
    throw new Error('該使用者帳號已存在，請使用其他帳號');
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(dto.password);
  const now = Date.now();

  const newUser = {
    id,
    username: normalizedUsername,
    displayName: dto.displayName.trim() || normalizedUsername,
    passwordHash,
    avatarUrl: null,
    serverRole: dto.serverRole || 'member',
    isActive: 1,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(users).values(newUser).run();

  return {
    id: newUser.id,
    username: newUser.username,
    displayName: newUser.displayName,
    serverRole: newUser.serverRole as 'admin' | 'member' | 'guest',
    avatarUrl: null,
  };
}

export async function registerGuestUser(displayName?: string): Promise<UserPayload> {
  const id = crypto.randomUUID();
  const shortId = id.substring(0, 6);
  const name = displayName?.trim() || `訪客畫師 #${shortId}`;
  const now = Date.now();
  const dummyHash = await hashPassword(crypto.randomUUID());

  const newUser = {
    id,
    username: `guest_${shortId}`,
    displayName: name,
    passwordHash: dummyHash,
    avatarUrl: null,
    serverRole: 'guest' as const,
    isActive: 1,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(users).values(newUser).run();

  return {
    id: newUser.id,
    username: newUser.username,
    displayName: newUser.displayName,
    serverRole: 'guest',
    avatarUrl: null,
  };
}

export function isTemporaryGuest(user: Pick<typeof users.$inferSelect, 'id' | 'username' | 'serverRole' | 'passwordHash'>): boolean {
  return user.serverRole !== 'admin' &&
    (user.username === `guest_${user.id.slice(0, 6)}` || user.passwordHash === 'guest_hash');
}

/** Delete an unused guest, retaining an inactive identity if its artwork still references it. */
export function removeGuestIdentity(userId: string, keepArtwork = false): boolean {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.guestRemovedAt || !isTemporaryGuest(user)) return false;
  try {
    db.delete(users).where(eq(users.id, userId)).run();
  } catch (error) {
    if ((error as { code?: string }).code !== 'SQLITE_CONSTRAINT_FOREIGNKEY') throw error;
    if (!keepArtwork) return false;
    const now = Date.now();
    db.update(users).set({ isActive: 0, guestRemovedAt: now, updatedAt: now }).where(eq(users.id, userId)).run();
  }
  return true;
}

export function toUserPayload(user: UserModel): UserPayload {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    serverRole: user.serverRole,
    avatarUrl: user.avatarUrl,
  };
}

export function updateUserProfile(
  userId: string,
  updates: { displayName?: string; avatarUrl?: string | null }
): UserPayload {
  const user = findUserById(userId);
  if (!user) throw new Error('使用者不存在');

  const patch: Record<string, any> = { updatedAt: Date.now() };
  if (updates.displayName !== undefined && updates.displayName.trim()) {
    patch.displayName = updates.displayName.trim();
  }
  if (updates.avatarUrl !== undefined) {
    patch.avatarUrl = updates.avatarUrl;
  }

  db.update(users).set(patch).where(eq(users.id, userId)).run();
  const updated = findUserById(userId)!;
  return toUserPayload(updated);
}

/**
 * Promotes a guest user to 'member' when they create their own room so they have full room-owner capabilities.
 */
export function promoteGuestToMember(userId: string): UserPayload | null {
  const user = findUserById(userId);
  if (!user) return null;
  if (user.serverRole === 'guest') {
    db.update(users)
      .set({ serverRole: 'member', updatedAt: Date.now() })
      .where(eq(users.id, userId))
      .run();
    const updated = findUserById(userId)!;
    return toUserPayload(updated);
  }
  return toUserPayload(user);
}
