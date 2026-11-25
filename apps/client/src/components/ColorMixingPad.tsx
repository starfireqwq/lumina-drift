import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { normalizeHexColor } from '../utils/colorPaletteIO';
import {
  hexToRgba, rgbaToHex, sampleMixingBuffer, seedDefaultMixingPad, strokeMixingSegment,
  type MixingPadMode, type RgbaColor,
} from '../utils/mixingPadEngine';

export interface ColorMixingPadProps {
  currentColor: string;
  onPickColor: (hex: string) => void;
  compact?: boolean;
}

const WIDTH = 240;
const HEIGHT = 156;
const SURFACE = '#262830';
const STORAGE_KEY = 'atelier_mixing_pad_canvas_v1';

type Point = { x: number; y: number };
type PadStroke = {
  pointerId: number;
  point: Point;
  mode: MixingPadMode;
  color: RgbaColor;
  carry: RgbaColor | null;
};

function canvasPoint(event: PointerEvent<HTMLCanvasElement>): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(WIDTH - 1, Math.floor((event.clientX - rect.left) * WIDTH / (rect.width || WIDTH)))),
    y: Math.max(0, Math.min(HEIGHT - 1, Math.floor((event.clientY - rect.top) * HEIGHT / (rect.height || HEIGHT)))),
  };
}

function saveCanvas(canvas: HTMLCanvasElement) {
  try {
    localStorage.setItem(STORAGE_KEY, canvas.toDataURL('image/png'));
  } catch {
    // Drawing still works when local storage is disabled or full.
  }
}

