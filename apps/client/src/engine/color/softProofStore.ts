import { useSyncExternalStore } from 'react';
import { PRINT_CONDITION_PRESETS, type BuiltinProofProfileId } from './cmykPrintModel';
import { isProofableProfile, parseIccProfile, type IccIntent } from './iccProfile';

export type SoftProofProfileId = `builtin:${BuiltinProofProfileId}` | `icc:${string}`;

export interface SoftProofSettings {
  enabled: boolean;
  gamutWarning: boolean;
  profileId: SoftProofProfileId;
  intent: IccIntent;
  blackPointCompensation: boolean;
  warningColor: string;
}

export const SOFT_PROOF_WARNING_COLORS: readonly string[] = ['#FF2BD6', '#00E5FF', '#7F7F7F', '#FFE500'];
export const DEFAULT_SOFT_PROOF_SETTINGS: SoftProofSettings = {
  enabled: false,
  gamutWarning: false,
  profileId: 'builtin:japan-color-2001-coated',
  intent: 'relative',
  blackPointCompensation: true,
  warningColor: SOFT_PROOF_WARNING_COLORS[0],
};

export interface StoredIccProfile {
  id: string;
  name: string;
  description: string;
  colorSpace: string;
  deviceClass: string;
  version: string;
  size: number;
  addedAt: number;
  bytes: Uint8Array;
}

export interface SoftProofProfileOption {
  id: SoftProofProfileId;
  kind: 'builtin' | 'icc';
  label: string;
  colorSpace: string;
  deviceClass: string;
  proofable: boolean;
}

export type SoftProofStatus =
  | { state: 'off' }
  | { state: 'building'; progress: number }
  | { state: 'ready'; buildMs: number; lutSize: number }
  | { state: 'error'; code: 'unsupported_profile' | 'missing_profile' | 'build_failed' };

export interface SoftProofSnapshot {
  settings: SoftProofSettings;
  profiles: SoftProofProfileOption[];
  status: SoftProofStatus;
}

export interface SoftProofSettingsStorage {
  load(): unknown;
  save(settings: SoftProofSettings): void;
}

export interface IccProfileRepository {
  list(): Promise<StoredIccProfile[]>;
  put(profile: StoredIccProfile): Promise<void>;
  delete(id: string): Promise<void>;
}

export type ImportIccResult = { ok: true; profile: SoftProofProfileOption }
  | { ok: false; code: 'too_large' | 'parse_failed' | 'unsupported_profile' };

export const MAX_ICC_PROFILE_BYTES = 8 * 1024 * 1024;

const builtinOptions: SoftProofProfileOption[] = PRINT_CONDITION_PRESETS.map(preset => ({
  id: `builtin:${preset.id}`, kind: 'builtin', label: preset.label, colorSpace: 'CMYK', deviceClass: 'prtr', proofable: true,
}));

function isProfileId(id: unknown): id is SoftProofProfileId {
  return typeof id === 'string' && (builtinOptions.some(option => option.id === id) || isIccProfileId(id));
}

function isIccProfileId(id: string): id is `icc:${string}` {
  return /^icc:\S+$/.test(id);
}

export function normalizeSoftProofSettings(raw: unknown): SoftProofSettings {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    enabled: false,
    gamutWarning: false,
    profileId: isProfileId(input.profileId) ? input.profileId : DEFAULT_SOFT_PROOF_SETTINGS.profileId,
    intent: input.intent === 'perceptual' || input.intent === 'relative' ? input.intent : DEFAULT_SOFT_PROOF_SETTINGS.intent,
    blackPointCompensation: typeof input.blackPointCompensation === 'boolean'
      ? input.blackPointCompensation : DEFAULT_SOFT_PROOF_SETTINGS.blackPointCompensation,
    warningColor: typeof input.warningColor === 'string' && /^#[0-9a-f]{6}$/i.test(input.warningColor)
      ? input.warningColor : DEFAULT_SOFT_PROOF_SETTINGS.warningColor,
  };
}

