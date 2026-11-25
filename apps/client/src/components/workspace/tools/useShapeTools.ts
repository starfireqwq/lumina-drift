import { useRef, useState } from 'react';
import { FillGradient, Graphics, RenderTexture } from 'pixi.js';
import { getTileBounds, type TileData, type ToolType } from '@atelier/shared';
import { RulerManager } from '../../../engine/RulerManager';
import { calculateGradientTiles, compressTiles } from '../../../engine/commitWorkers';
import type { Rect } from '../../../engine/LayerManager';
import { getWrapAroundBoundsOffsets, getWrappedDirtyTilesForBounds } from '../../../engine/wrapAround';
import { recordUsedColor } from '../../../services/colorHistoryStore';
import type { Point, ToolContext } from './toolContext';
import { commitInOrder, diffTilesAsync } from './asyncTiles';

export const SHAPE_TOOLS: ToolType[] = ['shape', 'shape_rect', 'shape_ellipse', 'shape_line', 'shape_arrow'];

export type ShapeSubtype = 'rect' | 'triangle' | 'diamond' | 'pentagon' | 'star' | 'ellipse' | 'line' | 'arrow';
export const CORNER_RADIUS_SHAPES: readonly ShapeSubtype[] = ['rect', 'triangle', 'diamond', 'pentagon', 'star'];

type PointerLike = { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean };

