import React, { useRef } from 'react';
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
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { useEffectiveWidth } from '../hooks/useEffectiveWidth';

interface ViewportToolbarProps {
  viewportState: ViewportState;
  displayScale?: number;
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
  onOpenAlign?: () => void;
  onOpenResize?: () => void;
}

/** Align: a dashed frame with a block snapped into its corner (same mark as the align window) */
const AlignMark = () => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
    <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.2 1.6" />
    <rect x="3.5" y="3.5" width="6" height="5" rx="1.2" fill="currentColor" />
  </svg>
);

const btn = 'atelier-icon-btn h-7 shrink-0 gap-1 px-1.5 text-[11px]';
const Sep = () => <div aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-neutral-700/70" />;

/** Status bar under the canvas: size, zoom, rotation, mirror and canvas utilities. */
export const ViewportToolbar: React.FC<ViewportToolbarProps> = ({
  viewportState,
  displayScale = 1,
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
  onOpenAlign,
  onOpenResize,
}) => {
  const { t } = useI18n();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const { effectiveWidth, viewportWidth } = useEffectiveWidth(toolbarRef);
  const isNarrowMobile = viewportWidth < 600;
  const showFitLabel = effectiveWidth >= 820;
  const showFlipLabel = effectiveWidth >= 1000;
  const showRulerLabel = effectiveWidth >= 660;
  const showRefLabel = effectiveWidth >= 940;
  const showFilterLabel = effectiveWidth >= 720;
  const showAlignLabel = effectiveWidth >= 780;
  const rotationDeg = Math.round(((viewportState.rotation * 180) / Math.PI) % 360);
  const zoomPercent = Math.round(viewportState.zoom * displayScale * 100);

  return (
    <div ref={toolbarRef} role="toolbar" aria-label={t.canvas.viewToolbar}
      className={`atelier-chrome flex shrink-0 items-center gap-1 border-t px-2 text-xs text-neutral-300 ${
        isNarrowMobile ? 'h-9 overflow-x-auto no-scrollbar' : 'min-h-9 flex-wrap py-0.5'
      }`}
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      {onOpenResize ? (
        <button type="button" onClick={onOpenResize} title={t.canvas.resizeTitle} className={`${btn} tabular-nums`}>
          <Crop className="h-3.5 w-3.5" /><span>{width} × {height}</span>
        </button>
      ) : <span className="shrink-0 px-1 tabular-nums">{width} × {height}</span>}

      <div className={`ml-auto flex items-center gap-0.5 ${isNarrowMobile ? 'shrink-0' : 'flex-wrap justify-end'}`}>
        <button type="button" onClick={onZoomOut} title={t.canvas.zoomOut} aria-label={t.canvas.zoomOut} className={btn}><ZoomOut className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={onResetZoom} title={t.canvas.resetZoom} className={`${btn} min-w-[46px] justify-center font-mono`}>{zoomPercent}%</button>
        <button type="button" onClick={onZoomIn} title={t.canvas.zoomIn} aria-label={t.canvas.zoomIn} className={btn}><ZoomIn className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={onFitView} title={t.canvas.fitView} aria-label={t.canvas.fitView} className={btn}><Maximize2 className="h-3.5 w-3.5" />{showFitLabel && <span>{t.canvas.fitViewButton}</span>}</button>
        <Sep />
        <button type="button" onClick={() => onRotate(-Math.PI / 12)} title={t.canvas.rotateLeft} aria-label={t.canvas.rotateLeft} className={btn}><RotateCcw className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={onResetRotation} title={t.canvas.resetRotation} className={`${btn} min-w-[38px] justify-center font-mono`}>{rotationDeg}°</button>
        <button type="button" onClick={() => onRotate(Math.PI / 12)} title={t.canvas.rotateRight} aria-label={t.canvas.rotateRight} className={btn}><RotateCw className="h-3.5 w-3.5" /></button>
        {rotationDeg % 360 !== 0 && (
          <button type="button" onClick={onResetRotation} title={t.canvas.resetRotation} className={`${btn} text-amber-300`}>
            <Undo2 className="h-3.5 w-3.5" /><span>{t.canvas.straighten}</span>
          </button>
        )}
        <button type="button" onClick={onToggleMirror} aria-pressed={viewportState.mirrorX} title={t.canvas.flipView} aria-label={t.canvas.flipView} className={btn}>
          <FlipHorizontal className="h-3.5 w-3.5" />{showFlipLabel && <span>{t.canvas.flipViewButton}</span>}
        </button>
        <Sep />
        {onOpenRuler && <button type="button" onClick={onOpenRuler} title={t.canvas.rulers} aria-label={t.canvas.rulers} className={btn}><Compass className="h-3.5 w-3.5" />{showRulerLabel && <span>{t.tools.ruler}</span>}</button>}
        {onOpenReference && <button type="button" onClick={onOpenReference} title={t.canvas.referenceImage} aria-label={t.canvas.referenceImage} className={btn}><ImageIcon className="h-3.5 w-3.5" />{showRefLabel && <span>{t.reference.title}</span>}</button>}
        {onOpenFilters && <button type="button" onClick={onOpenFilters} title={t.canvas.filters} aria-label={t.canvas.filters} className={btn}><SlidersHorizontal className="h-3.5 w-3.5" />{showFilterLabel && <span>{t.canvas.filters}</span>}</button>}
        {onOpenAlign && <button type="button" onClick={onOpenAlign} title={t.align.openTitle} aria-label={t.align.openTitle} className={btn}><AlignMark />{showAlignLabel && <span>{t.align.title}</span>}</button>}
        {onOpenRadial && <button type="button" onClick={onOpenRadial} title={t.canvas.radialMenu} aria-label={t.canvas.radialMenu} className={btn}><Sparkles className="h-3.5 w-3.5" /></button>}
      </div>
    </div>
  );
};
