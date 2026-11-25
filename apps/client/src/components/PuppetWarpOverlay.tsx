import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Check, Grid3X3, RefreshCw, Trash2, X } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import {
  attachPinToMesh,
  buildPuppetMeshFromAlpha,
  renderPuppetWarpToCanvas,
  solvePuppetWarp,
  type PuppetMesh,
  type PuppetMeshDensity,
  type PuppetPin,
} from '../engine/PuppetWarpEngine';
import { getDistortModeOptions, type DistortMode } from '../utils/distortModes';
import { BarSelect } from './workspace/CanvasActionBar';

interface Bounds { minX: number; minY: number; width: number; height: number }
interface Point { x: number; y: number }

interface PuppetWarpOverlayProps {
  isActive: boolean;
  onChangeMode: (mode: DistortMode | 'transform') => void;
  sourceCanvas: HTMLCanvasElement | null;
  initialBounds: Bounds;
  canvasWidth: number;
  canvasHeight: number;
  onApply: (warpedCanvas: HTMLCanvasElement, bounds: Bounds) => void;
  onCancel: () => void;
  canvasToScreen: (x: number, y: number) => Point;
  screenToCanvas: (x: number, y: number) => Point;
}

interface PinDrag {
  pin: PuppetPin;
  pointerId: number;
  start: Point;
  rotate: boolean;
}

interface SourceImage {
  canvas: HTMLCanvasElement;
  rgba: Uint8ClampedArray;
  mesh: PuppetMesh;
  density: PuppetMeshDensity;
}

const DENSITIES = ['coarse', 'normal', 'dense'] as const;
const PREVIEW_PIXEL_BUDGET = 420_000;
const DEGREES = 180 / Math.PI;
const hasDeformation = (pins: readonly PuppetPin[]) =>
  pins.some((pin) => pin.x !== pin.restX || pin.y !== pin.restY || pin.rotation !== 0);