export function ColorMixingPad({ currentColor, onPickColor, compact = false }: ColorMixingPadProps) {
  const { t: { studio } } = useI18n();
  const [mode, setMode] = useState<MixingPadMode | 'pick'>('paint');
  const [radius, setRadius] = useState(12);
  const [strength, setStrength] = useState(65);
  const [sampledColor, setSampledColor] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<{ context: CanvasRenderingContext2D; pixels: ImageData } | null>(null);
  const strokeRef = useRef<PadStroke | null>(null);
  const restoreRef = useRef<HTMLImageElement | null>(null);
  const saveTimer = useRef<number | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const pixels = context.createImageData(WIDTH, HEIGHT);
    padRef.current = { context, pixels };
    seedDefaultMixingPad(pixels.data, WIDTH, HEIGHT);
    context.putImageData(pixels, 0, 0);

    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && /^data:image\/[\w.+-]+(?:;[^,]*)?,/i.test(saved)) {
        const image = new Image();
        restoreRef.current = image;
        image.onload = () => {
          if (restoreRef.current !== image) return;
          restoreRef.current = null;
          try {
            context.clearRect(0, 0, WIDTH, HEIGHT);
            context.drawImage(image, 0, 0, WIDTH, HEIGHT);
            pixels.data.set(context.getImageData(0, 0, WIDTH, HEIGHT).data);
          } catch {
            context.putImageData(pixels, 0, 0);
          }
        };
        image.onerror = () => {
          if (restoreRef.current === image) restoreRef.current = null;
        };
        image.src = saved;
      }
    } catch {
      // The seeded pad is already ready to use.
    }

    const flushSave = () => {
      if (!dirtyRef.current) return;
      saveCanvas(canvas);
      dirtyRef.current = false;
    };
    window.addEventListener('pagehide', flushSave);
    return () => {
      window.removeEventListener('pagehide', flushSave);
      restoreRef.current = null;
      padRef.current = null;
      strokeRef.current = null;
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      flushSave();
    };
  }, []);

  const scheduleSave = () => {
    if (saveTimer.current !== null) return;
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      const canvas = canvasRef.current;
      if (!canvas || strokeRef.current || !dirtyRef.current) return;
      saveCanvas(canvas);
      dirtyRef.current = false;
    }, 180);
  };

  const drawTo = (stroke: PadStroke, point: Point) => {
    const pad = padRef.current;
    if (!pad) return;
    restoreRef.current = null;
    stroke.carry = strokeMixingSegment(pad.pixels.data, WIDTH, HEIGHT, stroke.point.x, stroke.point.y, point.x, point.y, {
      mode: stroke.mode,
      color: stroke.color,
      radius,
      strength: strength / 100,
      carryColor: stroke.carry,
    });
    stroke.point = point;
    pad.context.putImageData(pad.pixels, 0, 0);
    dirtyRef.current = true;
  };

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const pad = padRef.current;
    if (!pad || strokeRef.current || (event.button !== 0 && event.button !== 2)) return;
    event.preventDefault();
    event.stopPropagation();
    const point = canvasPoint(event);
    if (mode === 'pick' || event.altKey || event.button === 2) {
      const sample = sampleMixingBuffer(pad.pixels.data, WIDTH, HEIGHT, point.x, point.y, 0);
      if (!sample) return;
      const hex = rgbaToHex(sample.r, sample.g, sample.b);
      setSampledColor(hex);
      onPickColor(hex);
      return;
    }

    const stroke = {
      pointerId: event.pointerId,
      mode,
      point,
      color: hexToRgba(normalizeHexColor(currentColor) ?? '#000000'),
      carry: null,
    };
    strokeRef.current = stroke;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
    drawTo(stroke, point);
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const stroke = strokeRef.current;
    if (stroke?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const point = canvasPoint(event);
    if (point.x !== stroke.point.x || point.y !== stroke.point.y) drawTo(stroke, point);
  };

  const finishStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    const stroke = strokeRef.current;
    if (stroke?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (event.type === 'pointerup') {
      const point = canvasPoint(event);
      if (point.x !== stroke.point.x || point.y !== stroke.point.y) drawTo(stroke, point);
    }
    strokeRef.current = null;
    scheduleSave();
  };

  const resetPad = (seed: boolean) => {
    const pad = padRef.current;
    if (!pad) return;
    restoreRef.current = null;
    strokeRef.current = null;
    if (seed) {
      seedDefaultMixingPad(pad.pixels.data, WIDTH, HEIGHT);
      pad.context.putImageData(pad.pixels, 0, 0);
    } else {
      pad.context.fillStyle = SURFACE;
      pad.context.fillRect(0, 0, WIDTH, HEIGHT);
      pad.pixels.data.set(pad.context.getImageData(0, 0, WIDTH, HEIGHT).data);
    }
    dirtyRef.current = true;
    setSampledColor(null);
    scheduleSave();
  };

  return (
    <div className={`flex flex-col ${compact ? 'gap-1.5' : 'gap-2'}`}>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={studio.tabMixingPad}>
        {([
          ['paint', studio.mixingPaint],
          ['smudge', studio.mixingSmudge],
          ['pick', studio.mixingPick],
        ] as const).map(([value, label]) => (
          <button key={value} type="button" data-testid={`mixing-pad-mode-${value}`} aria-pressed={mode === value}
            onClick={() => setMode(value)}
            className={`min-h-7 flex-1 rounded-md px-1.5 text-[11px] ${mode === value ? 'bg-indigo-600 text-white' : 'bg-neutral-800 text-neutral-200 hover:bg-neutral-700'}`}>
            {label}
          </button>
        ))}
        <button type="button" data-testid="mixing-pad-clear" onClick={() => resetPad(false)}
          title={studio.mixingClear} aria-label={studio.mixingClear} className="atelier-icon-btn h-7 w-7">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button type="button" data-testid="mixing-pad-reset" onClick={() => resetPad(true)}
          title={studio.mixingReset} aria-label={studio.mixingReset} className="atelier-icon-btn h-7 w-7">
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px] text-neutral-300">
        <label className="flex min-w-0 flex-col">
          <span className="flex justify-between gap-1"><span>{studio.mixingBrushSize}</span><span className="shrink-0 tabular-nums">{radius} px</span></span>
          <input type="range" min={4} max={28} value={radius} onChange={(event) => setRadius(event.currentTarget.valueAsNumber)} className="w-full accent-indigo-500" />
        </label>
        <label className="flex min-w-0 flex-col">
          <span className="flex justify-between gap-1"><span>{studio.mixingStrength}</span><span className="shrink-0 tabular-nums">{strength}%</span></span>
          <input type="range" min={10} max={100} value={strength} onChange={(event) => setStrength(event.currentTarget.valueAsNumber)} className="w-full accent-indigo-500" />
        </label>
      </div>
      <canvas ref={canvasRef} data-testid="mixing-pad-canvas" width={WIDTH} height={HEIGHT} aria-label={studio.tabMixingPad}
        style={{ width: '100%', height: 'auto', aspectRatio: `${WIDTH} / ${HEIGHT}`, backgroundColor: SURFACE }}
        className="block cursor-crosshair touch-none select-none rounded-md ring-1 ring-neutral-700"
        onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={finishStroke}
        onPointerCancel={finishStroke} onLostPointerCapture={finishStroke}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }} />
      <div data-testid="mixing-pad-sampled" aria-live="polite" className="flex min-h-6 items-center gap-1.5 text-[11px] text-neutral-300">
        {sampledColor ? (
          <>
            <span aria-hidden="true" className="h-4 w-4 rounded border border-neutral-500" style={{ backgroundColor: sampledColor }} />
            <span className="font-mono">{sampledColor}</span>
          </>
        ) : studio.mixingPickHint}
      </div>
    </div>
  );
}
