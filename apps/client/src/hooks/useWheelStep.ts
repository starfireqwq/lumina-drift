import { useEffect, useRef, type RefObject } from 'react';

/**
 * Attaches a non-passive `wheel` listener to `ref` so hovering over sliders, tracks, or number
 * inputs adjusts their value without scrolling parent containers or logging passive warnings.
 * Wheel up (`deltaY < 0`) sends positive step count (`+1`, or `+5` while Shift is held).
 */
export function useWheelStep<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onStep: ((steps: number, e: WheelEvent) => void) | undefined
) {
  const cbRef = useRef(onStep);
  cbRef.current = onStep;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!cbRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      const dir = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
      if (!dir) return;
      cbRef.current(dir * (e.shiftKey ? 5 : 1), e);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [ref]);
}
