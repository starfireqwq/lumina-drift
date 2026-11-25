import { useSyncExternalStore } from 'react';
import {
  clampSubViewZoom,
  DEFAULT_SUB_VIEW_TRANSFORM,
  normalizeSubViewRotation,
  type SubViewTransform,
} from '../utils/subViewMath';

export interface SubViewImageItem {
  id: string;
  name: string;
  objectUrl: string;
  width: number;
  height: number;
  createdAt: number;
  transform: SubViewTransform;
}

export interface SubViewState {
  items: SubViewImageItem[];
  activeIndex: number;
  autoEyedropper: boolean;
  loaded: boolean;
}

interface StoredSubViewImage extends Omit<SubViewImageItem, 'objectUrl'> {
  mimeType: string;
  blob: Blob;
}

const DATABASE_NAME = 'lumina_subview_v1';
const IMAGE_STORE = 'images';
const METADATA_KEY = 'atelier_subview_meta_v1';

let state: SubViewState = { items: [], activeIndex: -1, autoEyedropper: true, loaded: false };
let database: IDBDatabase | undefined;
let ready: Promise<void> | undefined;
let pending: Promise<void> = Promise.resolve();
let autoEyedropperBeforeLoad: boolean | undefined;
const listeners = new Set<() => void>();

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(IMAGE_STORE, { keyPath: 'id' });
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Sub View database upgrade is blocked'));
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

function transact<T>(db: IDBDatabase, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(IMAGE_STORE, mode);
    transaction.onabort = () => reject(transaction.error);
    try {
      const result = operation(transaction.objectStore(IMAGE_STORE));
      transaction.oncomplete = () => resolve(result);
    } catch (error) {
      transaction.abort();
      reject(error);
    }
  });
}

async function persist(write: (store: IDBObjectStore) => void): Promise<void> {
  if (!database) return;
  try {
    await transact(database, 'readwrite', write);
  } catch {
    // Keep the current session usable when a write fails, for example when storage is full.
  }
}

function readMetadata(): { activeId?: string; autoEyedropper?: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(METADATA_KEY) ?? 'null');
    return {
      activeId: typeof saved?.activeId === 'string' ? saved.activeId : undefined,
      autoEyedropper: typeof saved?.autoEyedropper === 'boolean' ? saved.autoEyedropper : undefined,
    };
  } catch {
    return {};
  }
}

function saveMetadata(next: SubViewState): void {
  try {
    localStorage.setItem(METADATA_KEY, JSON.stringify({
      activeId: next.items[next.activeIndex]?.id ?? null,
      autoEyedropper: next.autoEyedropper,
    }));
  } catch {
    // Storage permissions can differ between renderer contexts.
  }
}

function publish(next: SubViewState): void {
  const save = state.loaded && (
    next.items[next.activeIndex]?.id !== state.items[state.activeIndex]?.id ||
    next.autoEyedropper !== state.autoEyedropper
  );
  state = next;
  if (save) saveMetadata(next);
  for (const listener of listeners) listener();
}

function normalizeTransform(transform: SubViewTransform): SubViewTransform {
  return {
    zoom: clampSubViewZoom(transform.zoom ?? DEFAULT_SUB_VIEW_TRANSFORM.zoom),
    panX: Number.isFinite(transform.panX) ? transform.panX : 0,
    panY: Number.isFinite(transform.panY) ? transform.panY : 0,
    rotationDeg: normalizeSubViewRotation(transform.rotationDeg),
    flipH: transform.flipH === true,
  };
}

function toImageItem(record: StoredSubViewImage, objectUrl: string): SubViewImageItem {
  return {
    id: record.id,
    name: record.name,
    objectUrl,
    width: record.width,
    height: record.height,
    createdAt: record.createdAt,
    transform: normalizeTransform({ ...DEFAULT_SUB_VIEW_TRANSFORM, ...record.transform }),
  };
}

async function readImages(): Promise<SubViewImageItem[]> {
  let connection: IDBDatabase | undefined;
  try {
    connection = await openDatabase();
    const db = connection;
    database = db;
    db.onversionchange = () => {
      db.close();
      if (database === db) database = undefined;
    };
    const request = await transact(db, 'readonly', store => store.getAll());
    const records = request.result as StoredSubViewImage[];
    return records.sort((a, b) => a.createdAt - b.createdAt).flatMap(record => {
      try {
        return [toImageItem(record, URL.createObjectURL(record.blob))];
      } catch {
        return [];
      }
    });
  } catch {
    connection?.close();
    database = undefined;
    return [];
  }
}

function load(): Promise<void> {
  ready ??= readImages().then(items => {
    const meta = readMetadata();
    const savedIndex = items.findIndex(item => item.id === meta.activeId);
    const next = {
      items,
      activeIndex: savedIndex >= 0 ? savedIndex : items.length ? 0 : -1,
      autoEyedropper: autoEyedropperBeforeLoad ?? meta.autoEyedropper ?? true,
      loaded: true,
    };
    if (autoEyedropperBeforeLoad !== undefined) saveMetadata(next);
    autoEyedropperBeforeLoad = undefined;
    publish(next);
  });
  return ready;
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(load).then(operation);
  pending = result.then(() => {}, () => {});
  return result;
}

