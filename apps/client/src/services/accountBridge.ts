import type { UserPayload } from '@atelier/shared';
import { ApiService } from './api';
import { parseServerLink } from '../utils/serverLinks';

/**
 * Carries one account across servers and server addresses.
 *
 * - Same server, another address (LAN IP, tunnel, localhost): the server proves who it is by signing
 *   a random challenge with its identity key; only then is a login made at the other address reused.
 *   A login is never handed to a server merely claiming to be the same one.
 * - The primary account lives on the user's own server ("home"). On someone else's server the app
 *   registers that name once (random password kept on this device, like the login tokens already are),
 *   signs in with it afterwards and keeps its display name and avatar in step with the primary account.
 *
 * Signature checks need WebCrypto, i.e. a secure context: the desktop app, the Android app and pages
 * opened at localhost. A browser opening a shared link keeps separate storage per address anyway.
 */

const SERVER_KEYS = 'lumina_server_keys';
const PRIMARY = 'lumina_primary_account';
const AUTO_ACCOUNTS = 'lumina_auto_accounts';
export const PRIMARY_ACCOUNT_EVENT = 'atelier:primary-account';

export interface PrimaryAccount {
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  /** Identity key of the server holding the real account */
  homeKey: string;
  homeOrigin: string;
  /** Changed away from home (solo mode or another server): push to the home account next time. */
  dirty?: boolean;
}

interface AutoAccount { username: string; password: string }

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked: the feature simply does nothing
  }
};

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const randomToken = (bytes: number) => {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const accountBridgeAvailable = () =>
  typeof window !== 'undefined' && window.isSecureContext && typeof crypto !== 'undefined' && Boolean(crypto.subtle);

const fetchWithTimeout = async (url: string, init: RequestInit = {}, ms = 6000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const jsonInit = (method: string, body: unknown, token?: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

const notifyPrimary = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PRIMARY_ACCOUNT_EVENT));
};

export const getPrimaryAccount = (): PrimaryAccount | null => {
  const value = read<PrimaryAccount | null>(PRIMARY, null);
  return value && typeof value.username === 'string' && typeof value.homeKey === 'string' ? value : null;
};

export const clearPrimaryAccount = () => {
  write(PRIMARY, null);
  notifyPrimary();
};

const savePrimary = (next: PrimaryAccount) => {
  write(PRIMARY, next);
  notifyPrimary();
};

