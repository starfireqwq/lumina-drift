export type TileCompression = 'lz4' | 'webp' | 'png' | 'raw';

export interface TileCoord {
  col: number;
  row: number;
}

export interface TileData {
  col: number;
  row: number;
  width: number;
  height: number;
  compression: TileCompression;
  /**
   * Data payload: Uint8Array for binary compressed/raw RGBA or string for base64/dataURL
   */
  data: Uint8Array | string;
  byteLength?: number;
}

export interface TilePatchPacket {
  type: 'TILE_PATCH';
  canvasId: string;
  layerId: string;
  tiles: TileData[];
  isUndo?: boolean;
  targetOpSeq?: number;
  /** The source edit's pixel changes in tiles where newer paint hides part of the undo/redo. */
  historyTiles?: Array<{ from: TileData; to: TileData }>;
  actionDesc?: string;
  clientSeq?: number;
}

export interface LayerTileSnapshot {
  layerId: string;
  name: string;
  tiles: TileData[];
  vectorStrokes?: any[];
}

export interface CanvasSnapshotBundle {
  canvasId: string;
  seq: number;
  tileSize: number;
  width: number;
  height: number;
  layers: LayerTileSnapshot[];
  createdAt: number;
  /** Marks a snapshot (such as post-resize/crop) as authoritative even when every layer is empty */
  authoritative?: boolean;
}

export interface SelectionSnapshot {
  width: number;
  height: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  activePixelCount: number;
  compression: 'lz4' | 'raw';
  data: Uint8Array;
}

/** A deleted layer as undo needs it; a group also holds what was inside it (bottom first) */
export interface RemovedLayer {
  model: any;
  tiles: TileData[];
  mask?: { model: any; tiles: TileData[] };
  strokes?: any[];
  children?: RemovedLayer[];
}

export interface ScopedUndoOp {
  opId: string;
  userId: string;
  layerId: string;
  opType: string;
  beforeTiles: TileData[];
  afterTiles: TileData[];
  /** Source-over brush pixels rendered onto transparent tiles, including unchanged ink. */
  inkTiles?: TileData[];
  timestamp: number;
  /** Server revision observed before this edit and the revision assigned on commit. */
  baseSeq?: number;
  seq?: number;
  desc?: string;
  vectorStroke?: any;
  vectorRemovedStrokes?: any[];
  /** Strokes a vector edit put in place of vectorRemovedStrokes (erase splits, reshape, node edits) */
  vectorAddedStrokes?: any[];
  /** Layer meta (text source) before / after the op: undo of a text edit restores the editable text too */
  metaBefore?: any;
  metaAfter?: any;
  /** The op made this layer (a new text layer): undo deletes it, redo makes it again */
  layerCreated?: { model: any };
  /** The op removed this layer (merged down or deleted): undo brings it back with its pixels, mask and vectors, redo removes it again */
  layerRemoved?: RemovedLayer & {
    /** The layers right below / above the deleted block when it went (undo puts it back between them) */
    below?: string | null;
    above?: string | null;
  };
  /** Cropped selection mask before / after (selection ops & selection-moving transforms) */
  selectionBefore?: SelectionSnapshot | null;
  selectionAfter?: SelectionSnapshot | null;
  /**
   * Client only: pixels other painters changed after this op, per tile ("col_row", 1 per pixel).
   * Undo / redo of this op keeps them; edits made before the op are never in here.
   */
  foreign?: Map<string, Uint8Array>;
}

export type ToolType =
  | 'select_brush'
  | 'select_eraser'
  | 'brush'
  | 'pencil'
  | 'eraser'
  | 'bucket'
  | 'magic_wand'
  | 'lasso'
  | 'smart_fill'
  | 'shape'
  | 'text'
  | 'comic_balloon'
  | 'comic_panel'
  | 'animation'
  | 'canvas_resize'
  | 'eyedropper'
  | 'shape_rect'
  | 'shape_ellipse'
  | 'shape_line'
  | 'shape_arrow'
  | 'gradient'
  | 'transform'
  | 'mesh_warp'
  | 'liquify'
  | 'blur'
  | 'smudge'
  | 'ruler'
  | 'vector_pen'
  | 'vector_eraser'
  | 'vector_reshape'
  | 'vector_width'
  | 'vector_bezier'
  | 'vector_edit'
  | 'hand'
  | 'color_curves'
  | 'gradient_map';
