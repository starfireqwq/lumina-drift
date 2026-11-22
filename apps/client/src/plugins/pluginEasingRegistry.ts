import { BEZIER_PRESETS, type KeyframeBezierPresetId } from '@atelier/shared';
import type { PluginEasingPresetInfo } from './pluginApi';
import { getPlugins, subscribePlugins, type InstalledPlugin } from './pluginStore';

export interface CustomEasingEntry {
  id: string;
  pluginId: string;
  label: string;
  bezier: [number, number, number, number];
}

const BUILTIN_LABELS: Record<KeyframeBezierPresetId, string> = {
  softEase: 'Soft Ease',
  strongEase: 'Strong Ease',
  decelerate: 'Decelerate',
  accelerate: 'Accelerate',
  softOvershoot: 'Soft Overshoot',
  strongOvershoot: 'Strong Overshoot',
};

const customEasings = new Map<string, CustomEasingEntry>();
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const fn of listeners) fn();
}

export function validateBezierTuple(raw: unknown): [number, number, number, number] {
  if (!Array.isArray(raw) || raw.length !== 4) {
    throw new Error('Bezier curve must be a 4-number array [x1, y1, x2, y2].');
  }
  const nums = raw.map((n) => Number(n));
  if (nums.some((n) => !Number.isFinite(n))) {
    throw new Error('Bezier control points must be finite numbers.');
  }
  const [x1, y1, x2, y2] = nums;
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    throw new Error('Bezier x1 and x2 must be between 0 and 1.');
  }
  if (y1 < -2 || y1 > 3 || y2 < -2 || y2 > 3) {
    throw new Error('Bezier y1 and y2 must be between -2 and 3.');
  }
  return [x1, y1, x2, y2];
}

export function registerPluginEasing(
  pluginId: string,
  id: string,
  label: string,
  bezier: [number, number, number, number],
  maxPerPlugin = 16,
): CustomEasingEntry {
  const cleanId = id.trim();
  if (!cleanId || cleanId.length > 60 || !/^[a-z0-9][a-z0-9._-]*$/i.test(cleanId)) {
    throw new Error('Invalid easing ID.');
  }
  if (BEZIER_PRESETS.some((p) => p.id === cleanId)) {
    throw new Error(`Cannot overwrite built-in easing preset: ${cleanId}`);
  }
  const existing = customEasings.get(cleanId);
  if (existing && existing.pluginId !== pluginId) {
    throw new Error(`Easing ID "${cleanId}" is already registered by another plugin.`);
  }
  if (!existing) {
    let ownedCount = 0;
    for (const entry of customEasings.values()) {
      if (entry.pluginId === pluginId) ownedCount += 1;
    }
    if (ownedCount >= maxPerPlugin) {
      throw new Error(`A plugin can register at most ${maxPerPlugin} custom easing curves.`);
    }
  }
  const cleanLabel = (label.trim() || cleanId).slice(0, 60);
  const validBezier = validateBezierTuple(bezier);
  const entry: CustomEasingEntry = {
    id: cleanId,
    pluginId,
    label: cleanLabel,
    bezier: validBezier,
  };
  customEasings.set(cleanId, entry);
  notifyListeners();
  return entry;
}

export function unregisterPluginEasing(pluginId: string, id: string): boolean {
  const existing = customEasings.get(id);
  if (!existing) return false;
  if (existing.pluginId !== pluginId) {
    throw new Error(`Easing ID "${id}" belongs to another plugin.`);
  }
  customEasings.delete(id);
  notifyListeners();
  return true;
}

export function clearPluginEasingsForPlugin(pluginId: string): void {
  let changed = false;
  for (const [id, entry] of customEasings.entries()) {
    if (entry.pluginId === pluginId) {
      customEasings.delete(id);
      changed = true;
    }
  }
  if (changed) notifyListeners();
}

export function getPluginEasing(id: string): CustomEasingEntry | undefined {
  return customEasings.get(id);
}

export function resolveEasingBezierById(id: string): [number, number, number, number] | null {
  const builtin = BEZIER_PRESETS.find((p) => p.id === id);
  if (builtin) return [...builtin.bezier] as [number, number, number, number];
  const custom = customEasings.get(id);
  if (custom) return [...custom.bezier] as [number, number, number, number];
  return null;
}

export function listAllEasingPresets(): PluginEasingPresetInfo[] {
  const out: PluginEasingPresetInfo[] = BEZIER_PRESETS.map((p) => ({
    id: p.id,
    label: BUILTIN_LABELS[p.id] ?? p.id,
    bezier: [...p.bezier] as [number, number, number, number],
    source: 'builtin',
  }));
  for (const entry of customEasings.values()) {
    out.push({
      id: entry.id,
      label: entry.label,
      bezier: [...entry.bezier] as [number, number, number, number],
      source: 'plugin',
      pluginId: entry.pluginId,
    });
  }
  return out;
}

export function syncPluginEasings(installedPlugins: readonly InstalledPlugin[]): void {
  const enabledTimelineWriters = new Set(
    installedPlugins
      .filter(
        (p) =>
          p.enabled &&
          p.manifest.apiVersion === 2 &&
          p.manifest.permissions.includes('timeline:write'),
      )
      .map((p) => p.manifest.id),
  );
  let changed = false;
  for (const [id, entry] of customEasings.entries()) {
    if (!enabledTimelineWriters.has(entry.pluginId)) {
      customEasings.delete(id);
      changed = true;
    }
  }
  if (changed) notifyListeners();
}

export function subscribePluginEasings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetPluginEasingsForTests(): void {
  customEasings.clear();
  notifyListeners();
}

subscribePlugins(() => {
  syncPluginEasings(getPlugins());
});
