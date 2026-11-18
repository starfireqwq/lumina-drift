import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pipette,
  RotateCcw,
  Sparkles,
  X as CloseIcon,
  Check,
  Palette,
} from 'lucide-react';
import { ToolWindow } from './workspace/ToolWindow';
import { BrushProperties } from '../engine/BrushRenderer';
import { useUiScale } from '../theme/uiScale';
import { useI18n } from '../context/I18nContext';
import {
  type ColorWheelMode,
  type TriangleVerts,
  hslToRgb,
  rgbToHsl,
  getTriangleVertices,
  hsvToBarycentric,
  barycentricToHsv,
  clampPointToTriangleBarycentric,
  hsvToRgb,
  rgbToHex,
  hexToRgb,
  rgbToHsv,
} from '../utils/colorWheelMath';

export {
  type ColorWheelMode,
  type TriangleVerts,
  hslToRgb,
  rgbToHsl,
  getTriangleVertices,
  hsvToBarycentric,
  barycentricToHsv,
  clampPointToTriangleBarycentric,
};

interface ColorWheelStudioProps {
  isOpen: boolean;
  onClose: () => void;
  brushProps: BrushProperties;
  onUpdateBrushProps: (props: Partial<BrushProperties>) => void;
  onActivateCanvasEyedropper?: () => void;
  embedded?: boolean;
  /** Edits one colour only (e.g. the outline colour): no background slot, no X / D keys */
  single?: boolean;
}

const CHECKER_BG_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, #9ca3af 25%, transparent 25%), linear-gradient(-45deg, #9ca3af 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #9ca3af 75%), linear-gradient(-45deg, transparent 75%, #9ca3af 75%)',
  backgroundSize: '8px 8px',
  backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0px',
  backgroundColor: '#ffffff',
};

const WHEEL_MODE_STORAGE_KEY = 'atelier_color_wheel_mode';

