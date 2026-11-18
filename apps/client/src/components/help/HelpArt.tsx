import React from 'react';
import type { HelpArtId } from './helpContent';

/**
 * Small line drawings for the help centre (gestures, docking, transform). Plain SVG in the theme's
 * colours: sharp at any size and they follow the light / dark theme.
 */
const INK = 'rgb(var(--n-400))';
const FAINT = 'rgb(var(--n-600))';
const ACCENT = 'rgb(var(--a-400))';
const ACCENT_FILL = 'rgb(var(--a-500) / .18)';

/** A tablet outline the gestures happen on */
const Device: React.FC = () => (
  <>
    <rect x="14" y="8" width="132" height="88" rx="10" fill="none" stroke={FAINT} strokeWidth="1.5" />
    <rect x="22" y="16" width="116" height="72" rx="4" fill="rgb(var(--n-950) / .5)" stroke="none" />
  </>
);

/** A fingertip touching the glass, with a ring that keeps rippling out */
const Tip: React.FC<{ x: number; y: number; delay?: number; ripple?: boolean }> = ({ x, y, delay = 0, ripple = true }) => (
  <g>
    {ripple && (
      <circle cx={x} cy={y} r="7" fill="none" stroke={ACCENT} strokeWidth="1.2" className="atelier-help-ripple" style={{ animationDelay: `${delay}s` }} />
    )}
    <ellipse cx={x} cy={y} rx="5.5" ry="6.5" fill={ACCENT_FILL} stroke={ACCENT} strokeWidth="1.5" />
  </g>
);

const Arrow: React.FC<{ d: string; head: string }> = ({ d, head }) => (
  <g fill="none" stroke={INK} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
    <path d={head} />
  </g>
);

const ART: Record<HelpArtId, React.ReactNode> = {
  'two-finger-tap': (
    <>
      <Device />
      <Tip x={68} y={54} />
      <Tip x={92} y={50} delay={0.12} />
    </>
  ),
  'three-finger-tap': (
    <>
      <Device />
      <Tip x={58} y={56} />
      <Tip x={80} y={48} delay={0.1} />
      <Tip x={102} y={54} delay={0.2} />
    </>
  ),
  pinch: (
    <>
      <Device />
      <Tip x={66} y={60} ripple={false} />
      <Tip x={94} y={44} ripple={false} />
      <Arrow d="M58 68 L46 78" head="M46 71 L46 78 L53 78" />
      <Arrow d="M102 36 L114 26" head="M107 26 L114 26 L114 33" />
      <path d="M50 40 A34 34 0 0 1 72 24" fill="none" stroke={ACCENT} strokeWidth="1.3" strokeDasharray="3 3" />
      <path d="M68 21 L72 24 L68 28" fill="none" stroke={ACCENT} strokeWidth="1.3" strokeLinecap="round" />
    </>
  ),
  'long-press': (
    <>
      <Device />
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const a0 = (i * 60 - 90 + 4) * (Math.PI / 180);
        const a1 = (i * 60 - 30 - 4) * (Math.PI / 180);
        const r0 = 14;
        const r1 = 30;
        const cx = 80;
        const cy = 52;
        const p = (r: number, a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
        return (
          <path key={i} d={`M${p(r0, a0)} L${p(r1, a0)} A${r1} ${r1} 0 0 1 ${p(r1, a1)} L${p(r0, a1)} A${r0} ${r0} 0 0 0 ${p(r0, a0)}`}
            fill={i === 1 ? 'rgb(var(--a-500) / .35)' : 'rgb(var(--n-700) / .5)'} stroke={i === 1 ? ACCENT : FAINT} strokeWidth="1" />
        );
      })}
      <circle cx="80" cy="52" r="10" fill="none" stroke={ACCENT} strokeWidth="2" strokeDasharray="47 63" strokeLinecap="round" transform="rotate(-90 80 52)" />
      <Tip x={80} y={52} ripple={false} />
    </>
  ),
  'space-pan': (
    <>
      <rect x="30" y="64" width="100" height="18" rx="5" fill="rgb(var(--n-800))" stroke={INK} strokeWidth="1.5" />
      <rect x="30" y="64" width="100" height="18" rx="5" fill={ACCENT_FILL} className="atelier-help-press" />
      <text x="80" y="77" textAnchor="middle" fontSize="9" fill={INK} fontFamily="ui-monospace, monospace">Space</text>
      <g transform="translate(80 34)" fill="none" stroke={ACCENT} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M0 -18 V18 M-18 0 H18" />
        <path d="M-4 -14 L0 -18 L4 -14 M-4 14 L0 18 L4 14 M-14 -4 L-18 0 L-14 4 M14 -4 L18 0 L14 4" />
        <circle r="5" fill="rgb(var(--n-900))" />
      </g>
    </>
  ),
  transform: (
    <>
      <path d="M48 70 C 60 40, 92 36, 110 56" fill="none" stroke="rgb(var(--n-300))" strokeWidth="3" strokeLinecap="round" />
      <rect x="42" y="30" width="76" height="48" fill="none" stroke={ACCENT} strokeWidth="1.2" strokeDasharray="4 3" />
      {[[42, 30], [80, 30], [118, 30], [118, 54], [118, 78], [80, 78], [42, 78], [42, 54]].map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x - 3} y={y - 3} width="6" height="6" rx="1" fill="rgb(var(--n-900))" stroke={ACCENT} strokeWidth="1.2" />
      ))}
      <path d="M80 30 V18" stroke={ACCENT} strokeWidth="1.2" />
      <circle cx="80" cy="15" r="3.5" fill={ACCENT} />
      <Arrow d="M124 84 L136 94" head="M129 94 L136 94 L136 87" />
    </>
  ),
  dock: (
    <>
      <rect x="10" y="10" width="140" height="84" rx="6" fill="rgb(var(--n-950) / .5)" stroke={FAINT} strokeWidth="1.5" />
      <rect x="16" y="16" width="9" height="72" rx="2" fill="rgb(var(--n-800))" />
      {/* drop zone lighting up on the left */}
      <rect x="29" y="16" width="30" height="72" rx="3" fill="rgb(var(--a-500) / .16)" stroke={ACCENT} strokeWidth="1.4" className="atelier-help-blink" />
      {/* right dock with two panels */}
      <rect x="112" y="16" width="32" height="34" rx="2" fill="rgb(var(--n-800))" stroke={FAINT} />
      <rect x="112" y="54" width="32" height="34" rx="2" fill="rgb(var(--n-800) / .4)" stroke={FAINT} strokeDasharray="3 2" />
      {/* the panel being dragged */}
      <g className="atelier-help-drag">
        <rect x="70" y="46" width="30" height="30" rx="3" fill="rgb(var(--n-800))" stroke={ACCENT} strokeWidth="1.4" />
        <rect x="70" y="46" width="30" height="7" rx="2" fill="rgb(var(--a-500) / .45)" />
      </g>
      <Arrow d="M66 61 L60 61" head="M63 58 L60 61 L63 64" />
    </>
  ),
};

export const HelpArt: React.FC<{ id: HelpArtId; className?: string }> = ({ id, className }) => (
  <svg viewBox="0 0 160 104" className={className} role="img" aria-hidden="true">
    {ART[id]}
  </svg>
);
