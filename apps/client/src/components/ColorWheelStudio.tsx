import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pipette,
  RotateCcw,
  Palette,
  Pin,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { ColorMixingPad } from './ColorMixingPad';
import { ToolWindow } from './workspace/ToolWindow';
import { BrushProperties } from '../engine/BrushRenderer';
import { useUiScale } from '../theme/uiScale';
import { useI18n } from '../context/I18nContext';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import { OfflineSessionStore } from '../services/offlineStore';
import { canEditRoomCollab, canManageRoomCollab } from '@atelier/shared';
import { colorHistoryStore, recordUsedColor, useColorHistoryState } from '../services/colorHistoryStore';
import { normalizeHexColor, parseAcoPalette, parseGplPalette, serializeAcoPalette, serializeGplPalette } from '../utils/colorPaletteIO';
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
  canvasOwnerId?: string;
}

const CHECKER_BG_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, #9ca3af 25%, transparent 25%), linear-gradient(-45deg, #9ca3af 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #9ca3af 75%), linear-gradient(-45deg, transparent 75%, #9ca3af 75%)',
  backgroundSize: '8px 8px',
  backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0px',
  backgroundColor: '#ffffff',
};

const WHEEL_MODE_STORAGE_KEY = 'atelier_color_wheel_mode';

function isEmptyAcoPalette(bytes: ArrayBuffer): boolean {
  const view = new DataView(bytes);
  if (view.byteLength === 4) return view.getUint32(0) === 0x00010000 || view.getUint32(0) === 0x00020000;
  return view.byteLength === 8 && view.getUint32(0) === 0x00010000 && view.getUint32(4) === 0x00020000;
}

