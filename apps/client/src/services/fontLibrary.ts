import { useSyncExternalStore } from 'react';

const MAX_FONT_BYTES = 32 * 1024 * 1024;
const FONT_MIME = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' } as const;
const STORE = 'fonts';

export interface ImportedFontEntry {
  id: string;
  name: string;
  family: string;
  fileName: string;
  format: keyof typeof FONT_MIME;
  mimeType: string;
  data: ArrayBuffer;
  addedAt: number;
}

export type LocalFontDetectionResult = { families: string[]; source: 'desktop' | 'web' | 'canvas' };
type FontFile = File | { name: string; arrayBuffer: () => Promise<ArrayBuffer> };
type FontError = 'unsupportedFormat' | 'invalidSize' | 'importFailed' | 'deleteFailed';

class FontFileError extends Error {
  constructor(readonly code: FontError) {
    super(code);
  }
}

const COMMON_FAMILIES = [
  'Arial', 'Arial Black', 'Arial Rounded MT Bold', 'Bahnschrift', 'Bradley Hand', 'Calibri', 'Cambria',
  'Cascadia Mono', 'Century Gothic', 'Comic Neue', 'Comic Sans MS', 'Consolas', 'Courier New', 'DejaVu Sans',
  'DejaVu Serif', 'Georgia', 'Helvetica', 'Helvetica Neue', 'Impact', 'JetBrains Mono', 'Liberation Sans',
  'Liberation Serif', 'Palatino Linotype', 'Roboto', 'Segoe Print', 'Segoe UI', 'SF Mono', 'Tahoma',
  'Times New Roman', 'Ubuntu', 'Verdana', 'BiauKai', 'DFKai-SB', 'GenJyuuGothic', 'Heiti TC', 'HunInn',
  'jf-openhuninn-2.0', 'Kaiti TC', 'Microsoft JhengHei', 'Microsoft JhengHei UI', 'MingLiU', 'Noto Sans TC',
  'Noto Sans CJK TC', 'Noto Serif TC', 'Noto Sans Mono CJK TC', 'PingFang TC', 'PMingLiU', 'Songti TC',
  'Microsoft YaHei', 'Noto Sans SC', 'Noto Sans CJK SC', 'Noto Serif SC', 'PingFang SC', 'SimHei', 'SimSun',
  'Songti SC', 'STKaiti', 'STSong', 'WenQuanYi Zen Hei', 'YouYuan', 'Hiragino Sans', 'Hiragino Kaku Gothic Std',
  'Hiragino Maru Gothic ProN', 'Hiragino Mincho ProN', 'Klee One', 'Kosugi Maru', 'M PLUS Rounded 1c',
  'Meiryo', 'MS PMincho', 'Noto Sans JP', 'Noto Sans CJK JP', 'Noto Serif JP', 'Yu Gothic', 'Yu Mincho',
];

