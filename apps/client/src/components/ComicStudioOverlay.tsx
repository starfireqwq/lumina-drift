import React, { useEffect, useRef, useState } from 'react';
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
  Scissors,
  Sparkles,
  Trash2,
  Type,
  X,
  Zap,
} from 'lucide-react';
import { useI18n } from '../context/I18nContext';

export type BalloonShape = 'oval' | 'rect' | 'spiky' | 'thought';
export type TextOrientation = 'horizontal' | 'vertical';

export interface ComicBalloonItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: BalloonShape;
  cornerRadius?: number;
  tailPos: { x: number; y: number }; // Relative to balloon center
  tailEnabled: boolean;
  bgColor: string;
  borderColor: string;
  borderWidth: number;
  text: string;
  fontSize: number;
  fontColor: string;
  fontFamily: string;
  orientation: TextOrientation;
  strokeColor: string;
  strokeWidth: number;
}

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

type DragMode = 'move' | 'nw' | 'ne' | 'se' | 'sw' | 'n' | 's' | 'w' | 'e' | 'tail';

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
  const [activeLayout, setActiveLayout] = useState<string>('');

  // Dragging and Resizing Ref for balloons
  const dragRef = useRef<{
    mode: DragMode;
    balloonId: string;
    startScreen: { x: number; y: number };
    origBalloon: ComicBalloonItem;
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
    const height = shape === 'rect' ? 200 : 110;
    const newB: ComicBalloonItem = {
      id: `balloon_${Date.now()}`,
      x: Math.max(50, center.x - 100),
      y: Math.max(0, center.y - height / 2),
      width: 200,
      height,
      shape,
      cornerRadius: 0,
      tailPos: { x: -50, y: 90 },
      tailEnabled: true,
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
    setActiveBalloonId(null);
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

      // 2. Balloon dragging / resizing
      if (!dragRef.current) return;
      const { mode, balloonId, startScreen, origBalloon } = dragRef.current;
      const dx = (e.clientX - startScreen.x) / viewportZoom;
      const dy = (e.clientY - startScreen.y) / viewportZoom;

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
    dragRef.current = {
      mode,
      balloonId: balloon.id,
      startScreen: { x: e.clientX, y: e.clientY },
      origBalloon: { ...balloon },
    };
  };

  // Bake all comic layout & balloons onto current layer
  const handleBakeAll = () => {
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

    // 2. Draw balloons & texts
    for (const b of isPanelActive ? [] : balloons) {
      ctx.save();

      // Draw bubble background & border
      if (b.bgColor !== 'transparent') {
        ctx.fillStyle = b.bgColor;
        ctx.strokeStyle = b.borderColor;
        ctx.lineWidth = b.borderWidth;

        ctx.beginPath();
        if (b.shape === 'oval') {
          ctx.ellipse(
            b.x + b.width / 2,
            b.y + b.height / 2,
            b.width / 2,
            b.height / 2,
            0,
            0,
            Math.PI * 2
          );
        } else {
          ctx.roundRect(b.x, b.y, b.width, b.height, Math.min(b.cornerRadius ?? 0, b.width / 2, b.height / 2));
        }
        ctx.fill();
        ctx.stroke();

        // Draw speech tail
        if (b.tailEnabled) {
          const cx = b.x + b.width / 2;
          const cy = b.y + b.height / 2;
          const tx = cx + b.tailPos.x;
          const ty = cy + b.tailPos.y;

          ctx.beginPath();
          ctx.moveTo(cx - 15, cy + b.height / 2 - 4);
          ctx.lineTo(tx, ty);
          ctx.lineTo(cx + 15, cy + b.height / 2 - 4);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }

      // Draw Text inside
      ctx.font = `bold ${b.fontSize}px ${b.fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const textX = b.x + b.width / 2;
      const textY = b.y + b.height / 2;

      if (b.strokeWidth > 0) {
        ctx.strokeStyle = b.strokeColor;
        ctx.lineWidth = b.strokeWidth * 2;
        ctx.strokeText(b.text, textX, textY);
      }
      ctx.fillStyle = b.fontColor;
      ctx.fillText(b.text, textX, textY);

      ctx.restore();
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

      {/* 2. Comic Balloons & Vector Text Overlay */}
      {!isPanelActive && balloons.map((b) => {
        const screenPos = canvasToScreen(b.x, b.y);
        const screenW = b.width * viewportZoom;
        const screenH = b.height * viewportZoom;
        const isSelected = activeBalloonId === b.id;

        return (
          <div
            key={b.id}
            onPointerDown={(e) => startDrag('move', b, e)}
            style={{
              transform: `translate(${screenPos.x}px, ${screenPos.y}px)`,
              width: `${screenW}px`,
              height: `${screenH}px`,
              backgroundColor: b.bgColor,
              borderColor: isSelected ? '#6366F1' : b.borderColor,
              borderWidth: `${Math.max(1, (b.borderWidth || 1) * viewportZoom)}px`,
              borderRadius: b.shape === 'oval' ? '50%' : Math.min(b.cornerRadius ?? 0, b.width / 2, b.height / 2) * viewportZoom,
            }}
            className={`absolute pointer-events-auto flex items-center justify-center p-2 shadow-lg transition-shadow cursor-move ${
              isSelected ? 'ring-2 ring-indigo-500 shadow-indigo-500/20' : ''
            }`}
          >
            {/* Inline editable text */}
            <input
              type="text"
              value={b.text}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const val = e.target.value;
                setBalloons((prev) =>
                  prev.map((item) => (item.id === b.id ? { ...item, text: val } : item))
                );
              }}
              style={{
                fontSize: `${Math.max(10, b.fontSize * viewportZoom)}px`,
                color: b.fontColor,
                fontFamily: b.fontFamily,
                WebkitTextStroke:
                  b.strokeWidth > 0
                    ? `${b.strokeWidth * viewportZoom}px ${b.strokeColor}`
                    : 'none',
              }}
              className="bg-transparent border-none outline-none text-center font-bold w-full truncate cursor-text"
            />

            {/* Speech Tail Handle (if selected & enabled) */}
            {isSelected && b.tailEnabled && (
              <div
                onPointerDown={(e) => startDrag('tail', b, e)}
                style={{
                  transform: `translate(${b.tailPos.x * viewportZoom}px, ${
                    b.tailPos.y * viewportZoom
                  }px)`,
                }}
                className="absolute w-4 h-4 rounded-full bg-amber-400 border-2 border-white shadow-md cursor-grab active:cursor-grabbing hover:scale-125 transition-transform"
                title="拖曳尾巴指向角色"
              />
            )}

            {/* 4 Corner Resize Handles (when selected) */}
            {isSelected && (
              <>
                <div
                  onPointerDown={(e) => startDrag('nw', b, e)}
                  className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border border-indigo-600 rounded-sm cursor-nwse-resize shadow"
                />
                <div
                  onPointerDown={(e) => startDrag('ne', b, e)}
                  className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border border-indigo-600 rounded-sm cursor-nesw-resize shadow"
                />
                <div
                  onPointerDown={(e) => startDrag('se', b, e)}
                  className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border border-indigo-600 rounded-sm cursor-nwse-resize shadow"
                />
                <div
                  onPointerDown={(e) => startDrag('sw', b, e)}
                  className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border border-indigo-600 rounded-sm cursor-nesw-resize shadow"
                />
              </>
            )}
          </div>
        );
      })}

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
              <>
                <button
                  type="button"
                  onClick={() => handleAddBalloon('oval')}
                  className="px-2 py-1 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white transition shrink-0"
                >
                  + {t.comic.balloonOval}
                </button>
                <button
                  type="button"
                  onClick={() => handleAddBalloon('rect')}
                  className="px-2 py-1 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white transition shrink-0"
                >
                  + {t.comic.balloonRounded}
                </button>
              </>
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

            {isBalloonActive && currentBalloon?.shape === 'rect' && currentBalloon.bgColor !== 'transparent' && (
              <label className="flex items-center gap-1.5 shrink-0">
                {t.toolOptions.shapeCornerRadius}
                <input type="range" min={0} max={Math.floor(Math.min(currentBalloon.width, currentBalloon.height) / 2)}
                  value={Math.min(currentBalloon.cornerRadius ?? 0, Math.floor(Math.min(currentBalloon.width, currentBalloon.height) / 2))}
                  onChange={(e) => {
                    const cornerRadius = Number(e.target.value);
                    setBalloons((prev) => prev.map((b) => b.id === currentBalloon.id ? { ...b, cornerRadius } : b));
                  }} className="w-20" />
              </label>
            )}
            {/* Current Balloon Text Styling Controls */}
            {currentBalloon && (
              <div className="flex items-center gap-1.5 ml-1 pl-1 border-l border-neutral-700 shrink-0">
                <span className="text-[11px] text-neutral-400">{t.comic.fontSize}:</span>
                <input
                  type="number"
                  min="12"
                  max="96"
                  value={currentBalloon.fontSize}
                  onChange={(e) => {
                    const sz = Math.max(10, Math.min(120, parseInt(e.target.value, 10) || 16));
                    setBalloons((prev) =>
                      prev.map((b) => (b.id === currentBalloon.id ? { ...b, fontSize: sz } : b))
                    );
                  }}
                  className="w-12 bg-neutral-900 border border-neutral-700 rounded-lg px-1.5 py-0.5 text-center text-xs text-white"
                />
                <span className="text-[11px] text-neutral-400">{t.comic.fontFamily}:</span>
                <select
                  value={currentBalloon.fontFamily}
                  onChange={(e) => {
                    const fam = e.target.value;
                    setBalloons((prev) =>
                      prev.map((b) => (b.id === currentBalloon.id ? { ...b, fontFamily: fam } : b))
                    );
                  }}
                  className="bg-neutral-900 border border-neutral-700 rounded-lg px-1.5 py-0.5 text-xs text-white"
                >
                  <option value="sans-serif">Sans-serif</option>
                  <option value="serif">Serif</option>
                  <option value="cursive">Cursive</option>
                  <option value="monospace">Monospace</option>
                </select>
                <button
                  type="button"
                  onClick={handleDeleteActiveBalloon}
                  className="p-1 rounded-lg text-rose-400 hover:bg-rose-950/40 transition"
                  title={t.common.delete}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
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
