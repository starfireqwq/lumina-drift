import React, { useEffect, useRef, useState } from 'react';
import {
  RotateCw,
  Lock,
  Unlock,
  Crosshair,
} from 'lucide-react';
import { DISTORT_MODES, type DistortMode } from '../utils/distortModes';
import { BarSelect, BarToggle, CanvasActionBar } from './workspace/CanvasActionBar';
import { projectTransformBox, getBoxPivotCanvasPoint, type TransformBox } from '../utils/transformProjection';

export type { TransformBox } from '../utils/transformProjection';

interface TransformOverlayProps {
  isActive: boolean;
  box: TransformBox;
  onChangeBox: (newBox: TransformBox) => void;
  onApply: () => void;
  onCancel: () => void;
  onChangeMode: (mode: DistortMode) => void;
  canvasToScreen: (cx: number, cy: number) => { x: number; y: number };
  screenToCanvas: (sx: number, sy: number) => { x: number; y: number };
  viewportZoom: number;
  previewUrl?: string | null;
}

type HandleType =
  | 'move'
  | 'rotate'
  | 'pivot'
  | 'nw'
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w';

export const TransformOverlay: React.FC<TransformOverlayProps> = ({
  isActive,
  box,
  onChangeBox,
  onApply,
  onCancel,
  onChangeMode,
  canvasToScreen,
  screenToCanvas,
  viewportZoom,
  previewUrl,
}) => {
  // Mobile touch toggle for Shift (Keep Aspect Ratio) and Alt (Center scale)
  const [maintainAspect, setMaintainAspect] = useState(false);
  const [centerScale, setCenterScale] = useState(false);

  const dragActionRef = useRef<{
    handle: HandleType;
    startPointer: { x: number; y: number };
    startBox: TransformBox;
  } | null>(null);

  // Keyboard shortcut Enter (Apply) & Escape (Cancel)
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter' && !(e.target as HTMLElement)?.closest('input, select, textarea, button')) {
        e.preventDefault();
        onApply();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, onApply, onCancel]);

  if (!isActive) return null;

  const { matrix, ...screenBounds } = projectTransformBox(box, viewportZoom, canvasToScreen);

  const handlePointerDown = (handle: HandleType, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // A failed capture (pointer already released) must not cancel the drag itself
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // keep dragging without capture
    }

    dragActionRef.current = {
      handle,
      startPointer: { x: e.clientX, y: e.clientY },
      startBox: { ...box },
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragActionRef.current) return;
    e.stopPropagation();

    const { handle, startPointer, startBox } = dragActionRef.current;
    const isShift = e.shiftKey || maintainAspect;
    const isAlt = e.altKey || centerScale;

    // Convert pointer displacement to canvas delta
    const curCanvas = screenToCanvas(e.clientX, e.clientY);
    const startCanvas = screenToCanvas(startPointer.x, startPointer.y);
    const dx = curCanvas.x - startCanvas.x;
    const dy = curCanvas.y - startCanvas.y;

    if (handle === 'move') {
      onChangeBox({
        ...startBox,
        x: startBox.x + dx,
        y: startBox.y + dy,
      });
      return;
    }

    if (handle === 'pivot') {
      const cos = Math.cos(startBox.rotation);
      const sin = Math.sin(startBox.rotation);
      const localDx = dx * cos + dy * sin;
      const localDy = -dx * sin + dy * cos;
      onChangeBox({
        ...startBox,
        pivotX: (startBox.pivotX ?? 0.5) + localDx / (startBox.width || 1),
        pivotY: (startBox.pivotY ?? 0.5) + localDy / (startBox.height || 1),
      });
      return;
    }

    if (handle === 'rotate') {
      const piv = getBoxPivotCanvasPoint(startBox);
      const initialAngle = Math.atan2(startCanvas.y - piv.y, startCanvas.x - piv.x);
      const currentAngle = Math.atan2(curCanvas.y - piv.y, curCanvas.x - piv.x);
      let newRot = startBox.rotation + (currentAngle - initialAngle);

      // Snap to 15 degrees if Shift is held
      if (isShift) {
        const snap = Math.PI / 12;
        newRot = Math.round(newRot / snap) * snap;
      }

      // Rotate box center rigidly around fixed canvas pivot point
      const ox = ((startBox.pivotX ?? 0.5) - 0.5) * startBox.width;
      const oy = ((startBox.pivotY ?? 0.5) - 0.5) * startBox.height;
      const newCos = Math.cos(newRot);
      const newSin = Math.sin(newRot);
      const newCenterX = piv.x - (ox * newCos - oy * newSin);
      const newCenterY = piv.y - (ox * newSin + oy * newCos);

      onChangeBox({
        ...startBox,
        x: newCenterX - startBox.width / 2,
        y: newCenterY - startBox.height / 2,
        rotation: newRot,
      });
      return;
    }

    // Resize in the box's own axes, then rotate the displaced center back into canvas space.
    const cos = Math.cos(startBox.rotation);
    const sin = Math.sin(startBox.rotation);
    const localX = dx * cos + dy * sin;
    const localY = -dx * sin + dy * cos;
    let newX = startBox.x;
    let newY = startBox.y;
    let newW = startBox.width;
    let newH = startBox.height;

    const initialRatio = startBox.width / (startBox.height || 1);

    // X adjustments
    if (handle.includes('e')) {
      newW = startBox.width + localX;
      if (isAlt) {
        newW = startBox.width + localX * 2;
        newX = startBox.x - localX;
      }
    } else if (handle.includes('w')) {
      newW = startBox.width - localX;
      newX = startBox.x + localX;
      if (isAlt) {
        newW = startBox.width - localX * 2;
      }
    }

    // Y adjustments
    if (handle.includes('s')) {
      newH = startBox.height + localY;
      if (isAlt) {
        newH = startBox.height + localY * 2;
        newY = startBox.y - localY;
      }
    } else if (handle.includes('n')) {
      newH = startBox.height - localY;
      newY = startBox.y + localY;
      if (isAlt) {
        newH = startBox.height - localY * 2;
      }
    }

    // Maintain aspect ratio if Shift is held
    if (isShift) {
      if (handle === 'e' || handle === 'w') {
        const targetH = Math.abs(newW / initialRatio) * Math.sign(startBox.height);
        newY = startBox.y + (startBox.height - targetH) / 2;
        newH = targetH;
      } else if (handle === 'n' || handle === 's') {
        const targetW = Math.abs(newH * initialRatio) * Math.sign(startBox.width);
        newX = startBox.x + (startBox.width - targetW) / 2;
        newW = targetW;
      } else {
        // Corner handles
        const scaleVal = Math.max(Math.abs(newW / startBox.width), Math.abs(newH / startBox.height));
        newW = Math.abs(startBox.width) * scaleVal * Math.sign(newW);
        newH = Math.abs(startBox.height) * scaleVal * Math.sign(newH);
        if (handle.includes('w')) newX = startBox.x + startBox.width - newW;
        if (handle.includes('n')) newY = startBox.y + startBox.height - newH;
      }
    }

    // Min dimensions
    if (Math.abs(newW) >= 1 && Math.abs(newH) >= 1) {
      const centerDeltaX = isAlt ? 0 : newX - startBox.x + (newW - startBox.width) / 2;
      const centerDeltaY = isAlt ? 0 : newY - startBox.y + (newH - startBox.height) / 2;
      onChangeBox({
        ...startBox,
        x: startBox.x + (startBox.width - newW) / 2 + centerDeltaX * cos - centerDeltaY * sin,
        y: startBox.y + (startBox.height - newH) / 2 + centerDeltaX * sin + centerDeltaY * cos,
        width: newW,
        height: newH,
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    dragActionRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  };

  const handles: Array<{ type: HandleType; style: React.CSSProperties; cursor: string }> = [
    { type: 'nw', style: { top: -6, left: -6 }, cursor: 'nwse-resize' },
    { type: 'n', style: { top: -6, left: '50%', transform: 'translateX(-50%)' }, cursor: 'ns-resize' },
    { type: 'ne', style: { top: -6, right: -6 }, cursor: 'nesw-resize' },
    { type: 'e', style: { top: '50%', right: -6, transform: 'translateY(-50%)' }, cursor: 'ew-resize' },
    { type: 'se', style: { bottom: -6, right: -6 }, cursor: 'nwse-resize' },
    { type: 's', style: { bottom: -6, left: '50%', transform: 'translateX(-50%)' }, cursor: 'ns-resize' },
    { type: 'sw', style: { bottom: -6, left: -6 }, cursor: 'nesw-resize' },
    { type: 'w', style: { top: '50%', left: -6, transform: 'translateY(-50%)' }, cursor: 'ew-resize' },
  ];

  return (
    <div className="absolute inset-0 pointer-events-none select-none z-30 overflow-hidden">
      {/* Transform Box Container */}
      <div
        style={{
          position: 'absolute',
          ...screenBounds,
          transformOrigin: 'center center',
          transform: `matrix(${matrix.join(', ')}, 0, 0)`,
        }}
        className="pointer-events-auto touch-none outline-2 outline-indigo-400 outline-dashed cursor-move overflow-visible"
        onPointerDown={(e) => handlePointerDown('move', e)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Real-time Visual Preview of Transformed Pixels */}
        {previewUrl && (
          <img
            src={previewUrl}
            alt="transform-preview"
            className="w-full h-full object-fill pointer-events-none select-none"
          />
        )}
        {/* Rotation Handle (Stems out from top) */}
        <div className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 w-0.5 h-6 bg-indigo-400" />
        <div
          className="absolute -top-7 left-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-indigo-500 border-2 border-white shadow-md flex items-center justify-center cursor-grab active:cursor-grabbing hover:scale-125 transition-transform z-20"
          onPointerDown={(e) => handlePointerDown('rotate', e)}
          title="旋轉把手 (拖曳以旋轉角度)"
        >
          <RotateCw className="w-2.5 h-2.5 text-white pointer-events-none" />
        </div>

        {/* 8 Resizing Handles */}
        {handles.map((h) => (
          <div
            key={h.type}
            style={{ ...h.style, cursor: h.cursor }}
            onPointerDown={(e) => handlePointerDown(h.type, e)}
            className="absolute w-3.5 h-3.5 rounded bg-white border-2 border-indigo-600 shadow hover:scale-125 transition-transform"
          />
        ))}

        {/* Draggable Joint Pivot / Anchor Point */}
        <div
          role="button"
          tabIndex={-1}
          title="關節軸心 / 旋轉支點（拖曳調整支點，雙擊重設回中心）"
          style={{
            left: `${(box.pivotX ?? 0.5) * 100}%`,
            top: `${(box.pivotY ?? 0.5) * 100}%`,
          }}
          onPointerDown={(e) => handlePointerDown('pivot', e)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onChangeBox({ ...box, pivotX: 0.5, pivotY: 0.5 });
          }}
          className="absolute -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center cursor-grab active:cursor-grabbing z-20 group"
        >
          <span className="w-3.5 h-3.5 rounded-full border-2 border-amber-400 bg-neutral-900/80 shadow flex items-center justify-center group-hover:scale-125 transition-transform">
            <span className="w-1 h-1 rounded-full bg-amber-300" />
          </span>
        </div>
      </div>

      <CanvasActionBar onApply={onApply} onCancel={onCancel}>
        <BarSelect label="變形模式" value={'transform' as DistortMode | 'transform'}
          options={[{ id: 'transform', label: '自由變形' }, ...DISTORT_MODES]}
          onChange={(m) => { if (m !== 'transform') onChangeMode(m); }} />
        <BarToggle on={maintainAspect} onClick={() => setMaintainAspect(!maintainAspect)} keyHint="Shift"
          icon={maintainAspect ? <Lock /> : <Unlock />} label="等比" title="等比例縮放" />
        <BarToggle on={centerScale} onClick={() => setCenterScale(!centerScale)} keyHint="Alt"
          icon={<Crosshair />} label="中心" title="以中心點縮放" />
      </CanvasActionBar>
    </div>
  );
};