export function PuppetWarpOverlay({
  isActive, onChangeMode, sourceCanvas, initialBounds, canvasWidth, canvasHeight, onApply, onCancel, canvasToScreen, screenToCanvas,
}: PuppetWarpOverlayProps) {
  const { t } = useI18n();
  const labels = t.puppetWarp;
  const [showMesh, setShowMesh] = useState(true);
  const [sourceImage, setSourceImage] = useState<SourceImage | null>(null);
  const [pins, setPins] = useState<PuppetPin[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [renderFailed, setRenderFailed] = useState(false);
  const pendingPins = useRef<PuppetPin[]>([]);
  const frameRef = useRef<number | null>(null);
  const dragRef = useRef<PinDrag | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewBounds = useRef<Bounds | null>(null);
  const selectedPin = pins.find((pin) => pin.id === selectedId);
  const clipBounds = useMemo(() => ({ minX: 0, minY: 0, width: canvasWidth, height: canvasHeight }), [canvasWidth, canvasHeight]);
  const image = sourceImage?.canvas === sourceCanvas ? sourceImage : null;
  const mesh = image?.mesh;
  const sourceRgba = image?.rgba;
  const density = image?.density ?? 'normal';
  const deformed = useMemo(() => mesh && solvePuppetWarp(mesh, pins), [mesh, pins]);

  useLayoutEffect(() => {
    if (!isActive || !sourceCanvas) return;
    try {
      const context = sourceCanvas.getContext('2d');
      if (!context) throw new Error('Puppet Warp requires a 2D source canvas');
      const { data: rgba } = context.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
      const mesh = buildPuppetMeshFromAlpha(rgba, sourceCanvas.width, sourceCanvas.height);
      setSourceImage({ canvas: sourceCanvas, rgba, mesh, density: 'normal' });
      setRenderFailed(false);
    } catch {
      setRenderFailed(true);
    }
  }, [isActive, sourceCanvas]);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!isActive || !preview || !sourceCanvas || !sourceRgba || !mesh || !deformed) return;
    try {
      const output = renderPuppetWarpToCanvas(sourceCanvas, mesh, deformed, initialBounds, {
        sourceRgba, clipBounds, previewPixelBudget: PREVIEW_PIXEL_BUDGET,
      });
      output.canvas.style.width = `${output.bounds.width}px`;
      output.canvas.style.height = `${output.bounds.height}px`;
      preview.replaceChildren(output.canvas);
      previewBounds.current = output.bounds;
      setRenderFailed(false);
    } catch {
      setRenderFailed(true);
    }
  }, [isActive, sourceCanvas, sourceRgba, mesh, deformed, initialBounds, clipBounds]);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    const bounds = previewBounds.current;
    if (!preview || !bounds) return;
    const origin = canvasToScreen(bounds.minX, bounds.minY);
    const x = canvasToScreen(bounds.minX + 1, bounds.minY);
    const y = canvasToScreen(bounds.minX, bounds.minY + 1);
    preview.style.transform = `matrix(${x.x - origin.x}, ${x.y - origin.y}, ${y.x - origin.x}, ${y.y - origin.y}, ${origin.x}, ${origin.y})`;
  });

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  function updatePins(next: PuppetPin[], defer = false) {
    pendingPins.current = next;
    if (!defer) {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      setPins(next);
    } else if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        setPins(pendingPins.current);
      });
    }
  }

  function updatePin(id: string, patch: Partial<Pick<PuppetPin, 'x' | 'y' | 'weight' | 'rotation'>>) {
    updatePins(pendingPins.current.map((pin) => pin.id === id ? { ...pin, ...patch } : pin), true);
  }

  function removePin(id: string) {
    if (dragRef.current?.pin.id === id) dragRef.current = null;
    updatePins(pendingPins.current.filter((pin) => pin.id !== id));
    setSelectedId((current) => current === id ? null : current);
  }

  function changeDensity(next: PuppetMeshDensity) {
    if (next === density || !sourceCanvas || !sourceRgba) return;
    const nextMesh = buildPuppetMeshFromAlpha(sourceRgba, sourceCanvas.width, sourceCanvas.height, { density: next });
    updatePins(pendingPins.current.map((pin) => {
      const rest = attachPinToMesh(nextMesh, pin.restX, pin.restY, pin.id, pin.weight);
      return {
        ...rest, x: rest.restX + pin.x - pin.restX, y: rest.restY + pin.y - pin.restY, rotation: pin.rotation,
      };
    }));
    setSourceImage({ canvas: sourceCanvas, rgba: sourceRgba, mesh: nextMesh, density: next });
  }

  function apply() {
    if (!sourceCanvas || !mesh) return;
    const latest = pendingPins.current;
    if (!hasDeformation(latest)) {
      onCancel();
      return;
    }
    let result: ReturnType<typeof renderPuppetWarpToCanvas>;
    try {
      result = renderPuppetWarpToCanvas(sourceCanvas, mesh, solvePuppetWarp(mesh, latest), initialBounds, {
        sourceRgba, clipBounds,
      });
    } catch {
      setRenderFailed(true);
      return;
    }
    onApply(result.canvas, result.bounds);
  }

  useEffect(() => {
    if (!isActive) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      const editing = target instanceof Element && target.closest('input:not([type="range"]), textarea, [contenteditable="true"]');
      const nativeEnter = editing || (target instanceof Element && target.closest('button, select'));
      if (event.key === 'Escape') onCancel();
      else if (event.key === 'Enter' && !nativeEnter) apply();
      else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId && !editing) removePin(selectedId);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  });

  function localPoint(event: PointerEvent<SVGElement>): Point {
    const point = screenToCanvas(event.clientX, event.clientY);
    return { x: point.x - initialBounds.minX, y: point.y - initialBounds.minY };
  }

  function addPin(event: PointerEvent<SVGRectElement>) {
    if (event.button !== 0 || !mesh || !deformed || dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const point = localPoint(event);
    // Hit test the visible mesh and carry its barycentric coordinates back to the rest pose.
    const pin = attachPinToMesh({ ...mesh, vertices: deformed }, point.x, point.y);
    pin.restX = pin.restY = 0;
    pin.barycentric.forEach((weight, corner) => {
      const index = 2 * mesh.triangles[3 * pin.triangleIndex + corner];
      pin.restX += weight * mesh.vertices[index];
      pin.restY += weight * mesh.vertices[index + 1];
    });
    if (!hasDeformation(pendingPins.current)) {
      pin.x = pin.restX;
      pin.y = pin.restY;
    }
    updatePins([...pendingPins.current, pin]);
    setSelectedId(pin.id);
  }

  function startDrag(event: PointerEvent<SVGCircleElement>, id: string, rotate: boolean) {
    const pin = pendingPins.current.find((item) => item.id === id);
    if (event.button !== 0 || !pin || dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { start: localPoint(event), pin, rotate, pointerId: event.pointerId };
    setSelectedId(id);
  }

  function moveDrag(event: PointerEvent<SVGCircleElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const { pin, start, rotate } = drag;
    const point = localPoint(event);
    if (rotate) {
      const angle = pin.rotation
        + Math.atan2(point.y - pin.y, point.x - pin.x)
        - Math.atan2(start.y - pin.y, start.x - pin.x);
      updatePin(pin.id, { rotation: Math.atan2(Math.sin(angle), Math.cos(angle)) });
    } else {
      updatePin(pin.id, { x: pin.x + point.x - start.x, y: pin.y + point.y - start.y });
    }
  }

  function endDrag(event: PointerEvent<SVGCircleElement>) {
    if (event.pointerId !== dragRef.current?.pointerId) return;
    event.stopPropagation();
    if (event.type === 'pointerup') moveDrag(event);
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  if (!isActive) return null;

  const project = (x: number, y: number) => canvasToScreen(initialBounds.minX + x, initialBounds.minY + y);
  const projectedVertices = mesh && deformed && showMesh
    ? Array.from({ length: mesh.vertexCount }, (_, i) => project(deformed[2 * i], deformed[2 * i + 1]))
    : [];
  const meshPath = projectedVertices.map(({ x, y }, i) => mesh?.neighbors[i]
    .filter((j) => j > i)
    .map((j) => `M${x} ${y}L${projectedVertices[j].x} ${projectedVertices[j].y}`).join('')).join('');
  const center = selectedPin && project(selectedPin.x, selectedPin.y);
  let rotationHandle: Point | null = null;
  if (selectedPin && center) {
    const aim = project(selectedPin.x + Math.sin(selectedPin.rotation), selectedPin.y - Math.cos(selectedPin.rotation));
    const scale = 27 / (Math.hypot(aim.x - center.x, aim.y - center.y) || 1);
    rotationHandle = { x: center.x + (aim.x - center.x) * scale, y: center.y + (aim.y - center.y) * scale };
  }

  return (
    <div data-testid="puppet-warp-overlay" className="pointer-events-none absolute inset-0 z-30 select-none">
      <div ref={previewRef} className="absolute left-0 top-0 origin-top-left" />
      <svg className="absolute inset-0 h-full w-full overflow-visible">
        <rect width="100%" height="100%" fill="transparent" onPointerDown={addPin}
          className="pointer-events-auto touch-none cursor-crosshair" />
        {meshPath && <path d={meshPath} fill="none" stroke="#818cf8" strokeWidth="1" opacity=".75" />}
        {pins.map((pin) => {
          const position = project(pin.x, pin.y);
          return (
            <circle key={pin.id} data-testid="puppet-warp-pin" data-pin-id={pin.id}
              cx={position.x} cy={position.y} r={pin.id === selectedId ? 7 : 6}
              fill={pin.id === selectedId ? '#fbbf24' : '#c7d2fe'} stroke="#312e81" strokeWidth="2"
              role="button" tabIndex={0} aria-label={labels.pin} aria-pressed={pin.id === selectedId}
              className="pointer-events-auto touch-none cursor-grab active:cursor-grabbing"
              onFocus={() => setSelectedId(pin.id)}
              onKeyDown={(event) => {
                if (event.key !== ' ') return;
                event.preventDefault();
                setSelectedId(pin.id);
              }}
              onPointerDown={(event) => startDrag(event, pin.id, false)}
              onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                removePin(pin.id);
              }} />
          );
        })}
        {rotationHandle && center && selectedPin && (
          <>
            <line x1={center.x} y1={center.y} x2={rotationHandle.x} y2={rotationHandle.y} stroke="#fbbf24" strokeWidth="2" />
            <circle cx={rotationHandle.x} cy={rotationHandle.y} r="5" fill="#312e81" stroke="#fbbf24" strokeWidth="2"
              aria-label={labels.rotation} className="pointer-events-auto touch-none cursor-grab active:cursor-grabbing"
              onPointerDown={(event) => startDrag(event, selectedPin.id, true)}
              onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} />
          </>
        )}
      </svg>
      <div data-transform-overlay="true" role="toolbar" aria-label={labels.title}
        onPointerDown={(event) => event.stopPropagation()}
        className="atelier-popover atelier-menu-in pointer-events-auto absolute bottom-3 left-1/2 flex w-max max-w-[96%] -translate-x-1/2 flex-wrap items-center gap-1.5 p-1.5 text-xs">
        <BarSelect label={labels.mode} value="puppet" options={getDistortModeOptions(t)} onChange={onChangeMode} />
        <select data-testid="puppet-warp-density" value={density} aria-label={labels.density} title={labels.density}
          className="atelier-field h-7 cursor-pointer px-2" onChange={(event) => changeDensity(event.target.value as PuppetMeshDensity)}>
          {DENSITIES.map((option) => <option key={option} value={option}>{labels[option]}</option>)}
        </select>
        <button type="button" className="atelier-btn" data-testid="puppet-warp-mesh-toggle"
          aria-pressed={showMesh} onClick={() => setShowMesh(!showMesh)}>
          <Grid3X3 />{labels.showMesh}
        </button>
        {selectedPin && (
          <>
            <label className="flex items-center gap-1">
              {labels.rotation}
              <input type="range" min="-180" max="180" step="1" value={Math.round(selectedPin.rotation * DEGREES)}
                data-testid="puppet-warp-rotation-input" className="w-20"
                onChange={(event) => updatePin(selectedPin.id, { rotation: Number(event.target.value) / DEGREES })} />
              <span aria-hidden className="w-8 tabular-nums">{Math.round(selectedPin.rotation * DEGREES)}°</span>
            </label>
            <label className="flex items-center gap-1">
              {labels.weight}
              <input type="range" min="0.2" max="3" step="0.1" value={selectedPin.weight}
                data-testid="puppet-warp-weight-input" className="w-16"
                onChange={(event) => updatePin(selectedPin.id, { weight: Number(event.target.value) })} />
              <span aria-hidden className="w-5 tabular-nums">{selectedPin.weight.toFixed(1)}</span>
            </label>
          </>
        )}
        <button type="button" className="atelier-btn atelier-btn--ghost" data-testid="puppet-warp-delete-pin"
          disabled={!selectedPin} onClick={() => selectedPin && removePin(selectedPin.id)}>
          <Trash2 />{labels.deletePin}
        </button>
        <button type="button" className="atelier-btn atelier-btn--ghost" disabled={!pins.length}
          onClick={() => updatePins(pendingPins.current.map((pin) => ({ ...pin, x: pin.restX, y: pin.restY, rotation: 0 })))}>
          <RefreshCw />{t.common.reset}
        </button>
        <button type="button" className="atelier-btn atelier-btn--primary" disabled={!mesh} onClick={apply}>
          <Check />{t.common.apply}<kbd className="atelier-kbd hidden md:inline">Enter</kbd>
        </button>
        <button type="button" className="atelier-btn atelier-btn--ghost" onClick={onCancel}>
          <X />{t.common.cancel}<kbd className="atelier-kbd hidden md:inline">Esc</kbd>
        </button>
        {renderFailed && <span role="alert" className="text-red-400">{labels.renderFailed}</span>}
      </div>
    </div>
  );
}