function shapePolygonPoints(shape: string, x: number, y: number, w: number, h: number): Point[] {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  if (shape === 'triangle') {
    return [{ x: cx, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  }
  if (shape === 'diamond') {
    return [{ x: cx, y }, { x: x + w, y: cy }, { x: cx, y: y + h }, { x, y: cy }];
  }
  if (shape === 'pentagon') {
    return Array.from({ length: 5 }, (_, i) => {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
      return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
    });
  }
  if (shape === 'star') {
    return Array.from({ length: 10 }, (_, i) => {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const k = i % 2 === 0 ? 1 : 0.42;
      return { x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k };
    });
  }
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function traceRoundedPolygon(g: NonNullable<ToolContext['shapeGraphicRef']['current']>, pts: Point[], radius: number) {
  const n = pts.length;
  if (n < 3) return;
  if (radius <= 0) {
    g.poly(pts, true);
    return;
  }
  const starts: Point[] = new Array(n);
  const ends: Point[] = new Array(n);
  const curved: boolean[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const ux = prev.x - curr.x;
    const uy = prev.y - curr.y;
    const vx = next.x - curr.x;
    const vy = next.y - curr.y;
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu < 1e-3 || lv < 1e-3) {
      starts[i] = ends[i] = curr;
      curved[i] = false;
      continue;
    }
    const nux = ux / lu;
    const nuy = uy / lu;
    const nvx = vx / lv;
    const nvy = vy / lv;
    const dot = Math.max(-1, Math.min(1, nux * nvx + nuy * nvy));
    const halfAngle = Math.acos(dot) / 2;
    const tanHalf = Math.tan(halfAngle);
    const offset = tanHalf > 1e-4 ? Math.min(lu * 0.48, lv * 0.48, radius / tanHalf) : 0;
    starts[i] = { x: curr.x + nux * offset, y: curr.y + nuy * offset };
    ends[i] = { x: curr.x + nvx * offset, y: curr.y + nvy * offset };
    curved[i] = offset > 0.25;
  }
  g.beginPath();
  g.moveTo(starts[0].x, starts[0].y);
  for (let i = 0; i < n; i++) {
    if (curved[i]) g.quadraticCurveTo(pts[i].x, pts[i].y, ends[i].x, ends[i].y);
    else g.lineTo(pts[i].x, pts[i].y);
    const nextStart = starts[(i + 1) % n];
    g.lineTo(nextStart.x, nextStart.y);
  }
  g.closePath();
}

/** Shapes (rect / sharp polygons / ellipse / line / arrow) and gradients: drag to preview, release to paint. */
export function useShapeTools(ctx: ToolContext) {
  const [shapeSubtype, setShapeSubtype] = useState<ShapeSubtype>('rect');
  const [shapeFillMode, setShapeFillMode] = useState<'stroke' | 'fill' | 'stroke_and_fill'>('stroke');
  const [shapeLineWidth, setShapeLineWidth] = useState<number>(3);
  const [shapeCornerRadius, setShapeCornerRadius] = useState<number>(0);
  const [gradientMode, setGradientMode] = useState<'fg_to_bg' | 'fg_to_trans'>('fg_to_bg');
  const [gradientType, setGradientType] = useState<'linear' | 'radial'>('linear');

  const shapeStartPos = useRef<Point | null>(null);
  const wrappedShapeRef = useRef<{ graphic: Graphics; bounds: Rect; regions: Rect[] } | null>(null);
  const isDrawingShape = useRef<boolean>(false);
  const gradientStartPos = useRef<Point | null>(null);
  const isDrawingGradient = useRef<boolean>(false);

  const start = (local: Point) => {
    if (ctx.currentTool === 'gradient') {
      gradientStartPos.current = { x: local.x, y: local.y };
      isDrawingGradient.current = true;
    } else {
      shapeStartPos.current = { x: local.x, y: local.y };
      isDrawingShape.current = true;
    }
  };

  /** Shift = 1:1 box / 45° steps, Alt = drawn from the centre */
  const shapeEnds = (e: PointerLike, local: Point, origin: Point) => {
    let dx = local.x - origin.x;
    let dy = local.y - origin.y;
    const { currentTool } = ctx;
    const effectiveShape = currentTool === 'shape' ? shapeSubtype : currentTool.replace('shape_', '');
    if (e.shiftKey) {
      if (effectiveShape === 'line' || effectiveShape === 'arrow') {
        const snap = Math.PI / 4;
        const snappedAngle = Math.round(Math.atan2(dy, dx) / snap) * snap;
        const dist = Math.hypot(dx, dy);
        dx = Math.cos(snappedAngle) * dist;
        dy = Math.sin(snappedAngle) * dist;
      } else {
        const maxD = Math.max(Math.abs(dx), Math.abs(dy));
        dx = maxD * (dx < 0 ? -1 : 1);
        dy = maxD * (dy < 0 ? -1 : 1);
      }
    }
    const startX = e.altKey ? origin.x - dx : origin.x;
    const startY = e.altKey ? origin.y - dy : origin.y;
    return { effectiveShape, startX, startY, endX: origin.x + dx, endY: origin.y + dy };
  };

  /** Live preview while dragging; false when no shape / gradient drag is active. */
  const move = (e: PointerLike, local: Point): boolean => {
    const { shapeGraphicRef, brushProps, currentTool } = ctx;
    const preview = shapeGraphicRef.current;
    if (isDrawingShape.current && shapeStartPos.current && preview) {
      const canvas = ctx.wrapAroundRef.current ? ctx.canvas : null;
      const wrapped = canvas ? ctx.layerManagerRef.current?.getWrapAroundShapePreview() : null;
      const g = wrapped ?? preview;
      const ends = shapeEnds(e, local, shapeStartPos.current);
      preview.clear();
      wrapped?.clear();
      wrappedShapeRef.current = null;
      const hexNum = parseInt(brushProps.color.replace('#', ''), 16) || 0x3b82f6;
      const lineW = currentTool === 'shape' ? shapeLineWidth : Math.max(1, brushProps.size);
      const strokeStyle = { width: lineW, color: hexNum, alpha: brushProps.opacity };
      const shouldFill = currentTool === 'shape' && (shapeFillMode === 'fill' || shapeFillMode === 'stroke_and_fill');
      const shouldStroke = currentTool !== 'shape' || shapeFillMode === 'stroke' || shapeFillMode === 'stroke_and_fill';

      const draw = (dx: number, dy: number) => {
        const { effectiveShape } = ends;
        const startX = ends.startX + dx, startY = ends.startY + dy;
        const endX = ends.endX + dx, endY = ends.endY + dy;
        if (effectiveShape === 'ellipse') {
          g.ellipse((startX + endX) / 2, (startY + endY) / 2, Math.abs(endX - startX) / 2, Math.abs(endY - startY) / 2);
        } else if (effectiveShape === 'line' || effectiveShape === 'arrow') {
          g.beginPath();
          g.moveTo(startX, startY);
          g.lineTo(endX, endY);
          g.stroke(strokeStyle);
          if (effectiveShape !== 'arrow') return;
          const angle = Math.atan2(ends.endY - ends.startY, ends.endX - ends.startX);
          const headLen = Math.max(12, lineW * 2.5);
          const a1 = angle - Math.PI / 6;
          const a2 = angle + Math.PI / 6;
          g.beginPath();
          g.moveTo(endX, endY);
          g.lineTo(endX - headLen * Math.cos(a1), endY - headLen * Math.sin(a1));
          g.moveTo(endX, endY);
          g.lineTo(endX - headLen * Math.cos(a2), endY - headLen * Math.sin(a2));
          g.stroke(strokeStyle);
          return;
        } else {
          const x = Math.min(startX, endX);
          const y = Math.min(startY, endY);
          const w = Math.abs(endX - startX);
          const h = Math.abs(endY - startY);
          if (effectiveShape === 'rect') {
            if (shapeCornerRadius > 0) g.roundRect(x, y, w, h, Math.min(shapeCornerRadius, w / 2, h / 2));
            else g.rect(x, y, w, h);
          } else {
            traceRoundedPolygon(g, shapePolygonPoints(effectiveShape, x, y, w, h), shapeCornerRadius);
          }
        }
        if (shouldFill) g.fill({ color: hexNum, alpha: brushProps.opacity });
        if (shouldStroke) g.stroke(strokeStyle);
      };
      draw(0, 0);
      if (wrapped && canvas) {
        const { x, y, width, height } = g.getLocalBounds();
        const bounds = { x: x - 1, y: y - 1, w: width + 2, h: height + 2 };
        const offsets = getWrapAroundBoundsOffsets(bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h,
          canvas.width, canvas.height);
        if (offsets.length !== 1 || offsets[0].dx || offsets[0].dy) {
          g.clear();
          for (const { dx, dy } of offsets) draw(dx, dy);
        }
        const regions = offsets.map(({ dx, dy }) => ({ ...bounds, x: bounds.x + dx, y: bounds.y + dy }));
        wrappedShapeRef.current = { graphic: g, bounds, regions };
      }
      ctx.requestRender();
      return true;
    }

    const g = preview;
    if (isDrawingGradient.current && gradientStartPos.current && g) {
      g.clear();
      g.beginPath();
      g.moveTo(gradientStartPos.current.x, gradientStartPos.current.y);
      g.lineTo(local.x, local.y);
      g.stroke({ width: 2, color: 0x6366f1, alpha: 0.9 });
      g.circle(gradientStartPos.current.x, gradientStartPos.current.y, 5).fill({ color: 0x6366f1 });
      g.circle(local.x, local.y, 5).fill({ color: 0x38bdf8 });
      ctx.requestRender();
      return true;
    }
    return false;
  };

  /** Paints the shape (the previewed graphic) into the layer as one op and undo step. */
  const finishShape = (e: PointerLike, local: Point): boolean => {
    const { shapeGraphicRef, activeLayer, layerManagerRef, pixiAppRef, tileEngineRef, user, scopedUndoRef, currentTool, brushProps } = ctx;
    if (!isDrawingShape.current || !shapeStartPos.current || !shapeGraphicRef.current || !activeLayer
      || !layerManagerRef.current || !pixiAppRef.current || !tileEngineRef.current) return false;
    move(e, local);
    isDrawingShape.current = false;
    const { effectiveShape, startX, startY, endX, endY } = shapeEnds(e, local, shapeStartPos.current);

    const item = Math.hypot(endX - startX, endY - startY) >= 3 ? layerManagerRef.current.getLayerItem(activeLayer.id) : null;
    if (item) {
      const wrapped = wrappedShapeRef.current;
      const g = wrapped?.graphic ?? shapeGraphicRef.current;
      const { x, y, width, height } = g.getLocalBounds();
      const lm = layerManagerRef.current;
      const layerId = activeLayer.id;
      const renderer = pixiAppRef.current.renderer;
      const canvas = ctx.canvas;
      const bounds = wrapped?.bounds;
      const dirtyCoords = bounds && canvas
        ? getWrappedDirtyTilesForBounds(bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h,
          canvas.width, canvas.height)
        : tileEngineRef.current.getDirtyTilesForBounds(x - 1, y - 1, x + width + 1, y + height + 1);
      const diff = diffTilesAsync(lm, layerId, dirtyCoords, () => {
        const target = lm.drawTarget(layerId);
        if (!target) return;
        if ('draw' in target) target.draw(g, x - 1, y - 1, width + 2, height + 2, wrapped?.regions);
        else renderer.render({ container: g, target, clear: false });
      });
      lm.syncPingPong(layerId);
      const effectiveUserId = ctx.userRef.current?.id || user?.id || 'guest';
      commitInOrder(diff, ({ beforeTiles, afterTiles }) => {
        scopedUndoRef.current.push({
          opId: `op_shape_${Date.now()}`, userId: effectiveUserId, layerId, opType: 'STROKE',
          beforeTiles, afterTiles, timestamp: Date.now(), desc: `繪製形狀 (${effectiveShape})`,
        });
        ctx.updateUndoRedoState();
        ctx.commitOp(layerId, 'STROKE', { tool: currentTool, shapeSubtype: effectiveShape, tiles: afterTiles }, true);
        if (afterTiles.length > 0) recordUsedColor(brushProps.color);
      });
    }
    shapeGraphicRef.current.clear();
    ctx.layerManagerRef.current?.clearWrapAroundShapePreview();
    wrappedShapeRef.current = null;
    shapeStartPos.current = null;
    ctx.requestRender();
    return true;
  };

  /** Paints the gradient tile-by-tile (clipped to selection) without promoting large canvases to resident textures. */
  const finishGradient = (local: Point): boolean => {
    const { shapeGraphicRef, activeLayer, layerManagerRef, tileEngineRef, canvas, brushProps, selectionEngineRef, user, scopedUndoRef } = ctx;
    if (!isDrawingGradient.current || !gradientStartPos.current || !shapeGraphicRef.current || !activeLayer
      || !layerManagerRef.current || !tileEngineRef.current || !canvas) return false;
    isDrawingGradient.current = false;
    const { x: startX, y: startY } = gradientStartPos.current;
    const { x: endX, y: endY } = local;
    const item = Math.hypot(endX - startX, endY - startY) >= 4 ? layerManagerRef.current.getLayerItem(activeLayer.id) : null;
    if (item) {
      const fg = brushProps.color || '#3B82F6';
      const hexToRgba = (hex: string, alpha: number) => {
        let c = hex.replace('#', '');
        if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
        const num = parseInt(c, 16);
        if (isNaN(num)) return `rgba(0,0,0,${alpha})`;
        return `rgba(${(num >> 16) & 255},${(num >> 8) & 255},${num & 255},${alpha})`;
      };
      const bg = gradientMode === 'fg_to_trans' ? hexToRgba(fg, 0) : brushProps.secondaryColor || '#FFFFFF';
      const rulerMgr = RulerManager.getInstance();
      const isSym = rulerMgr.state.mode === 'symmetry';
      const startSyms = isSym ? rulerMgr.getSymmetryPoints({ x: startX, y: startY }) : [{ x: startX, y: startY }];
      const endSyms = isSym ? rulerMgr.getSymmetryPoints({ x: endX, y: endY }) : [{ x: endX, y: endY }];
      const maskData = selectionEngineRef.current?.hasSelection() ? selectionEngineRef.current.getMaskData() : null;
      const te = tileEngineRef.current;
      const lm = layerManagerRef.current;
      const layerId = activeLayer.id;
      const bx0 = maskData ? maskData.bounds.minX : 0;
      const by0 = maskData ? maskData.bounds.minY : 0;
      const bx1 = maskData ? maskData.bounds.maxX + 1 : canvas.width;
      const by1 = maskData ? maskData.bounds.maxY + 1 : canvas.height;
      const dirtyCoords = te.getDirtyTilesForBounds(bx0, by0, bx1, by1);
      const effectiveUserId = ctx.userRef.current?.id || user?.id || 'guest';

      commitInOrder(async () => {
        const stillHere = () => layerManagerRef.current === lm && lm.getLayerItem(layerId) === item;
        if (!stillHere()) return null;
        const opaqueHex = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;
        if (!maskData && !isSym && brushProps.opacity === 1 && opaqueHex.test(fg) && opaqueHex.test(bg)) {
          // An opaque gradient covers the whole layer. Build the new tiles while the
          // existing pixels are read for undo, without cloning them into the workers.
          const empty = new Uint8Array(0);
          const geometry: TileData[] = dirtyCoords.map(({ col, row }) => {
            const { width, height } = getTileBounds(col, row, te.tileSize, canvas.width, canvas.height);
            return { col, row, width, height, compression: 'raw', data: empty, byteLength: 0 };
          });
          const [beforeTiles, afterRaw] = await Promise.all([
            lm.readTilesAsync(layerId, dirtyCoords).then(compressTiles),
            calculateGradientTiles(geometry, {
              rays: [{ start: { x: startX, y: startY }, end: { x: endX, y: endY } }],
              type: gradientType, fg, bg, opacity: 1, tileSize: te.tileSize, canvasWidth: canvas.width, replace: true,
            }),
          ]);
          if (!stillHere()) return null;
          lm.applyTiles(layerId, afterRaw);
          lm.syncPingPong(layerId);
          const afterTiles = await compressTiles(afterRaw);
          return stillHere() ? { beforeTiles, afterTiles } : null;
        }
        if (!maskData && !isSym) {
          const start = { x: startX, y: startY };
          const end = { x: endX, y: endY };
          const stops = [{ offset: 0, color: fg }, { offset: 1, color: bg }];
          const common = { textureSpace: 'global' as const, colorStops: stops };
          const gradient = new FillGradient(gradientType === 'radial'
            ? { ...common, type: 'radial', center: start, outerCenter: start, innerRadius: 0,
                outerRadius: Math.hypot(endX - startX, endY - startY) }
            : { ...common, type: 'linear', start, end, textureSize: 1024 });
          const graphic = new Graphics().rect(0, 0, canvas.width, canvas.height)
            .fill({ fill: gradient, alpha: brushProps.opacity });
          const diff = diffTilesAsync(lm, layerId, dirtyCoords, () => {
            const target = lm.drawTarget(layerId);
            if (target instanceof RenderTexture) ctx.pixiAppRef.current?.renderer.render({ container: graphic, target, clear: false });
            else target?.draw(graphic, 0, 0, canvas.width, canvas.height);
          });
          graphic.destroy();
          gradient.destroy();
          lm.syncPingPong(layerId);
          const result = await diff;
          return stillHere() ? result : null;
        }
        const beforeRaw = await lm.readTilesAsync(layerId, dirtyCoords);
        if (!stillHere()) return null;
        const afterRaw = await calculateGradientTiles(beforeRaw, {
          rays: startSyms.map((start, i) => ({ start, end: endSyms[i] ?? { x: endX, y: endY } })),
          type: gradientType, fg, bg, opacity: brushProps.opacity, tileSize: te.tileSize,
          canvasWidth: canvas.width, mask: maskData?.data,
        });
        if (!stillHere()) return null;
        lm.applyTiles(layerId, afterRaw);
        lm.syncPingPong(layerId);
        const [beforeTiles, afterTiles] = await Promise.all([compressTiles(beforeRaw), compressTiles(afterRaw)]);
        return stillHere() ? { beforeTiles, afterTiles } : null;
      }, (res) => {
        if (!res) return;
        scopedUndoRef.current.push({
          opId: `op_gradient_${Date.now()}`, userId: effectiveUserId, layerId, opType: 'STROKE',
          beforeTiles: res.beforeTiles, afterTiles: res.afterTiles, timestamp: Date.now(), desc: '漸層填色',
        });
        ctx.updateUndoRedoState();
        ctx.commitOp(layerId, 'STROKE', { tool: 'gradient', tiles: res.afterTiles }, true);
        if (res.afterTiles.length > 0) recordUsedColor(fg);
      });
    }
    shapeGraphicRef.current.clear();
    gradientStartPos.current = null;
    ctx.requestRender();
    return true;
  };

  /** Ends a drag; false when no shape / gradient drag was active. */
  const finish = (e: PointerLike, local: Point): boolean => finishShape(e, local) || finishGradient(local);

  /** Drops a drag without painting (multi-touch gesture, canvas switch). */
  const cancel = () => {
    isDrawingShape.current = false;
    isDrawingGradient.current = false;
    ctx.layerManagerRef.current?.clearWrapAroundShapePreview();
    wrappedShapeRef.current = null;
    shapeStartPos.current = null;
    gradientStartPos.current = null;
  };

  return {
    shapeSubtype, setShapeSubtype,
    shapeFillMode, setShapeFillMode,
    shapeLineWidth, setShapeLineWidth,
    shapeCornerRadius, setShapeCornerRadius,
    gradientMode, setGradientMode,
    gradientType, setGradientType,
    start,
    move,
    finish,
    cancel,
  };
}
