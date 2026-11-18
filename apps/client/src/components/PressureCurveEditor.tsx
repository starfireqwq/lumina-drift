import React, { useRef } from 'react';
import { RotateCcw } from 'lucide-react';
import { evaluatePressureCurve, type PressureCurveConfig } from '@atelier/shared';
import { useI18n } from '../context/I18nContext';
import { constrainStylusCurve, DEFAULT_PRESSURE_CURVE, MAX_STYLUS_DEAD_ZONE } from '../engine/stylusPressure';

const pressurePresets: NonNullable<PressureCurveConfig['bezierPoints']>[] = [
  [0, 0.65, 0.28, 1],
  [0.12, 0.40, 0.62, 0.90],
  [0.25, 0.25, 0.75, 0.75],
  [0.40, 0.12, 0.90, 0.62],
  [0.65, 0, 1, 0.28],
];

export const PressureCurveEditor = React.memo(function PressureCurveEditor({ curve, onChange }: {
  curve: PressureCurveConfig;
  onChange: (curve: PressureCurveConfig) => void;
}) {
  const { t } = useI18n();
  const graph = useRef<SVGSVGElement>(null);
  const points = curve.bezierPoints ?? DEFAULT_PRESSURE_CURVE.bezierPoints!;
  const dead = curve.deadZone ?? 0;
  const update = (index: number, x: number, y: number) => {
    const next: typeof points = [...points];
    next[index] = x;
    next[index + 1] = y;
    onChange(constrainStylusCurve({ ...curve, bezierPoints: next }));
  };
  const displayX = (x: number) => 10 + 200 * (dead + x * (1 - dead));
  const path = Array.from({ length: 101 }, (_, i) => {
    return `${i ? 'L' : 'M'}${10 + i * 2} ${210 - 200 * evaluatePressureCurve(i / 100, curve)}`;
  }).join(' ');
  return (
    <section className="grid gap-2 rounded-lg border border-neutral-800 p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-semibold">{t.settings.pressureCurve}</h4>
        <button type="button" className="atelier-btn" aria-label={t.settings.resetPressureCurve}
          title={t.settings.resetPressureCurve} onClick={() => onChange(DEFAULT_PRESSURE_CURVE)}>
          <RotateCcw size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="grid items-center gap-3 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <div className="grid max-w-64 grid-cols-[minmax(0,1fr)_auto] items-center gap-1">
        <svg ref={graph} viewBox="-20 0 240 240" aria-label={t.settings.pressureCurve}
          className="w-full touch-none rounded bg-neutral-950">
          <rect x="10" y="10" width="200" height="200" fill="#28282b" stroke="#52525b" />
          <path d={Array.from({ length: 4 }, (_, i) => 50 + i * 40)
            .map(value => `M${value} 10V210 M10 ${value}H210`).join(' ')}
            fill="none" stroke="#3f3f46" />
          <text x="17" y="28" className="pointer-events-none fill-neutral-300 text-[14px]">{t.settings.pressureSofter}</text>
          <text x="203" y="199" textAnchor="end" className="pointer-events-none fill-neutral-300 text-[14px]">{t.settings.pressureFirmer}</text>
          <text x="110" y="229" textAnchor="middle" className="fill-neutral-300 text-[14px]">{t.settings.pressureInput}</text>
          <text transform="translate(-5 110) rotate(-90)" textAnchor="middle" className="fill-neutral-300 text-[14px]">{t.settings.pressureOutput}</text>
          <path d={path} fill="none" stroke="#e4e4e7" strokeWidth="2" />
          {[0, 2].map((index) => {
            const x = displayX(points[index]);
            const y = 210 - points[index + 1] * 200;
            return (
              <g key={index}>
                <path d={`M${index ? 210 : displayX(0)} ${index ? 10 : 210} L${x} ${y}`} stroke="#818cf8" />
                <circle cx={x} cy={y} r="7" fill={index ? '#f87171' : '#facc15'} stroke="#18181b" tabIndex={0}
                  aria-label={`${t.settings.pressureCurve} ${index / 2 + 1}`}
                  className="cursor-move focus:stroke-amber-400"
                  onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
                  onPointerMove={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !graph.current) return;
                    const transform = graph.current.getScreenCTM();
                    if (!transform) return;
                    const { x, y } = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
                    update(index, ((x - 10) / 200 - dead) / (1 - dead), (210 - y) / 200);
                  }}
                  onKeyDown={(event) => {
                    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
                    const direction = arrows[event.key];
                    if (!direction) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const step = event.shiftKey ? 0.05 : 0.01;
                    update(index, points[index] + direction[0] * step, points[index + 1] + direction[1] * step);
                  }}
                />
              </g>
            );
          })}
        </svg>
        <div className="grid gap-1.5">
          {pressurePresets.map((preset, i) => {
            const label = i === 2 ? t.settings.pressureLinear
              : `${i < 2 ? t.settings.pressureSofter : t.settings.pressureFirmer} ${Math.abs(i - 2)}`;
            return (
              <button key={i} type="button" className="atelier-btn !p-1" title={label} aria-label={label}
                aria-pressed={points.every((point, index) => point === preset[index])}
                onClick={() => onChange({ ...curve, bezierPoints: [...preset] })}>
                <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                  <rect x="1" y="1" width="18" height="18" rx="2" fill="none" stroke="currentColor" opacity=".35" />
                  <path d={`M1 19 C${1 + 18 * preset[0]} ${19 - 18 * preset[1]} ${1 + 18 * preset[2]} ${19 - 18 * preset[3]} 19 1`}
                    fill="none" stroke="currentColor" />
                </svg>
              </button>
            );
          })}
        </div>
        </div>
        <label className="grid gap-1 text-neutral-300">
          <span>{t.settings.pressureThreshold} · {Math.round(dead * 100)}%</span>
          <input type="range" min={0} max={MAX_STYLUS_DEAD_ZONE * 100} value={Math.round(dead * 100)}
            onChange={(event) => onChange({ ...curve, deadZone: Number(event.target.value) / 100 })} />
        </label>
      </div>
    </section>
  );
});
