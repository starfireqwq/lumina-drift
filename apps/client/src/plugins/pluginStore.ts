import { MAX_PLUGINS, parsePlugin, type PluginManifest } from './pluginApi';

export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
}

const STORAGE_KEY = 'lumina_plugins_v1';
const listeners = new Set<() => void>();

function readPlugins(): InstalledPlugin[] {
  try {
    const items: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(items)) return [];
    const plugins = new Map<string, InstalledPlugin>();
    for (const entry of items.slice(0, MAX_PLUGINS)) {
      try {
        const manifest = parsePlugin(entry.manifest);
        plugins.set(manifest.id, { manifest, enabled: entry.enabled === true });
      } catch {
        // A damaged record must not hide the remaining plugins.
      }
    }
    return [...plugins.values()];
  } catch {
    return [];
  }
}

let installed = readPlugins();
export const getPlugins = () => installed;

function publish(plugins: InstalledPlugin[]) {
  installed = plugins;
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) publish(readPlugins());
  });
}

export function subscribePlugins(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function installPlugin(manifest: PluginManifest) {
  const plugins = readPlugins().filter((plugin) => plugin.manifest.id !== manifest.id);
  if (plugins.length >= MAX_PLUGINS) throw new Error(`At most ${MAX_PLUGINS} plugins can be installed.`);
  save([...plugins, { manifest, enabled: false }]);
}

export function setPluginEnabled(id: string, enabled: boolean) {
  save(readPlugins().map((plugin) => plugin.manifest.id === id ? { ...plugin, enabled } : plugin));
}

export function removePlugin(id: string) {
  save(readPlugins().filter((plugin) => plugin.manifest.id !== id));
}

function save(plugins: InstalledPlugin[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(plugins));
  publish(plugins);
}
