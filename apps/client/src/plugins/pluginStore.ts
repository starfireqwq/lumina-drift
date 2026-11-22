import { PLUGIN_LIMITS, parsePlugin, type PluginManifest } from './pluginApi';
import { revokePluginV3Consent } from './pluginV3Client';

export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
}

/**
 * Storage backend contract for installed plugins.
 * Abstracted so future iterations can swap localStorage for IndexedDB or
 * Electron filesystem storage without changing callers.
 */
export interface PluginStorageBackend {
  readonly storageKey: string;
  readonly legacyKeys?: readonly string[];
  readRaw(): string | null;
  readLegacyRaw?(key: string): string | null;
  writeRaw(serialized: string): void;
  subscribeExternal?(onExternalChange: () => void): () => void;
}

export const PLUGIN_STORAGE_KEY_V1 = 'lumina_plugins_v1';
export const PLUGIN_STORAGE_KEY_V2 = 'lumina_plugins_v2';

function createLocalStorageBackend(): PluginStorageBackend {
  const safeGet = (key: string): string | null => {
    try {
      if (typeof localStorage === 'undefined') return null;
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const safeSet = (key: string, value: string): void => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  };
  return {
    storageKey: PLUGIN_STORAGE_KEY_V2,
    legacyKeys: [PLUGIN_STORAGE_KEY_V1],
    readRaw: () => safeGet(PLUGIN_STORAGE_KEY_V2),
    readLegacyRaw: (key: string) => safeGet(key),
    writeRaw: (serialized: string) => safeSet(PLUGIN_STORAGE_KEY_V2, serialized),
    subscribeExternal: (onExternalChange: () => void) => {
      if (typeof window === 'undefined') return () => {};
      const handler = (event: StorageEvent) => {
        if (
          event.key === PLUGIN_STORAGE_KEY_V2 ||
          event.key === PLUGIN_STORAGE_KEY_V1 ||
          event.key === null
        ) {
          onExternalChange();
        }
      };
      window.addEventListener('storage', handler);
      return () => window.removeEventListener('storage', handler);
    },
  };
}

export interface PluginStoreInstance {
  getPlugins(): InstalledPlugin[];
  subscribePlugins(listener: () => void): () => void;
  installPlugin(manifest: PluginManifest): void;
  setPluginEnabled(id: string, enabled: boolean): void;
  removePlugin(id: string): void;
  reload(): InstalledPlugin[];
  dispose(): void;
}

function parseStoredList(raw: string | null, maxPlugins: number): InstalledPlugin[] {
  if (!raw) return [];
  try {
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items)) return [];
    const plugins = new Map<string, InstalledPlugin>();
    for (const entry of items.slice(0, maxPlugins)) {
      if (!entry || typeof entry !== 'object') continue;
      try {
        const record = entry as { manifest?: unknown; enabled?: unknown };
        const manifest = parsePlugin(record.manifest);
        plugins.set(manifest.id, { manifest, enabled: record.enabled === true });
      } catch {
        // A damaged record must not hide the remaining plugins.
      }
    }
    return [...plugins.values()];
  } catch {
    return [];
  }
}

export function createPluginStore(
  backend: PluginStorageBackend,
  maxPlugins: number = PLUGIN_LIMITS.maxInstalledPlugins,
): PluginStoreInstance {
  const listeners = new Set<() => void>();

  const readPlugins = (): InstalledPlugin[] => {
    const primaryRaw = backend.readRaw();
    if (primaryRaw !== null) {
      return parseStoredList(primaryRaw, maxPlugins);
    }
    // Transparent migration from v1 storage key to v2 storage key.
    if (backend.legacyKeys && backend.readLegacyRaw) {
      for (const legacyKey of backend.legacyKeys) {
        const legacyRaw = backend.readLegacyRaw(legacyKey);
        if (legacyRaw !== null) {
          const migrated = parseStoredList(legacyRaw, maxPlugins);
          try {
            backend.writeRaw(JSON.stringify(migrated));
          } catch {
            // Keep working in memory if quota or private mode blocks write.
          }
          return migrated;
        }
      }
    }
    return [];
  };

  let installed = readPlugins();

  const publish = (plugins: InstalledPlugin[]) => {
    installed = plugins;
    for (const listener of listeners) listener();
  };

  const save = (plugins: InstalledPlugin[]) => {
    backend.writeRaw(JSON.stringify(plugins));
    publish(plugins);
  };

  const unsubscribeExternal = backend.subscribeExternal?.(() => {
    publish(readPlugins());
  });

  return {
    getPlugins: () => installed,
    subscribePlugins: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    installPlugin: (manifest: PluginManifest) => {
      const plugins = readPlugins().filter((plugin) => plugin.manifest.id !== manifest.id);
      if (plugins.length >= maxPlugins) {
        throw new Error(`At most ${maxPlugins} plugins can be installed.`);
      }
      // Security rule: new installs and same-id replacements always start disabled
      // and revoke any prior in-memory v3 session consents for this plugin ID.
      revokePluginV3Consent(manifest.id);
      save([...plugins, { manifest, enabled: false }]);
    },
    setPluginEnabled: (id: string, enabled: boolean) => {
      if (!enabled) revokePluginV3Consent(id);
      save(readPlugins().map((plugin) => (plugin.manifest.id === id ? { ...plugin, enabled } : plugin)));
    },
    removePlugin: (id: string) => {
      revokePluginV3Consent(id);
      save(readPlugins().filter((plugin) => plugin.manifest.id !== id));
    },
    reload: () => {
      const next = readPlugins();
      publish(next);
      return next;
    },
    dispose: () => {
      unsubscribeExternal?.();
      listeners.clear();
    },
  };
}

const defaultStore = createPluginStore(createLocalStorageBackend());

export const getPlugins = () => defaultStore.getPlugins();
export const subscribePlugins = (listener: () => void) => defaultStore.subscribePlugins(listener);
export const installPlugin = (manifest: PluginManifest) => defaultStore.installPlugin(manifest);
export const setPluginEnabled = (id: string, enabled: boolean) => defaultStore.setPluginEnabled(id, enabled);
export const removePlugin = (id: string) => defaultStore.removePlugin(id);
