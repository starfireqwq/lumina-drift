import React from 'react';
import { ViewportState } from '../engine/Viewport';
import {
  Compass,
  Crop,
  FlipHorizontal,
  Image as ImageIcon,
  Maximize2,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useI18n } from '../context/I18nContext';

interface ViewportToolbarProps {
  viewportState: ViewportState;
  width: number;
  height: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onFitView: () => void;
  onRotate: (deltaRadians: number) => void;
  onResetRotation: () => void;
  onToggleMirror: () => void;
  onOpenRuler?: () => void;
  onOpenReference?: () => void;
  onOpenRadial?: () => void;
  onOpenFilters?: () => void;
  onOpenResize?: () => void;
}

const btn = 'atelier-icon-btn h-7 shrink-0 gap-1 px-1.5 text-[11px]';
const Sep = () => <div aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-neutral-700/70" />;

/** Status bar under the canvas: size, zoom, rotation, mirror and canvas utilities. */
export const ViewportToolbar: React.FC<ViewportToolbarProps> = ({
  viewportState,
  width,
  height,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onFitView,
  onRotate,
  onResetRotation,
  onToggleMirror,
  onOpenRuler,
  onOpenReference,
  onOpenRadial,
  onOpenFilters,
  onOpenResize,
}) => {
  const { t } = useI18n();
  const rotationDeg = Math.round(((viewportState.rotation * 180) / Math.PI) % 360);
  const zoomPercent = Math.round(viewportState.zoom * 100);

  return (
    <div role="toolbar" aria-label={t.canvas.viewToolbar}
      className="atelier-chrome flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-t px-2 text-xs text-neutral-300 no-scrollbar"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      {onOpenResize ? (
        <button type="button" onClick={onOpenResize} title={t.canvas.resizeTitle} className={`${btn} tabular-nums`}>
          <Crop className="h-3.5 w-3.5" /><span>{width} × {height}</span>
        </button>
      ) : <span className="shrink-0 px-1 tabular-nums">{width} × {height}</span>}

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button type="button" onClick={onZoomOut} title={t.canvas.zoomOut} aria-label={t.canvas.zoomOut} className={btn}><ZoomOut className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={onResetZoom} title={t.canvas.resetZoom} className={`${btn} min-w-[46px] justify-center font-mono`}>{zoomPercent}%</button>
        <button type="button" onClick={onZoomIn} title={t.canvas.zoomIn} aria-label={t.canvas.zoomIn} className={btn}><ZoomIn className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={onFitView} title={t.canvas.fitView} className={btn}><Maximize2 className="h-3.5 w-3.5" /><span className="hidden md:inline">{t.canvas.fitViewButton}</span></button>
        <Sep />
        <button type="button" onClick={() => onRotate(-Math.PI / 12)} title={t.canvas.rotateLeft} aria-label={t.canvas.rotateLeft} className={btn}><RotateCcw className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={onResetRotation} title={t.canvas.resetRotation} className={`${btn} min-w-[38px] justify-center font-mono`}>{rotationDeg}°</button>
        <button type="button" onClick={() => onRotate(Math.PI / 12)} title={t.canvas.rotateRight} aria-label={t.canvas.rotateRight} className={btn}><RotateCw className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={onToggleMirror} aria-pressed={viewportState.mirrorX} title={t.canvas.flipView} className={btn}>
          <FlipHorizontal className="h-3.5 w-3.5" /><span className="hidden lg:inline">{t.canvas.flipViewButton}</span>
        </button>
        <Sep />
        {onOpenRuler && <button type="button" onClick={onOpenRuler} title={t.canvas.rulers} className={btn}><Compass className="h-3.5 w-3.5" /><span className="hidden sm:inline">{t.tools.ruler}</span></button>}
        {onOpenReference && <button type="button" onClick={onOpenReference} title={t.canvas.referenceImage} aria-label={t.canvas.referenceImage} className={btn}><ImageIcon className="h-3.5 w-3.5" /><span className="hidden lg:inline">{t.reference.title}</span></button>}
        {onOpenFilters && <button type="button" onClick={onOpenFilters} title={t.canvas.filters} className={btn}><SlidersHorizontal className="h-3.5 w-3.5" /><span className="hidden sm:inline">{t.canvas.filters}</span></button>}
        {onOpenRadial && <button type="button" onClick={onOpenRadial} title={t.canvas.radialMenu} aria-label={t.canvas.radialMenu} className={btn}><Sparkles className="h-3.5 w-3.5" /></button>}
      </div>
    </div>
  );
};
