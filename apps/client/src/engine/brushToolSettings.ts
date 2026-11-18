import { MIN_BRUSH_SPACING, type ToolType } from '@atelier/shared';
import type { BrushProperties } from './BrushRenderer';

/** Each brush tool keeps its own settings (CSP sub-tools): switching tools restores them */
export type BrushToolId = 'brush' | 'pencil' | 'eraser';
export const isBrushTool = (tool: ToolType): tool is BrushToolId => tool === 'brush' || tool === 'pencil' || tool === 'eraser';

const COMMON: Partial<BrushProperties> = {
  size: 24,
  minSize: 0.8,
  opacity: 1,
  flow: 1,
  hardness: 0.8,
  antiAlias: 'medium',
  spacing: MIN_BRUSH_SPACING,
  scatter: 0,
  stabilizerLevel: 0,
  pressureCurve: 'linear',
  customBrushUrl: null,
  colorMixing: 0,
  paintAmount: 0.7,
  colorStretch: 0,
  textureDensity: 0,
  textureScale: 1,
  dualBrush: false,
  dualSize: 0.4,
  dualScatter: 0.6,
  hueJitter: 0,
  satJitter: 0,
  valJitter: 0,
  angleMode: 'direction',
  tipAngle: 0,
  roundness: 1,
  tiltSize: 0,
};

export const BRUSH_TOOL_DEFAULTS: Record<BrushToolId, Partial<BrushProperties>> = {
  brush: { ...COMMON, brushType: 'brush', isEraser: false },
  pencil: { ...COMMON, brushType: 'pencil', isEraser: false, size: 8, hardness: 0.85, flow: 0.85, scatter: 0.04 },
  eraser: { ...COMMON, brushType: 'brush', isEraser: true, eraserMode: 'hard', size: 40 },
};

/** Both eraser modes use a clean round tip. The selected tool's size, opacity and stabilizer still apply. */
export const eraserStrokeProperties = (props: BrushProperties): BrushProperties => ({
  ...props,
  isEraser: true,
  eraserMode: props.eraserMode === 'soft' ? 'soft' : 'hard',
  hardness: props.eraserMode === 'soft' ? 0 : 1,
  flow: 1,
  spacing: MIN_BRUSH_SPACING,
  scatter: 0,
  brushType: 'brush',
  customBrushUrl: null,
  antiAlias: props.antiAlias === 'none' ? 'medium' : props.antiAlias,
  colorMixing: 0,
  textureDensity: 0,
  dualBrush: false,
  hueJitter: 0,
  satJitter: 0,
  valJitter: 0,
  roundness: 1,
  tiltSize: 0,
});

const KEY = 'atelier_brush_tools';
// Per-viewer brush settings: colour belongs to the colour panel, blob: tips do not survive a reload
const strip = (p: Partial<BrushProperties>): Partial<BrushProperties> => {
  const { color: _c, secondaryColor: _s, ...rest } = p;
  if (typeof rest.customBrushUrl === 'string' && rest.customBrushUrl.startsWith('blob:')) rest.customBrushUrl = null;
  return rest;
};

type SavedTools = Partial<Record<BrushToolId, Partial<BrushProperties>>> & { brushDefaultsVersion?: number };

const readAll = (): SavedTools => {
  try {
    const saved: SavedTools = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (saved.brushDefaultsVersion !== 1) {
      const previousDefaults = new Set([0.04, 0.06, 0.08, 0.1, 0.22]);
      for (const tool of ['brush', 'pencil', 'eraser'] as const) {
        if (previousDefaults.has(saved[tool]?.spacing ?? MIN_BRUSH_SPACING)) {
          saved[tool] = { ...saved[tool], spacing: MIN_BRUSH_SPACING };
        }
        if (saved[tool]?.brushType === 'pen' && (saved[tool]?.minSize ?? 1) <= 1) {
          saved[tool] = { ...saved[tool], minSize: 0 };
        }
      }
      saved.brushDefaultsVersion = 1;
      try {
        localStorage.setItem(KEY, JSON.stringify(saved));
      } catch {
        // Apply the new defaults for this session when storage is unavailable.
      }
    }
    return saved;
  } catch {
    return {};
  }
};

// What makes the tool that tool: never taken from saved settings (a brush saved while erasing would erase)
const IDENTITY: Record<BrushToolId, Partial<BrushProperties>> = {
  brush: { isEraser: false },
  pencil: { isEraser: false, brushType: 'pencil' },
  eraser: { isEraser: true },
};

export const loadBrushTool = (tool: BrushToolId): Partial<BrushProperties> => {
  const saved = strip(readAll()[tool] || {});
  if (tool === 'brush' && saved.brushType === 'pencil') saved.brushType = 'brush';
  return { ...BRUSH_TOOL_DEFAULTS[tool], ...saved, ...IDENTITY[tool] };
};

export const saveBrushTool = (tool: BrushToolId, props: Partial<BrushProperties>) => {
  try {
    const cleaned = { ...strip(props), ...IDENTITY[tool] };
    if (tool === 'brush' && cleaned.brushType === 'pencil') cleaned.brushType = 'brush';
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [tool]: cleaned }));
  } catch {
    // storage full or blocked: the settings last for this session only
  }
};
