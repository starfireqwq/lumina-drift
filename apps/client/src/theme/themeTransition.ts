import { flushSync } from 'react-dom';

/**
 * Animated theme switch. The browser snapshots the old UI, we apply the new theme synchronously,
 * then animate the new snapshot in (View Transitions API):
 *  - ripple: a circle grows from where you clicked, fast → slow → fast
 *  - jelly:  the new look drops in with a squash-and-stretch wobble
 *  - fade:   a plain cross-fade
 * Browsers without View Transitions (or reduced motion) just switch.
 */
export type ThemeAnim = 'ripple' | 'jelly' | 'fade' | 'none';

const KEY = 'atelier_theme_anim';
export const THEME_ANIMS: Array<{ id: ThemeAnim; label: string }> = [
  { id: 'ripple', label: '擴散' },
  { id: 'jelly', label: '果凍' },
  { id: 'fade', label: '淡入' },
  { id: 'none', label: '無' },
];

export const loadThemeAnim = (): ThemeAnim => {
  try {
    const v = localStorage.getItem(KEY) as ThemeAnim | null;
    if (v && THEME_ANIMS.some((a) => a.id === v)) return v;
  } catch { /* ignore */ }
  return 'ripple';
};

export const saveThemeAnim = (v: ThemeAnim) => {
  try { localStorage.setItem(KEY, v); } catch { /* ignore */ }
};

/** Fast at both ends, lingering in the middle (快-慢-快) */
export const EASE_FAST_SLOW_FAST = 'cubic-bezier(.12,.62,.88,.38)';

type ViewTransitionDoc = Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> } };

let running = false;

export const runThemeTransition = (apply: () => void, origin?: { x: number; y: number }, style: ThemeAnim = loadThemeAnim()) => {
  const doc = document as ViewTransitionDoc;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (running) return;
  if (style === 'none' || reduced || !doc.startViewTransition) {
    apply();
    return;
  }
  running = true;
  const root = document.documentElement;
  root.classList.add('atelier-theme-vt');
  // The visible snapshot and the live UI can differ during the transition. Consume a second tap
  // before it can dismiss a menu or be interpreted as a canvas gesture.
  const guard = new AbortController();
  const consume = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of ['pointerdown', 'click', 'dblclick', 'contextmenu']) {
    window.addEventListener(type, consume, { capture: true, signal: guard.signal });
  }
  const done = () => {
    guard.abort();
    running = false;
    root.classList.remove('atelier-theme-vt');
  };
  let vt: ReturnType<NonNullable<ViewTransitionDoc['startViewTransition']>>;
  try {
    vt = doc.startViewTransition(() => flushSync(apply));
  } catch {
    done();
    apply();
    return;
  }
  vt.finished.then(done, done);
  vt.ready.then(() => {
    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? 0;
    if (style === 'ripple') {
      const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 780, easing: EASE_FAST_SLOW_FAST, pseudoElement: '::view-transition-new(root)' },
      );
    } else if (style === 'jelly') {
      root.animate(
        {
          transform: ['scale(.94, .94)', 'scale(1.035, .97)', 'scale(.985, 1.02)', 'scale(1.008, .995)', 'scale(1, 1)'],
          opacity: [0, 1, 1, 1, 1],
          transformOrigin: [`${x}px ${y}px`, `${x}px ${y}px`, `${x}px ${y}px`, `${x}px ${y}px`, `${x}px ${y}px`],
        },
        { duration: 720, easing: 'cubic-bezier(.34,1.56,.64,1)', pseudoElement: '::view-transition-new(root)' },
      );
      root.animate({ opacity: [1, 0] }, { duration: 260, easing: 'ease-out', fill: 'forwards', pseudoElement: '::view-transition-old(root)' });
    } else {
      root.animate({ opacity: [0, 1] }, { duration: 320, easing: 'ease-out', pseudoElement: '::view-transition-new(root)' });
    }
  }).catch(() => { /* The finished promise releases the input guard even if snapshots are skipped. */ });
};
