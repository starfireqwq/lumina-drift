export interface VectorAnchor {
  x: number;
  y: number;
  cp1x?: number; // Incoming Bézier tangent control point
  cp1y?: number;
  cp2x?: number; // Outgoing Bézier tangent control point
  cp2y?: number;
  pressure: number; // 0.0 to 1.0
  width: number;    // Stroke width in px at this anchor
}

export interface VectorBoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface VectorStroke {
  id: string;
  layerId: string;
  color: string;
  opacity: number;
  baseWidth: number;
  anchors: VectorAnchor[];
  bounds: VectorBoundingBox;
  closed?: boolean;
  createdAt: number;
}

export type VectorEraserMode = 'intersect' | 'entire';

export type VectorReshapeMode = 'pinch' | 'anchor_drag';

export type VectorWidthMode = 'thicken' | 'thin';
