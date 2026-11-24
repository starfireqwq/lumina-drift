import React from 'react';
import { computeLoupePosition } from '../engine/touchGestures';

export interface TouchEyedropperState {
  active: boolean;
  clientX: number;
  clientY: number;
  pickedColor: string;
  previousColor: string;
}

interface TouchEyedropperLoupeProps {
  state: TouchEyedropperState;
}

/**
 * Procraft-inspired floating eyedropper loupe for touch long-press color picking:
 * - Lifted above the fingertip so the finger never hides the sampled color
 * - Top half of ring shows the newly sampled color; bottom half shows the previous brush color
 * - Inner reticle + live HEX readout pill in Lumina Drift glass styling
 */
export const TouchEyedropperLoupe: React.FC<TouchEyedropperLoupeProps> = ({ state }) => {
  if (!state.active) return null;

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const pos = computeLoupePosition(state.clientX, state.clientY, vw, vh, 68, 48);

  const outerR = 44;
  const innerR = 30;
  const ringMid = (outerR + innerR) / 2;
  const strokeWidth = outerR - innerR;
  const size = outerR * 2 + 16;
  const c = size / 2;

  return (
    <div
      data-touch-eyedropper-loupe=""
      aria-live="polite"
      className="pointer-events-none fixed left-0 top-0 z-[95] select-none"
      style={{
        transform: `translate3d(${Math.round(pos.x - c)}px, ${Math.round(pos.y - c)}px, 0)`,
        willChange: 'transform',
      }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="drop-shadow-[0_10px_24px_rgba(0,0,0,0.55)]">
        {/* Top half: live sampled color */}
        <path
          d={`M ${c - ringMid} ${c} A ${ringMid} ${ringMid} 0 0 1 ${c + ringMid} ${c}`}
          fill="none"
          stroke={state.pickedColor}
          strokeWidth={strokeWidth}
        />
        {/* Bottom half: previous color for direct comparison */}
        <path
          d={`M ${c + ringMid} ${c} A ${ringMid} ${ringMid} 0 0 1 ${c - ringMid} ${c}`}
          fill="none"
          stroke={state.previousColor}
          strokeWidth={strokeWidth}
        />
        {/* Inner translucent preview fill */}
        <circle cx={c} cy={c} r={innerR - 1} fill={state.pickedColor} fillOpacity={0.22} />
        {/* Crisp outer & inner optical rims */}
        <circle cx={c} cy={c} r={outerR} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="1.5" />
        <circle cx={c} cy={c} r={innerR} fill="none" stroke="rgba(255,255,255,0.72)" strokeWidth="1.2" />
        <circle cx={c} cy={c} r={outerR + 1.2} fill="none" stroke="rgba(0,0,0,0.38)" strokeWidth="1" />
        {/* Center precision crosshair */}
        <line x1={c - 7} y1={c} x2={c - 2.5} y2={c} stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
        <line x1={c + 2.5} y1={c} x2={c + 7} y2={c} stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
        <line x1={c} y1={c - 7} x2={c} y2={c - 2.5} stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
        <line x1={c} y1={c + 2.5} x2={c} y2={c + 7} stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx={c} cy={c} r="1.5" fill="#ffffff" stroke="rgba(0,0,0,0.55)" strokeWidth="0.7" />
      </svg>
      <div
        className="atelier-popover mx-auto -mt-1 flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-mono font-semibold tracking-wider text-neutral-100"
      >
        <span
          className="h-2.5 w-2.5 rounded-full border border-white/80"
          style={{ backgroundColor: state.pickedColor }}
        />
        <span>{state.pickedColor.toUpperCase()}</span>
      </div>
    </div>
  );
};