/** Asks the server at `origin` to sign a fresh challenge; returns its key only when the signature holds. */
export async function verifyServerIdentity(origin: string): Promise<string | null> {
  if (!accountBridgeAvailable() || !origin) return null;
  try {
    const challenge = randomToken(32);
    const res = await fetchWithTimeout(`${origin}/api/server/identity?challenge=${challenge}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const { key, signature } = await res.json();
    if (typeof key !== 'string' || typeof signature !== 'string') return null;
    const publicKey = await crypto.subtle.importKey('spki', fromBase64(key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      fromBase64(signature),
      new TextEncoder().encode(`lumina-drift-identity:v1:${challenge}`),
    );
    if (!valid) return null;
    const keys = read<Record<string, string>>(SERVER_KEYS, {});
    if (keys[origin] !== key) write(SERVER_KEYS, { ...keys, [origin]: key });
    return key;
  } catch {
    return null;
  }
}

const tokenAccepted = async (origin: string, token: string) => {
  try {
    const res = await fetchWithTimeout(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
};

/**
 * Nothing stored for `origin`: reuse a login from another address of the same server, sign in with
 * the account this app registered there, or register the primary account's name there.
 * Returns the token now stored for `origin`, or null.
 */
export async function restoreSession(origin: string): Promise<string | null> {
  const key = await verifyServerIdentity(origin);
  if (!key) return null;

  const keys = read<Record<string, string>>(SERVER_KEYS, {});
  for (const [other, otherKey] of Object.entries(keys)) {
    if (other === origin || otherKey !== key) continue;
    const token = ApiService.getToken(other);
    if (token && await tokenAccepted(origin, token)) {
      ApiService.setToken(token, origin);
      return token;
    }
  }

  const autos = read<Record<string, AutoAccount>>(AUTO_ACCOUNTS, {});
  const auto = autos[key];
  if (auto) {
    const res = await fetchWithTimeout(`${origin}/api/auth/login`, jsonInit('POST', auto)).catch(() => null);
    if (!res) return null;
    if (res.ok) {
      const data = await res.json();
      ApiService.setToken(data.token, origin);
      return data.token as string;
    }
    if (res.status !== 401) return null;
    // The account is gone (e.g. the server was reset): register again below.
    delete autos[key];
    write(AUTO_ACCOUNTS, autos);
  }

  const primary = getPrimaryAccount();
  if (!primary || primary.homeKey === key) return null;
  const base = primary.username.trim().toLowerCase().replace(/\s+/g, '').slice(0, 24) || 'artist';
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const username = attempt === 1 ? base : `${base}_${attempt}`;
    const password = randomToken(24);
    const res = await fetchWithTimeout(
      `${origin}/api/auth/register`,
      jsonInit('POST', { username, password, displayName: primary.displayName }),
    ).catch(() => null);
    if (!res) return null;
    if (res.ok) {
      const data = await res.json();
      write(AUTO_ACCOUNTS, { ...read<Record<string, AutoAccount>>(AUTO_ACCOUNTS, {}), [key]: { username: data.user.username, password } });
      ApiService.setToken(data.token, origin);
      if (primary.avatarUrl) await patchProfile(origin, data.token, { avatarUrl: primary.avatarUrl });
      return ApiService.getToken(origin);
    }
    const error = res.status === 400 ? String((await res.json().catch(() => ({}))).error || '') : '';
    if (!/已存在|exists/i.test(error)) return null;
  }
  return null;
}

async function patchProfile(origin: string, token: string, body: { displayName?: string; avatarUrl?: string | null }) {
  const res = await fetchWithTimeout(`${origin}/api/auth/profile`, jsonInit('PATCH', body, token)).catch(() => null);
  if (!res?.ok) return null;
  const data = await res.json() as { token: string; user: UserPayload };
  if (ApiService.getToken(origin) === token) ApiService.setToken(data.token, origin);
  return data;
}

type Role = 'home' | 'auto' | null;

/** Which of the accounts this app manages `user` is on the server at `origin`. */
async function roleOf(origin: string, user: UserPayload): Promise<{ role: Role; primary: PrimaryAccount | null }> {
  const primary = getPrimaryAccount();
  if (!primary) return { role: null, primary };
  const key = read<Record<string, string>>(SERVER_KEYS, {})[origin] ?? await verifyServerIdentity(origin);
  if (!key) return { role: null, primary };
  if (key === primary.homeKey && user.username === primary.username) return { role: 'home', primary };
  if (read<Record<string, AutoAccount>>(AUTO_ACCOUNTS, {})[key]?.username === user.username) return { role: 'auto', primary };
  return { role: null, primary };
}

/**
 * After a session is confirmed: remember this address's server key, and keep names and avatars in step.
 * The home account feeds the primary profile (unless the primary was edited away from home); accounts
 * the app registered elsewhere follow the primary profile. Returns the updated session when it changed.
 */
export async function syncAfterSession(origin: string, user: UserPayload): Promise<{ token: string; user: UserPayload } | null> {
  // Remember which server this address is, so another address of it can reuse this login.
  if (!read<Record<string, string>>(SERVER_KEYS, {})[origin]) await verifyServerIdentity(origin);
  const { role, primary } = await roleOf(origin, user);
  if (!role || !primary) return null;
  const differs = user.displayName !== primary.displayName || (user.avatarUrl ?? null) !== (primary.avatarUrl ?? null);
  if (role === 'home' && !primary.dirty) {
    if (differs) savePrimary({ ...primary, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null });
    return null;
  }
  if (!differs) {
    if (role === 'home') savePrimary({ ...primary, dirty: false });
    return null;
  }
  const token = ApiService.getToken(origin);
  if (!token) return null;
  const updated = await patchProfile(origin, token, { displayName: primary.displayName, avatarUrl: primary.avatarUrl ?? null });
  if (updated && role === 'home') savePrimary({ ...primary, dirty: false });
  return updated;
}

/** Makes the account just signed in at `origin` the primary account. */
export async function setPrimaryFromSession(origin: string, user: UserPayload): Promise<boolean> {
  const key = await verifyServerIdentity(origin);
  if (!key) return false;
  savePrimary({ username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null, homeKey: key, homeOrigin: origin });
  return true;
}

/** Signs in to the primary account at `serverUrl` (works in solo mode, without switching servers). */
export async function signInPrimary(serverUrl: string, username: string, password: string): Promise<PrimaryAccount> {
  const origin = parseServerLink(serverUrl)?.origin;
  if (!origin) throw new Error('伺服器網址格式不正確');
  const res = await fetchWithTimeout(`${origin}/api/auth/login`, jsonInit('POST', { username: username.trim(), password }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  ApiService.setToken(data.token, origin);
  if (!await setPrimaryFromSession(origin, data.user)) throw new Error('無法確認這台伺服器的身分');
  return getPrimaryAccount()!;
}

/**
 * A profile edit: solo mode or a managed account updates the primary profile. Edits made away from
 * home are pushed to the home account on the next visit there.
 */
export async function notePrimaryEdit(edit: { displayName: string; avatarUrl?: string | null }, origin: string | null, user?: UserPayload) {
  const primary = getPrimaryAccount();
  if (!primary) return;
  const role = origin && user ? (await roleOf(origin, user)).role : null;
  if (origin && !role) return;
  savePrimary({
    ...primary,
    displayName: edit.displayName || primary.displayName,
    avatarUrl: edit.avatarUrl !== undefined ? edit.avatarUrl : primary.avatarUrl,
    dirty: role !== 'home',
  });
}