export function createLocalStorageSettingsStorage(key = 'atelier_soft_proof_v1'): SoftProofSettingsStorage {
  let saved: unknown;
  return {
    load() {
      try {
        return JSON.parse(window.localStorage.getItem(key) ?? 'null');
      } catch {
        return saved;
      }
    },
    save({ profileId, intent, blackPointCompensation, warningColor }) {
      saved = { profileId, intent, blackPointCompensation, warningColor };
      try {
        window.localStorage.setItem(key, JSON.stringify(saved));
      } catch {
        // Keep preferences available in memory when local storage is blocked.
      }
    },
  };
}

export function createIndexedDbIccRepository(dbName = 'LuminaDrift_IccProfiles'): IccProfileRepository {
  const storeName = 'profiles';
  let database: Promise<IDBDatabase> | undefined;
  function open() {
    return database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'id' });
      request.onblocked = () => {
        blocked = true;
        reject(new Error('ICC profile database upgrade is blocked'));
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (blocked) request.result.close();
        else resolve(request.result);
      };
    });
  }

  async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error('ICC profile transaction aborted'));
    });
  }

  return {
    list: () => transact('readonly', store => store.getAll()),
    async put(profile) { await transact('readwrite', store => store.put(profile)); },
    async delete(id) { await transact('readwrite', store => store.delete(id)); },
  };
}

export function createMemoryIccRepository(): IccProfileRepository {
  const entries = new Map<string, StoredIccProfile>();
  const copy = (profile: StoredIccProfile) => ({ ...profile, bytes: Uint8Array.from(profile.bytes) });
  return {
    async list() { return Array.from(entries.values(), copy); },
    async put(profile) { entries.set(profile.id, copy(profile)); },
    async delete(id) { entries.delete(id); },
  };
}

