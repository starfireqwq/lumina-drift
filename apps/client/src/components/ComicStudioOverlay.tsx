import React, { useEffect, useId, useRef, useState } from 'react';
import { ToolType } from '@atelier/shared';
import {
  Check,
  Columns,
  Grid,
  Maximize2,
  MessageCircle,
  MessageSquare,
  Move,
  Plus,
  RotateCcw,
  Scissors,
  Sparkles,
  Trash2,
  Type,
  X,
  Zap,
} from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import {
  type BalloonGeometryResult,
  type BalloonShape,
  type ComicBalloonItem,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_TAIL_CURVE,
  DEFAULT_TAIL_WIDTH,
  type TextOrientation,
  buildBalloonGeometry,
  buildBalloonRenderPlan,
  clamp,
  commandsToSvgPath,
  layoutBalloonText,
  normalizeAngleDeg,
  parseColorAlpha,
  renderBalloonTextToCanvas,
  renderBalloonToCanvas,
  resolveBalloonTailParams,
} from '../utils/comicBubbleGeometry';

export type { BalloonShape, TextOrientation, ComicBalloonItem };

export interface ComicPanelItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  borderWidth: number;
  borderColor: string;
}

interface ComicStudioOverlayProps {
  currentTool: ToolType;
  canvasWidth: number;
  canvasHeight: number;
  canvasToScreen: (cx: number, cy: number) => { x: number; y: number };
  getCanvasViewCenter: () => { x: number; y: number };
  viewportZoom: number;
  onBakeToLayer: (renderedCanvas: HTMLCanvasElement) => boolean;
  onClose?: () => void;
}

type DragMode =
  | 'move'
  | 'nw'
  | 'ne'
  | 'se'
  | 'sw'
  | 'n'
  | 's'
  | 'w'
  | 'e'
  | 'tail'
  | 'tailBase'
  | 'tailCurve';

function getCanvasBasis(toScreen: (cx: number, cy: number) => { x: number; y: number }) {
  const o = toScreen(0, 0);
  const ex = toScreen(1, 0);
  const ey = toScreen(0, 1);
  const ux = ex.x - o.x;
  const uy = ex.y - o.y;
  const vx = ey.x - o.x;
  const vy = ey.y - o.y;
  const det = ux * vy - vx * uy;
  return { ux, uy, vx, vy, det };
}

function colorToHex6(color: string | undefined, fallback = '#ffffff'): string {
  if (!color) return fallback;
  const s = color.trim().toLowerCase();
  if (s === 'transparent' || s === 'none') return fallback;
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    }
    if (hex.length >= 6) {
      return `#${hex.slice(0, 6)}`;
    }
  }
  const match = s.match(/^rgba?\(\s*([^)]+)\s*\)$/);
  if (match) {
    const inner = match[1].split('/')[0].trim();
    const parts = inner.includes(',') ? inner.split(',').map((p) => p.trim()) : inner.split(/\s+/);
    if (parts.length >= 3) {
      const toHex = (v: string) =>
        clamp(Math.round(parseFloat(v) || 0), 0, 255)
          .toString(16)
          .padStart(2, '0');
      return `#${toHex(parts[0])}${toHex(parts[1])}${toHex(parts[2])}`;
    }
  }
  return fallback;
}

