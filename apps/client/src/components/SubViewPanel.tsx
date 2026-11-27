import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, PointerEvent, ReactNode } from 'react';
import {
  ChevronLeft, ChevronRight, FlipHorizontal2, Hand, ImagePlus, Pipette,
  RotateCcw, RotateCw, Scan, Trash2, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { useSocket } from '../context/SocketContext';
import { RoomReferenceBoard } from './RoomReferenceBoard';
import {
  addSubViewFiles,
  clearSubViewImages,
  getSubViewState,
  removeSubViewImage,
  resetActiveSubViewTransform,
  setSubViewAutoEyedropper,
  stepSubViewIndex,
  updateActiveSubViewTransform,
  useSubViewState,
} from '../services/subViewStore';
import {
  clampSubViewZoom,
  computeSubViewFitScale,
  normalizeSubViewRotation,
  sampleSubViewPixel,
  SUB_VIEW_MAX_ZOOM,
  SUB_VIEW_MIN_ZOOM,
  subViewScreenToImage,
  zoomSubViewAroundPoint,
} from '../utils/subViewMath';
import type { SubViewTransform } from '../utils/subViewMath';

export interface SubViewPanelProps {
  onPickColor: (hex: string) => void;
  embedded?: boolean;
  canvasOwnerId?: string;
}

type Point = { x: number; y: number };
type ViewSize = { width: number; height: number; dpr: number };
type PanOffset = { imageId: string; x: number; y: number };
type Gesture = {
  pointerId: number;
  imageId: string;
  lastPoint: Point;
  lastPicked?: string;
  pan: PanOffset | null;
};

const PAN_BUTTONS = 2 | 4;
const ZOOM_STEP = 1.25;
const EYEDROPPER_PATH = 'm14 7 3 3 M3 21l4-1 12-12a2.1 2.1 0 0 0-3-3L4 17l-1 4Z';
const EYEDROPPER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="${EYEDROPPER_PATH}" stroke="black" stroke-width="4"/>
    <path d="${EYEDROPPER_PATH}" stroke="white" stroke-width="2"/>
  </g>
</svg>`;
const EYEDROPPER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(EYEDROPPER_SVG)}") 3 21, crosshair`;

function PanelButton({ label, testId, onClick, disabled, pressed, children }: {
  label: string;
  testId?: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="atelier-icon-btn h-7 w-7 shrink-0 [&_svg]:h-3.5 [&_svg]:w-3.5"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function readImagePixels(image: HTMLImageElement): ImageData | null {
  const { naturalWidth, naturalHeight } = image;
  const canvas = document.createElement('canvas');
  canvas.width = naturalWidth;
  canvas.height = naturalHeight;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, naturalWidth, naturalHeight);
  } catch {
    return null;
  }
}

function sampleAt(pixels: ImageData | null, view: ViewSize, transform: SubViewTransform | undefined, point: Point) {
  if (!pixels || !transform || point.x < 0 || point.y < 0 || point.x >= view.width || point.y >= view.height) return null;
  const { width, height, data } = pixels;
  const imagePoint = subViewScreenToImage(point.x, point.y, view.width, view.height, width, height, transform);
  if (!imagePoint.inside) return null;
  const color = sampleSubViewPixel(data, width, height, imagePoint.x, imagePoint.y);
  return color && color.a > 0 ? color : null;
}

function toCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

export function SubViewPanel({ onPickColor, embedded = false, canvasOwnerId }: SubViewPanelProps) {
  const { t } = useI18n();
  const labels = t.subView;
  const { roomReferenceBoard } = useSocket();
  const [boardTab, setBoardTab] = useState<'personal' | 'room'>('personal');
  const state = useSubViewState();
  const item = state.items[state.activeIndex];
  const imageUrl = item?.objectUrl;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pixelsRef = useRef<{ url: string; data: ImageData | null } | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const dragDepth = useRef(0);
  const spaceRef = useRef(false);
  const feedbackTimer = useRef<number | undefined>(undefined);
  const [view, setView] = useState<ViewSize>({ width: 0, height: 0, dpr: 1 });
  const [decoded, setDecoded] = useState<{ url: string; image: HTMLImageElement } | null>(null);
  const [pointer, setPointer] = useState<(Point & { buttons: number }) | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [pan, setPan] = useState<PanOffset | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [pickedColor, setPickedColor] = useState<{ imageId: string; hex: string } | null>(null);

  const image = decoded && decoded.url === imageUrl ? decoded.image : null;
  const cachedPixels = pixelsRef.current;
  const pixels = cachedPixels && cachedPixels.url === imageUrl ? cachedPixels.data : null;
  const activePan = pan && pan.imageId === item?.id ? pan : null;
  const transform = item && activePan
    ? { ...item.transform, panX: item.transform.panX + activePan.x, panY: item.transform.panY + activePan.y }
    : item?.transform;
  const panButtonHeld = ((pointer?.buttons ?? 0) & PAN_BUTTONS) !== 0;
  const canSample = image && state.autoEyedropper && !spaceHeld && !activePan && !panButtonHeld;
  const hoverColor = canSample && pointer ? sampleAt(pixels, view, transform, pointer) : null;
  const cursor = canSample ? 'eyedropper' : activePan ? 'grabbing' : 'grab';

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      setView(previous => previous.width === width && previous.height === height && previous.dpr === dpr
        ? previous : { width, height, dpr });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => {
    setDecoded(null);
    pixelsRef.current = null;
    if (!imageUrl) return;
    let cancelled = false;
    const nextImage = new Image();
    nextImage.src = imageUrl;
    void nextImage.decode().then(() => {
      if (cancelled) return;
      pixelsRef.current = { url: imageUrl, data: readImagePixels(nextImage) };
      setDecoded({ url: imageUrl, image: nextImage });
    }, () => {});
    return () => { cancelled = true; };
  }, [imageUrl]);

  const zoom = transform?.zoom ?? 1;
  const panX = transform?.panX ?? 0;
  const panY = transform?.panY ?? 0;
  const rotationDeg = transform?.rotationDeg ?? 0;
  const flipH = transform?.flipH ?? false;
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view.width || !view.height) return;
    const width = Math.max(1, Math.round(view.width * view.dpr));
    const height = Math.max(1, Math.round(view.height * view.dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.resetTransform();
    ctx.clearRect(0, 0, width, height);
    if (!image) return;
    const imgW = image.naturalWidth;
    const imgH = image.naturalHeight;
    const scale = computeSubViewFitScale(view.width, view.height, imgW, imgH) * clampSubViewZoom(zoom);
    ctx.scale(width / view.width, height / view.height);
    ctx.translate(view.width / 2 + panX, view.height / 2 + panY);
    ctx.rotate(rotationDeg * Math.PI / 180);
    ctx.scale(flipH ? -scale : scale, scale);
    ctx.drawImage(image, -imgW / 2, -imgH / 2);
  }, [image, view, zoom, panX, panY, rotationDeg, flipH]);

  useEffect(() => {
    const setSpace = (held: boolean) => {
      if (spaceRef.current === held) return;
      spaceRef.current = held;
      setSpaceHeld(held);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpace(true);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpace(false);
    };
    const blur = () => {
      setSpace(false);
      setPointer(null);
    };
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('blur', blur);
      window.clearTimeout(feedbackTimer.current);
    };
  }, []);

  const imageWidth = item?.width;
  const imageHeight = item?.height;
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageWidth || !imageHeight) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.deltaY || gestureRef.current?.pan) return;
      const point = toCanvasPoint(canvas, event.clientX, event.clientY);
      const sensitivity = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 0.002 : 0.05;
      const factor = Math.exp(-event.deltaY * sensitivity);
      updateActiveSubViewTransform(previous => zoomSubViewAroundPoint(
        previous, view.width, view.height, imageWidth, imageHeight, point.x, point.y, previous.zoom * factor,
      ));
    };
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [imageWidth, imageHeight, view]);

  function nudgeZoom(factor: number) {
    if (!item) return;
    updateActiveSubViewTransform(previous => zoomSubViewAroundPoint(
      previous, view.width, view.height, item.width, item.height,
      view.width / 2, view.height / 2, previous.zoom * factor,
    ));
  }

  function pickAt(point: Point, gesture: Gesture) {
    const sampled = sampleAt(pixels, view, transform, point);
    if (!sampled || gesture.lastPicked === sampled.hex) return;
    gesture.lastPicked = sampled.hex;
    onPickColor(sampled.hex);
    setPickedColor({ imageId: gesture.imageId, hex: sampled.hex });
    window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setPickedColor(null), 850);
  }

  function trackPointer(event: PointerEvent<HTMLCanvasElement>) {
    const point = toCanvasPoint(event.currentTarget, event.clientX, event.clientY);
    setPointer({ ...point, buttons: event.buttons });
    return point;
  }

  function handlePointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button < 0 || event.button > 2 || gestureRef.current) return;
    event.currentTarget.focus({ preventScroll: true });
    if (!item) return;
    event.preventDefault();
    const point = trackPointer(event);
    const pan = event.button !== 0 || spaceRef.current || !state.autoEyedropper
      ? { imageId: item.id, x: 0, y: 0 } : null;
    const gesture = { pointerId: event.pointerId, imageId: item.id, lastPoint: point, pan };
    gestureRef.current = gesture;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pan) setPan(pan);
    else pickAt(point, gesture);
  }

  function handlePointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const gesture = gestureRef.current;
    if (gesture && gesture.pointerId !== event.pointerId) return;
    const point = trackPointer(event);
    if (!gesture || !item || gesture.imageId !== item.id || !(event.buttons & (1 | PAN_BUTTONS))) return;
    if (gesture.pan || spaceRef.current || !state.autoEyedropper || (event.buttons & PAN_BUTTONS)) {
      const next = {
        imageId: item.id,
        x: (gesture.pan?.x ?? 0) + point.x - gesture.lastPoint.x,
        y: (gesture.pan?.y ?? 0) + point.y - gesture.lastPoint.y,
      };
      gesture.pan = next;
      setPan(next);
    } else {
      pickAt(point, gesture);
    }
    gesture.lastPoint = point;
  }

  function finishGesture(event: PointerEvent<HTMLCanvasElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    setPan(null);
    if (event.type === 'pointerup' && event.pointerType !== 'touch') trackPointer(event);
    else setPointer(null);
    const offset = gesture.pan;
    const latest = getSubViewState();
    if (offset && (offset.x || offset.y) && latest.items[latest.activeIndex]?.id === offset.imageId) {
      // Preview every move, then persist the finished pan once.
      updateActiveSubViewTransform(previous => ({
        ...previous, panX: previous.panX + offset.x, panY: previous.panY + offset.y,
      }));
    }
  }

  function handleFileDrag(event: DragEvent, entering = false) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    if (entering) dragDepth.current += 1;
    setDraggingFiles(true);
  }

  function handleDrop(event: DragEvent) {
    const files = event.dataTransfer.files;
    if (!files.length && !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDraggingFiles(false);
    canvasRef.current?.focus({ preventScroll: true });
    void addSubViewFiles(files);
  }

  function handlePaste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
    const images = files.length ? files : Array.from(event.clipboardData.items)
      .filter(entry => entry.kind === 'file' && entry.type.startsWith('image/'))
      .map(entry => entry.getAsFile()).filter((file): file is File => file !== null);
    if (!images.length) return;
    event.preventDefault();
    event.stopPropagation();
    void addSubViewFiles(images);
  }

  return (
    <section
      aria-label={labels.title}
      className={`relative flex h-full min-w-0 flex-col gap-1.5 p-1.5 ${embedded ? 'min-h-36' : 'min-h-64 rounded-lg border border-neutral-800 bg-neutral-950'}`}
      onPaste={handlePaste}
      onKeyDown={event => {
        // Let the native paste event reach this panel before canvas shortcuts handle it.
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') event.stopPropagation();
        if (event.target === canvasRef.current && event.code === 'Space') {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onDragEnter={event => handleFileDrag(event, true)}
      onDragOver={event => handleFileDrag(event)}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDraggingFiles(false);
      }}
      onDrop={handleDrop}
    >
      {/* Personal SubView vs Shared Room Reference Board tab switch */}
      <div className="flex shrink-0 items-center gap-1 border-b border-neutral-800/80 pb-1">
        <button
          type="button"
          data-testid="subview-tab-personal"
          aria-pressed={boardTab === 'personal'}
          onClick={() => setBoardTab('personal')}
          className={`flex-1 rounded px-2 py-0.5 text-[11px] font-medium transition ${
            boardTab === 'personal'
              ? 'bg-indigo-600 text-white'
              : 'text-neutral-300 hover:bg-neutral-800'
          }`}
        >
          {t.collab.subViewTabPersonal}
        </button>
        <button
          type="button"
          data-testid="subview-tab-room-board"
          aria-pressed={boardTab === 'room'}
          onClick={() => setBoardTab('room')}
          className={`flex-1 inline-flex items-center justify-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition ${
            boardTab === 'room'
              ? 'bg-indigo-600 text-white'
              : 'text-neutral-300 hover:bg-neutral-800'
          }`}
        >
          <span className="truncate">{t.collab.subViewTabRoomBoard}</span>
          {roomReferenceBoard.items.length > 0 && (
            <span className="rounded-full bg-black/30 px-1 font-mono text-[9px]">
              {roomReferenceBoard.items.length}
            </span>
          )}
        </button>
      </div>

      {boardTab === 'room' ? (
        <RoomReferenceBoard onPickColor={onPickColor} canvasOwnerId={canvasOwnerId} />
      ) : (
        <>
      <div className="flex min-w-0 shrink-0 items-center gap-0.5">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          data-testid="subview-file-input"
          hidden
          onChange={event => {
            const input = event.currentTarget;
            if (input.files?.length) void addSubViewFiles(input.files);
            input.value = '';
            canvasRef.current?.focus({ preventScroll: true });
          }}
        />
        <PanelButton label={labels.importImages} onClick={() => fileInputRef.current?.click()}><ImagePlus /></PanelButton>
        <PanelButton label={labels.prevImage} testId="subview-prev" disabled={state.items.length < 2} onClick={() => stepSubViewIndex(-1)}><ChevronLeft /></PanelButton>
        <span data-testid="subview-counter" className="shrink-0 whitespace-nowrap px-0.5 text-[11px] tabular-nums text-neutral-300">
          {item ? state.activeIndex + 1 : 0} / {state.items.length}
        </span>
        <PanelButton label={labels.nextImage} testId="subview-next" disabled={state.items.length < 2} onClick={() => stepSubViewIndex(1)}><ChevronRight /></PanelButton>
        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-300" title={item?.name}>{item?.name}</span>
        <PanelButton label={labels.removeImage} testId="subview-remove" disabled={!item} onClick={() => { if (item) void removeSubViewImage(item.id); }}><X /></PanelButton>
        <PanelButton label={labels.clearAll} testId="subview-clear" disabled={!state.items.length} onClick={() => void clearSubViewImages()}><Trash2 /></PanelButton>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-0.5">
        <div className="flex items-center">
          <PanelButton label={labels.zoomOut} testId="subview-zoom-out" disabled={!item || zoom <= SUB_VIEW_MIN_ZOOM} onClick={() => nudgeZoom(1 / ZOOM_STEP)}><ZoomOut /></PanelButton>
          <span data-testid="subview-zoom-label" className="min-w-9 px-0.5 text-center text-[11px] tabular-nums text-neutral-300">{Math.round(zoom * 100)}%</span>
          <PanelButton label={labels.zoomIn} testId="subview-zoom-in" disabled={!item || zoom >= SUB_VIEW_MAX_ZOOM} onClick={() => nudgeZoom(ZOOM_STEP)}><ZoomIn /></PanelButton>
        </div>
        <PanelButton label={labels.flipH} testId="subview-flip-h" disabled={!item} pressed={flipH} onClick={() => updateActiveSubViewTransform(previous => ({ ...previous, flipH: !previous.flipH }))}><FlipHorizontal2 /></PanelButton>
        <PanelButton label={labels.rotateCcw} testId="subview-rotate-ccw" disabled={!item} onClick={() => updateActiveSubViewTransform({ rotationDeg: normalizeSubViewRotation(rotationDeg - 90) })}><RotateCcw /></PanelButton>
        <PanelButton label={labels.rotateCw} testId="subview-rotate-cw" disabled={!item} onClick={() => updateActiveSubViewTransform({ rotationDeg: normalizeSubViewRotation(rotationDeg + 90) })}><RotateCw /></PanelButton>
        <PanelButton label={labels.resetView} testId="subview-reset" disabled={!item} onClick={resetActiveSubViewTransform}><Scan /></PanelButton>
        <PanelButton
          label={labels.autoEyedropper}
          testId="subview-auto-eyedropper"
          pressed={state.autoEyedropper}
          onClick={() => setSubViewAutoEyedropper(!state.autoEyedropper)}
        >
          {state.autoEyedropper ? <Pipette /> : <Hand />}
        </PanelButton>
      </div>

      <div
        className="relative min-h-16 min-w-0 flex-1 overflow-hidden rounded-md border border-neutral-800 bg-neutral-950"
        style={item ? { backgroundImage: 'conic-gradient(#242424 25%, #181818 0 50%, #242424 0 75%, #181818 0)', backgroundSize: '16px 16px' } : undefined}
      >
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label={labels.title}
          aria-description={state.autoEyedropper ? undefined : labels.panMode}
          data-testid="subview-canvas"
          data-subview-cursor={item ? cursor : undefined}
          className="absolute inset-0 block h-full w-full touch-none focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-indigo-400"
          style={{ cursor: item ? (cursor === 'eyedropper' ? EYEDROPPER_CURSOR : cursor) : undefined }}
          onContextMenu={event => event.preventDefault()}
          onPointerDown={handlePointerDown}
          onPointerEnter={trackPointer}
          onPointerMove={handlePointerMove}
          onPointerUp={finishGesture}
          onPointerCancel={finishGesture}
          onLostPointerCapture={finishGesture}
          onPointerLeave={() => setPointer(null)}
        />
        {state.loaded && !item && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-center">
            <p className="text-xs font-medium text-neutral-300">{labels.emptyTitle}</p>
            <p className="text-[11px] text-neutral-400">{labels.emptyHint}</p>
          </div>
        )}
        {hoverColor && (
          <div data-testid="subview-hover-color" className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-950/90 px-2 py-1 font-mono text-[11px] text-white shadow">
            <span className="h-3.5 w-3.5 rounded-full border border-white/40" style={{ backgroundColor: hoverColor.hex }} />
            {hoverColor.hex}
          </div>
        )}
        <div role="status" className="pointer-events-none absolute inset-x-1.5 top-1.5 flex justify-center">
          {pickedColor && pickedColor.imageId === item?.id && (
            <span className="rounded-full bg-indigo-600 px-2 py-1 text-center text-[11px] font-medium text-white">
              {labels.pickedColor} {pickedColor.hex}
            </span>
          )}
        </div>
      </div>
      {draggingFiles && (
        <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-indigo-400 bg-neutral-950/85 p-2 text-center text-xs font-semibold text-indigo-200">
          {labels.dropHint}
        </div>
      )}
        </>
      )}
    </section>
  );
}