export function getSubViewState(): SubViewState {
  return state;
}

export function subscribeSubView(listener: () => void): () => void {
  listeners.add(listener);
  void load();
  return () => { listeners.delete(listener); };
}

export function useSubViewState(): SubViewState {
  return useSyncExternalStore(subscribeSubView, getSubViewState, getSubViewState);
}

async function prepareImage(blob: File | Blob, name: string | undefined, createdAt: number) {
  let objectUrl: string | undefined;
  try {
    objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Sub View image has no dimensions');

    const record: StoredSubViewImage = {
      id: globalThis.crypto?.randomUUID?.() ?? `subview_${createdAt}_${Math.random().toString(36).slice(2)}`,
      name: name?.trim() || ('name' in blob && blob.name) || 'Image',
      mimeType: blob.type,
      blob,
      width: image.naturalWidth,
      height: image.naturalHeight,
      createdAt,
      transform: { ...DEFAULT_SUB_VIEW_TRANSFORM },
    };
    return { record, item: toImageItem(record, objectUrl) };
  } catch {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return null;
  }
}

export function addSubViewFiles(files: Iterable<File | Blob>, names?: string[]): Promise<number> {
  const inputs = Array.from(files, (file, index) => ({ file, name: names?.[index] }));
  return enqueue(async () => {
    const records: StoredSubViewImage[] = [];
    const added: SubViewImageItem[] = [];
    let createdAt = state.items.at(-1)?.createdAt ?? 0;
    for (const { file, name } of inputs) {
      if (!file.type.startsWith('image/')) continue;
      const entry = await prepareImage(file, name, Math.max(Date.now(), createdAt + 1));
      if (!entry) continue;
      records.push(entry.record);
      added.push(entry.item);
      createdAt = entry.record.createdAt;
    }
    if (!added.length) return 0;

    await persist(store => {
      for (const record of records) store.add(record);
    });
    publish({ ...state, items: [...state.items, ...added], activeIndex: state.items.length });
    return added.length;
  });
}

export function removeSubViewImage(id: string): Promise<void> {
  return enqueue(async () => {
    const index = state.items.findIndex(item => item.id === id);
    if (index < 0) return;
    const removed = state.items[index];
    await persist(store => { store.delete(id); });

    const items = state.items.filter(item => item.id !== id);
    const selected = state.activeIndex - (state.activeIndex > index ? 1 : 0);
    URL.revokeObjectURL(removed.objectUrl);
    publish({ ...state, items, activeIndex: Math.min(selected, items.length - 1) });
  });
}

export function clearSubViewImages(): Promise<void> {
  return enqueue(async () => {
    await persist(store => { store.clear(); });
    if (!state.items.length) return;
    for (const item of state.items) URL.revokeObjectURL(item.objectUrl);
    publish({ ...state, items: [], activeIndex: -1 });
  });
}

export function setSubViewActiveIndex(index: number): void {
  if (!state.items.length || !Number.isFinite(index)) return;
  const activeIndex = Math.max(0, Math.min(Math.trunc(index), state.items.length - 1));
  if (activeIndex !== state.activeIndex) publish({ ...state, activeIndex });
}

export function stepSubViewIndex(delta: number): void {
  const count = state.items.length;
  if (!count || !Number.isFinite(delta)) return;
  const offset = Math.trunc(delta) % count;
  setSubViewActiveIndex((state.activeIndex + offset + count) % count);
}

export function updateActiveSubViewTransform(
  updater: Partial<SubViewTransform> | ((prev: SubViewTransform) => SubViewTransform),
): void {
  const index = state.activeIndex;
  const item = state.items[index];
  if (!item) return;
  const next = typeof updater === 'function' ? updater({ ...item.transform }) : { ...item.transform, ...updater };
  const transform = normalizeTransform(next);
  const previous = item.transform;
  if (
    transform.zoom === previous.zoom && transform.panX === previous.panX && transform.panY === previous.panY &&
    transform.rotationDeg === previous.rotationDeg && transform.flipH === previous.flipH
  ) return;

  const items = state.items.slice();
  items[index] = { ...item, transform };

  void enqueue(() => persist(store => {
    const request = store.get(item.id);
    request.onsuccess = () => {
      const record = request.result as StoredSubViewImage | undefined;
      if (record) store.put({ ...record, transform });
    };
  }));
  publish({ ...state, items });
}

export function resetActiveSubViewTransform(): void {
  updateActiveSubViewTransform(DEFAULT_SUB_VIEW_TRANSFORM);
}

export function setSubViewAutoEyedropper(enabled: boolean): void {
  if (!state.loaded) {
    autoEyedropperBeforeLoad = enabled;
    void load();
  }
  if (enabled !== state.autoEyedropper) publish({ ...state, autoEyedropper: enabled });
}