function iccProfileId(bytes: Uint8Array): `icc:${string}` {
  // FNV-1a 64-bit, with the multiplication split across two 32-bit words.
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (const byte of bytes) {
    low = (low ^ byte) >>> 0;
    const product = low * 0x1b3;
    high = (Math.imul(high, 0x1b3) + (low << 8) + Math.floor(product / 0x100000000)) >>> 0;
    low = product >>> 0;
  }
  return `icc:${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

function iccOption(id: `icc:${string}`, profile: StoredIccProfile, proofable: boolean): SoftProofProfileOption {
  return {
    id,
    kind: 'icc',
    label: profile.description || profile.name,
    colorSpace: profile.colorSpace,
    deviceClass: profile.deviceClass,
    proofable,
  };
}

export class SoftProofStore {
  private snapshot: SoftProofSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly imported = new Map<SoftProofProfileId, { stored: StoredIccProfile; option: SoftProofProfileOption }>();
  private readonly loading: Promise<void>;
  private writes: Promise<void>;

  constructor(private readonly deps: { settings: SoftProofSettingsStorage; repository: IccProfileRepository }) {
    this.snapshot = { settings: normalizeSoftProofSettings(deps.settings.load()), profiles: [...builtinOptions], status: { state: 'off' } };
    this.loading = this.loadProfiles();
    this.writes = this.loading;
  }

  getSnapshot = (): SoftProofSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  ready(): Promise<void> {
    return this.loading;
  }

  update(patch: Partial<SoftProofSettings>): void {
    const previous = this.snapshot.settings;
    const merged = { ...previous, ...patch };
    const settings = {
      ...normalizeSoftProofSettings(merged),
      enabled: typeof merged.enabled === 'boolean' ? merged.enabled : previous.enabled,
      gamutWarning: typeof merged.gamutWarning === 'boolean' ? merged.gamutWarning : previous.gamutWarning,
    };
    this.updateSnapshotSettings(settings);
  }

  toggleEnabled(): void {
    this.update({ enabled: !this.snapshot.settings.enabled });
  }

  toggleGamutWarning(): void {
    this.update({ gamutWarning: !this.snapshot.settings.gamutWarning });
  }

  async importProfile(fileName: string, bytes: Uint8Array): Promise<ImportIccResult> {
    if (bytes.byteLength > MAX_ICC_PROFILE_BYTES) return { ok: false, code: 'too_large' };
    let profile;
    try {
      profile = parseIccProfile(bytes);
    } catch {
      return { ok: false, code: 'parse_failed' };
    }
    const proofable = isProofableProfile(profile);
    const { colorSpace, deviceClass, version } = profile.header;
    if (!proofable && colorSpace !== 'RGB') return { ok: false, code: 'unsupported_profile' };

    const id = iccProfileId(profile.bytes);
    return this.write(async () => {
      const existing = this.imported.get(id);
      if (existing) {
        if (existing.option.proofable) this.update({ profileId: id });
        return { ok: true, profile: existing.option };
      }
      const stored = {
        id, name: fileName.replace(/\.[^.]+$/, '').trim(), description: profile.description.trim(),
        colorSpace, deviceClass, version, size: profile.bytes.byteLength, addedAt: Date.now(), bytes: profile.bytes,
      };
      const option = iccOption(id, stored, proofable);
      await this.deps.repository.put(stored);
      this.imported.set(id, { stored, option });
      const settings = proofable ? { ...this.snapshot.settings, profileId: id } : this.snapshot.settings;
      this.updateSnapshotSettings(settings, this.profileOptions());
      return { ok: true, profile: option };
    });
  }

  removeProfile(id: SoftProofProfileId): Promise<void> {
    return this.write(async () => {
      const entry = this.imported.get(id);
      if (!entry) return;
      await this.deps.repository.delete(entry.stored.id);
      this.imported.delete(id);
      const previous = this.snapshot.settings;
      const settings = previous.profileId === id ? { ...previous, profileId: DEFAULT_SOFT_PROOF_SETTINGS.profileId } : previous;
      this.updateSnapshotSettings(settings, this.profileOptions());
    });
  }

  getIccBytes(id: SoftProofProfileId): Uint8Array | null {
    const entry = this.imported.get(id);
    return entry ? Uint8Array.from(entry.stored.bytes) : null;
  }

  setStatus(status: SoftProofStatus): void {
    if (status.state === 'off' && this.snapshot.status.state === 'off') return;
    this.publish({ ...this.snapshot, status });
  }

  listRgbEmbedProfiles(): Array<{ id: SoftProofProfileId; label: string; bytes: Uint8Array }> {
    return Array.from(this.imported.values())
      .filter(({ option }) => option.colorSpace === 'RGB')
      .map(({ stored, option }) => ({ id: option.id, label: option.label, bytes: Uint8Array.from(stored.bytes) }));
  }

  private async loadProfiles(): Promise<void> {
    for (const stored of await this.deps.repository.list()) {
      try {
        if (!isIccProfileId(stored.id)) continue;
        const profile = parseIccProfile(stored.bytes);
        const option = iccOption(stored.id, stored, isProofableProfile(profile));
        this.imported.set(option.id, { stored, option });
      } catch {
        // Ignore unreadable records so the remaining profiles still load.
      }
    }
    if (this.imported.size) this.publish({ ...this.snapshot, profiles: this.profileOptions() });
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.then(() => {}, () => {});
    return result;
  }

  private profileOptions(): SoftProofProfileOption[] {
    return [...builtinOptions, ...Array.from(this.imported.values(), entry => entry.option)];
  }

  private updateSnapshotSettings(settings: SoftProofSettings, profiles = this.snapshot.profiles): void {
    const previous = this.snapshot.settings;
    const persist = settings.profileId !== previous.profileId || settings.intent !== previous.intent
      || settings.blackPointCompensation !== previous.blackPointCompensation || settings.warningColor !== previous.warningColor;
    const changed = persist || settings.enabled !== previous.enabled || settings.gamutWarning !== previous.gamutWarning;
    if (persist) this.deps.settings.save(normalizeSoftProofSettings(settings));
    if (changed || profiles !== this.snapshot.profiles) {
      this.publish({ ...this.snapshot, settings: changed ? settings : previous, profiles });
    }
  }

  private publish(snapshot: SoftProofSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

let singleton: SoftProofStore | undefined;

export function getSoftProofStore(): SoftProofStore {
  if (singleton) return singleton;
  let repository = typeof window === 'undefined' ? createMemoryIccRepository() : createIndexedDbIccRepository();
  singleton = new SoftProofStore({
    settings: createLocalStorageSettingsStorage(),
    repository: {
      async list() {
        try {
          return await repository.list();
        } catch {
          repository = createMemoryIccRepository();
          return [];
        }
      },
      put: profile => repository.put(profile),
      delete: id => repository.delete(id),
    },
  });
  return singleton;
}

export function useSoftProof(): SoftProofSnapshot {
  const store = getSoftProofStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