export function quoteFontFamily(family: string): string {
  return '"' + family.replace(/["\\]/g, '\\$&').replace(/[\n\r\f]/g, (char) => '\\' + char.charCodeAt(0).toString(16) + ' ') + '"';
}

function sortedFamilies(families: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const family of families) {
    const name = family.trim();
    if (name && !unique.has(name.toLowerCase())) unique.set(name.toLowerCase(), name);
  }
  return [...unique.values()].sort((a, b) => a.localeCompare(b));
}

export function probeLocalFonts(
  measureWidth: (font: string, sample: string) => number,
  candidates: readonly string[] = COMMON_FAMILIES,
): string[] {
  const sample = 'mmmmmmmWWWIl1@#$0123繁體漫畫简体汉字かなカナ';
  const baselines = ['monospace', 'sans-serif', 'serif'].map((generic) => ({
    generic, width: measureWidth(`72px ${generic}`, sample),
  }));
  return sortedFamilies(candidates.filter((family) => baselines.some(({ generic, width }) =>
    Math.abs(measureWidth(`72px ${quoteFontFamily(family)}, ${generic}`, sample) - width) > 0.1,
  )));
}

export function filterFontGroups<T extends Pick<ImportedFontEntry, 'name' | 'family' | 'fileName'>, P extends { label: string; id: string }>(
  query: string, groups: { imported: readonly T[]; presets: readonly P[]; local: readonly string[] },
): { imported: T[]; presets: P[]; local: string[] } {
  const keyword = query.trim().toLowerCase();
  const matches = (...fields: string[]) => fields.some((field) => field.toLowerCase().includes(keyword));
  return {
    imported: groups.imported.filter((entry) => matches(entry.name, entry.fileName, entry.family)),
    presets: groups.presets.filter((entry) => matches(entry.label, entry.id)),
    local: groups.local.filter((family) => matches(family)),
  };
}

type FontWindow = Window & {
  atelierDesktop?: { fonts?: { listLocal?: (force?: boolean) => Promise<string[]> } };
  queryLocalFonts?: () => Promise<{ family: string }[]>;
};

async function scanLocalFonts(force: boolean): Promise<LocalFontDetectionResult> {
  const host = typeof window === 'undefined' ? undefined : window as FontWindow;
  try {
    const families = sortedFamilies(await host?.atelierDesktop?.fonts?.listLocal?.(force) ?? []);
    if (families.length) return { families, source: 'desktop' };
  } catch {
    // Continue to browser APIs if the desktop bridge is unavailable.
  }
  try {
    const fonts = await host?.queryLocalFonts?.();
    if (fonts) return { families: sortedFamilies(fonts.map((font) => font.family)), source: 'web' };
  } catch {
    // Permission or browser support can prevent enumeration.
  }
  try {
    const ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    if (ctx) return {
      source: 'canvas',
      families: probeLocalFonts((font, sample) => {
        ctx.font = font;
        return ctx.measureText(sample).width;
      }),
    };
  } catch {
    // Canvas can also be unavailable in restricted environments.
  }
  return { families: [], source: 'canvas' };
}

let database: Promise<IDBDatabase | null> | undefined;

function openDatabase(): Promise<IDBDatabase | null> {
  return database ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const request = indexedDB.open('atelier-font-library', 1);
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) return db.close();
        db.onversionchange = () => { db.close(); database = undefined; };
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => { blocked = true; resolve(null); };
    } catch {
      resolve(null);
    }
  });
}

function fontTransaction<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? new Error('Font transaction aborted'));
  });
}

const loadedFaces = new Map<string, FontFace>();
const listeners = new Set<() => void>();

let state = {
  importedFonts: [] as ImportedFontEntry[],
  localFonts: [] as string[],
  localFontSource: null as LocalFontDetectionResult['source'] | null,
  scanningLocal: false,
  importing: false,
  error: null as FontError | null,
};

function updateState(patch: Partial<typeof state>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function subscribeFontLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const getImportedFonts = () => state.importedFonts;
const getState = () => state;

let localCache: LocalFontDetectionResult | undefined;
let localScan: Promise<LocalFontDetectionResult> | undefined;

export function detectLocalFonts({ force = false }: { force?: boolean } = {}): Promise<LocalFontDetectionResult> {
  if (localScan) return localScan;
  if (localCache && !force) return Promise.resolve(localCache);
  localScan = scanLocalFonts(force).then((result) => {
    localCache = result;
    updateState({ localFonts: result.families, localFontSource: result.source, scanningLocal: false });
    return result;
  }).finally(() => { localScan = undefined; });
  updateState({ scanningLocal: true });
  return localScan;
}

async function loadFace(entry: ImportedFontEntry): Promise<FontFace> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) throw new FontFileError('importFailed');
  return new FontFace(entry.family, entry.data).load();
}

