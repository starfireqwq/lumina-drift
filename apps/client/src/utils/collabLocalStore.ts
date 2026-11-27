import {
  CanvasGridConfig,
  createDefaultGridConfig,
  createDefaultReferenceBoard,
  normalizeGridConfig,
  normalizeReferenceBoard,
  normalizeRoomSwatches,
  RoomReferenceBoardState,
  RoomSwatch,
} from '@atelier/shared';

export interface LocalCollabSnapshot {
  grid: CanvasGridConfig;
  swatches: RoomSwatch[];
  referenceBoard: RoomReferenceBoardState;
}

const STORAGE_PREFIX = 'atelier_offline_collab_v1_';

export function loadOfflineCollabState(canvasId: string): LocalCollabSnapshot {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${canvasId}`);
    if (!raw) {
      return {
        grid: createDefaultGridConfig(),
        swatches: [],
        referenceBoard: createDefaultReferenceBoard(),
      };
    }
    const parsed = JSON.parse(raw) as Partial<LocalCollabSnapshot>;
    return {
      grid: normalizeGridConfig(parsed.grid),
      swatches: normalizeRoomSwatches(parsed.swatches),
      referenceBoard: normalizeReferenceBoard(parsed.referenceBoard),
    };
  } catch {
    return {
      grid: createDefaultGridConfig(),
      swatches: [],
      referenceBoard: createDefaultReferenceBoard(),
    };
  }
}

export function saveOfflineCollabState(canvasId: string, state: LocalCollabSnapshot): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${canvasId}`, JSON.stringify(state));
  } catch {
    // Ignore quota errors in constrained environments
  }
}

export function getToolDisplayLabel(tool: string | undefined, toolsDict: Record<string, unknown>): string {
  if (!tool) return '';
  const map: Record<string, string> = {
    brush: 'brush',
    pencil: 'pencil',
    eraser: 'eraser',
    bucket: 'bucket',
    fill: 'bucket',
    eyedropper: 'eyedropper',
    hand: 'hand',
    select: 'select',
    select_rect: 'selectRect',
    select_ellipse: 'selectEllipse',
    select_lasso: 'selectLasso',
    select_wand: 'selectWand',
    select_brush: 'selectBrush',
    select_eraser: 'selectEraser',
    lasso: 'selectLasso',
    transform: 'transform',
    liquify: 'liquify',
    blur: 'blur',
    smudge: 'smudge',
    text: 'text',
    vector: 'vector',
    vector_pen: 'vectorPen',
    vector_eraser: 'vectorEraser',
    vector_reshape: 'vectorReshape',
    vector_width: 'vectorWidth',
    ruler: 'ruler',
    quickMask: 'quickMask',
  };
  const key = map[tool] ?? tool;
  const val = toolsDict[key];
  if (typeof val === 'string' && val.trim()) return val;
  return tool;
}

/**
 * Downscales and encodes a dropped/selected reference image File into a compact DataURL
 * suitable for multiplayer Socket.IO synchronization (<= 1024px longest side, WebP/PNG/JPEG).
 */
export async function encodeReferenceFileToDataUrl(
  file: File,
  maxSide = 1024
): Promise<{ dataUrl: string; width: number; height: number }> {
  const bitmapUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode image'));
      el.src = bitmapUrl;
    });
    const natW = Math.max(1, img.naturalWidth || img.width || 256);
    const natH = Math.max(1, img.naturalHeight || img.height || 256);
    const scale = Math.min(1, maxSide / Math.max(natW, natH));
    const outW = Math.max(1, Math.round(natW * scale));
    const outH = Math.max(1, Math.round(natH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    ctx.drawImage(img, 0, 0, outW, outH);
    const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    let dataUrl = canvas.toDataURL(mime, mime === 'image/jpeg' ? 0.86 : undefined);
    if (dataUrl.length > 1_600_000) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.75);
    }
    return { dataUrl, width: outW, height: outH };
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}