export const ColorWheelStudio: React.FC<ColorWheelStudioProps> = ({
  isOpen,
  onClose,
  brushProps,
  onUpdateBrushProps,
  onActivateCanvasEyedropper,
  embedded = false,
  single = false,
  canvasOwnerId,
}) => {
  const { t } = useI18n();
  const studio = t.studio;
  const { user, isGuest } = useAuth();
  const { activeCanvasId, members, roomSwatches, addRoomSwatch, removeRoomSwatch } = useSocket();
  const isOfflineCanvas = !activeCanvasId || OfflineSessionStore.isOfflineCanvas(activeCanvasId);
  const selfMember = user ? members.find((m) => m.userId === user.id) : undefined;
  const roomRole = isOfflineCanvas
    ? { isCanvasOwner: true, canvasRole: 'owner', isGuest: false }
    : {
        serverRole: user?.serverRole,
        canvasRole: selfMember?.canvasRole ?? (canvasOwnerId && user?.id === canvasOwnerId ? 'owner' : undefined),
        isCanvasOwner: Boolean(canvasOwnerId && user?.id === canvasOwnerId),
        isGuest,
      };
  const canEditRoomSwatches = canEditRoomCollab(roomRole);
  const canManageRoomSwatches = canManageRoomCollab(roomRole);
  const fgColor = brushProps.color || '#3B82F6';
  const bgColor = brushProps.secondaryColor || '#FFFFFF';

  // Which swatch is currently actively picked: 'fg' (foreground) or 'bg' (background)
  const [selectedSlot, setActiveSlot] = useState<'fg' | 'bg'>('fg');
  const activeSlot = single ? 'fg' : selectedSlot;
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
  const [tab, setTab] = useState<'wheel' | 'mixing'>('wheel');
  const [paletteStatus, setPaletteStatus] = useState<'imported' | 'importError' | 'exportError' | null>(null);
  const { history, pinnedSets, activeSetId } = useColorHistoryState();
  const activeSet = pinnedSets.find((set) => set.id === activeSetId) ?? pinnedSets[0];
  const activeSetName = activeSet.id === 'default-favorites' ? studio.paletteSetDefault : activeSet.name;
  const paletteInput = useRef<HTMLInputElement>(null);
  const showWheel = single || tab === 'wheel';

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
    applyLiveColor(hex);
    setHexInput(hex.toUpperCase());
    recordUsedColor(hex);
  }, [applyLiveColor]);

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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
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
  }, [hsv, wheelMode, isOpen, showWheel, uiScale, WHEEL_SIZE]);

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
      recordUsedColor(hex);
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
      alert(studio.eyedropperUnavailable);
    }
  };

  const createPalette = () => {
    const base = studio.paletteSetUntitled;
    let name = base;
    let suffix = 2;
    while (pinnedSets.some((set) => set.name === name)) name = base + ' ' + suffix++;
    colorHistoryStore.createPinnedSet(name);
    setPaletteStatus(null);
  };

  const importPalette = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setPaletteStatus(null);
    const fallbackName = file.name.replace(/\.(aco|gpl)$/i, '').trim() || studio.paletteSetUntitled;

    try {
      if (/\.gpl$/i.test(file.name)) {
        const lines = (await file.text()).trim().split(/\r\n?|\n/);
        if (lines.shift()?.trim() !== 'GIMP Palette') throw new Error();
        const { name, colors } = parseGplPalette(lines.join('\n'));
        const swatchLines = lines.some((line) => /^(?!#|Name:|Columns:)\S/.test(line.trim()));
        if (!colors.length && swatchLines) throw new Error();
        const hasName = lines.some((line) => /^Name:\s*\S/.test(line.trim()));
        colorHistoryStore.importPaletteSet(hasName ? name : fallbackName, colors);
      } else if (/\.aco$/i.test(file.name)) {
        const bytes = await file.arrayBuffer();
        const colors = parseAcoPalette(bytes);
        if (!colors.length && !isEmptyAcoPalette(bytes)) throw new Error();
        colorHistoryStore.importPaletteSet(fallbackName, colors);
      } else {
        throw new Error();
      }
      setPaletteStatus('imported');
    } catch {
      setPaletteStatus('importError');
    }
  };

  const exportPalette = (format: 'gpl' | 'aco') => {
    setPaletteStatus(null);
    try {
      const contents = format === 'gpl'
        ? serializeGplPalette(activeSetName, activeSet.colors)
        : new Uint8Array(serializeAcoPalette(activeSet.colors));
      const blob = new Blob([contents], { type: format === 'gpl' ? 'text/plain;charset=utf-8' : 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = activeSetName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') + '.' + format;
        link.click();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch {
      setPaletteStatus('exportError');
    }
  };

  if (!isOpen && !embedded) return null;

  const compactEmbedded = embedded && !single;
  const normalizedCurrentColor = normalizeHexColor(currentColor);
  const swatchGrid = 'grid grid-cols-8 ' + (compactEmbedded ? 'gap-1' : 'gap-1.5');
  const swatchClass = (hex: string) => 'w-full aspect-square rounded-md border transition hover:scale-105 active:scale-95 ' + (
    normalizedCurrentColor === hex ? 'border-indigo-400 ring-1 ring-indigo-400' : 'border-neutral-600'
  );
  const recentColors = (
    <div className={swatchGrid} data-testid="color-history-list">
      {(single ? history.slice(0, 16) : showWheel ? history : history.slice(0, 8)).map((color) => (
        <button key={color} type="button" onClick={() => applyColor(color)} data-color-swatch={color}
          style={{ backgroundColor: color }} title={color} aria-label={color} className={swatchClass(color)} />
      ))}
    </div>
  );

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
                    title={studio.backgroundColor}
                    aria-label={studio.backgroundColor}
                    className={`absolute bottom-0 right-0 h-5 w-5 rounded border-2 ${!isTransparent && activeSlot === 'bg' ? 'z-10 border-indigo-400' : 'border-neutral-600'}`}
                  />
                  <button
                    type="button"
                    onClick={() => { setActiveSlot('fg'); onUpdateBrushProps({ isEraser: false }); }}
                    style={{ backgroundColor: fgColor }}
                    title={studio.foregroundColor}
                    aria-label={studio.foregroundColor}
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
                <button type="button" onClick={handleSwapSlots} title={`${studio.swapColors} (X)`} aria-label={studio.swapColors} className="atelier-icon-btn h-7 w-7 text-xs">⇄</button>
                <button type="button" onClick={handleResetDefaultColors} title={`${studio.resetColors} (D)`} aria-label={studio.resetColors} className="atelier-icon-btn h-7 w-7 text-xs">◩</button>
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

        {showWheel ? (
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
        ) : (
          <ColorMixingPad currentColor={currentColor} onPickColor={applyColor} compact={compactEmbedded} />
        )}

        {single || !showWheel ? recentColors : (
          <section aria-label={studio.recentColors} className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <h3 className="mr-auto text-[11px] font-medium text-neutral-200">{studio.recentColors}</h3>
              <button type="button" data-testid="color-pin-current" onClick={() => colorHistoryStore.pinColorToActiveSet(currentColor)}
                disabled={!normalizedCurrentColor || activeSet.colors.some((swatch) => swatch.hex === normalizedCurrentColor)}
                title={studio.pinCurrentColor} aria-label={studio.pinCurrentColor} className="atelier-icon-btn h-7 w-7 disabled:opacity-40">
                <Pin className="h-3.5 w-3.5" />
              </button>
              <button type="button" data-testid="color-clear-history" onClick={() => colorHistoryStore.clearHistory()}
                disabled={!history.length} title={studio.clearHistory} aria-label={studio.clearHistory} className="atelier-icon-btn h-7 w-7 disabled:opacity-40">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {recentColors}
          </section>
        )}

        {!single && (
          <div role="group" aria-label={studio.colorPalette} className="grid grid-cols-2 gap-1 rounded-lg border border-neutral-800 bg-neutral-900/60 p-0.5">
            {([['wheel', studio.tabWheel], ['mixing', studio.tabMixingPad]] as const).map(([id, label]) => (
              <button key={id} type="button" data-testid={`color-tab-${id}`} aria-pressed={tab === id} onClick={() => setTab(id)}
                className={`min-h-7 rounded-md px-1.5 text-[11px] font-medium ${tab === id ? 'bg-indigo-600 text-white' : 'text-neutral-300 hover:bg-neutral-800'}`}>
                {label}
              </button>
            ))}
          </div>
        )}

        {showWheel && (
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
        )}

        {showWheel && !single && (
          <>
            <section data-testid="color-pinned-section" aria-label={studio.pinnedSwatches} className="flex flex-col gap-1 border-t border-neutral-800 pt-2">
              <h3 className="text-[11px] font-medium text-neutral-200">{studio.pinnedSwatches}</h3>
              <div className="flex items-center gap-1">
                <select data-testid="color-set-select" value={activeSetId} aria-label={studio.pinnedSwatches}
                  onChange={(event) => { colorHistoryStore.setActiveSet(event.currentTarget.value); setPaletteStatus(null); }}
                  className="atelier-field h-7 min-w-0 flex-1 px-1.5 text-[11px]">
                  {pinnedSets.map((set) => (
                    <option key={set.id} value={set.id}>{set.id === 'default-favorites' ? studio.paletteSetDefault : set.name}</option>
                  ))}
                </select>
                <button type="button" data-testid="color-new-set" onClick={createPalette}
                  title={studio.newPaletteSet} aria-label={studio.newPaletteSet} className="atelier-icon-btn h-7 w-7">
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <button type="button" data-testid="color-delete-set" disabled={pinnedSets.length <= 1}
                  onClick={() => { colorHistoryStore.deletePinnedSet(activeSetId); setPaletteStatus(null); }}
                  title={studio.deletePaletteSet} aria-label={studio.deletePaletteSet} className="atelier-icon-btn h-7 w-7 disabled:opacity-40">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <input ref={paletteInput} type="file" accept=".gpl,.aco" data-testid="color-palette-import-input" onChange={importPalette} hidden />
                <button type="button" data-testid="color-import-palette" onClick={() => paletteInput.current?.click()}
                  title={studio.importPalette} className="atelier-icon-btn h-7 gap-1 px-1.5 text-[11px]">
                  <Upload className="h-3.5 w-3.5" /> {studio.importPalette}
                </button>
                <button type="button" data-testid="color-export-gpl" onClick={() => exportPalette('gpl')}
                  title={studio.exportGpl} aria-label={studio.exportGpl} className="atelier-icon-btn h-7 px-1.5 text-[11px]">GPL</button>
                <button type="button" data-testid="color-export-aco" onClick={() => exportPalette('aco')}
                  title={studio.exportAco} aria-label={studio.exportAco} className="atelier-icon-btn h-7 px-1.5 text-[11px]">ACO</button>
              </div>
              {paletteStatus && (
                <p role={paletteStatus === 'imported' ? 'status' : 'alert'} className={`text-[11px] ${paletteStatus === 'imported' ? 'text-neutral-300' : 'text-red-300'}`}>
                  {{ imported: studio.importPaletteSuccess, importError: studio.importPaletteError, exportError: studio.exportPaletteError }[paletteStatus]}
                </p>
              )}
              <div className={swatchGrid}>
                {activeSet.colors.map(({ hex, name }) => {
                  const label = name ? `${name} (${hex})` : hex;
                  return (
                    <div key={hex} className="group relative">
                      <button type="button" data-pinned-swatch={hex} style={{ backgroundColor: hex }} title={label} aria-label={label}
                        onClick={() => applyColor(hex)}
                        onContextMenu={(event) => { event.preventDefault(); colorHistoryStore.unpinColorFromActiveSet(hex); }}
                        className={`block ${swatchClass(hex)}`} />
                      <button type="button" onClick={() => colorHistoryStore.unpinColorFromActiveSet(hex)}
                        title={studio.removePinnedColor} aria-label={`${studio.removePinnedColor} ${label}`}
                        className="pointer-events-none absolute -right-1 -top-1 rounded-full bg-neutral-900 p-0.5 text-white opacity-0 outline-offset-1 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Phase 5.3: Shared Room Swatches */}
            <section data-testid="room-swatches-section" aria-label={t.collab.roomSwatchesTitle} className="flex flex-col gap-1 border-t border-neutral-800 pt-2">
              <div className="flex items-center gap-1">
                <h3 className="text-[11px] font-medium text-neutral-200">{t.collab.roomSwatchesTitle}</h3>
                <span className="mr-auto rounded bg-indigo-950/80 px-1.5 py-0.5 text-[9px] text-indigo-300 border border-indigo-800/70">
                  {isOfflineCanvas ? t.collab.roomSwatchesLocal : t.collab.roomSwatchesSynced}
                </span>
                <button
                  type="button"
                  data-testid="room-swatch-add-current"
                  disabled={
                    !canEditRoomSwatches ||
                    !normalizedCurrentColor ||
                    roomSwatches.some((sw) => sw.hex === normalizedCurrentColor)
                  }
                  onClick={() => {
                    if (normalizedCurrentColor) addRoomSwatch(normalizedCurrentColor);
                  }}
                  title={t.collab.roomSwatchesAdd}
                  aria-label={t.collab.roomSwatchesAdd}
                  className="atelier-icon-btn h-7 w-7 disabled:opacity-40"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              {roomSwatches.length === 0 ? (
                <p className="text-[10px] text-neutral-500">
                  {canEditRoomSwatches ? t.collab.roomSwatchesEmpty : t.collab.roomSwatchesReadOnly}
                </p>
              ) : (
                <div className={swatchGrid} data-testid="room-swatches-list">
                  {roomSwatches.map((sw) => {
                    const label = sw.name ? `${sw.name} (${sw.hex}) · ${sw.addedByName}` : `${sw.hex} · ${sw.addedByName}`;
                    const canDelete = canEditRoomSwatches && (sw.addedBy === user?.id || canManageRoomSwatches || isOfflineCanvas);
                    return (
                      <div key={sw.id} className="group relative">
                        <button
                          type="button"
                          data-room-swatch={sw.hex}
                          style={{ backgroundColor: sw.hex }}
                          title={label}
                          aria-label={label}
                          onClick={() => applyColor(sw.hex)}
                          className={`block ${swatchClass(sw.hex)}`}
                        />
                        {canDelete && (
                          <button
                            type="button"
                            data-testid={`room-swatch-remove-${sw.hex}`}
                            onClick={() => removeRoomSwatch(sw.id)}
                            title={t.collab.roomSwatchesRemove}
                            aria-label={`${t.collab.roomSwatchesRemove} ${sw.hex}`}
                            className="pointer-events-none absolute -right-1 -top-1 rounded-full bg-neutral-900 p-0.5 text-white opacity-0 outline-offset-1 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}
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
