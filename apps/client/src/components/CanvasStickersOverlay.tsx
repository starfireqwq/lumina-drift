import React, { useState, useRef } from 'react';
import { CanvasSticker } from '@atelier/shared';
import {
  Eye,
  EyeOff,
  FlipHorizontal,
  Lock,
  Maximize2,
  Minimize2,
  Move,
  Palette,
  Pin,
  Plus,
  Share2,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';

interface CanvasStickersOverlayProps {
  stickers: CanvasSticker[];
  currentUserId?: string;
  zoom: number;
  pan: { x: number; y: number };
  onUpdateSticker: (stickerId: string, updates: Partial<CanvasSticker>) => void;
  onRemoveSticker: (stickerId: string) => void;
  onAddSticker: (sticker: Omit<CanvasSticker, 'id' | 'createdAt'>) => void;
}

export const PRESET_REACTION_STICKERS = [
  {
    title: '摸魚中',
    text: '🐟 摸魚中...',
    bgColor: '#3b82f6',
  },
  {
    title: '神仙畫畫',
    text: '🎨 神仙合繪！',
    bgColor: '#8b5cf6',
  },
  {
    title: '草稿讚',
    text: '✨ 草稿大好！',
    bgColor: '#10b981',
  },
  {
    title: '手殘求救',
    text: '💦 手殘了救命',
    bgColor: '#f97316',
  },
  {
    title: '進度狂飆',
    text: '🚀 完稿衝刺',
    bgColor: '#ec4899',
  },
  {
    title: '急了',
    text: '🔥 我急了！',
    bgColor: '#ef4444',
  },
];

export const CanvasStickersOverlay: React.FC<CanvasStickersOverlayProps> = ({
  stickers,
  currentUserId,
  zoom,
  pan,
  onUpdateSticker,
  onRemoveSticker,
  onAddSticker,
}) => {
  const [activeStickerId, setActiveStickerId] = useState<string | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Dragging state
  const dragRef = useRef<{
    stickerId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  // Resizing state
  const resizeRef = useRef<{
    stickerId: string;
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const handlePointerDownDrag = (e: React.PointerEvent, s: CanvasSticker) => {
    if (s.isLocked) return;
    e.stopPropagation();
    setActiveStickerId(s.id);

    dragRef.current = {
      stickerId: s.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: s.x,
      origY: s.y,
    };

    const handlePointerMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = (ev.clientX - dragRef.current.startX) / (s.isPinnedToScreen ? 1 : zoom);
      const dy = (ev.clientY - dragRef.current.startY) / (s.isPinnedToScreen ? 1 : zoom);

      onUpdateSticker(dragRef.current.stickerId, {
        x: Math.round(dragRef.current.origX + dx),
        y: Math.round(dragRef.current.origY + dy),
      });
    };

    const handlePointerUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const handlePointerDownResize = (e: React.PointerEvent, s: CanvasSticker) => {
    if (s.isLocked) return;
    e.stopPropagation();

    resizeRef.current = {
      stickerId: s.id,
      startX: e.clientX,
      startY: e.clientY,
      origW: s.width,
      origH: s.height,
    };

    const handlePointerMove = (ev: PointerEvent) => {
      if (!resizeRef.current) return;
      const dx = (ev.clientX - resizeRef.current.startX) / (s.isPinnedToScreen ? 1 : zoom);
      const dy = (ev.clientY - resizeRef.current.startY) / (s.isPinnedToScreen ? 1 : zoom);

      const newW = Math.max(64, Math.round(resizeRef.current.origW + dx));
      const newH = Math.max(64, Math.round(resizeRef.current.origH + dy));

      onUpdateSticker(resizeRef.current.stickerId, {
        width: newW,
        height: newH,
      });
    };

    const handlePointerUp = () => {
      resizeRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const handleUploadImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        const img = new Image();
        img.onload = () => {
          let w = img.width;
          let h = img.height;
          // Scale down if massive
          if (w > 600 || h > 600) {
            const ratio = Math.min(600 / w, 600 / h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
          }

          onAddSticker({
            canvasId: '',
            ownerId: currentUserId || 'me',
            ownerName: '我',
            title: file.name,
            imageUrl: reader.result as string,
            x: 200,
            y: 200,
            width: w,
            height: h,
            opacity: 0.9,
            isLocked: false,
            isFlippedH: false,
            isGrayscale: false,
            isPinnedToScreen: false,
            isShared: true,
          });
        };
        img.src = reader.result;
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
    setIsPickerOpen(false);
  };

  const handleAddPresetSticker = (preset: typeof PRESET_REACTION_STICKERS[0]) => {
    // Generate a rich canvas SVG/DataURL badge
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 90;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // Rounded pill badge
      ctx.fillStyle = preset.bgColor;
      ctx.beginPath();
      ctx.roundRect(4, 4, 232, 82, 16);
      ctx.fill();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(preset.text, 120, 45);

      onAddSticker({
        canvasId: '',
        ownerId: currentUserId || 'me',
        ownerName: '我',
        title: preset.title,
        imageUrl: canvas.toDataURL('image/png'),
        x: 300,
        y: 300,
        width: 200,
        height: 75,
        opacity: 0.95,
        isLocked: false,
        isFlippedH: false,
        isGrayscale: false,
        isPinnedToScreen: false,
        isShared: true,
      });
    }
    setIsPickerOpen(false);
  };

  return (
    <div className="absolute inset-0 pointer-events-none z-20 overflow-hidden">
      {/* 1. Floating Sticker Picker Trigger Button */}
      {/* stopPropagation: this sits inside the canvas, whose pointerdown would otherwise paint here too */}
      <div className="absolute bottom-3 right-3 pointer-events-auto flex items-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => setIsPickerOpen(!isPickerOpen)}
          aria-expanded={isPickerOpen}
          className="flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-900/90 px-2.5 py-1.5 text-[11px] font-medium text-neutral-200 shadow-lg backdrop-blur-md transition hover:bg-neutral-800"
          title="貼圖與參考圖"
        >
          <Pin className="w-3.5 h-3.5 text-indigo-400" />
          <span className="hidden sm:inline">貼圖</span>
        </button>

        {isPickerOpen && (
          <div className="atelier-popover atelier-menu-in absolute bottom-12 right-0 flex w-72 flex-col gap-2 p-3 text-xs">
            <div className="flex items-center justify-between pb-1.5 border-b border-neutral-800">
              <span className="font-semibold flex items-center gap-1.5 text-white">
                <Palette className="w-4 h-4 text-indigo-400" />
                貼圖
              </span>
              <button
                type="button"
                onClick={() => setIsPickerOpen(false)}
                className="text-neutral-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Upload Custom Reference Image */}
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-200 font-medium transition"
              >
                <Plus className="w-4 h-4 text-indigo-400" />
                <span>上傳圖片</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleUploadImage}
                className="hidden"
              />
            </div>

            {/* Quick Artist Meme Stickers */}
            <div className="text-[11px] text-neutral-400 pt-1">社群即時貼圖：</div>
            <div className="grid grid-cols-2 gap-1.5">
              {PRESET_REACTION_STICKERS.map((pst) => (
                <button
                  key={pst.title}
                  type="button"
                  onClick={() => handleAddPresetSticker(pst)}
                  style={{ backgroundColor: pst.bgColor + '33', borderColor: pst.bgColor + '88' }}
                  className="p-1.5 rounded-lg border text-[11px] font-medium text-white hover:brightness-125 transition truncate"
                >
                  {pst.text}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 2. Render Canvas Stickers & Reference Pins */}
      {stickers.map((s) => {
        // Calculate screen coordinates
        const screenX = s.isPinnedToScreen ? s.x : s.x * zoom + pan.x;
        const screenY = s.isPinnedToScreen ? s.y : s.y * zoom + pan.y;
        const screenW = s.isPinnedToScreen ? s.width : s.width * zoom;
        const screenH = s.isPinnedToScreen ? s.height : s.height * zoom;

        const isSelected = activeStickerId === s.id;

        return (
          <div
            key={s.id}
            onClick={() => setActiveStickerId(s.id)}
            style={{
              transform: `translate(${screenX}px, ${screenY}px)`,
              width: `${screenW}px`,
              height: `${screenH}px`,
              opacity: s.opacity ?? 0.9,
            }}
            className={`absolute pointer-events-auto rounded-lg select-none group transition-shadow ${
              isSelected ? 'ring-2 ring-indigo-500 shadow-2xl' : 'hover:ring-1 hover:ring-indigo-400/50'
            }`}
          >
            {/* Header Toolbar (Controls: Move, Lock, Flip, Grayscale, Opacity, Close) */}
            <div
              onPointerDown={(e) => handlePointerDownDrag(e, s)}
              className={`h-6 px-1.5 rounded-t-lg bg-neutral-900/90 backdrop-blur-md flex items-center justify-between text-[10px] text-neutral-300 cursor-move border-b border-neutral-800 transition ${
                isSelected || !s.isLocked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              <div className="flex items-center gap-1 truncate max-w-[120px]">
                <Move className="w-2.5 h-2.5 text-neutral-400" />
                <span className="truncate">{s.title || '釘選貼圖'}</span>
              </div>

              <div className="flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
                {/* Flip Horizontal */}
                <button
                  type="button"
                  onClick={() => onUpdateSticker(s.id, { isFlippedH: !s.isFlippedH })}
                  title="水平翻轉"
                  className="p-0.5 hover:text-white rounded"
                >
                  <FlipHorizontal className="w-3 h-3" />
                </button>

                {/* Grayscale Mode */}
                <button
                  type="button"
                  onClick={() => onUpdateSticker(s.id, { isGrayscale: !s.isGrayscale })}
                  title="灰階對比模式 (Grayscale)"
                  className={`p-0.5 rounded ${s.isGrayscale ? 'text-indigo-400' : 'hover:text-white'}`}
                >
                  <Palette className="w-3 h-3" />
                </button>

                {/* Lock Position */}
                <button
                  type="button"
                  onClick={() => onUpdateSticker(s.id, { isLocked: !s.isLocked })}
                  title={s.isLocked ? '已鎖定 (點擊解鎖)' : '鎖定位置'}
                  className={`p-0.5 rounded ${s.isLocked ? 'text-amber-400' : 'hover:text-white'}`}
                >
                  {s.isLocked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                </button>

                {/* Delete Pin */}
                <button
                  type="button"
                  onClick={() => onRemoveSticker(s.id)}
                  title="移除貼圖"
                  className="p-0.5 hover:text-rose-400 rounded"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Sticker Image Content */}
            <div className="w-full h-[calc(100%-24px)] overflow-hidden rounded-b-lg relative bg-neutral-900/40">
              <img
                src={s.imageUrl}
                alt={s.title}
                draggable={false}
                style={{
                  transform: s.isFlippedH ? 'scaleX(-1)' : 'none',
                  filter: s.isGrayscale ? 'grayscale(100%)' : 'none',
                }}
                className="w-full h-full object-contain pointer-events-none"
              />

              {/* Bottom Opacity Bar on Hover */}
              <div
                className="absolute bottom-0 inset-x-0 h-4 bg-black/60 backdrop-blur-sm opacity-0 group-hover:opacity-100 flex items-center px-1.5 transition text-[9px] gap-1 text-white"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <span>不透明度:</span>
                <input
                  type="range"
                  min="0.1"
                  max="1.0"
                  step="0.05"
                  value={s.opacity ?? 0.9}
                  onChange={(e) => onUpdateSticker(s.id, { opacity: parseFloat(e.target.value) })}
                  className="w-16 h-1 accent-indigo-500 cursor-pointer"
                />
              </div>

              {/* Bottom-right Resize Handle */}
              {!s.isLocked && (
                <div
                  onPointerDown={(e) => handlePointerDownResize(e, s)}
                  className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize flex items-center justify-center text-neutral-400 hover:text-white bg-black/50 rounded-tl"
                >
                  <Maximize2 className="w-2.5 h-2.5" />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
