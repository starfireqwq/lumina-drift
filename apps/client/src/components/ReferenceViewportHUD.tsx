import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Compass,
  Expand,
  Eye,
  FlipHorizontal,
  Image as ImageIcon,
  Minimize2,
  Minus,
  Move,
  Pipette,
  Plus,
  RotateCw,
  Sliders,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { startDrag } from './workspace/DockSystem';
import { rgbToHex } from '@atelier/shared';
import { useI18n } from '../context/I18nContext';

interface ReferenceViewportHUDProps {
  isOpen: boolean;
  onClose: () => void;
  onPickColor: (hex: string) => void;
}

export const ReferenceViewportHUD: React.FC<ReferenceViewportHUDProps> = ({
  isOpen,
  onClose,
  onPickColor,
}) => {
  const { t } = useI18n();
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imgElement, setImgElement] = useState<HTMLImageElement | null>(null);

  // Viewport transforms
  const [zoom, setZoom] = useState<number>(1.0);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [rotationDeg, setRotationDeg] = useState<number>(0);
  const [isFlippedH, setIsFlippedH] = useState<boolean>(false);
  const [opacity, setOpacity] = useState<number>(0.95);
  const [isMinimized, setIsMinimized] = useState<boolean>(false);

  // Window position
  const [windowPos, setWindowPos] = useState<{ x: number; y: number }>({ x: 80, y: 80 });
  // Size of the picture area (the canvas is drawn 1:1 with it, so the eyedropper maps directly)
  const [viewSize, setViewSize] = useState<{ w: number; h: number }>({ w: 320, h: 288 });
  const isDraggingWindowRef = useRef<boolean>(false);
  const windowDragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Eyedropper state
  const [hoverColor, setHoverColor] = useState<{ hex: string; r: number; g: number; b: number } | null>(null);
  const [eyedropperActive, setEyedropperActive] = useState<boolean>(true);
  const [pickedToast, setPickedToast] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Pan dragging
  const isPanningRef = useRef<boolean>(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const clampHud = useCallback((pos: { x: number; y: number }, size: { w: number; h: number }) => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const w = Math.max(200, Math.min(size.w, vw - 18));
    const h = Math.max(160, Math.min(size.h, vh - 140));
    const x = Math.max(8, Math.min(vw - w - 10, pos.x));
    const y = Math.max(8, Math.min(vh - 96, pos.y));
    return { pos: { x, y }, size: { w, h } };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const fit = () => {
      const next = clampHud(windowPos, viewSize);
      if (next.size.w !== viewSize.w || next.size.h !== viewSize.h) setViewSize(next.size);
      if (next.pos.x !== windowPos.x || next.pos.y !== windowPos.y) setWindowPos(next.pos);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Load image when imageSrc changes
  useEffect(() => {
    if (!imageSrc) {
      setImgElement(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      setImgElement(img);
      // Reset view to fit
      setZoom(1.0);
      setPan({ x: 0, y: 0 });
      setRotationDeg(0);
      setIsFlippedH(false);
    };
    img.src = imageSrc;
  }, [imageSrc]);

  // Clipboard paste listener
  useEffect(() => {
    if (!isOpen) return;

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          if (file) {
            const url = URL.createObjectURL(file);
            setImageSrc(url);
            e.preventDefault();
            break;
          }
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [isOpen]);

  // Render canvas
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!imgElement) {
      // Empty checkerboard or placeholder
      ctx.fillStyle = '#181920';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }

    ctx.save();
    // Center transformation
    const cx = canvas.width / 2 + pan.x;
    const cy = canvas.height / 2 + pan.y;
    ctx.translate(cx, cy);

    // Rotation
    ctx.rotate((rotationDeg * Math.PI) / 180);

    // Zoom & Flip
    ctx.scale(zoom * (isFlippedH ? -1 : 1), zoom);

    // Draw centered image
    const iw = imgElement.width;
    const ih = imgElement.height;
    ctx.drawImage(imgElement, -iw / 2, -ih / 2, iw, ih);

    ctx.restore();
  }, [imgElement, pan, zoom, rotationDeg, isFlippedH, viewSize.w, viewSize.h]);

  useEffect(() => {
    render();
  }, [render]);

  if (!isOpen) return null;

  // Window drag handlers
  const handleWindowHeaderPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // A press on a header button is that button's click: capturing the pointer here would send the
    // click to the header instead (close, minimise and the eyedropper never fired)
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.stopPropagation();

    isDraggingWindowRef.current = true;
    windowDragStartRef.current = {
      x: e.clientX - windowPos.x,
      y: e.clientY - windowPos.y,
    };

    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}

    const onPointerMove = (ev: PointerEvent) => {
      if (!isDraggingWindowRef.current) return;
      ev.preventDefault();
      const maxX = Math.max(10, window.innerWidth - 80);
      const maxY = Math.max(10, window.innerHeight - 50);
      setWindowPos({
        x: Math.max(0, Math.min(maxX, ev.clientX - windowDragStartRef.current.x)),
        y: Math.max(0, Math.min(maxY, ev.clientY - windowDragStartRef.current.y)),
      });
    };

    const onPointerUp = (ev: PointerEvent) => {
      isDraggingWindowRef.current = false;
      try {
        (ev.target as HTMLElement)?.releasePointerCapture?.(ev.pointerId);
      } catch {}
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  // Canvas Pan & Wheel Zoom
  const handleCanvasWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    setZoom((prev) => Math.max(0.1, Math.min(6.0, prev * factor)));
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}

    if (e.button === 0 && !eyedropperActive) {
      isPanningRef.current = true;
      panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    } else if (e.button === 1 || e.altKey) {
      isPanningRef.current = true;
      panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    } else if (eyedropperActive && hoverColor) {
      // Pick Color
      onPickColor(hoverColor.hex);
      setPickedToast(`已吸取顏色: ${hoverColor.hex}`);
      setTimeout(() => setPickedToast(null), 2500);
    }
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isPanningRef.current) {
      setPan({
        x: e.clientX - panStartRef.current.x,
        y: e.clientY - panStartRef.current.y,
      });
      return;
    }

    // Sample color under cursor
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = Math.floor(e.clientX - rect.left);
    const sy = Math.floor(e.clientY - rect.top);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    try {
      const p = ctx.getImageData(sx, sy, 1, 1).data;
      if (p[3] > 0) {
        const hex = rgbToHex(p[0], p[1], p[2]).toUpperCase();
        setHoverColor({ hex, r: p[0], g: p[1], b: p[2] });
      } else {
        setHoverColor(null);
      }
    } catch {
      setHoverColor(null);
    }
  };

  const handleCanvasPointerUp = () => {
    isPanningRef.current = false;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setImageSrc(url);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      setImageSrc(url);
    }
  };

  return (
    <div
      style={{
        left: `${windowPos.x}px`,
        top: `${windowPos.y}px`,
        opacity,
      }}
      className="atelier-popover atelier-window fixed z-40 flex select-none flex-col overflow-hidden text-neutral-200 transition-opacity duration-150"
    >
      {/* Window Header */}
      <div
        onPointerDown={handleWindowHeaderPointerDown}
        className="flex h-9 cursor-grab touch-none select-none items-center justify-between gap-2 border-b border-neutral-700/70 bg-neutral-800/60 pl-3 pr-1 text-xs active:cursor-grabbing"
      >
        <div className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-indigo-400" />
          <span className="font-semibold text-neutral-100">{t.reference.title}</span>
        </div>

        <div className="flex items-center gap-1">
          {/* Eyedropper mode button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setEyedropperActive(!eyedropperActive);
            }}
            title={eyedropperActive ? '目前為滴管吸色模式 (點擊吸取)' : '目前為平移檢視模式'}
            className={`p-1 rounded transition flex items-center gap-1 text-[11px] ${
              eyedropperActive
                ? 'bg-indigo-600 text-white font-semibold shadow-sm'
                : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
            }`}
          >
            <Pipette className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{t.tools.eyedropper}</span>
          </button>

          {/* Minimize toggle */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsMinimized(!isMinimized);
            }}
            className="p-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition"
          >
            {isMinimized ? <Expand className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
          </button>

          {/* Close */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="p-1 rounded text-neutral-400 hover:text-rose-400 hover:bg-neutral-800 transition"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!isMinimized && (
        <>
          {/* Main Canvas Viewport Area */}
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            style={{ width: viewSize.w, height: viewSize.h }}
            className="relative flex items-center justify-center overflow-hidden border-b border-neutral-800 bg-neutral-950 cursor-crosshair"
          >
            {imgElement ? (
              <canvas
                ref={canvasRef}
                width={viewSize.w}
                height={viewSize.h}
                className="touch-none w-full h-full block"
                onWheel={handleCanvasWheel}
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
                onPointerCancel={handleCanvasPointerUp}
                onPointerLeave={() => {
                  isPanningRef.current = false;
                  setHoverColor(null);
                }}
              />
            ) : (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center justify-center p-6 text-center text-neutral-500 hover:text-neutral-300 transition cursor-pointer"
              >
                <Upload className="w-8 h-8 mb-2 opacity-40 text-neutral-400" />
                <p className="text-xs font-semibold text-neutral-400">{t.reference.openImage}</p>
                <p className="text-[10px] mt-1 text-neutral-600">{t.reference.dropHint}</p>
              </div>
            )}

            {/* Hidden File Input */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />

            {/* Hover Color Loupe Pill */}
            {hoverColor && (
              <div className="absolute bottom-2 left-2 pointer-events-none flex items-center gap-1.5 px-2 py-1 rounded-lg bg-neutral-900/90 border border-neutral-700/80 text-[11px] font-mono shadow-lg">
                <span
                  className="w-3.5 h-3.5 rounded-full border border-white/40 shadow-sm"
                  style={{ backgroundColor: hoverColor.hex }}
                />
                <span className="text-white font-bold">{hoverColor.hex}</span>
              </div>
            )}

            {/* Picked notification toast */}
            {pickedToast && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 pointer-events-none px-3 py-1 rounded-full bg-indigo-600 text-white text-[11px] font-semibold shadow-xl animate-fade-in">
                {pickedToast}
              </div>
            )}
            <div aria-label="調整大小" title="拖曳調整大小" style={{ touchAction: 'none' }}
              onPointerDown={(e) => {
                const start = viewSize;
                startDrag(e, (dx, dy) => setViewSize({
                  w: Math.round(Math.max(220, Math.min(window.innerWidth - 40, start.w + dx))),
                  h: Math.round(Math.max(160, Math.min(window.innerHeight - 200, start.h + dy))),
                }));
              }}
              className="absolute bottom-0 right-0 z-10 h-4 w-4 cursor-nwse-resize">
              <svg viewBox="0 0 16 16" className="h-4 w-4 text-neutral-500"><path d="M15 6L6 15M15 11l-4 4" stroke="currentColor" strokeWidth="1.5" /></svg>
            </div>
          </div>

          {/* Bottom Toolbar & Viewport Controls */}
          <div className="space-y-2 p-2.5 text-xs">
            {/* Row 1: Zoom & Rotate & Flip & Reset buttons */}
            <div className="flex items-center justify-between gap-1">
              {/* Zoom buttons */}
              <div className="flex items-center gap-0.5 bg-neutral-900 p-0.5 rounded-lg border border-neutral-800">
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.max(0.1, z * 0.85))}
                  title={t.reference.zoomOut}
                  className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-800 transition"
                >
                  <Minus className="w-3 h-3" />
                </button>
                <span className="px-1 font-mono text-[10px] text-neutral-300 w-9 text-center">
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.min(6.0, z * 1.15))}
                  title={t.reference.zoomIn}
                  className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-800 transition"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>

              {/* Rotate 90 deg */}
              <button
                type="button"
                onClick={() => setRotationDeg((deg) => (deg + 90) % 360)}
                title="順時針旋轉 90°"
                className="p-1.5 rounded-lg bg-neutral-900 border border-neutral-800 text-neutral-300 hover:text-white hover:bg-neutral-800 transition flex items-center gap-1 text-[11px]"
              >
                <RotateCw className="w-3 h-3" />
                <span>90°</span>
              </button>

              {/* Flip Horizontal */}
              <button
                type="button"
                onClick={() => setIsFlippedH(!isFlippedH)}
                title={t.reference.flipH}
                className={`p-1.5 rounded-lg border text-[11px] transition flex items-center gap-1 ${
                  isFlippedH
                    ? 'bg-cyan-950 border-cyan-700 text-cyan-300 font-semibold'
                    : 'bg-neutral-900 border-neutral-800 text-neutral-300 hover:text-white hover:bg-neutral-800'
                }`}
              >
                <FlipHorizontal className="w-3 h-3" />
                <span>{t.reference.flipH}</span>
              </button>

              {/* Reset 1:1 View */}
              <button
                type="button"
                onClick={() => {
                  setZoom(1.0);
                  setPan({ x: 0, y: 0 });
                  setRotationDeg(0);
                  setIsFlippedH(false);
                }}
                title={t.reference.fitView}
                className="p-1.5 rounded-lg bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-800 transition text-[11px]"
              >
                {t.common.reset}
              </button>
            </div>

            {/* Row 2: Window Opacity Slider */}
            <div className="flex items-center justify-between text-[11px] text-neutral-400 pt-1">
              <span className="flex items-center gap-1">
                <Eye className="w-3 h-3 text-neutral-400" />
                <span>{t.reference.opacity}</span>
              </span>
              <div className="flex items-center gap-2 w-32">
                <input
                  type="range"
                  min="0.3"
                  max="1.0"
                  step="0.05"
                  value={opacity}
                  onChange={(e) => setOpacity(parseFloat(e.target.value))}
                  className="w-full h-1.5"
                />
                <span className="font-mono text-[10px] w-6">{Math.round(opacity * 100)}%</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
