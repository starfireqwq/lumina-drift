import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  buildCurveLUT,
  ColorCurvesOptions,
  CurvePoint,
} from '@atelier/shared';
import { Sliders, Check, RotateCcw, Eye } from 'lucide-react';
import { ToolWindow } from './workspace/ToolWindow';
import { useI18n } from '../context/I18nContext';

interface ColorCurvesModalProps {
  isOpen: boolean;
  busy: boolean;
  onClose: () => void;
  onApply: (options: ColorCurvesOptions) => Promise<boolean>;
  onPreview?: (options: ColorCurvesOptions | null) => void;
}

type ChannelType = 'master' | 'red' | 'green' | 'blue';

export const ColorCurvesModal: React.FC<ColorCurvesModalProps> = ({
  isOpen,
  busy,
  onClose,
  onApply,
  onPreview,
}) => {
  const { t } = useI18n();
  const [activeChannel, setActiveChannel] = useState<ChannelType>('master');
  const [livePreview, setLivePreview] = useState(true);

  // Curves for each channel (starts as linear 0..255)
  const [masterCurve, setMasterCurve] = useState<CurvePoint[]>([
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ]);
  const [redCurve, setRedCurve] = useState<CurvePoint[]>([
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ]);
  const [greenCurve, setGreenCurve] = useState<CurvePoint[]>([
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ]);
  const [blueCurve, setBlueCurve] = useState<CurvePoint[]>([
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ]);

  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const [draggedPointIndex, setDraggedPointIndex] = useState<number | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);

  const currentPoints = useMemo(() => {
    switch (activeChannel) {
      case 'red': return redCurve;
      case 'green': return greenCurve;
      case 'blue': return blueCurve;
      default: return masterCurve;
    }
  }, [activeChannel, masterCurve, redCurve, greenCurve, blueCurve]);

  const setCurrentPoints = (newPoints: CurvePoint[]) => {
    switch (activeChannel) {
      case 'red': setRedCurve(newPoints); break;
      case 'green': setGreenCurve(newPoints); break;
      case 'blue': setBlueCurve(newPoints); break;
      default: setMasterCurve(newPoints); break;
    }
  };

  // Generate 256-LUT for preview and SVG path
  const currentLut = useMemo(() => {
    return buildCurveLUT(currentPoints);
  }, [currentPoints]);

  const curveSvgPath = useMemo(() => {
    let d = `M 0 ${255 - currentLut[0]}`;
    for (let x = 1; x < 256; x += 2) {
      d += ` L ${x} ${255 - currentLut[x]}`;
    }
    return d;
  }, [currentLut]);

  // Live preview callback
  useEffect(() => {
    if (!isOpen || busy) return;
    if (livePreview && onPreview) {
      const timer = setTimeout(() => onPreview({
        masterCurve,
        redCurve,
        greenCurve,
        blueCurve,
      }), 160);
      return () => clearTimeout(timer);
    } else if (onPreview) {
      onPreview(null);
    }
  }, [isOpen, busy, livePreview, masterCurve, redCurve, greenCurve, blueCurve, onPreview]);

  if (!isOpen) return null;

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = Math.round(Math.max(0, Math.min(255, ((e.clientX - rect.left) / rect.width) * 255)));
    const py = Math.round(Math.max(0, Math.min(255, 255 - ((e.clientY - rect.top) / rect.height) * 255)));

    // Check if clicked an existing point
    const hitIdx = currentPoints.findIndex(
      (p) => Math.hypot(p.x - px, p.y - py) < 14
    );

    if (hitIdx !== -1) {
      setSelectedPointIndex(hitIdx);
      setDraggedPointIndex(hitIdx);
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      // Add a new control point
      const newPoints = [...currentPoints, { x: px, y: py }].sort((a, b) => a.x - b.x);
      const newIdx = newPoints.findIndex((p) => p.x === px && p.y === py);
      setCurrentPoints(newPoints);
      setSelectedPointIndex(newIdx);
      setDraggedPointIndex(newIdx);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (draggedPointIndex === null || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = Math.round(Math.max(0, Math.min(255, ((e.clientX - rect.left) / rect.width) * 255)));
    const py = Math.round(Math.max(0, Math.min(255, 255 - ((e.clientY - rect.top) / rect.height) * 255)));

    const pts = [...currentPoints];
    const isFirst = draggedPointIndex === 0;
    const isLast = draggedPointIndex === pts.length - 1;

    // First point locked to x=0, last point locked to x=255
    const finalX = isFirst ? 0 : isLast ? 255 : px;
    pts[draggedPointIndex] = { x: finalX, y: py };

    pts.sort((a, b) => a.x - b.x);
    const newIdx = pts.findIndex((p) => p.x === finalX && p.y === py);
    setDraggedPointIndex(newIdx);
    setSelectedPointIndex(newIdx);
    setCurrentPoints(pts);
  };

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (draggedPointIndex !== null) {
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignored
      }
      setDraggedPointIndex(null);
    }
  };

  const handleDeletePoint = () => {
    if (selectedPointIndex === null || selectedPointIndex === 0 || selectedPointIndex === currentPoints.length - 1) {
      return;
    }
    const updated = currentPoints.filter((_, idx) => idx !== selectedPointIndex);
    setCurrentPoints(updated);
    setSelectedPointIndex(null);
  };

  const handleResetCurrent = () => {
    setCurrentPoints([
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ]);
    setSelectedPointIndex(null);
  };

  const handlePresetSCurve = () => {
    setCurrentPoints([
      { x: 0, y: 0 },
      { x: 64, y: 44 },
      { x: 192, y: 212 },
      { x: 255, y: 255 },
    ]);
    setSelectedPointIndex(null);
  };

  const handlePresetWarm = () => {
    setMasterCurve([
      { x: 0, y: 0 },
      { x: 128, y: 136 },
      { x: 255, y: 255 },
    ]);
    setRedCurve([
      { x: 0, y: 0 },
      { x: 128, y: 142 },
      { x: 255, y: 255 },
    ]);
    setBlueCurve([
      { x: 0, y: 0 },
      { x: 128, y: 114 },
      { x: 255, y: 255 },
    ]);
  };

  const handleConfirm = async () => {
    if (busy || !await onApply({
      masterCurve,
      redCurve,
      greenCurve,
      blueCurve,
    })) return;
    if (onPreview) onPreview(null);
    onClose();
  };

  const handleCancel = () => {
    if (onPreview) onPreview(null);
    onClose();
  };

  const channelColor =
    activeChannel === 'red' ? '#ef4444' :
    activeChannel === 'green' ? '#22c55e' :
    activeChannel === 'blue' ? '#3b82f6' : '#e2e8f0';

  const selectedPoint = selectedPointIndex !== null ? currentPoints[selectedPointIndex] : null;

  const channels: Array<{ id: typeof activeChannel; label: string; dot: string }> = [
    { id: 'master', label: t.studio.channelRgb, dot: '#e2e8f0' },
    { id: 'red', label: t.studio.channelRed, dot: '#ef4444' },
    { id: 'green', label: t.studio.channelGreen, dot: '#22c55e' },
    { id: 'blue', label: t.studio.channelBlue, dot: '#3b82f6' },
  ];

  return (
    <ToolWindow id="curves" title={t.studio.colorCurvesTitle} icon={<Sliders />} onClose={handleCancel}
      initial={{ x: -332, y: 96, w: 320, h: 0 }} minW={280}
      footer={(
        <>
          <button type="button" onClick={handleCancel} className="atelier-btn atelier-btn--ghost">{t.common.cancel}</button>
          <button type="button" onClick={handleConfirm} disabled={busy} className="atelier-btn atelier-btn--primary">
            <Check />{busy ? t.common.processing : t.common.apply}
          </button>
        </>
      )}>
        <div className="space-y-3">
          {/* Channel Selector Tabs */}
          <div role="radiogroup" aria-label="色版" className="grid grid-cols-4 gap-0.5 rounded-lg border border-neutral-700 bg-neutral-950/60 p-0.5 text-[11px] font-medium">
            {channels.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={activeChannel === c.id}
                onClick={() => { setActiveChannel(c.id); setSelectedPointIndex(null); }}
                className={`flex items-center justify-center gap-1.5 rounded-md py-1 transition ${activeChannel === c.id ? 'bg-neutral-700 text-white shadow' : 'text-neutral-400 hover:text-white'}`}>
                <span className="h-2 w-2 rounded-full" style={{ background: c.dot }} />{c.label}
              </button>
            ))}
          </div>

          {/* SVG Bézier Curve Editor Area */}
          <div className="relative w-full aspect-square bg-neutral-950 rounded-lg border border-neutral-800 overflow-hidden flex items-center justify-center">
            {/* Background Grid (Quarters) */}
            <div className="absolute inset-0 grid grid-cols-4 grid-rows-4 pointer-events-none opacity-20">
              {Array.from({ length: 16 }).map((_, i) => (
                <div key={i} className="border-r border-b border-neutral-500" />
              ))}
            </div>

            {/* Diagonal reference line */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 255 255">
              <line x1="0" y1="255" x2="255" y2="0" stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
            </svg>

            {/* Interactive SVG Curve */}
            <svg
              ref={svgRef}
              viewBox="0 0 255 255"
              className="w-full h-full cursor-crosshair touch-none"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              {/* Spline Curve Path */}
              <path
                d={curveSvgPath}
                fill="none"
                stroke={channelColor}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {/* Control Point Nodes */}
              {currentPoints.map((pt, idx) => {
                const isSelected = selectedPointIndex === idx;
                return (
                  <circle
                    key={idx}
                    cx={pt.x}
                    cy={255 - pt.y}
                    r={isSelected ? 6 : 4}
                    fill={isSelected ? '#fbbf24' : channelColor}
                    stroke="#ffffff"
                    strokeWidth="1.5"
                    className="cursor-pointer transition-transform hover:scale-125"
                  />
                );
              })}
            </svg>
          </div>

          {/* Coordinate Readout & Point controls */}
          <div className="flex h-6 items-center justify-between text-[11px] text-neutral-400">
            <div className="flex items-center gap-3 tabular-nums">
              <span>{t.studio.inputCoord} <strong className="font-mono text-neutral-200">{selectedPoint ? selectedPoint.x : '—'}</strong></span>
              <span>{t.studio.outputCoord} <strong className="font-mono text-neutral-200">{selectedPoint ? selectedPoint.y : '—'}</strong></span>
            </div>
            {selectedPoint && selectedPointIndex !== 0 && selectedPointIndex !== currentPoints.length - 1 && (
              <button type="button" onClick={handleDeletePoint} className="atelier-btn atelier-btn--ghost atelier-btn--danger !h-6 !px-2 text-[11px]">
                {t.studio.deletePoint}
              </button>
            )}
          </div>

          {/* Quick Preset Buttons */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={handleResetCurrent} className="atelier-btn !h-6 !px-2 text-[11px]"><RotateCcw />{t.common.reset}</button>
            <button type="button" onClick={handlePresetSCurve} className="atelier-btn !h-6 !px-2 text-[11px]">{t.studio.presetSCurve}</button>
            <button type="button" onClick={handlePresetWarm} className="atelier-btn !h-6 !px-2 text-[11px]">{t.studio.presetWarm}</button>
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-neutral-300">
              <input type="checkbox" checked={livePreview} onChange={(e) => setLivePreview(e.target.checked)} />
              <Eye className="h-3.5 w-3.5 text-neutral-400" />{t.common.preview}
            </label>
          </div>
        </div>
    </ToolWindow>
  );
};
