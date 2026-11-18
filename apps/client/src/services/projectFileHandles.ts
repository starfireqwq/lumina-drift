type ProjectHandle = FileSystemFileHandle & {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
};

type SavePicker = (options: {
  id: string;
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<ProjectHandle>;

const handles = new Map<string, ProjectHandle>();
let database: Promise<IDBDatabase> | undefined;

function openHandles() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('LuminaDrift_ProjectFiles', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

async function getHandle(canvasId: string): Promise<ProjectHandle | undefined> {
  if (handles.has(canvasId)) return handles.get(canvasId);
  try {
    const db = await openHandles();
    return await new Promise((resolve, reject) => {
      const request = db.transaction('handles').objectStore('handles').get(canvasId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return undefined;
  }
}

export function getProjectSavePicker() {
  return (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker?.bind(window);
}

export async function pickProjectFile(
  picker: SavePicker,
  canvasId: string,
  filename: string,
  hasPreviousFile: boolean,
) {
  const previous = hasPreviousFile ? await getHandle(canvasId) : undefined;
  const access = { mode: 'readwrite' } as const;
  if (previous && (await previous.queryPermission(access) === 'granted' || await previous.requestPermission(access) === 'granted')) {
    return previous;
  }
  return picker({
    id: 'lumina-project',
    suggestedName: filename,
    types: [{ description: 'Lumina Drift Project', accept: { 'application/x-lumina-drift-project': ['.lumina'] } }],
  });
}

export async function writeProjectFile(canvasId: string, handle: ProjectHandle, blob: Blob) {
  const writer = await handle.createWritable();
  try {
    await writer.write(blob);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
  handles.set(canvasId, handle);
  try {
    const db = await openHandles();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(handle, canvasId);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } catch (error) {
    console.warn('Could not remember Lumina save location across browser sessions:', error);
  }
}
