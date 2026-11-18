import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Maximize2,
  Minimize2,
  Move,
  RotateCw,
  Sparkles,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

interface AvatarCropModalProps {
  isOpen: boolean;
  imageSrc: string | null;
  userThemeColor?: string;
  onClose: () => void;
  onConfirm: (croppedDataUrl: string) => void;
}

export const AvatarCropModal: React.FC<AvatarCropModalProps> = ({
  isOpen,
  imageSrc,
  userThemeColor = '#6366f1',
  onClose,
  onConfirm,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const [zoom, setZoom] = useState<number>(1.0);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [rotation, setRotation] = useState<number>(0);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [previewDataUrl, setPreviewDataUrl] = useState<string>('');

  // Dragging state
  const isDraggingRef = useRef<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Multi-touch pinch state
  const initialPinchDistRef = useRef<number | null>(null);
  const initialPinchZoomRef = useRef<number>(1.0);

  const VIEWFINDER_SIZE = 220; // circular crop diameter in px

  // Reset transforms whenever a new image is loaded
  useEffect(() => {
    if (imageSrc && isOpen) {
      setZoom(1.0);
      setPan({ x: 0, y: 0 });
      setRotation(0);

      const img = new Image();
      img.onload = () => {
        setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.src = imageSrc;
    }
  }, [imageSrc, isOpen]);

  // Compute live crop preview whenever zoom, pan, or rotation changes
  useEffect(() => {
    if (!imageSrc || !naturalSize.width || !naturalSize.height) return;

    const timer = setTimeout(() => {
      const cropped = renderCroppedCanvas(128, 128);
      if (cropped) {
        setPreviewDataUrl(cropped);
      }
    }, 40);

    return () => clearTimeout(timer);
  }, [zoom, pan, rotation, naturalSize, imageSrc]);

  if (!isOpen || !imageSrc) return null;

  // Render to offscreen canvas using exact math
  const renderCroppedCanvas = (targetW = 128, targetH = 128): string | null => {
    if (!imageRef.current || !naturalSize.width || !naturalSize.height) return null;

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Scale ratio from viewfinder (VIEWFINDER_SIZE px) to target output (targetW px)
    const scaleRatio = targetW / VIEWFINDER_SIZE;

    // Base fitting scale so the image covers or fits nicely into the viewfinder at zoom = 1.0
    const baseFitScale = Math.max(
      VIEWFINDER_SIZE / naturalSize.width,
      VIEWFINDER_SIZE / naturalSize.height
    );

    ctx.save();
    // 1. Move to canvas center (e.g. 64, 64)
    ctx.translate(targetW / 2, targetH / 2);

    // 2. Apply user pan (scaled by scaleRatio)
    ctx.translate(pan.x * scaleRatio, pan.y * scaleRatio);

    // 3. Apply user rotation
    ctx.rotate((rotation * Math.PI) / 180);

    // 4. Apply combined scale (baseFitScale * zoom * scaleRatio)
    const totalScale = baseFitScale * zoom * scaleRatio;
    ctx.scale(totalScale, totalScale);

    // 5. Draw image centered
    ctx.drawImage(
      imageRef.current,
      -naturalSize.width / 2,
      -naturalSize.height / 2,
      naturalSize.width,
      naturalSize.height
    );

    ctx.restore();
    return canvas.toDataURL('image/jpeg', 0.88);
  };

  // Mouse / Pointer Drag Handlers
  const handlePointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    isDraggingRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    panStartRef.current = { ...pan };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPan({
      x: panStartRef.current.x + dx,
      y: panStartRef.current.y + dy,
    });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    isDraggingRef.current = false;
  };

  // Mouse Wheel Zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 0.08 : -0.08;
    setZoom((prev) => Math.min(3.5, Math.max(0.4, Number((prev + factor).toFixed(2)))));
  };

  // Touch Pinch-to-zoom
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      initialPinchDistRef.current = dist;
      initialPinchZoomRef.current = zoom;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && initialPinchDistRef.current !== null) {
      e.preventDefault();
      const currentDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const scale = currentDist / initialPinchDistRef.current;
      const nextZoom = Math.min(3.5, Math.max(0.4, Number((initialPinchZoomRef.current * scale).toFixed(2))));
      setZoom(nextZoom);
    }
  };

  const handleTouchEnd = () => {
    initialPinchDistRef.current = null;
  };

  // Rotate 90 degrees
  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  // Reset Center & Zoom
  const handleReset = () => {
    setZoom(1.0);
    setPan({ x: 0, y: 0 });
    setRotation(0);
  };

  // Confirm and Export
  const handleConfirm = () => {
    const cropped = renderCroppedCanvas(128, 128);
    if (cropped) {
      onConfirm(cropped);
    }
  };

  // Base fit scale in interactive DOM viewport
  const baseFitScale = naturalSize.width && naturalSize.height
    ? Math.max(VIEWFINDER_SIZE / naturalSize.width, VIEWFINDER_SIZE / naturalSize.height)
    : 1;

  return (
    <div role="dialog" aria-modal="true" className="atelier-modal-backdrop fixed inset-0 z-[70] flex items-center justify-center p-2 sm:p-4 animate-in fade-in duration-200 select-none">
      <div className="atelier-modal max-h-[calc(100dvh-1rem)] max-w-sm sm:max-w-md w-full overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-neutral-800/80 bg-neutral-900/80 flex shrink-0 items-center justify-between">
          <div className="flex items-center gap-2 text-white font-bold text-sm">
            <span className="p-1 rounded-lg bg-indigo-600/30 text-indigo-400">✂️</span>
            <span>自訂頭像縮放與裁切</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Viewport Area */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5 flex flex-col items-center gap-4">
          <div
            ref={containerRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onWheel={handleWheel}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            className="relative w-[280px] h-[280px] bg-neutral-950 rounded-2xl overflow-hidden border border-neutral-800 shadow-inner flex items-center justify-center cursor-grab active:cursor-grabbing touch-none select-none"
            title="滑鼠或觸控拖曳平移，滾輪或滑桿放大縮小"
          >
            {/* Background grid texture */}
            <div
              className="absolute inset-0 opacity-15 pointer-events-none"
              style={{
                backgroundImage:
                  'radial-gradient(circle, #6366f1 1px, transparent 1px)',
                backgroundSize: '16px 16px',
              }}
            />

            {/* Transformable Image Layer */}
            <div
              className="absolute pointer-events-none transition-transform duration-75 will-change-transform"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) rotate(${rotation}deg) scale(${baseFitScale * zoom})`,
                transformOrigin: 'center center',
              }}
            >
              <img
                ref={imageRef}
                src={imageSrc}
                alt="Avatar Source"
                className="max-w-none select-none pointer-events-none block"
                draggable={false}
              />
            </div>

            {/* Dark Vignette Mask (Masking out non-circular regions) */}
            <div
              className="absolute pointer-events-none rounded-full"
              style={{
                width: `${VIEWFINDER_SIZE}px`,
                height: `${VIEWFINDER_SIZE}px`,
                boxShadow: '0 0 0 9999px rgba(10, 11, 16, 0.72)',
              }}
            />

            {/* Circular Viewfinder Ring */}
            <div
              className="absolute pointer-events-none rounded-full border-2 border-indigo-500/90 shadow-xl flex items-center justify-center"
              style={{
                width: `${VIEWFINDER_SIZE}px`,
                height: `${VIEWFINDER_SIZE}px`,
                borderColor: userThemeColor,
                boxShadow: `0 0 25px ${userThemeColor}44, inset 0 0 15px ${userThemeColor}22`,
              }}
            >
              {/* Soft crosshair / guide for facial alignment */}
              <div className="absolute w-full h-px bg-white/10" />
              <div className="absolute h-full w-px bg-white/10" />
              <div className="w-12 h-12 rounded-full border border-dashed border-white/20" />
            </div>

            {/* Hint overlay pill */}
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-black/60 text-[10px] text-neutral-300 font-medium pointer-events-none backdrop-blur-sm border border-white/10">
              拖曳調整位置 • 雙指縮放
            </div>
          </div>

          {/* Zoom Slider and Adjustment Controls */}
          <div className="w-full max-w-[280px] flex flex-col gap-2.5">
            <div className="flex items-center justify-between text-xs text-neutral-400 font-medium px-1">
              <span className="flex items-center gap-1">
                <ZoomIn className="w-3.5 h-3.5 text-indigo-400" />
                <span>縮放比例</span>
              </span>
              <span className="font-mono text-indigo-300 font-bold">
                {Math.round(zoom * 100)}%
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.4, Number((z - 0.1).toFixed(2))))}
                className="p-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 transition active:scale-95 shrink-0"
                title="縮小"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>

              <input
                type="range"
                min="0.4"
                max="3.5"
                step="0.05"
                value={zoom}
                onChange={(e) => setZoom(parseFloat(e.target.value))}
                className="flex-1 accent-indigo-500 h-1.5 bg-neutral-800 rounded-lg cursor-pointer"
              />

              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(3.5, Number((z + 0.1).toFixed(2))))}
                className="p-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 transition active:scale-95 shrink-0"
                title="放大"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Quick action buttons (Rotate, Reset) */}
            <div className="flex items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={handleRotate}
                className="flex-1 py-1.5 px-2 rounded-xl bg-neutral-800/90 hover:bg-neutral-700 text-neutral-300 text-xs font-semibold flex items-center justify-center gap-1.5 transition active:scale-95 border border-neutral-700/60"
              >
                <RotateCw className="w-3.5 h-3.5 text-cyan-400" />
                <span>旋轉 90°</span>
              </button>

              <button
                type="button"
                onClick={handleReset}
                className="flex-1 py-1.5 px-2 rounded-xl bg-neutral-800/90 hover:bg-neutral-700 text-neutral-300 text-xs font-semibold flex items-center justify-center gap-1.5 transition active:scale-95 border border-neutral-700/60"
              >
                <Move className="w-3.5 h-3.5 text-indigo-400" />
                <span>置中重設</span>
              </button>
            </div>
          </div>

          {/* Live Preview Bar */}
          <div className="w-full max-w-[280px] p-2.5 rounded-2xl bg-neutral-900/60 border border-neutral-800/80 flex items-center justify-between">
            <span className="text-[11px] text-neutral-400 font-medium pl-1">
              即時預覽效果:
            </span>
            <div className="flex items-center gap-3">
              {/* 36px Cursor preview */}
              <div
                className="w-9 h-9 rounded-full overflow-hidden border-2 shadow-md shrink-0 flex items-center justify-center bg-black"
                style={{ borderColor: userThemeColor }}
              >
                {previewDataUrl ? (
                  <img
                    src={previewDataUrl}
                    alt="Preview 36px"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-xs text-neutral-500">...</span>
                )}
              </div>

              {/* 24px Navbar preview */}
              <div
                className="w-6 h-6 rounded-full overflow-hidden border shadow-sm shrink-0 flex items-center justify-center bg-black"
                style={{ borderColor: userThemeColor }}
              >
                {previewDataUrl ? (
                  <img
                    src={previewDataUrl}
                    alt="Preview 24px"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-[9px] text-neutral-500">...</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 border-t border-neutral-800 bg-neutral-900/80 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs font-semibold transition"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-5 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white text-xs font-bold shadow-lg shadow-indigo-600/30 flex items-center gap-1.5 transition active:scale-95"
          >
            <Check className="w-3.5 h-3.5" />
            <span>套用裁切頭像</span>
          </button>
        </div>
      </div>
    </div>
  );
};
