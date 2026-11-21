import {
  compressTileBuffer,
  contractSelectionMask,
  decompressTileBuffer,
  expandSelectionMask,
  rasterizeLassoMask,
  type SelectionMaskData,
  type SelectionSnapshot,
} from '@atelier/shared';
import type { SelectionEngine } from '../engine/SelectionEngine';
import {
  applyMaskRectPatch,
  combineSelectionMasks,
  computeMaskBoundsAndCount,
  featherMaskBuffer,
  rasterizeEllipseMask,
  rasterizeRectMask,
  readMaskSubRect,
} from '../engine/selectionMaskOps';
import type { PluginRect } from './pluginApi';
import type { PluginSelectionBridge } from './pluginCanvasBridge';

function toPluginSelectionRect(mask: SelectionMaskData | null): PluginRect | null {
  if (!mask || mask.activePixelCount <= 0) return null;
  const { minX, minY, maxX, maxY } = mask.bounds;
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX + 1),
    height: Math.max(1, maxY - minY + 1),
  };
}

/**
 * Connects PluginCanvasTransaction to the live PixiJS SelectionEngine in CanvasWorkspace.
 */
export function createSelectionEngineBridge(
  engine: SelectionEngine,
  onChanged?: () => void,
): PluginSelectionBridge {
  const notify = () => onChanged?.();

  return {
    getInfo: () => {
      const mask = engine.getMaskData();
      const hasSelection = Boolean(mask && mask.activePixelCount > 0);
      return {
        hasSelection,
        bounds: hasSelection ? toPluginSelectionRect(mask) : null,
      };
    },
    captureSnapshot: () => engine.exportSnapshot(),
    restoreSnapshot: (snapshot) => {
      engine.restoreSnapshot(snapshot);
      notify();
    },
    readMaskRect: (rect) => engine.readMaskRect(rect.x, rect.y, rect.width, rect.height),
    writeMaskRect: (rect, data, mode) => {
      engine.writeMaskRect(rect.x, rect.y, rect.width, rect.height, data, mode);
      notify();
    },
    selectRect: (rect, mode) => {
      engine.selectRect(rect.x, rect.y, rect.width, rect.height, mode);
      notify();
    },
    selectEllipse: (rect, mode) => {
      engine.selectEllipse(rect.x, rect.y, rect.width, rect.height, mode);
      notify();
    },
    selectPolygon: (points, mode) => {
      engine.selectPolygon(points, mode);
      notify();
    },
    clear: () => {
      engine.clearSelection();
      notify();
    },
    invert: () => {
      engine.invertSelection();
      notify();
    },
    expand: (radius) => {
      engine.expandSelection(radius);
      notify();
    },
    contract: (radius) => {
      engine.contractSelection(radius);
      notify();
    },
    feather: (radius) => {
      engine.featherSelection(radius);
      notify();
    },
  };
}

/**
 * Headless SelectionBridge sharing the exact same mask operations as SelectionEngine.
 * Used for deterministic Node.js tests without requiring WebGL / PixiJS.
 */
export function createHeadlessSelectionBridge(canvasWidth: number, canvasHeight: number): PluginSelectionBridge {
  let mask: SelectionMaskData | null = null;

  const commitMask = (next: SelectionMaskData | null) => {
    mask = next && next.activePixelCount > 0 ? next : null;
  };

  return {
    getInfo: () => ({
      hasSelection: Boolean(mask && mask.activePixelCount > 0),
      bounds: toPluginSelectionRect(mask),
    }),
    captureSnapshot: (): SelectionSnapshot | null => {
      if (!mask || mask.activePixelCount <= 0) return null;
      const { minX, minY, maxX, maxY } = mask.bounds;
      const bw = Math.max(1, maxX - minX + 1);
      const bh = Math.max(1, maxY - minY + 1);
      const crop = new Uint8Array(bw * bh);
      for (let y = 0; y < bh; y++) {
        const srcOff = (minY + y) * mask.width + minX;
        crop.set(mask.data.subarray(srcOff, srcOff + bw), y * bw);
      }
      const { compression, data } = compressTileBuffer(crop, 'lz4');
      return {
        width: canvasWidth,
        height: canvasHeight,
        bounds: { ...mask.bounds },
        activePixelCount: mask.activePixelCount,
        compression: compression === 'raw' ? 'raw' : 'lz4',
        data,
      };
    },
    restoreSnapshot: (snap) => {
      if (!snap || snap.activePixelCount <= 0) {
        mask = null;
        return;
      }
      const full = new Uint8Array(canvasWidth * canvasHeight);
      const { minX, minY, maxX, maxY } = snap.bounds;
      const bw = Math.max(1, maxX - minX + 1);
      const bh = Math.max(1, maxY - minY + 1);
      const raw = snap.compression === 'lz4' ? decompressTileBuffer(snap.data, 'lz4', bw * bh) : snap.data;
      const copyW = Math.min(bw, Math.max(0, canvasWidth - minX));
      const copyH = Math.min(bh, Math.max(0, canvasHeight - minY));
      for (let y = 0; y < copyH; y++) {
        full.set(raw.subarray(y * bw, y * bw + copyW), (minY + y) * canvasWidth + minX);
      }
      mask = computeMaskBoundsAndCount(full, canvasWidth, canvasHeight);
    },
    readMaskRect: (rect) => readMaskSubRect(mask, rect.x, rect.y, rect.width, rect.height),
    writeMaskRect: (rect, data, mode) => {
      commitMask(applyMaskRectPatch(mask, canvasWidth, canvasHeight, rect.x, rect.y, rect.width, rect.height, data, mode));
    },
    selectRect: (rect, mode) => {
      const next = rasterizeRectMask(rect.x, rect.y, rect.width, rect.height, canvasWidth, canvasHeight);
      commitMask(combineSelectionMasks(mask, next, mode));
    },
    selectEllipse: (rect, mode) => {
      const next = rasterizeEllipseMask(rect.x, rect.y, rect.width, rect.height, canvasWidth, canvasHeight);
      commitMask(combineSelectionMasks(mask, next, mode));
    },
    selectPolygon: (points, mode) => {
      const next = rasterizeLassoMask(points, canvasWidth, canvasHeight);
      commitMask(combineSelectionMasks(mask, next, mode));
    },
    clear: () => {
      mask = null;
    },
    invert: () => {
      const data = new Uint8Array(canvasWidth * canvasHeight);
      if (!mask || mask.activePixelCount === 0) {
        data.fill(255);
      } else {
        for (let i = 0; i < data.length; i++) data[i] = 255 - mask.data[i];
      }
      commitMask(computeMaskBoundsAndCount(data, canvasWidth, canvasHeight));
    },
    expand: (radius) => {
      if (!mask || mask.activePixelCount === 0) return;
      const expanded = expandSelectionMask(mask.data, canvasWidth, canvasHeight, radius, mask.bounds);
      commitMask(computeMaskBoundsAndCount(expanded, canvasWidth, canvasHeight));
    },
    contract: (radius) => {
      if (!mask || mask.activePixelCount === 0) return;
      const contracted = contractSelectionMask(mask.data, canvasWidth, canvasHeight, radius, mask.bounds);
      commitMask(computeMaskBoundsAndCount(contracted, canvasWidth, canvasHeight));
    },
    feather: (radius) => {
      if (!mask || mask.activePixelCount === 0) return;
      const feathered = featherMaskBuffer(mask.data, canvasWidth, canvasHeight, radius);
      commitMask(computeMaskBoundsAndCount(feathered, canvasWidth, canvasHeight));
    },
  };
}
