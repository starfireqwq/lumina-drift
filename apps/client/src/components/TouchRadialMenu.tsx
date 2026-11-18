import React, { useEffect, useState } from 'react';
import {
  Compass,
  Eraser,
  FlipHorizontal,
  Image as ImageIcon,
  Paintbrush,
  Pipette,
  Redo2,
  Undo2,
  XSquare,
} from 'lucide-react';

export interface RadialMenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  action: () => void;
  color?: string;
}

interface TouchRadialMenuProps {
  isOpen: boolean;
  position: { x: number; y: number };
  onClose: () => void;
  canUndo: boolean;
  canRedo: boolean;
  isEraser: boolean;
  currentColor: string;
  onUndo: () => void;
  onRedo: () => void;
  onSelectEyedropper: () => void;
  onToggleEraser: () => void;
  onFlipCanvas: () => void;
  onToggleRuler: () => void;
  onToggleReference: () => void;
  onClearSelection: () => void;
}

export const TouchRadialMenu: React.FC<TouchRadialMenuProps> = ({
  isOpen,
  position,
  onClose,
  canUndo,
  canRedo,
  isEraser,
  currentColor,
  onUndo,
  onRedo,
  onSelectEyedropper,
  onToggleEraser,
  onFlipCanvas,
  onToggleRuler,
  onToggleReference,
  onClearSelection,
}) => {
  const [activeSliceIndex, setActiveSliceIndex] = useState<number | null>(null);

  const items: RadialMenuItem[] = [
    {
      id: 'undo',
      label: '撤銷',
      icon: <Undo2 className="w-4 h-4" />,
      action: onUndo,
      color: canUndo ? '#818CF8' : '#6B7280',
    },
    {
      id: 'redo',
      label: '重做',
      icon: <Redo2 className="w-4 h-4" />,
      action: onRedo,
      color: canRedo ? '#818CF8' : '#6B7280',
    },
    {
      id: 'eyedropper',
      label: '吸管',
      icon: <Pipette className="w-4 h-4" />,
      action: onSelectEyedropper,
      color: '#06B6D4',
    },
    {
      id: 'eraser',
      label: isEraser ? '畫筆' : '橡皮擦',
      icon: isEraser ? <Paintbrush className="w-4 h-4" /> : <Eraser className="w-4 h-4" />,
      action: onToggleEraser,
      color: '#EC4899',
    },
    {
      id: 'flip',
      label: '翻轉',
      icon: <FlipHorizontal className="w-4 h-4" />,
      action: onFlipCanvas,
      color: '#10B981',
    },
    {
      id: 'ruler',
      label: '尺規',
      icon: <Compass className="w-4 h-4" />,
      action: onToggleRuler,
      color: '#A855F7',
    },
    {
      id: 'reference',
      label: '參考圖',
      icon: <ImageIcon className="w-4 h-4" />,
      action: onToggleReference,
      color: '#38BDF8',
    },
    {
      id: 'deselect',
      label: '清選區',
      icon: <XSquare className="w-4 h-4" />,
      action: onClearSelection,
      color: '#F59E0B',
    },
  ];

  const sliceCount = items.length;
  const radius = 118;
  const innerRadius = 40;

  // Clamped position so the menu doesn't overflow screen bounds
  const clampedX = Math.max(radius + 20, Math.min(window.innerWidth - radius - 20, position.x));
  const clampedY = Math.max(radius + 20, Math.min(window.innerHeight - radius - 20, position.y));

  useEffect(() => {
    if (!isOpen) { setActiveSliceIndex(null); return; }
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[90] pointer-events-auto select-none touch-none">
      {/* Background Dim Backdrop */}
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-[2px] transition-opacity"
        onPointerDown={(e) => {
          e.currentTarget.dataset.armed = '1';
        }}
        onPointerCancel={(e) => {
          delete e.currentTarget.dataset.armed;
        }}
        onClick={(e) => {
          // 長按喚出圓盤的手指抬起時會補發 click，不可立刻關閉；僅接受喚出後的真實點擊
          if (e.currentTarget.dataset.armed !== '1') return;
          delete e.currentTarget.dataset.armed;
          onClose();
        }}
      />

      {/* Radial Menu Ring */}
      {/* Positioned without a transform: the spin-open animation owns `transform` */}
      <div
        style={{
          left: `${clampedX - radius}px`,
          top: `${clampedY - radius}px`,
          width: `${radius * 2}px`,
          height: `${radius * 2}px`,
        }}
        className="absolute rounded-full shadow-2xl flex items-center justify-center atelier-wheel-spin"
      >
        <svg
          className="absolute inset-0 w-full h-full overflow-visible"
          viewBox={`-${radius} -${radius} ${radius * 2} ${radius * 2}`}
        >
          <defs>
            <filter id="radial-glow">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Slices */}
          {items.map((item, idx) => {
            const step = (Math.PI * 2) / sliceCount;
            const startAngle = idx * step - step / 2;
            const endAngle = startAngle + step;

            const x1 = Math.cos(startAngle) * radius;
            const y1 = Math.sin(startAngle) * radius;
            const x2 = Math.cos(endAngle) * radius;
            const y2 = Math.sin(endAngle) * radius;

            const ix1 = Math.cos(startAngle) * innerRadius;
            const iy1 = Math.sin(startAngle) * innerRadius;
            const ix2 = Math.cos(endAngle) * innerRadius;
            const iy2 = Math.sin(endAngle) * innerRadius;

            const isHovered = activeSliceIndex === idx;

            // SVG Donut Slice Path
            const pathData = `
              M ${ix1} ${iy1}
              L ${x1} ${y1}
              A ${radius} ${radius} 0 0 1 ${x2} ${y2}
              L ${ix2} ${iy2}
              A ${innerRadius} ${innerRadius} 0 0 0 ${ix1} ${iy1}
              Z
            `;

            return (
              <path
                key={item.id}
                d={pathData}
                fill={isHovered ? '#4F46E5' : '#181920'}
                fillOpacity={isHovered ? 0.95 : 0.88}
                stroke={isHovered ? '#A5B4FC' : '#2E313D'}
                strokeWidth={isHovered ? 2 : 1}
                filter={isHovered ? 'url(#radial-glow)' : 'none'}
                className="transition-colors duration-75 cursor-pointer atelier-wheel-slice"
                style={{ animationDelay: `${idx * 28}ms` }}
                onPointerEnter={() => setActiveSliceIndex(idx)}
                onPointerLeave={() => setActiveSliceIndex(null)}
                onClick={() => {
                  if ((item.id === 'undo' && !canUndo) || (item.id === 'redo' && !canRedo)) return;
                  item.action();
                  onClose();
                }}
              />
            );
          })}
        </svg>

        {/* Slice Icons & Labels (Precisely Centered Radially) */}
        {items.map((item, idx) => {
          const step = (Math.PI * 2) / sliceCount;
          const midAngle = idx * step;
          const iconDist = (radius + innerRadius) / 2;
          const ix = Math.round(Math.cos(midAngle) * iconDist);
          const iy = Math.round(Math.sin(midAngle) * iconDist);
          const isHovered = activeSliceIndex === idx;

          return (
            <button
              type="button"
              aria-label={item.label}
              disabled={(item.id === "undo" && !canUndo) || (item.id === "redo" && !canRedo)}
              onClick={() => { item.action(); onClose(); }}
              onFocus={() => setActiveSliceIndex(idx)}
              onBlur={() => setActiveSliceIndex(null)}
              key={`label-${item.id}`}
              style={{
                left: `${radius + ix}px`,
                top: `${radius + iy}px`,
                transform: `translate(-50%, -50%) ${isHovered ? 'scale(1.18)' : 'scale(1)'}`,
                width: '54px',
                height: '40px',
                willChange: 'transform',
                animationDelay: `${idx * 28 + 60}ms`,
              }}
              className="absolute pointer-events-auto flex flex-col items-center justify-center transition-transform duration-75 select-none disabled:opacity-50 atelier-wheel-slice"
            >
              <div
                style={{ color: isHovered ? '#FFFFFF' : item.color || '#E0E7FF' }}
                className="transition-colors flex items-center justify-center shrink-0"
              >
                {item.icon}
              </div>
              <span
                className={`text-[10px] font-semibold tracking-tight transition-colors whitespace-nowrap leading-none mt-1 ${
                  isHovered ? 'text-white' : 'text-neutral-300'
                }`}
              >
                {item.label}
              </span>
            </button>
          );
        })}

        {/* Center Hub */}
        <div
          onPointerDown={(e) => {
            e.currentTarget.dataset.armed = '1';
          }}
          onPointerCancel={(e) => {
            delete e.currentTarget.dataset.armed;
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (e.currentTarget.dataset.armed !== '1') return;
            delete e.currentTarget.dataset.armed;
            onClose();
          }}
          style={{ width: `${innerRadius * 2 - 4}px`, height: `${innerRadius * 2 - 4}px` }}
          className="absolute rounded-full bg-neutral-950 border border-neutral-700/80 shadow-inner flex flex-col items-center justify-center cursor-pointer hover:bg-neutral-800 transition"
        >
          <div
            className="w-4 h-4 rounded-full border border-white/40 shadow-sm"
            style={{ backgroundColor: currentColor }}
          />
          <span className="text-[8px] text-neutral-400 font-mono mt-0.5">關閉</span>
        </div>
      </div>
    </div>
  );
};