export const ColorWheelStudio: React.FC<ColorWheelStudioProps> = ({
  isOpen,
  onClose,
  brushProps,
  onUpdateBrushProps,
  onActivateCanvasEyedropper,
  embedded = false,
  single = false,
}) => {
  const { t } = useI18n();
  const fgColor = brushProps.color || '#3B82F6';
  const bgColor = brushProps.secondaryColor || '#FFFFFF';

  // Which swatch is currently actively picked: 'fg' (foreground) or 'bg' (background)
  const [activeSlot, setActiveSlot] = useState<'fg' | 'bg'>('fg');
  const [wheelMode, setWheelMode] = useState<ColorWheelMode>(() => {
    try {
      return localStorage.getItem(WHEEL_MODE_STORAGE_KEY) === 'hls-triangle' ? 'hls-triangle' : 'hsv-square';
    } catch {
      return 'hsv-square';
    }
  });
  const isTransparent = !single && Boolean(brushProps.isEraser);
  const currentColor = activeSlot === 'fg' ? fgColor : bgColor;

  // HSV state
  const [hsv, setHsv] = useState<[number, number, number]>(() => {
    const [r, g, b] = hexToRgb(currentColor);
    return rgbToHsv(r, g, b);
  });
  const hsvRef = useRef<[number, number, number]>(hsv);
  const slotHueRef = useRef<{ fg: number; bg: number }>({
    fg: rgbToHsv(...hexToRgb(fgColor))[0],
    bg: rgbToHsv(...hexToRgb(bgColor))[0],
  });
  const lastEmittedRef = useRef<{ hex: string; slot: 'fg' | 'bg' } | null>(null);

  const [hexInput, setHexInput] = useState(currentColor);
  const [recentSwatches, setRecentSwatches] = useState<string[]>([
    '#000000', '#FFFFFF', '#EF4444', '#F97316', '#FBBF24', '#10B981',
    '#06B6D4', '#3B82F6', '#8B5CF6', '#EC4899', '#78350F', '#475569',
  ]);

  const wheelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDraggingWheel = useRef(false);
  const isDraggingSquare = useRef(false);

  // Sync HSV when external color slot changes (without resetting hue when touching white/black/gray or re-quantizing our own drag)
  useEffect(() => {
    const normHex = currentColor.toUpperCase();
    setHexInput(normHex);
    if (
      lastEmittedRef.current &&
      lastEmittedRef.current.slot === activeSlot &&
      lastEmittedRef.current.hex === normHex
    ) {
      lastEmittedRef.current = null;
      return;
    }
    lastEmittedRef.current = null;
    const [r, g, b] = hexToRgb(normHex);
    const next = rgbToHsv(r, g, b);
    if (r === g && g === b) {
      next[0] = slotHueRef.current[activeSlot];
    } else {
      slotHueRef.current[activeSlot] = next[0];
    }
    hsvRef.current = next;
    setHsv(next);
  }, [currentColor, activeSlot]);

  // Push to recent swatches
  const pushRecentSwatch = (color: string) => {
    setRecentSwatches((prev) => {
      const filtered = prev.filter((c) => c.toUpperCase() !== color.toUpperCase());
      return [color, ...filtered].slice(0, 16);
    });
  };

  // Live color preview during drag (does not pollute history swatches)
  const applyLiveColor = useCallback((hex: string) => {
    const normHex = hex.toUpperCase();
    if (normHex !== currentColor.toUpperCase()) {
      lastEmittedRef.current = { hex: normHex, slot: activeSlot };
    }
    if (activeSlot === 'fg') {
      onUpdateBrushProps({ color: hex, isEraser: false });
    } else {
      onUpdateBrushProps({ secondaryColor: hex });
    }
  }, [activeSlot, currentColor, onUpdateBrushProps]);

  // Commit color to brushProps & push to history swatches on pointer release
  const applyColor = useCallback((hex: string) => {
    const normHex = hex.toUpperCase();
    if (normHex !== currentColor.toUpperCase()) {
      lastEmittedRef.current = { hex: normHex, slot: activeSlot };
    }
    if (activeSlot === 'fg') {
      onUpdateBrushProps({ color: hex, isEraser: false });
    } else {
      onUpdateBrushProps({ secondaryColor: hex });
    }
    pushRecentSwatch(hex);
  }, [activeSlot, currentColor, onUpdateBrushProps]);

  // Swap FG / BG (Key X)
  const handleSwapSlots = useCallback(() => {
    const { fg, bg } = slotHueRef.current;
    slotHueRef.current = { fg: bg, bg: fg };
    onUpdateBrushProps({
      color: bgColor,
      secondaryColor: fgColor,
      isEraser: false,
    });
  }, [fgColor, bgColor, onUpdateBrushProps]);

  // Reset to default Black & White (Key D)
  const handleResetDefaultColors = useCallback(() => {
    onUpdateBrushProps({
      color: '#000000',
      secondaryColor: '#FFFFFF',
      isEraser: false,
    });
  }, [onUpdateBrushProps]);

  // Global Keyboard shortcuts X and D
  useEffect(() => {
    if (!isOpen || single) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (document.querySelector('[aria-modal="true"]')) return; // an open dialog owns the keyboard
      // Plain X / D only: Ctrl+D (deselect) used to reset the colours too
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'x' || e.key === 'X') {
        e.preventDefault();
        handleSwapSlots();
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        handleResetDefaultColors();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, single, handleSwapSlots, handleResetDefaultColors]);

  const uiScale = useUiScale();

  // Render Wheel & SV square to Canvas (embedded docked mode fits swatches without scrolling)
  const WHEEL_SIZE = embedded ? (single ? 168 : 148) : 220;
  const CENTER = WHEEL_SIZE / 2;
  const OUTER_R = embedded ? 75 : 98;
  const INNER_R = embedded ? 58 : 76;
  const SQUARE_SIZE = embedded ? 72 : 96;

  useEffect(() => {
    const canvas = wheelCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Retina / High-DPI + UI scale support for crisp color ring across 50–200% UI scale and 4K displays
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 2;
    const targetPx = Math.round(WHEEL_SIZE * uiScale * dpr);
    if (canvas.width !== targetPx || canvas.height !== targetPx) {
      canvas.width = targetPx;
      canvas.height = targetPx;
    }
    // Set absolute DPR + UI scale transform to eliminate any recursive scale multiplication bugs
    const drawScale = targetPx / WHEEL_SIZE;
    ctx.setTransform(drawScale, 0, 0, drawScale, 0, 0);
    ctx.clearRect(0, 0, WHEEL_SIZE, WHEEL_SIZE);

    // 1. Draw outer hue ring with high sub-degree resolution
    for (let angle = 0; angle < 360; angle += 0.5) {
      const startAngle = ((angle - 0.75) * Math.PI) / 180;
      const endAngle = ((angle + 0.75) * Math.PI) / 180;
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, OUTER_R, startAngle, endAngle);
      ctx.arc(CENTER, CENTER, INNER_R, endAngle, startAngle, true);
      ctx.fillStyle = `hsl(${angle}, 100%, 50%)`;
      ctx.fill();
    }

    // Indicator for current Hue on outer ring
    const curHue = hsv[0];
    const hueRad = (curHue * Math.PI) / 180;
    const midR = (OUTER_R + INNER_R) / 2;
    const hx = CENTER + Math.cos(hueRad) * midR;
    const hy = CENTER + Math.sin(hueRad) * midR;

    ctx.beginPath();
    ctx.arc(hx, hy, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000000';
    ctx.stroke();

    // 2. Draw inner SV square or HLS triangle
    if (wheelMode === 'hls-triangle') {
      const tri = getTriangleVertices(CENTER, CENTER, INNER_R - 4, curHue);
      const minX = Math.min(tri.c[0], tri.w[0], tri.k[0]);
      const maxX = Math.max(tri.c[0], tri.w[0], tri.k[0]);
      const minY = Math.min(tri.c[1], tri.w[1], tri.k[1]);
      const maxY = Math.max(tri.c[1], tri.w[1], tri.k[1]);
      const bw = maxX - minX + 2;
      const bh = maxY - minY + 2;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(tri.c[0], tri.c[1]);
      ctx.lineTo(tri.w[0], tri.w[1]);
      ctx.lineTo(tri.k[0], tri.k[1]);
      ctx.closePath();
      ctx.clip();

      // Base black (K = 1)
      ctx.fillStyle = '#000000';
      ctx.fillRect(minX - 1, minY - 1, bw, bh);

      // White ramp from V_W -> edge V_C-V_K
      const mCKx = (tri.c[0] + tri.k[0]) / 2;
      const mCKy = (tri.c[1] + tri.k[1]) / 2;
      const wGrad = ctx.createLinearGradient(tri.w[0], tri.w[1], mCKx, mCKy);
      wGrad.addColorStop(0, 'rgba(255,255,255,1)');
      wGrad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = wGrad;
      ctx.fillRect(minX - 1, minY - 1, bw, bh);

      // Additive pure-hue ramp from V_C -> edge V_W-V_K (exact barycentric w_C*pure + w_W*white)
      const [pr, pg, pb] = hsvToRgb(curHue, 1, 1);
      const mWKx = (tri.w[0] + tri.k[0]) / 2;
      const mWKy = (tri.w[1] + tri.k[1]) / 2;
      ctx.globalCompositeOperation = 'lighter';
      const cGrad = ctx.createLinearGradient(tri.c[0], tri.c[1], mWKx, mWKy);
      cGrad.addColorStop(0, `rgba(${pr},${pg},${pb},1)`);
      cGrad.addColorStop(1, `rgba(${pr},${pg},${pb},0)`);
      ctx.fillStyle = cGrad;
      ctx.fillRect(minX - 1, minY - 1, bw, bh);
      ctx.restore();

      // Triangle border
      ctx.beginPath();
      ctx.moveTo(tri.c[0], tri.c[1]);
      ctx.lineTo(tri.w[0], tri.w[1]);
      ctx.lineTo(tri.k[0], tri.k[1]);
      ctx.closePath();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.stroke();

      // Cursor dot from barycentric weights
      const [wc, ww, wk] = hsvToBarycentric(hsv[1], hsv[2]);
      const tx = wc * tri.c[0] + ww * tri.w[0] + wk * tri.k[0];
      const ty = wc * tri.c[1] + ww * tri.w[1] + wk * tri.k[1];
      ctx.beginPath();
      ctx.arc(tx, ty, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#000000';
      ctx.stroke();
    } else {
      const sx = CENTER - SQUARE_SIZE / 2;
      const sy = CENTER - SQUARE_SIZE / 2;

      // Base color for Hue
      ctx.fillStyle = `hsl(${curHue}, 100%, 50%)`;
      ctx.fillRect(sx, sy, SQUARE_SIZE, SQUARE_SIZE);

      // White gradient horizontal (Saturation 0 -> 1)
      const whiteGrad = ctx.createLinearGradient(sx, sy, sx + SQUARE_SIZE, sy);
      whiteGrad.addColorStop(0, '#FFFFFF');
      whiteGrad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = whiteGrad;
      ctx.fillRect(sx, sy, SQUARE_SIZE, SQUARE_SIZE);

      // Black gradient vertical (Value 1 -> 0)
      const blackGrad = ctx.createLinearGradient(sx, sy, sx, sy + SQUARE_SIZE);
      blackGrad.addColorStop(0, 'rgba(0,0,0,0)');
      blackGrad.addColorStop(1, '#000000');
      ctx.fillStyle = blackGrad;
      ctx.fillRect(sx, sy, SQUARE_SIZE, SQUARE_SIZE);

      // Inner SV square border
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.strokeRect(sx, sy, SQUARE_SIZE, SQUARE_SIZE);

      // Indicator for current S, V in square
      const svX = sx + hsv[1] * SQUARE_SIZE;
      const svY = sy + (1 - hsv[2]) * SQUARE_SIZE;

      ctx.beginPath();
      ctx.arc(svX, svY, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#000000';
      ctx.stroke();
    }
  }, [hsv, wheelMode, isOpen, uiScale, WHEEL_SIZE]);

  // Pointer interactions on Canvas with accurate CSS-to-Canvas coordinate projection
  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = WHEEL_SIZE / (rect.width || WHEEL_SIZE);
    const scaleY = WHEEL_SIZE / (rect.height || WHEEL_SIZE);
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    const dx = x - CENTER;
    const dy = y - CENTER;
    const dist = Math.hypot(dx, dy);

    // Check if clicked in inner area (SV square or HLS triangle)
    if (wheelMode === 'hls-triangle') {
      if (dist < INNER_R - 2) {
        isDraggingSquare.current = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
        updateSVFromCoords(x, y);
        return;
      }
    } else {
      const sx = CENTER - SQUARE_SIZE / 2;
      const sy = CENTER - SQUARE_SIZE / 2;
      if (x >= sx && x <= sx + SQUARE_SIZE && y >= sy && y <= sy + SQUARE_SIZE) {
        isDraggingSquare.current = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
        updateSVFromCoords(x, y);
        return;
      }
    }

    // Check if clicked on Hue ring
    if (dist >= INNER_R - 6 && dist <= OUTER_R + 6) {
      isDraggingWheel.current = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
      updateHueFromCoords(x, y);
      return;
    }
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDraggingWheel.current && !isDraggingSquare.current) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = WHEEL_SIZE / (rect.width || WHEEL_SIZE);
    const scaleY = WHEEL_SIZE / (rect.height || WHEEL_SIZE);
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    if (isDraggingWheel.current) {
      updateHueFromCoords(x, y);
    } else if (isDraggingSquare.current) {
      updateSVFromCoords(x, y);
    }
  };

  const handleCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isDraggingWheel.current || isDraggingSquare.current) {
      // Commit and save to recent swatches using latest ref so fast taps don't push the previous color
      const cur = hsvRef.current;
      const [r, g, b] = hsvToRgb(cur[0], cur[1], cur[2]);
      const hex = rgbToHex(r, g, b);
      pushRecentSwatch(hex);
    }
    isDraggingWheel.current = false;
    isDraggingSquare.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  };

  const updateHueFromCoords = (x: number, y: number) => {
    const dx = x - CENTER;
    const dy = y - CENTER;
    let angle = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
    if (angle < 0) angle += 360;

    const cur = hsvRef.current;
    const newHsv: [number, number, number] = [angle, cur[1], cur[2]];
    slotHueRef.current[activeSlot] = angle;
    hsvRef.current = newHsv;
    setHsv(newHsv);
    const [r, g, b] = hsvToRgb(newHsv[0], newHsv[1], newHsv[2]);
    const hex = rgbToHex(r, g, b);
    setHexInput(hex);
    applyLiveColor(hex);
  };

  const updateSVFromCoords = (x: number, y: number) => {
    const cur = hsvRef.current;
    let newHsv: [number, number, number];
    if (wheelMode === 'hls-triangle') {
      const tri = getTriangleVertices(CENTER, CENTER, INNER_R - 4, cur[0]);
      const [wc, ww] = clampPointToTriangleBarycentric(x, y, tri);
      newHsv = barycentricToHsv(cur[0], wc, ww, cur[1]);
    } else {
      const sx = CENTER - SQUARE_SIZE / 2;
      const sy = CENTER - SQUARE_SIZE / 2;
      const clampedX = Math.max(sx, Math.min(sx + SQUARE_SIZE, x));
      const clampedY = Math.max(sy, Math.min(sy + SQUARE_SIZE, y));
      const s = (clampedX - sx) / SQUARE_SIZE;
      const v = 1 - (clampedY - sy) / SQUARE_SIZE;
      newHsv = [cur[0], s, v];
    }

    hsvRef.current = newHsv;
    setHsv(newHsv);
    const [r, g, b] = hsvToRgb(newHsv[0], newHsv[1], newHsv[2]);
    const hex = rgbToHex(r, g, b);
    setHexInput(hex);
    applyLiveColor(hex);
  };

  // Eyedropper API
  const handleNativeEyedropper = async () => {
    if ('EyeDropper' in window) {
      try {
        const eyeDropper = new (window as any).EyeDropper();
        const result = await eyeDropper.open();
        if (result && result.sRGBHex) {
          applyColor(result.sRGBHex.toUpperCase());
        }
      } catch {}
    } else if (onActivateCanvasEyedropper) {
      onActivateCanvasEyedropper();
      onClose();
    } else {
      alert('請直接切換工具列「滴管」工具點擊畫布吸取顏色！');
    }
  };

  if (!isOpen && !embedded) return null;

  const [curR, curG, curB] = hexToRgb(currentColor);

  const compactEmbedded = embedded && !single;

  const innerContent = (
    <div className={`flex w-full flex-col ${compactEmbedded ? 'gap-2' : 'gap-2.5'} text-white`}>

        {/* Docked panel: one compact row (swatches, transparent eraser, swap, reset, eyedropper, hex) */}
        {(
          <div className="flex items-center gap-1.5 flex-wrap">
            {single ? (
              <span className="h-7 w-7 shrink-0 rounded-md border-2 border-neutral-600" style={{ backgroundColor: fgColor }} aria-hidden />
            ) : (
              <>
                <div className="relative h-9 w-9 shrink-0">
                  <button
                    type="button"
                    onClick={() => { setActiveSlot('bg'); onUpdateBrushProps({ isEraser: false }); }}
                    style={{ backgroundColor: bgColor }}
                    title="背景色"
                    aria-label="背景色"
                    className={`absolute bottom-0 right-0 h-5 w-5 rounded border-2 ${!isTransparent && activeSlot === 'bg' ? 'z-10 border-indigo-400' : 'border-neutral-600'}`}
                  />
                  <button
                    type="button"
                    onClick={() => { setActiveSlot('fg'); onUpdateBrushProps({ isEraser: false }); }}
                    style={{ backgroundColor: fgColor }}
                    title="前景色"
                    aria-label="前景色"
                    className={`absolute left-0 top-0 h-6 w-6 rounded-md border-2 ${!isTransparent && activeSlot === 'fg' ? 'z-10 border-indigo-400' : 'border-neutral-600'}`}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onUpdateBrushProps({ isEraser: !isTransparent })}
                  title={t.studio.transparentColor}
                  aria-label={t.studio.transparentColor}
                  aria-pressed={isTransparent}
                  style={CHECKER_BG_STYLE}
                  className={`h-7 w-7 shrink-0 rounded-md border-2 transition cursor-pointer ${
                    isTransparent
                      ? 'border-indigo-400 ring-2 ring-indigo-400/70 scale-105'
                      : 'border-neutral-600 hover:border-neutral-400 opacity-90 hover:opacity-100'
                  }`}
                />
                <button type="button" onClick={handleSwapSlots} title="交換前景／背景色 (X)" aria-label="交換前景與背景色" className="atelier-icon-btn h-7 w-7 text-xs">⇄</button>
                <button type="button" onClick={handleResetDefaultColors} title="重設為黑白 (D)" aria-label="重設為黑白" className="atelier-icon-btn h-7 w-7 text-xs">◩</button>
              </>
            )}
            <button type="button" onClick={handleNativeEyedropper} title={t.tools.eyedropper} aria-label={t.tools.eyedropper} className="atelier-icon-btn h-7 w-7"><Pipette className="h-3.5 w-3.5" /></button>
            <input type="text" value={hexInput} aria-label={t.studio.hexColor}
              onChange={(e) => {
                const val = e.target.value.toUpperCase();
                setHexInput(val);
                if (/^#[0-9A-F]{6}$/i.test(val)) applyColor(val);
              }}
              maxLength={7} className="atelier-field ml-auto h-7 w-[72px] px-1.5 font-mono text-[11px] uppercase" />
          </div>
        )}

        {/* Color Wheel Geometry Switcher (HSV Square / HLS Triangle) */}
        <div className="grid grid-cols-2 gap-1 bg-neutral-900/60 p-0.5 rounded-lg border border-neutral-800/80">
          {([
            { id: 'hsv-square', label: t.studio.wheelHsvSquare },
            { id: 'hls-triangle', label: t.studio.wheelHlsTriangle },
          ] as const).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                setWheelMode(m.id);
                try { localStorage.setItem(WHEEL_MODE_STORAGE_KEY, m.id); } catch {}
              }}
              aria-pressed={wheelMode === m.id}
              className={`py-1 px-1.5 rounded-md text-[10px] font-medium transition cursor-pointer truncate ${
                wheelMode === m.id
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Foreground / Background Dual Swatches & Tools */}

        {/* HSV Color Wheel Canvas */}
        <div className={`flex items-center justify-center ${compactEmbedded ? 'py-0' : 'py-1'} overflow-hidden w-full`}>
          <canvas
            ref={wheelCanvasRef}
            width={WHEEL_SIZE}
            height={WHEEL_SIZE}
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={handleCanvasPointerUp}
            onPointerCancel={handleCanvasPointerUp}
            style={{
              width: `${(WHEEL_SIZE / 16).toFixed(5)}rem`,
              height: 'auto',
              maxWidth: '100%',
              aspectRatio: '1 / 1',
              touchAction: 'none',
            }}
            className="cursor-crosshair touch-none rounded-full shadow-inner block mx-auto shrink-0 select-none"
          />
        </div>

        {/* Hex Input & RGB readout */}

        {/* Recent & Swatches Palette */}
        <div>
          <div className={`grid grid-cols-8 ${compactEmbedded ? 'gap-1' : 'gap-1.5'}`}>
            {recentSwatches.map((color, idx) => (
              <button
                key={`${color}-${idx}`}
                type="button"
                onClick={() => {
                  applyColor(color);
                  setHexInput(color.toUpperCase());
                }}
                style={{ backgroundColor: color }}
                title={color}
                className={`w-full aspect-square rounded-lg border transition transform hover:scale-110 active:scale-95 ${
                  currentColor.toUpperCase() === color.toUpperCase()
                    ? 'border-indigo-400 ring-2 ring-indigo-400 scale-105'
                    : 'border-neutral-700/80'
                }`}
              />
            ))}
          </div>
        </div>
    </div>
  );

  if (embedded) return innerContent;

  return (
    <ToolWindow id="color-studio" title={t.studio.colorWheel} icon={<Palette />} onClose={onClose}
      initial={{ x: -292, y: 96, w: 280, h: 0 }} minW={240}>
      {innerContent}
    </ToolWindow>
  );
};
