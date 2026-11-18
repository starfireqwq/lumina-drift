import { DEFAULT_COMMUNITY_PRESETS, MIN_BRUSH_SPACING, type AtelierBrushPreset } from '@atelier/shared';

export interface BrushLibrary {
  brushes: AtelierBrushPreset[];
  groups: string[];
}

interface BrushLibraryIndex {
  ids: string[];
  groups: string[];
  revision: string;
  brushDefaultsVersion?: number;
}

const oldStorageKey = 'atelier_user_brush_presets';
const databaseName = 'lumina_brush_library';
const previousBuiltInNames = new Map([
  ['preset_csp_gpen', '經典 G 筆 (G-Pen)'],
  ['preset_csp_watercolor', '逼真濃淡水彩 (Wet Watercolor)'],
]);
const builtInNames = new Map(DEFAULT_COMMUNITY_PRESETS.map((brush) => [brush.id, brush.name]));
let dbPromise: Promise<IDBDatabase> | undefined;

function database() {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(databaseName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('library');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export function brushGroup(brush: AtelierBrushPreset) {
  return (typeof brush.category === 'string' && brush.category.trim()) || '自訂筆刷';
}

export function newBrushId() {
  return globalThis.crypto?.randomUUID?.() ?? `brush_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function fromLegacy(): BrushLibrary {
  let saved: AtelierBrushPreset[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(oldStorageKey) || '[]');
    if (Array.isArray(parsed)) saved = parsed.filter((brush) => typeof brush?.name === 'string' && brush.name && brush.properties);
  } catch {
    // The starter library is available even when browser storage is blocked.
  }
  const ids = new Set(DEFAULT_COMMUNITY_PRESETS.map((brush) => brush.id));
  const custom = saved.map((brush) => {
    const id = brush.id && !ids.has(brush.id) ? brush.id : newBrushId();
    ids.add(id);
    return { ...brush, id };
  });
  const brushes = [...DEFAULT_COMMUNITY_PRESETS, ...custom];
  return { brushes, groups: Array.from(new Set(brushes.map(brushGroup))) };
}

let current: BrushLibrary = fromLegacy();
let currentRevision: string | undefined;
let ready: Promise<void> | undefined;
let writes: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function publish(next: BrushLibrary, revision?: string) {
  current = next;
  currentRevision = revision;
  for (const listener of listeners) listener();
}

export function subscribeBrushLibrary(listener: () => void) {
  listeners.add(listener);
  void load();
  return () => { listeners.delete(listener); };
}

export function getBrushLibrary() {
  return current;
}

function load() {
  if (!ready) {
    ready = database().then((db) => new Promise<void>((resolve, reject) => {
      const tx = db.transaction('library');
      readStoredLibrary(tx, (stored, index) => {
        publish(withCurrentBrushDefaults(withCurrentBuiltInNames(stored), index), index?.revision);
        resolve();
        if (index?.brushDefaultsVersion !== 1) {
          void updateBrushLibrary(library => library).catch(error => console.warn('Brush defaults migration failed:', error));
        }
      });
      tx.onabort = () => reject(tx.error);
    })).catch(() => {});
  }
  return ready;
}

function readStoredLibrary(tx: IDBTransaction, done: (library: BrushLibrary, index?: BrushLibraryIndex) => void) {
  const store = tx.objectStore('library');
  const request = store.get('brush-index');
  request.onsuccess = () => {
    const saved = request.result as BrushLibraryIndex | undefined;
    if (!saved) {
      const legacy = store.get('presets');
      legacy.onsuccess = () => done(legacy.result ?? current);
      return;
    }
    if (saved.revision === currentRevision && saved.brushDefaultsVersion === 1) {
      done(current, saved);
      return;
    }
    const brushes = new Map<string, AtelierBrushPreset>();
    const cursor = store.openCursor(IDBKeyRange.bound('brush/', 'brush0', false, true));
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (row) {
        const brush = row.value as AtelierBrushPreset;
        brushes.set(brush.id, brush);
        row.continue();
      } else {
        done({
          groups: saved.groups,
          brushes: saved.ids.flatMap(id => {
            const brush = brushes.get(id);
            return brush ? [brush] : [];
          }),
        }, saved);
      }
    };
  };
}

function withCurrentBuiltInNames(library: BrushLibrary): BrushLibrary {
  const brushes = library.brushes.map((brush) => {
    const name = builtInNames.get(brush.id);
    return name && brush.name === previousBuiltInNames.get(brush.id) ? { ...brush, name } : brush;
  });
  return brushes.some((brush, index) => brush !== library.brushes[index]) ? { ...library, brushes } : library;
}

function withCurrentBrushDefaults(library: BrushLibrary, index?: BrushLibraryIndex): BrushLibrary {
  if (index?.brushDefaultsVersion === 1) return library;
  const brushes = library.brushes.map(brush => {
    const defaultBrush = builtInNames.has(brush.id) || brush.tags?.some(tag => tag === 'Imported' || tag === 'CustomImage');
    const minSize = brush.id === 'preset_csp_gpen' && brush.properties.minSize === 1 ? 0 : brush.properties.minSize;
    return defaultBrush && (brush.properties.spacing !== MIN_BRUSH_SPACING || brush.properties.minSize !== minSize)
      ? { ...brush, properties: { ...brush.properties, spacing: MIN_BRUSH_SPACING, minSize } }
      : brush;
  });
  return brushes.some((brush, index) => brush !== library.brushes[index]) ? { ...library, brushes } : library;
}

export async function updateBrushLibrary(update: (library: BrushLibrary) => BrushLibrary) {
  const write = writes.then(async () => {
    await load();
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('library', 'readwrite');
      const store = tx.objectStore('library');
      let next = current;
      let revision = currentRevision;
      readStoredLibrary(tx, (stored, index) => {
        try {
          const prior = withCurrentBrushDefaults(withCurrentBuiltInNames(stored), index);
          next = update(prior);
          revision = index?.revision;
          if (next === stored && index?.brushDefaultsVersion === 1) return;
          revision = newBrushId();
          const oldBrushes = new Map(index ? stored.brushes.map(brush => [brush.id, brush]) : []);
          for (const brush of next.brushes) {
            if (oldBrushes.get(brush.id) !== brush) store.put(brush, `brush/${brush.id}`);
            oldBrushes.delete(brush.id);
          }
          for (const id of oldBrushes.keys()) store.delete(`brush/${id}`);
          // One value per tip keeps large brush sets within IndexedDB's per-value limit.
          store.put({ ids: next.brushes.map(brush => brush.id), groups: next.groups, revision, brushDefaultsVersion: 1 }, 'brush-index');
        } catch (error) {
          reject(error);
          tx.abort();
        }
      });
      tx.oncomplete = () => {
        publish(next, revision);
        resolve();
      };
      tx.onabort = () => reject(tx.error);
    });
  });
  writes = write.catch(() => {});
  return write;
}