function registerFace(entry: ImportedFontEntry, face: FontFace) {
  document.fonts.add(face);
  loadedFaces.set(entry.id, face);
}

let restoring: Promise<ImportedFontEntry[]> | undefined;
let restored = false;

export function restoreImportedFonts(): Promise<ImportedFontEntry[]> {
  if (restored) return Promise.resolve(getImportedFonts());
  if (restoring) return restoring;
  restoring = (async () => {
    try {
      const db = await openDatabase();
      const entries = db ? await fontTransaction(db, 'readonly', (store) => store.getAll() as IDBRequest<ImportedFontEntry[]>) : [];
      const available: ImportedFontEntry[] = [];
      for (const entry of entries) {
        if (loadedFaces.has(entry.id)) continue;
        try {
          registerFace(entry, await loadFace(entry));
          available.push(entry);
        } catch {
          // An unreadable font must not block the rest of the library.
        }
      }
      restored = true;
      if (available.length) updateState({ importedFonts: [...available, ...getImportedFonts()].sort((a, b) => b.addedAt - a.addedAt) });
    } catch {
      // A later open can retry a failed read transaction.
    }
    return getImportedFonts();
  })().finally(() => { restoring = undefined; });
  return restoring;
}

export async function importFontFile(file: FontFile): Promise<ImportedFontEntry> {
  const dot = file.name.lastIndexOf('.');
  const format = file.name.slice(dot + 1).toLowerCase() as ImportedFontEntry['format'];
  if (dot < 0 || !Object.hasOwn(FONT_MIME, format)) throw new FontFileError('unsupportedFormat');
  if ('size' in file && (file.size === 0 || file.size > MAX_FONT_BYTES)) throw new FontFileError('invalidSize');
  const data = await file.arrayBuffer();
  if (!data.byteLength || data.byteLength > MAX_FONT_BYTES) throw new FontFileError('invalidSize');
  await restoreImportedFonts();
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const entry: ImportedFontEntry = {
    id,
    name: file.name.slice(0, dot).trim() || file.name,
    family: `AtelierImported-${id}`,
    fileName: file.name,
    format,
    mimeType: FONT_MIME[format],
    data,
    addedAt: Date.now(),
  };
  const face = await loadFace(entry);
  const db = await openDatabase();
  if (db) await fontTransaction(db, 'readwrite', (store) => store.put(entry));
  registerFace(entry, face);
  updateState({ importedFonts: [entry, ...getImportedFonts()] });
  return entry;
}

export async function deleteImportedFont(id: string): Promise<void> {
  await restoreImportedFonts();
  const db = await openDatabase();
  if (db) await fontTransaction(db, 'readwrite', (store) => store.delete(id));
  const face = loadedFaces.get(id);
  if (face) {
    document.fonts.delete(face);
    loadedFaces.delete(id);
  }
  const importedFonts = getImportedFonts();
  if (importedFonts.some((entry) => entry.id === id)) updateState({ importedFonts: importedFonts.filter((entry) => entry.id !== id) });
}

let activeImports = 0;

async function importFiles(files: Iterable<FontFile>) {
  activeImports++;
  updateState({ importing: true, error: null });
  let error: FontError | null = null;
  try {
    for (const file of files) {
      try {
        await importFontFile(file);
      } catch (failure) {
        error ??= failure instanceof FontFileError ? failure.code : 'importFailed';
      }
    }
  } finally {
    updateState({ importing: --activeImports > 0, ...(error ? { error } : {}) });
  }
}

async function removeFont(id: string) {
  updateState({ error: null });
  try {
    await deleteImportedFont(id);
  } catch {
    updateState({ error: 'deleteFailed' });
  }
}

const rescanLocalFonts = (options: { force?: boolean } = { force: true }) => detectLocalFonts(options);

export function useFontLibrary() {
  return { ...useSyncExternalStore(subscribeFontLibrary, getState, getState), importFiles, removeFont, rescanLocalFonts };
}
