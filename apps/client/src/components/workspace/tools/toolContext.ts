import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Application, Graphics } from 'pixi.js';
import type { CanvasModel, LayerModel, TileData, ToolType, UserPayload } from '@atelier/shared';
import type { CanvasViewport } from '../../../engine/Viewport';
import type { LayerManager } from '../../../engine/LayerManager';
import type { TileEngine } from '../../../engine/TileEngine';
import type { BrushProperties, BrushRenderer } from '../../../engine/BrushRenderer';
import type { SelectionEngine } from '../../../engine/SelectionEngine';
import type { VectorEngine } from '../../../engine/VectorEngine';
import type { StrokePipeline } from '../../../engine/StrokePipeline';
import type { ScopedUndoManager } from '../../../engine/ScopedUndoManager';

export type Point = { x: number; y: number };
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * What every canvas tool (components/workspace/tools/use*Tool) needs from CanvasWorkspace: the
 * engines of the open canvas (refs, rebuilt per canvas), the live editing state, and the shared
 * commit / undo / notice plumbing. Rebuilt on every render, like the handlers that read it.
 * Tools commit through commitOp / commitTilePatch only (they sync the ping-pong buffer first).
 */
export interface ToolContext {
  canvas: CanvasModel | null;
  layers: LayerModel[];
  activeLayer: LayerModel | null;
  user: UserPayload | null;
  isAdmin: boolean;
  isCanvasViewer?: boolean;
  viewerReadOnlyWarn?: string;
  currentTool: ToolType;
  brushProps: BrushProperties;
  setBrushProps: Dispatch<SetStateAction<BrushProperties>>;

  pixiAppRef: MutableRefObject<Application | null>;
  viewportRef: MutableRefObject<CanvasViewport | null>;
  layerManagerRef: MutableRefObject<LayerManager | null>;
  tileEngineRef: MutableRefObject<TileEngine | null>;
  brushRendererRef: MutableRefObject<BrushRenderer | null>;
  selectionEngineRef: MutableRefObject<SelectionEngine | null>;
  vectorEngineRef: MutableRefObject<VectorEngine | null>;
  strokePipelineRef: MutableRefObject<StrokePipeline | null>;
  /** Shape / gradient / vector-pen preview drawn above the layers */
  shapeGraphicRef: MutableRefObject<Graphics | null>;

  activeLayerRef: MutableRefObject<LayerModel | null>;
  brushPropsRef: MutableRefObject<BrushProperties | null>;
  userRef: MutableRefObject<UserPayload | null>;
  currentToolRef: MutableRefObject<ToolType>;
  scopedUndoRef: MutableRefObject<ScopedUndoManager>;

  updateUndoRedoState: () => void;
  commitOp: (layerId: string, opType: string, payload: unknown, alreadySynced?: boolean) => void;
  commitTilePatch: (layerId: string, tiles: TileData[], isUndo?: boolean, actionDesc?: string, alreadySynced?: boolean) => void;
  refreshLayerThumbnail: (layerId: string) => void;
  canEditPixels: (layer: LayerModel) => boolean;
  /** Short notice over the canvas (permission problems, results) */
  warn: (message: string, ms?: number) => void;
  selectTool: (tool: ToolType) => void;
  requestRender: () => void;
}