function applyAlphaToColor(color: string, alpha01: number): string {
  const a = clamp(Math.round(alpha01 * 100) / 100, 0, 1);
  if (a <= 0.001) return 'transparent';
  const hex6 = colorToHex6(color, '#ffffff');
  if (a >= 0.999) return hex6.toUpperCase();
  const r = parseInt(hex6.slice(1, 3), 16);
  const g = parseInt(hex6.slice(3, 5), 16);
  const b = parseInt(hex6.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

let cachedMeasureCtx: CanvasRenderingContext2D | null = null;
function measureBrowserTextWidth(text: string, font: string): number {
  if (typeof document === 'undefined') return text.length * 10;
  if (!cachedMeasureCtx) {
    const c = document.createElement('canvas');
    cachedMeasureCtx = c.getContext('2d');
  }
  if (!cachedMeasureCtx) return text.length * 10;
  cachedMeasureCtx.font = font;
  return cachedMeasureCtx.measureText(text).width;
}

export const ComicStudioOverlay: React.FC<ComicStudioOverlayProps> = ({
  currentTool,
  canvasWidth,
  canvasHeight,
  canvasToScreen,
  getCanvasViewCenter,
  viewportZoom,
  onBakeToLayer,
  onClose,
}) => {
  const { t } = useI18n();
  const maskIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, '_');
  const canvasToScreenRef = useRef(canvasToScreen);
  canvasToScreenRef.current = canvasToScreen;

  const isPanelActive = currentTool === 'comic_panel';
  const isBalloonActive = currentTool === 'comic_balloon';
  // Text is a text layer of its own now (the text tool in CanvasWorkspace), not part of this overlay
  const isTextActive = false;
  const isActive = isPanelActive || isBalloonActive;

  // Comic Panels state
  // Starts empty: pick a layout or draw panels (the demo frames used to appear on every canvas)
  const [panels, setPanels] = useState<ComicPanelItem[]>([]);

  const [activePanelId, setActivePanelId] = useState<string | null>(null);

  // Balloons & Text Items
  const [balloons, setBalloons] = useState<ComicBalloonItem[]>([]);

  const [activeBalloonId, setActiveBalloonId] = useState<string | null>(null);
  const [editingBalloonId, setEditingBalloonId] = useState<string | null>(null);
  const [activeLayout, setActiveLayout] = useState<string>('');

  useEffect(() => {
    if (!isBalloonActive) {
      setEditingBalloonId(null);
    }
  }, [isBalloonActive]);

  // Dragging and Resizing Ref for balloons
  const dragRef = useRef<{
    mode: DragMode;
    balloonId: string;
    startScreen: { x: number; y: number };
    origBalloon: ComicBalloonItem;
    origGeom: BalloonGeometryResult;
    moved: boolean;
  } | null>(null);

  // Dragging and Resizing Ref for panels
  const panelDragRef = useRef<{
    mode: DragMode;
    panelId: string;
    startScreen: { x: number; y: number };
    origPanel: ComicPanelItem;
  } | null>(null);

  // Layout Presets
  const handleApplyLayout = (type: '4koma' | '2h' | '2v' | '3koma' | '6grid' | 'full') => {
    setActiveLayout(type);
    const margin = 80;
    const gutter = 24;
    const totalW = canvasWidth - margin * 2;
    const totalH = canvasHeight - margin * 2;
    const newPanels: ComicPanelItem[] = [];

    if (type === '4koma') {
      const panelH = Math.floor((totalH - gutter * 3) / 4);
      for (let i = 0; i < 4; i++) {
        newPanels.push({
          id: `koma_${i + 1}`,
          x: margin,
          y: margin + i * (panelH + gutter),
          width: totalW,
          height: panelH,
          borderWidth: 4,
          borderColor: '#000000',
        });
      }
    } else if (type === '2h') {
      const panelH = Math.floor((totalH - gutter) / 2);
      newPanels.push(
        { id: '2h_1', x: margin, y: margin, width: totalW, height: panelH, borderWidth: 4, borderColor: '#000000' },
        { id: '2h_2', x: margin, y: margin + panelH + gutter, width: totalW, height: panelH, borderWidth: 4, borderColor: '#000000' }
      );
    } else if (type === '2v') {
      const panelW = Math.floor((totalW - gutter) / 2);
      newPanels.push(
        { id: '2v_1', x: margin, y: margin, width: panelW, height: totalH, borderWidth: 4, borderColor: '#000000' },
        { id: '2v_2', x: margin + panelW + gutter, y: margin, width: panelW, height: totalH, borderWidth: 4, borderColor: '#000000' }
      );
    } else if (type === '3koma') {
      const topH = Math.floor(totalH * 0.45);
      const btmH = totalH - topH - gutter;
      const btmW = Math.floor((totalW - gutter) / 2);
      newPanels.push(
        { id: '3k_1', x: margin, y: margin, width: totalW, height: topH, borderWidth: 4, borderColor: '#000000' },
        { id: '3k_2', x: margin, y: margin + topH + gutter, width: btmW, height: btmH, borderWidth: 4, borderColor: '#000000' },
        { id: '3k_3', x: margin + btmW + gutter, y: margin + topH + gutter, width: btmW, height: btmH, borderWidth: 4, borderColor: '#000000' }
      );
    } else if (type === '6grid') {
      const panelW = Math.floor((totalW - gutter) / 2);
      const panelH = Math.floor((totalH - gutter * 2) / 3);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 2; c++) {
          newPanels.push({
            id: `6g_${r}_${c}`,
            x: margin + c * (panelW + gutter),
            y: margin + r * (panelH + gutter),
            width: panelW,
            height: panelH,
            borderWidth: 4,
            borderColor: '#000000',
          });
        }
      }
    } else if (type === 'full') {
      newPanels.push({
        id: 'full_1',
        x: margin,
        y: margin,
        width: totalW,
        height: totalH,
        borderWidth: 5,
        borderColor: '#000000',
      });
    }

    setPanels(newPanels);
  };

  // Add new Balloon
  const handleAddBalloon = (shape: BalloonShape = 'oval') => {
    const center = getCanvasViewCenter();
    const width = shape === 'spiky' ? 220 : 200;
    const height = shape === 'rect' ? 180 : shape === 'spiky' || shape === 'thought' ? 140 : 110;
    const id = `balloon_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newB: ComicBalloonItem = {
      id,
      x: Math.max(50, center.x - width / 2),
      y: Math.max(0, center.y - height / 2),
      width,
      height,
      shape,
      cornerRadius: shape === 'rect' ? 12 : 0,
      tailPos: { x: -50, y: Math.round(height / 2 + 45) },
      tailEnabled: true,
      tailBaseAngle: undefined,
      tailWidth: DEFAULT_TAIL_WIDTH,
      tailCurve: DEFAULT_TAIL_CURVE,
      lineHeight: DEFAULT_LINE_HEIGHT,
      shapeSeed: id,
      bgColor: '#FFFFFF',
      borderColor: '#000000',
      borderWidth: 3,
      text: '在這裡輸入對白...',
      fontSize: 18,
      fontColor: '#000000',
      fontFamily: 'sans-serif',
      orientation: 'horizontal',
      strokeColor: '#FFFFFF',
      strokeWidth: 0,
    };
    setBalloons((prev) => [...prev, newB]);
    setActiveBalloonId(newB.id);
    setEditingBalloonId(null);
  };

  // Add pure text item
  const handleAddPureText = () => {
    const center = getCanvasViewCenter();
    const newT: ComicBalloonItem = {
      id: `text_${Date.now()}`,
      x: Math.max(50, center.x - 80),
      y: Math.max(50, center.y - 40),
      width: 180,
      height: 60,
      shape: 'rect',
      tailPos: { x: 0, y: 0 },
      tailEnabled: false,
      bgColor: 'transparent',
      borderColor: 'transparent',
      borderWidth: 0,
      text: '雙擊編輯文字',
      fontSize: 28,
      fontColor: '#FFFFFF',
      fontFamily: 'sans-serif',
      orientation: 'horizontal',
      strokeColor: '#000000',
      strokeWidth: 4,
    };
    setBalloons((prev) => [...prev, newT]);
    setActiveBalloonId(newT.id);
  };

  const handleDeleteActiveBalloon = () => {
    if (!activeBalloonId) return;
    setBalloons((prev) => prev.filter((b) => b.id !== activeBalloonId));
    setEditingBalloonId((cur) => (cur === activeBalloonId ? null : cur));
    setActiveBalloonId(null);
  };

  const updateBalloon = (balloonId: string, patch: Partial<ComicBalloonItem>) => {
    setBalloons((prev) => prev.map((b) => (b.id === balloonId ? { ...b, ...patch } : b)));
  };

  const handleAddPanel = () => {
    const center = getCanvasViewCenter();
    const newP: ComicPanelItem = {
      id: `panel_${Date.now()}`,
      x: Math.max(50, Math.round(center.x - 220)),
      y: Math.max(50, Math.round(center.y - 160)),
      width: 440,
      height: 320,
      borderWidth: 4,
      borderColor: '#000000',
    };
    setPanels((prev) => [...prev, newP]);
    setActivePanelId(newP.id);
  };

  const handleDeleteActivePanel = () => {
    if (!activePanelId) return;
    setPanels((prev) => prev.filter((p) => p.id !== activePanelId));
    setActivePanelId(null);
  };

  const handleUpdateActivePanelBorder = (delta: number) => {
    if (!activePanelId) return;
    setPanels((prev) =>
      prev.map((p) => (p.id === activePanelId ? { ...p, borderWidth: Math.max(1, Math.min(16, p.borderWidth + delta)) } : p))
    );
  };

  // Dragging event listeners on window
  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      // 1. Panel dragging / resizing
      if (panelDragRef.current) {
        const { mode, panelId, startScreen, origPanel } = panelDragRef.current;
        const dx = (e.clientX - startScreen.x) / viewportZoom;
        const dy = (e.clientY - startScreen.y) / viewportZoom;

        setPanels((prev) =>
          prev.map((p) => {
            if (p.id !== panelId) return p;
            if (mode === 'move') {
              return {
                ...p,
                x: Math.round(origPanel.x + dx),
                y: Math.round(origPanel.y + dy),
              };
            }
            if (mode === 'se') {
              return {
                ...p,
                width: Math.max(60, Math.round(origPanel.width + dx)),
                height: Math.max(40, Math.round(origPanel.height + dy)),
              };
            }
            if (mode === 'sw') {
              const newW = Math.max(60, Math.round(origPanel.width - dx));
              return {
                ...p,
                x: Math.round(origPanel.x + (origPanel.width - newW)),
                width: newW,
                height: Math.max(40, Math.round(origPanel.height + dy)),
              };
            }
            if (mode === 'ne') {
              const newH = Math.max(40, Math.round(origPanel.height - dy));
              return {
                ...p,
                y: Math.round(origPanel.y + (origPanel.height - newH)),
                width: Math.max(60, Math.round(origPanel.width + dx)),
                height: newH,
              };
            }
            if (mode === 'nw') {
              const newW = Math.max(60, Math.round(origPanel.width - dx));
              const newH = Math.max(40, Math.round(origPanel.height - dy));
              return {
                ...p,
                x: Math.round(origPanel.x + (origPanel.width - newW)),
                y: Math.round(origPanel.y + (origPanel.height - newH)),
                width: newW,
                height: newH,
              };
            }
            if (mode === 'e') {
              return { ...p, width: Math.max(60, Math.round(origPanel.width + dx)) };
            }
            if (mode === 'w') {
              const newW = Math.max(60, Math.round(origPanel.width - dx));
              return { ...p, x: Math.round(origPanel.x + (origPanel.width - newW)), width: newW };
            }
            if (mode === 's') {
              return { ...p, height: Math.max(40, Math.round(origPanel.height + dy)) };
            }
            if (mode === 'n') {
              const newH = Math.max(40, Math.round(origPanel.height - dy));
              return { ...p, y: Math.round(origPanel.y + (origPanel.height - newH)), height: newH };
            }
            return p;
          })
        );
        return;
      }

      // 2. Balloon dragging / resizing (using canvasToScreen inverse matrix for zoom/pan/rotation/mirror)
      if (!dragRef.current) return;
      const { mode, balloonId, startScreen, origBalloon, origGeom } = dragRef.current;
      const dsx = e.clientX - startScreen.x;
      const dsy = e.clientY - startScreen.y;
      if (Math.hypot(dsx, dsy) > 3) {
        dragRef.current.moved = true;
      }

      const { ux, uy, vx, vy, det } = getCanvasBasis(canvasToScreenRef.current);
      const dx = Math.abs(det) > 1e-8 ? (dsx * vy - dsy * vx) / det : dsx / viewportZoom;
      const dy = Math.abs(det) > 1e-8 ? (ux * dsy - uy * dsx) / det : dsy / viewportZoom;

      setBalloons((prev) =>
        prev.map((b) => {
          if (b.id !== balloonId) return b;
          if (mode === 'move') {
            return {
              ...b,
              x: Math.round(origBalloon.x + dx),
              y: Math.round(origBalloon.y + dy),
            };
          }
          if (mode === 'tail') {
            return {
              ...b,
              tailPos: {
                x: Math.round(origBalloon.tailPos.x + dx),
                y: Math.round(origBalloon.tailPos.y + dy),
              },
            };
          }
          if (mode === 'tailBase') {
            const targetX = origGeom.tailLocal.baseCenter.x + dx;
            const targetY = origGeom.tailLocal.baseCenter.y + dy;
            if (Math.hypot(targetX, targetY) <= 2) return b;
            const rx = Math.max(10, origBalloon.width * 0.5);
            const ry = Math.max(10, origBalloon.height * 0.5);
            const angleDeg = Math.round(
              normalizeAngleDeg((Math.atan2(targetY / ry, targetX / rx) * 180) / Math.PI)
            ) % 360;
            return {
              ...b,
              tailBaseAngle: angleDeg,
            };
          }
          if (mode === 'tailCurve') {
            const baseMid = {
              x: (origGeom.tailLocal.baseLeft.x + origGeom.tailLocal.baseRight.x) * 0.5,
              y: (origGeom.tailLocal.baseLeft.y + origGeom.tailLocal.baseRight.y) * 0.5,
            };
            const tip = origBalloon.tailPos;
            const chordDx = tip.x - baseMid.x;
            const chordDy = tip.y - baseMid.y;
            const L = Math.hypot(chordDx, chordDy);
            if (L < 1e-3) return b;
            const uX = chordDx / L;
            const uY = chordDy / L;
            const nX = -uY;
            const nY = uX;
            const midX = (baseMid.x + tip.x) * 0.5;
            const midY = (baseMid.y + tip.y) * 0.5;
            const maxBend = Math.max(1e-3, origGeom.tailLocal.maxBend);
            const px = origGeom.tailLocal.curveHandle.x + dx;
            const py = origGeom.tailLocal.curveHandle.y + dy;
            const signedDist = (px - midX) * nX + (py - midY) * nY;
            const raw = clamp(signedDist / maxBend, -1, 1);
            const tailCurve = Math.abs(raw) < 0.05 ? 0 : Math.round(raw * 100) / 100;
            return {
              ...b,
              tailCurve,
            };
          }
          if (mode === 'se') {
            return {
              ...b,
              width: Math.max(60, Math.round(origBalloon.width + dx)),
              height: Math.max(40, Math.round(origBalloon.height + dy)),
            };
          }
          if (mode === 'sw') {
            const newW = Math.max(60, Math.round(origBalloon.width - dx));
            return {
              ...b,
              x: Math.round(origBalloon.x + (origBalloon.width - newW)),
              width: newW,
              height: Math.max(40, Math.round(origBalloon.height + dy)),
            };
          }
          if (mode === 'ne') {
            const newH = Math.max(40, Math.round(origBalloon.height - dy));
            return {
              ...b,
              y: Math.round(origBalloon.y + (origBalloon.height - newH)),
              width: Math.max(60, Math.round(origBalloon.width + dx)),
              height: newH,
            };
          }
          if (mode === 'nw') {
            const newW = Math.max(60, Math.round(origBalloon.width - dx));
            const newH = Math.max(40, Math.round(origBalloon.height - dy));
            return {
              ...b,
              x: Math.round(origBalloon.x + (origBalloon.width - newW)),
              y: Math.round(origBalloon.y + (origBalloon.height - newH)),
              width: newW,
              height: newH,
            };
          }
          return b;
        })
      );
    };

    const handlePointerUp = () => {
      if (dragRef.current?.moved) {
        lastDragMovedAtRef.current = Date.now();
      }
      dragRef.current = null;
      panelDragRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [viewportZoom]);

  const lastDragMovedAtRef = useRef(0);

  const startPanelDrag = (
    mode: DragMode,
    panel: ComicPanelItem,
    e: React.PointerEvent
  ) => {
    e.stopPropagation();
    setActivePanelId(panel.id);
    panelDragRef.current = {
      mode,
      panelId: panel.id,
      startScreen: { x: e.clientX, y: e.clientY },
      origPanel: { ...panel },
    };
  };

  const startDrag = (
    mode: DragMode,
    balloon: ComicBalloonItem,
    e: React.PointerEvent
  ) => {
    e.stopPropagation();
    setActiveBalloonId(balloon.id);
    if (editingBalloonId && editingBalloonId !== balloon.id) {
      setEditingBalloonId(null);
    }
    dragRef.current = {
      mode,
      balloonId: balloon.id,
      startScreen: { x: e.clientX, y: e.clientY },
      origBalloon: { ...balloon, tailPos: { ...balloon.tailPos } },
      origGeom: buildBalloonGeometry(balloon),
      moved: false,
    };
  };

  // Bake all comic layout & balloons onto current layer
  const handleBakeAll = () => {
    setEditingBalloonId(null);
    const bakeCanvas = document.createElement('canvas');
    bakeCanvas.width = canvasWidth;
    bakeCanvas.height = canvasHeight;
    const ctx = bakeCanvas.getContext('2d');
    if (!ctx) return;

    // Only what this tool shows: the text / balloon tools used to stamp the (demo) panel frames too
    // 1. Draw comic panels
    if (isPanelActive) {
      for (const p of panels) {
        ctx.strokeStyle = p.borderColor;
        ctx.lineWidth = p.borderWidth;
        ctx.strokeRect(p.x, p.y, p.width, p.height);
      }
    }

    // 2. Draw balloons & texts via shared dual-layer / seamless transparency geometry engine
    const measureText = (text: string, font: string) => {
      ctx.save();
      ctx.font = font;
      const width = ctx.measureText(text).width;
      ctx.restore();
      return width;
    };

    for (const b of isPanelActive ? [] : balloons) {
      renderBalloonToCanvas(ctx, b);
      renderBalloonTextToCanvas(ctx, b, measureText);
    }

    if (onBakeToLayer(bakeCanvas)) onClose?.();
  };

  if (!isActive) return null;

  const currentBalloon = balloons.find((b) => b.id === activeBalloonId);

  return (
    <div className="absolute inset-0 pointer-events-none z-30 select-none overflow-hidden">
      {/* 1. Comic Panels Overlay (what is shown is what gets baked) */}
      {isPanelActive && panels.map((p, idx) => {
        const screenPos = canvasToScreen(p.x, p.y);
        const screenW = p.width * viewportZoom;
        const screenH = p.height * viewportZoom;
        const isSelected = isPanelActive && activePanelId === p.id;

        return (
          <div
            key={p.id}
            onPointerDown={(e) => isPanelActive && startPanelDrag('move', p, e)}
            style={{
              transform: `translate(${screenPos.x}px, ${screenPos.y}px)`,
              width: `${screenW}px`,
              height: `${screenH}px`,
              borderWidth: `${Math.max(1, p.borderWidth * viewportZoom)}px`,
              borderColor: isSelected ? '#6366F1' : p.borderColor,
            }}
            className={`absolute border-solid pointer-events-auto transition-shadow ${
              isPanelActive ? 'cursor-move' : ''
            } ${
              isSelected ? 'ring-2 ring-indigo-500/80 shadow-lg shadow-indigo-500/20' : 'shadow-sm'
            }`}
          >
            {/* Selection badge & move indicator */}
            {isSelected && (
              <div className="absolute top-2 left-2 bg-indigo-600/90 text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow pointer-events-none flex items-center gap-1 backdrop-blur-sm">
                <Move className="w-2.5 h-2.5" />
                <span>分鏡 #{idx + 1} ({Math.round(p.width)}x{Math.round(p.height)})</span>
              </div>
            )}

            {/* 8 Resize Handles (when panel is selected in panel tool mode) */}
            {isSelected && (
              <>
                {/* Corners */}
                <div
                  onPointerDown={(e) => startPanelDrag('nw', p, e)}
                  className="absolute -top-2 -left-2 w-4 h-4 bg-white border-2 border-indigo-600 rounded-sm cursor-nwse-resize shadow-md hover:scale-125 transition-transform z-10"
                  title="調整左上角"
                />
                <div
                  onPointerDown={(e) => startPanelDrag('ne', p, e)}
                  className="absolute -top-2 -right-2 w-4 h-4 bg-white border-2 border-indigo-600 rounded-sm cursor-nesw-resize shadow-md hover:scale-125 transition-transform z-10"
                  title="調整右上角"
                />
                <div
                  onPointerDown={(e) => startPanelDrag('se', p, e)}
                  className="absolute -bottom-2 -right-2 w-4 h-4 bg-white border-2 border-indigo-600 rounded-sm cursor-nwse-resize shadow-md hover:scale-125 transition-transform z-10"
                  title="調整右下角"
                />
                <div
                  onPointerDown={(e) => startPanelDrag('sw', p, e)}
                  className="absolute -bottom-2 -left-2 w-4 h-4 bg-white border-2 border-indigo-600 rounded-sm cursor-nesw-resize shadow-md hover:scale-125 transition-transform z-10"
                  title="調整左下角"
                />

                {/* Edges */}
                <div
                  onPointerDown={(e) => startPanelDrag('n', p, e)}
                  className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-5 h-3 bg-white border-2 border-indigo-600 rounded-sm cursor-ns-resize shadow-md hover:scale-125 transition-transform z-10"
                  title="調整頂邊"
                />
                <div
                  onPointerDown={(e) => startPanelDrag('s', p, e)}
                  className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-5 h-3 bg-white border-2 border-indigo-600 rounded-sm cursor-ns-resize shadow-md hover:scale-125 transition-transform z-10"
                  title="調整底邊"
                />
                <div
                  onPointerDown={(e) => startPanelDrag('w', p, e)}
                  className="absolute top-1/2 -left-1.5 -translate-y-1/2 w-3 h-5 bg-white border-2 border-indigo-600 rounded-sm cursor-ew-resize shadow-md hover:scale-125 transition-transform z-10"
                  title="調整左邊"
                />
                <div
                  onPointerDown={(e) => startPanelDrag('e', p, e)}
                  className="absolute top-1/2 -right-1.5 -translate-y-1/2 w-3 h-5 bg-white border-2 border-indigo-600 rounded-sm cursor-ew-resize shadow-md hover:scale-125 transition-transform z-10"
                  title="調整右邊"
                />
              </>
            )}
          </div>
        );
      })}

      {/* 2. Comic Balloons & Vector Text Overlay (WYSIWYG SVG matching bake pipeline) */}
      {!isPanelActive &&
        (() => {
          const basis = getCanvasBasis(canvasToScreen);
          const hasValidBasis = Math.abs(basis.det) > 1e-8;
          const mA = hasValidBasis ? basis.ux : viewportZoom;
          const mB = hasValidBasis ? basis.uy : 0;
          const mC = hasValidBasis ? basis.vx : 0;
          const mD = hasValidBasis ? basis.vy : viewportZoom;

          return balloons.map((b) => {
            const screenPos = canvasToScreen(b.x, b.y);
            const isSelected = activeBalloonId === b.id;
            const isEditing = editingBalloonId === b.id;
            const plan = buildBalloonRenderPlan(b);
            const geom = plan.geometry;
            const textLayout = layoutBalloonText(b, measureBrowserTextWidth);
            const safeBox = geom.safeTextBounds;
            const maskId = `comic_balloon_mask_${maskIdPrefix}_${b.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            const maskPad = 24;
            const maskX = geom.bounds.x - maskPad;
            const maskY = geom.bounds.y - maskPad;
            const maskW = geom.bounds.width + maskPad * 2;
            const maskH = geom.bounds.height + maskPad * 2;

            const nwPt = canvasToScreen(b.x, b.y);
            const nePt = canvasToScreen(b.x + b.width, b.y);
            const sePt = canvasToScreen(b.x + b.width, b.y + b.height);
            const swPt = canvasToScreen(b.x, b.y + b.height);
            const tailTipPt = canvasToScreen(geom.tailTip.x, geom.tailTip.y);
            const tailBasePt = canvasToScreen(geom.tailBaseCenter.x, geom.tailBaseCenter.y);
            const tailCurvePt = canvasToScreen(geom.tailCurveHandle.x, geom.tailCurveHandle.y);
            const showCurveHandle = b.tailEnabled && !geom.tailSuppressed && geom.tailLocal.chordLength >= 28;

            return (
              <React.Fragment key={b.id}>
                {/* Pure WYSIWYG Balloon Body + Tail + Text (zero selection overrides) */}
                <div
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setActiveBalloonId(b.id);
                    setEditingBalloonId(b.id);
                  }}
                  style={{
                    transform: `translate(${screenPos.x}px, ${screenPos.y}px) matrix(${mA}, ${mB}, ${mC}, ${mD}, 0, 0)`,
                    transformOrigin: '0 0',
                    width: `${b.width}px`,
                    height: `${b.height}px`,
                  }}
                  className="absolute top-0 left-0 pointer-events-none"
                >
                  <svg
                    className="absolute inset-0 h-full w-full overflow-visible pointer-events-none"
                    viewBox={`${b.x} ${b.y} ${b.width} ${b.height}`}
                  >
                    {plan.mode === 'isolated-alpha' && plan.hasBorder && (
                      <defs>
                        <mask
                          id={maskId}
                          maskUnits="userSpaceOnUse"
                          x={maskX}
                          y={maskY}
                          width={maskW}
                          height={maskH}
                        >
                          <rect x={maskX} y={maskY} width={maskW} height={maskH} fill="white" />
                          {plan.punchOuts.map((cmds, idx) => (
                            <path key={idx} d={commandsToSvgPath(cmds)} fill="black" />
                          ))}
                        </mask>
                      </defs>
                    )}

                    {plan.mode === 'opaque-dual-layer' ? (
                      <>
                        {plan.hasBorder && (
                          <g
                            pointerEvents="visiblePainted"
                            className="cursor-move"
                            onPointerDown={(e) => startDrag('move', b, e)}
                          >
                            {plan.strokes.map((s, idx) => (
                              <path
                                key={idx}
                                d={commandsToSvgPath(s.commands)}
                                fill="none"
                                stroke={s.strokeStyle}
                                strokeWidth={s.lineWidth}
                                strokeLinejoin="round"
                                strokeLinecap="round"
                                strokeMiterlimit={2.5}
                              />
                            ))}
                          </g>
                        )}
                        {plan.hasFill && (
                          <g
                            pointerEvents="visiblePainted"
                            className="cursor-move"
                            onPointerDown={(e) => startDrag('move', b, e)}
                          >
                            {plan.fills.map((f, idx) => (
                              <path
                                key={idx}
                                d={commandsToSvgPath(f.commands)}
                                fill={f.fillStyle}
                                stroke="none"
                              />
                            ))}
                          </g>
                        )}
                      </>
                    ) : (
                      <>
                        {!plan.hasFill && (
                          <g
                            pointerEvents="visibleFill"
                            className="cursor-move"
                            onPointerDown={(e) => startDrag('move', b, e)}
                          >
                            {plan.shapes.map((cmds, idx) => (
                              <path
                                key={idx}
                                d={commandsToSvgPath(cmds)}
                                fill="transparent"
                                stroke="none"
                              />
                            ))}
                          </g>
                        )}
                        {plan.hasFill && (
                          <g
                            opacity={plan.bgAlpha}
                            pointerEvents="visiblePainted"
                            className="cursor-move"
                            onPointerDown={(e) => startDrag('move', b, e)}
                          >
                            {plan.fills.map((f, idx) => (
                              <path
                                key={idx}
                                d={commandsToSvgPath(f.commands)}
                                fill={f.fillStyle}
                                stroke="none"
                              />
                            ))}
                          </g>
                        )}
                        {plan.hasBorder && (
                          <g
                            opacity={plan.borderAlpha}
                            mask={`url(#${maskId})`}
                            pointerEvents="visiblePainted"
                            className="cursor-move"
                            onPointerDown={(e) => startDrag('move', b, e)}
                          >
                            {plan.strokes.map((s, idx) => (
                              <path
                                key={idx}
                                d={commandsToSvgPath(s.commands)}
                                fill="none"
                                stroke={s.strokeStyle}
                                strokeWidth={s.lineWidth}
                                strokeLinejoin="round"
                                strokeLinecap="round"
                                strokeMiterlimit={2.5}
                              />
                            ))}
                          </g>
                        )}
                      </>
                    )}

                    {/* WYSIWYG Text Layer (hidden only while inline textarea is active) */}
                    {!isEditing && b.text && (
                      <g
                        pointerEvents="visiblePainted"
                        className="cursor-move select-none"
                        onPointerDown={(e) => startDrag('move', b, e)}
                      >
                        {textLayout.items.map((item, idx) =>
                          item.text ? (
                            <text
                              key={idx}
                              x={item.x}
                              y={item.y}
                              transform={
                                item.rotationDeg !== 0
                                  ? `rotate(${item.rotationDeg} ${item.x} ${item.y})`
                                  : undefined
                              }
                              textAnchor="middle"
                              dominantBaseline="central"
                              fontFamily={b.fontFamily}
                              fontSize={b.fontSize}
                              fontWeight="bold"
                              fill={b.fontColor}
                              paintOrder="stroke"
                              stroke={b.strokeWidth > 0 ? b.strokeColor : 'none'}
                              strokeWidth={b.strokeWidth > 0 ? b.strokeWidth * 2 : 0}
                              strokeLinejoin="round"
                            >
                              {item.text}
                            </text>
                          ) : null
                        )}
                      </g>
                    )}
                  </svg>

                  {/* Click-to-edit safe text trigger when selected (strictly inside safeBox so perimeter tailBase stays unobstructed) */}
                  {isSelected && !isEditing && (
                    <div
                      onPointerDown={(e) => startDrag('move', b, e)}
                      onClick={(e) => {
                        if (Date.now() - lastDragMovedAtRef.current > 200) {
                          e.stopPropagation();
                          setEditingBalloonId(b.id);
                        }
                      }}
                      style={{
                        left: `${safeBox.x - b.x}px`,
                        top: `${safeBox.y - b.y}px`,
                        width: `${safeBox.width}px`,
                        height: `${safeBox.height}px`,
                      }}
                      className="absolute pointer-events-auto cursor-text"
                    />
                  )}

                  {/* Inline Multiline Editor inside safeBox */}
                  {isEditing && (
                    <textarea
                      autoFocus
                      value={b.text}
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) => updateBalloon(b.id, { text: e.target.value })}
                      onBlur={() => setEditingBalloonId((cur) => (cur === b.id ? null : cur))}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.stopPropagation();
                          setEditingBalloonId(null);
                        }
                      }}
                      style={{
                        left: `${safeBox.x - b.x}px`,
                        top: `${safeBox.y - b.y}px`,
                        width: `${safeBox.width}px`,
                        height: `${safeBox.height}px`,
                        fontSize: `${b.fontSize}px`,
                        lineHeight: b.lineHeight ?? DEFAULT_LINE_HEIGHT,
                        color: b.fontColor,
                        fontFamily: b.fontFamily,
                        writingMode: b.orientation === 'vertical' ? 'vertical-rl' : 'horizontal-tb',
                      }}
                      className="absolute pointer-events-auto bg-transparent border border-indigo-400/50 rounded outline-none text-center font-bold resize-none overflow-hidden p-0.5 select-text"
                    />
                  )}
                </div>

                {/* Independent Selection Overlay & Screen-space Handles (only when selected) */}
                {isSelected && (
                  <>
                    <svg className="absolute inset-0 h-full w-full overflow-visible pointer-events-none z-10">
                      <polygon
                        points={`${nwPt.x},${nwPt.y} ${nePt.x},${nePt.y} ${sePt.x},${sePt.y} ${swPt.x},${swPt.y}`}
                        fill="none"
                        stroke="#6366F1"
                        strokeOpacity={0.85}
                        strokeWidth={1.5}
                        strokeDasharray="4 3"
                      />
                      {b.tailEnabled && (
                        <polyline
                          points={
                            showCurveHandle
                              ? `${tailBasePt.x},${tailBasePt.y} ${tailCurvePt.x},${tailCurvePt.y} ${tailTipPt.x},${tailTipPt.y}`
                              : `${tailBasePt.x},${tailBasePt.y} ${tailTipPt.x},${tailTipPt.y}`
                          }
                          fill="none"
                          stroke="#38BDF8"
                          strokeOpacity={0.7}
                          strokeWidth={1.25}
                          strokeDasharray="3 3"
                        />
                      )}
                    </svg>

                    {/* 4 Corner Resize Handles (edges kept free for tailBase sliding) */}
                    {[
                      { mode: 'nw' as const, pt: nwPt, cursor: 'cursor-nwse-resize' },
                      { mode: 'ne' as const, pt: nePt, cursor: 'cursor-nesw-resize' },
                      { mode: 'se' as const, pt: sePt, cursor: 'cursor-nwse-resize' },
                      { mode: 'sw' as const, pt: swPt, cursor: 'cursor-nesw-resize' },
                    ].map((h) => (
                      <div
                        key={h.mode}
                        onPointerDown={(e) => startDrag(h.mode, b, e)}
                        style={{
                          left: `${h.pt.x}px`,
                          top: `${h.pt.y}px`,
                          transform: 'translate(-50%, -50%)',
                        }}
                        className={`absolute z-20 w-3 h-3 bg-white border border-indigo-600 rounded-sm shadow pointer-events-auto ${h.cursor}`}
                      />
                    ))}

                    {/* 3 Tail Handles: tip (amber), base (emerald diamond), curve midpoint (sky) */}
                    {b.tailEnabled && (
                      <>
                        {showCurveHandle && (
                          <div
                            onPointerDown={(e) => startDrag('tailCurve', b, e)}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              updateBalloon(b.id, { tailCurve: 0 });
                            }}
                            style={{
                              left: `${tailCurvePt.x}px`,
                              top: `${tailCurvePt.y}px`,
                              transform: 'translate(-50%, -50%)',
                            }}
                            className="absolute z-20 w-3 h-3 rounded-full bg-sky-400 border-2 border-white shadow-md cursor-grab active:cursor-grabbing hover:scale-125 transition-transform pointer-events-auto"
                            title={t.comic.tailDirect}
                          />
                        )}
                        <div
                          onPointerDown={(e) => startDrag('tailBase', b, e)}
                          style={{
                            left: `${tailBasePt.x}px`,
                            top: `${tailBasePt.y}px`,
                            transform: 'translate(-50%, -50%) rotate(45deg)',
                          }}
                          className="absolute z-[25] w-3.5 h-3.5 rounded-[2px] bg-emerald-400 border-2 border-white shadow-md cursor-grab active:cursor-grabbing hover:scale-125 transition-transform pointer-events-auto"
                          title={t.comic.balloonTail}
                        />
                        <div
                          onPointerDown={(e) => startDrag('tail', b, e)}
                          style={{
                            left: `${tailTipPt.x}px`,
                            top: `${tailTipPt.y}px`,
                            transform: 'translate(-50%, -50%)',
                          }}
                          className="absolute z-30 w-3.5 h-3.5 rounded-full bg-amber-400 border-2 border-white shadow-md cursor-grab active:cursor-grabbing hover:scale-125 transition-transform pointer-events-auto"
                          title={t.comic.tailDirect}
                        />
                      </>
                    )}
                  </>
                )}
              </React.Fragment>
            );
          });
        })()}

      {/* Floating Comic / Balloon Tool Options Bar */}
      <div className="absolute top-14 left-1/2 -translate-x-1/2 pointer-events-auto atelier-popover atelier-menu-in p-1.5 flex flex-wrap items-center gap-1.5 text-xs text-neutral-200 animate-in slide-in-from-top-2 duration-150 max-w-[94vw] overflow-x-auto no-scrollbar">
        {isPanelActive && (
          <>
            <span className="font-bold text-indigo-400 flex items-center gap-1 shrink-0 px-1">
              <Columns className="w-3.5 h-3.5" />
              <span>{t.comic.panelSplit}：</span>
            </span>
            {[
              { id: '4koma', label: '4-Koma' },
              { id: '2h', label: '2-H' },
              { id: '2v', label: '2-V' },
              { id: '3koma', label: '3-Koma' },
              { id: '6grid', label: '6-Grid' },
              { id: 'full', label: 'Full' },
            ].map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => handleApplyLayout(p.id as any)}
                className={`px-2.5 py-1 rounded-xl font-medium transition shrink-0 ${
                  activeLayout === p.id
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-300'
                }`}
              >
                {p.label}
              </button>
            ))}

            <div className="h-4 w-px bg-neutral-700 mx-1 shrink-0" />

            <button
              type="button"
              onClick={handleAddPanel}
              className="px-2.5 py-1 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-indigo-300 hover:text-white font-medium transition flex items-center gap-1 shrink-0 border border-indigo-500/30"
              title="Add frame"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t.common.add}</span>
            </button>

            {activePanelId && (
              <>
                <div className="flex items-center gap-1 bg-neutral-900/80 px-2 py-0.5 rounded-xl border border-neutral-700 shrink-0">
                  <span className="text-[11px] text-neutral-400">{t.comic.panelBorderWidth}:</span>
                  <button
                    type="button"
                    onClick={() => handleUpdateActivePanelBorder(-1)}
                    className="px-1 text-neutral-300 hover:text-white"
                  >
                    -
                  </button>
                  <span className="text-white font-mono px-1">
                    {panels.find((p) => p.id === activePanelId)?.borderWidth || 4}px
                  </span>
                  <button
                    type="button"
                    onClick={() => handleUpdateActivePanelBorder(1)}
                    className="px-1 text-neutral-300 hover:text-white"
                  >
                    +
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleDeleteActivePanel}
                  className="px-2 py-1 rounded-xl bg-rose-950/60 hover:bg-rose-900 border border-rose-700/50 text-rose-300 hover:text-white transition flex items-center gap-1 shrink-0"
                  title={t.common.delete}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{t.common.delete}</span>
                </button>
              </>
            )}
          </>
        )}

        {(isBalloonActive || isTextActive) && (
          <>
            <span className="font-bold text-yellow-400 flex items-center gap-1 shrink-0 px-1">
              {isBalloonActive ? <MessageCircle className="w-3.5 h-3.5" /> : <Type className="w-3.5 h-3.5" />}
              <span>{isBalloonActive ? t.comic.speechBalloon : t.tools.text}：</span>
            </span>
            {isBalloonActive && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => handleAddBalloon('oval')}
                  title={t.comic.balloonOval}
                  className="px-2 py-1 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white transition flex items-center gap-1 shrink-0"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  <span>+ {t.comic.balloonOval.split(' (')[0]}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleAddBalloon('rect')}
                  title={t.comic.balloonRounded}
                  className="px-2 py-1 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white transition flex items-center gap-1 shrink-0"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  <span>+ {t.comic.balloonRounded.split(' (')[0]}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleAddBalloon('spiky')}
                  title={t.comic.balloonSpiky}
                  className="px-2 py-1 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white transition flex items-center gap-1 shrink-0"
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>+ {t.comic.balloonSpiky.split(' (')[0]}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleAddBalloon('thought')}
                  title={t.comic.balloonThought}
                  className="px-2 py-1 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white transition flex items-center gap-1 shrink-0"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>+ {t.comic.balloonThought.split(' (')[0]}</span>
                </button>
              </div>
            )}
            {isTextActive && (
              <button
                type="button"
                onClick={handleAddPureText}
                className="px-2 py-1 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold transition flex items-center gap-1 shrink-0"
              >
                <Plus className="w-3 h-3" />
                <span>{t.common.add}</span>
              </button>
            )}

            {/* Selected Balloon Properties (Shape, Tail, Border/Fill, Text) */}
            {currentBalloon && (() => {
              const tailParams = resolveBalloonTailParams(currentBalloon);
              const bgAlpha = parseColorAlpha(currentBalloon.bgColor);
              const isTransparentBg = bgAlpha <= 0.001;
              return (
                <div className="flex flex-wrap items-center gap-1.5 ml-1 pl-1.5 border-l border-neutral-700">
                  {/* Shape Switcher */}
                  <label className="flex items-center gap-1 shrink-0" title={t.comic.balloonType}>
                    <span className="text-[11px] text-neutral-400">{t.comic.balloonType}:</span>
                    <select
                      value={currentBalloon.shape}
                      onChange={(e) =>
                        updateBalloon(currentBalloon.id, { shape: e.target.value as BalloonShape })
                      }
                      className="bg-neutral-900 border border-neutral-700 rounded-lg px-1.5 py-0.5 text-xs text-white"
                    >
                      <option value="oval">{t.comic.balloonOval}</option>
                      <option value="rect">{t.comic.balloonRounded}</option>
                      <option value="spiky">{t.comic.balloonSpiky}</option>
                      <option value="thought">{t.comic.balloonThought}</option>
                    </select>
                  </label>

                  {currentBalloon.shape === 'rect' && (
                    <label className="flex items-center gap-1 shrink-0">
                      <span className="text-[11px] text-neutral-400">{t.toolOptions.shapeCornerRadius}:</span>
                      <input
                        type="range"
                        min={0}
                        max={Math.floor(Math.min(currentBalloon.width, currentBalloon.height) / 2)}
                        value={Math.min(
                          currentBalloon.cornerRadius ?? 0,
                          Math.floor(Math.min(currentBalloon.width, currentBalloon.height) / 2)
                        )}
                        onChange={(e) =>
                          updateBalloon(currentBalloon.id, { cornerRadius: Number(e.target.value) })
                        }
                        className="w-16"
                      />
                    </label>
                  )}

                  {/* Tail Toggle + Free Base Angle / Width / Curve */}
                  <button
                    type="button"
                    onClick={() =>
                      updateBalloon(currentBalloon.id, { tailEnabled: !currentBalloon.tailEnabled })
                    }
                    title={t.comic.balloonTail}
                    className={`px-2 py-0.5 rounded-lg border text-[11px] transition shrink-0 ${
                      currentBalloon.tailEnabled
                        ? 'bg-amber-500/20 border-amber-400/60 text-amber-200'
                        : 'bg-neutral-900 border-neutral-700 text-neutral-400'
                    }`}
                  >
                    {currentBalloon.tailEnabled ? t.comic.balloonTail : t.comic.tailNone}
                  </button>

                  {currentBalloon.tailEnabled && (
                    <div className="flex items-center gap-1.5 bg-neutral-900/70 px-1.5 py-0.5 rounded-lg border border-neutral-700/80 shrink-0">
                      {/* Base Angle */}
                      <label className="flex items-center gap-1" title={t.comic.tailDirect}>
                        <span className="text-[11px] text-emerald-300">⌖</span>
                        <input
                          type="range"
                          min={0}
                          max={360}
                          step={1}
                          value={Math.round(tailParams.tailBaseAngle)}
                          onChange={(e) =>
                            updateBalloon(currentBalloon.id, {
                              tailBaseAngle: Number(e.target.value) % 360,
                            })
                          }
                          className="w-16"
                        />
                        <span className="text-[11px] font-mono w-9 text-right">
                          {Math.round(tailParams.tailBaseAngle)}°
                        </span>
                      </label>
                      {!tailParams.isAutoBaseAngle && (
                        <button
                          type="button"
                          onClick={() =>
                            updateBalloon(currentBalloon.id, { tailBaseAngle: undefined })
                          }
                          title={t.common.reset}
                          className="p-0.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-800"
                        >
                          <RotateCcw className="w-3 h-3" />
                        </button>
                      )}

                      {/* Tail Width */}
                      <label className="flex items-center gap-1" title={t.comic.tailSize}>
                        <span className="text-[11px] text-neutral-400">{t.comic.tailSize}:</span>
                        <input
                          type="range"
                          min={8}
                          max={80}
                          step={1}
                          value={Math.round(tailParams.tailWidth)}
                          onChange={(e) =>
                            updateBalloon(currentBalloon.id, { tailWidth: Number(e.target.value) })
                          }
                          className="w-14"
                        />
                        <span className="text-[11px] font-mono w-8 text-right">
                          {Math.round(tailParams.tailWidth)}
                        </span>
                      </label>

                      {/* Tail Curve */}
                      <label className="flex items-center gap-1" title={t.comic.tailDirect}>
                        <span className="text-[11px] text-sky-300">⌒</span>
                        <input
                          type="range"
                          min={-100}
                          max={100}
                          step={1}
                          value={Math.round(tailParams.tailCurve * 100)}
                          onChange={(e) => {
                            const raw = Number(e.target.value) / 100;
                            updateBalloon(currentBalloon.id, {
                              tailCurve: Math.abs(raw) < 0.05 ? 0 : raw,
                            });
                          }}
                          className="w-14"
                        />
                        <span className="text-[11px] font-mono w-10 text-right">
                          {Math.round(tailParams.tailCurve * 100)}%
                        </span>
                      </label>
                      {tailParams.tailCurve !== 0 && (
                        <button
                          type="button"
                          onClick={() => updateBalloon(currentBalloon.id, { tailCurve: 0 })}
                          title={t.common.reset}
                          className="p-0.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-800"
                        >
                          <RotateCcw className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  )}

                  {/* Border & Fill Colors */}
                  <div className="flex items-center gap-1.5 bg-neutral-900/70 px-1.5 py-0.5 rounded-lg border border-neutral-700/80 shrink-0">
                    <label className="flex items-center gap-1" title={t.comic.borderWidth}>
                      <span className="text-[11px] text-neutral-400">{t.comic.borderWidth}:</span>
                      <input
                        type="range"
                        min={0}
                        max={16}
                        step={0.5}
                        value={currentBalloon.borderWidth}
                        onChange={(e) =>
                          updateBalloon(currentBalloon.id, { borderWidth: Number(e.target.value) })
                        }
                        className="w-14"
                      />
                      <span className="text-[11px] font-mono w-7 text-right">
                        {currentBalloon.borderWidth}
                      </span>
                    </label>
                    <input
                      type="color"
                      value={colorToHex6(currentBalloon.borderColor, '#000000')}
                      onChange={(e) =>
                        updateBalloon(currentBalloon.id, { borderColor: e.target.value })
                      }
                      title={t.comic.borderColor}
                      className="w-5 h-5 rounded border border-neutral-600 bg-transparent cursor-pointer p-0"
                    />
                    <span className="text-[11px] text-neutral-400">{t.comic.fillColor}:</span>
                    <input
                      type="color"
                      value={colorToHex6(currentBalloon.bgColor, '#ffffff')}
                      onChange={(e) => {
                        const alpha = bgAlpha <= 0.001 ? 1 : bgAlpha;
                        updateBalloon(currentBalloon.id, {
                          bgColor: applyAlphaToColor(e.target.value, alpha),
                        });
                      }}
                      title={t.comic.fillColor}
                      className="w-5 h-5 rounded border border-neutral-600 bg-transparent cursor-pointer p-0"
                    />
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={Math.round(bgAlpha * 100)}
                      onChange={(e) =>
                        updateBalloon(currentBalloon.id, {
                          bgColor: applyAlphaToColor(
                            currentBalloon.bgColor,
                            Number(e.target.value) / 100
                          ),
                        })
                      }
                      title={`${t.comic.fillColor} ${Math.round(bgAlpha * 100)}%`}
                      className="w-12"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        updateBalloon(currentBalloon.id, {
                          bgColor: isTransparentBg ? '#FFFFFF' : 'transparent',
                        })
                      }
                      title={t.comic.fillColor}
                      className={`px-1.5 py-0.5 rounded text-[10px] border transition ${
                        isTransparentBg
                          ? 'bg-indigo-600/30 border-indigo-400 text-indigo-200'
                          : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white'
                      }`}
                    >
                      {Math.round(bgAlpha * 100)}%
                    </button>
                  </div>

                  {/* Text Direction, Font Size, Line Height, Family & Color */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        updateBalloon(currentBalloon.id, {
                          orientation:
                            currentBalloon.orientation === 'vertical' ? 'horizontal' : 'vertical',
                        })
                      }
                      title={
                        currentBalloon.orientation === 'vertical'
                          ? t.comic.verticalText
                          : t.comic.horizontalText
                      }
                      className={`px-2 py-0.5 rounded-lg border text-[11px] transition shrink-0 ${
                        currentBalloon.orientation === 'vertical'
                          ? 'bg-indigo-600/30 border-indigo-400 text-indigo-200'
                          : 'bg-neutral-900 border-neutral-700 text-neutral-300'
                      }`}
                    >
                      {currentBalloon.orientation === 'vertical'
                        ? t.comic.verticalText.split(' (')[0]
                        : t.comic.horizontalText.split(' (')[0]}
                    </button>
                    <span className="text-[11px] text-neutral-400">{t.comic.fontSize}:</span>
                    <input
                      type="number"
                      min="10"
                      max="120"
                      value={currentBalloon.fontSize}
                      onChange={(e) => {
                        const sz = Math.max(10, Math.min(120, parseInt(e.target.value, 10) || 16));
                        updateBalloon(currentBalloon.id, { fontSize: sz });
                      }}
                      className="w-12 bg-neutral-900 border border-neutral-700 rounded-lg px-1 py-0.5 text-center text-xs text-white"
                    />
                    <span className="text-[11px] text-neutral-400">{t.comic.lineHeight}:</span>
                    <input
                      type="number"
                      min="0.8"
                      max="2.5"
                      step="0.05"
                      value={currentBalloon.lineHeight ?? DEFAULT_LINE_HEIGHT}
                      onChange={(e) => {
                        const lh = clamp(parseFloat(e.target.value) || DEFAULT_LINE_HEIGHT, 0.8, 2.5);
                        updateBalloon(currentBalloon.id, { lineHeight: lh });
                      }}
                      className="w-14 bg-neutral-900 border border-neutral-700 rounded-lg px-1 py-0.5 text-center text-xs text-white"
                    />
                    <select
                      value={currentBalloon.fontFamily}
                      onChange={(e) =>
                        updateBalloon(currentBalloon.id, { fontFamily: e.target.value })
                      }
                      title={t.comic.fontFamily}
                      className="bg-neutral-900 border border-neutral-700 rounded-lg px-1.5 py-0.5 text-xs text-white"
                    >
                      <option value="sans-serif">Sans-serif</option>
                      <option value="serif">Serif</option>
                      <option value="cursive">Cursive</option>
                      <option value="monospace">Monospace</option>
                    </select>
                    <input
                      type="color"
                      value={colorToHex6(currentBalloon.fontColor, '#000000')}
                      onChange={(e) =>
                        updateBalloon(currentBalloon.id, { fontColor: e.target.value })
                      }
                      className="w-5 h-5 rounded border border-neutral-600 bg-transparent cursor-pointer p-0"
                    />
                    <button
                      type="button"
                      onClick={handleDeleteActiveBalloon}
                      className="p-1 rounded-lg text-rose-400 hover:bg-rose-950/40 transition"
                      title={t.common.delete}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })()}
          </>
        )}

        <div className="h-4 w-px bg-neutral-700 mx-0.5 shrink-0" />

        {/* Bake to Layer Button */}
        <button
          type="button"
          onClick={handleBakeAll}
          className="atelier-btn atelier-btn--primary shrink-0"
        >
          <Check className="w-3.5 h-3.5" />
          <span>{t.comic.screentoneBake}</span>
        </button>

        {/* Close Button */}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-lg transition shrink-0"
            title="關閉漫畫分鏡模式"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
};
