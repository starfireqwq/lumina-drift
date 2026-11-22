/**
 * Local-only IndexedDB store for Phase E2 Light Table external reference images.
 * Images stay strictly on this browser/device and are never uploaded to the collaboration server.
 */

const DB_NAME = 'atelier_light_table_assets';
const DB_VERSION = 1;
const STORE_NAME = 'images';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB safety cap

export interface StoredLightTableAsset {
  id: string;
  name: string;
  mimeType: string;
  width: number;
  height: number;
  blob: Blob;
  createdAt: number;
}

const memoryFallback = new Map<string, StoredLightTableAsset>();
const objectUrlCache = new Map<string, string>();

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function readImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth || 512, height: img.naturalHeight || 512 });
      img.onerror = () => reject(new Error('Failed to decode reference image'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function saveLightTableAsset(file: File): Promise<StoredLightTableAsset> {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('Image file exceeds 20MB limit');
  }
  const dims = await readImageDimensions(file);
  const id = `lt_img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const asset: StoredLightTableAsset = {
    id,
    name: file.name || 'Reference',
    mimeType: file.type || 'image/png',
    width: dims.width,
    height: dims.height,
    blob: file,
    createdAt: Date.now(),
  };

  memoryFallback.set(id, asset);
  const db = await openDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(asset);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
  return asset;
}

export async function getLightTableAsset(id: string): Promise<StoredLightTableAsset | null> {
  const mem = memoryFallback.get(id);
  if (mem) return mem;
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => {
        const val = (req.result as StoredLightTableAsset | undefined) ?? null;
        if (val) memoryFallback.set(id, val);
        resolve(val);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function getLightTableAssetUrl(id: string): Promise<string | null> {
  const cached = objectUrlCache.get(id);
  if (cached) return cached;
  const asset = await getLightTableAsset(id);
  if (!asset) return null;
  const url = URL.createObjectURL(asset.blob);
  objectUrlCache.set(id, url);
  return url;
}

export async function deleteLightTableAsset(id: string): Promise<void> {
  memoryFallback.delete(id);
  const cached = objectUrlCache.get(id);
  if (cached) {
    URL.revokeObjectURL(cached);
    objectUrlCache.delete(id);
  }
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
