import { RefObject, useEffect, useState } from 'react';
import { useUiScale } from '../theme/uiScale';

/**
 * Returns the container's (or viewport's) width in unscaled layout units (`physicalPx / uiScale`).
 * PostCSS converts pixel utilities into `rem` (which scales with `uiScale`), while CSS media
 * queries stay in physical `px`. Comparing against `effectiveWidth` ensures responsive collapsing
 * still triggers when the user increases `uiScale` or narrows panels.
 */
export function useEffectiveWidth(ref?: RefObject<HTMLElement | null>) {
  const uiScale = useUiScale();
  const [rawWidth, setRawWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1440
  );

  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1440
  );

  useEffect(() => {
    const onWinResize = () => setViewportWidth(window.innerWidth);
    onWinResize();
    window.addEventListener('resize', onWinResize, { passive: true });
    return () => window.removeEventListener('resize', onWinResize);
  }, []);

  useEffect(() => {
    const el = ref?.current;
    if (el && typeof ResizeObserver !== 'undefined') {
      const sync = () => {
        const w = el.clientWidth;
        if (w > 0) setRawWidth(w);
      };
      sync();
      const ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width;
        if (w && w > 0) setRawWidth(w);
      });
      ro.observe(el);
      return () => ro.disconnect();
    }
    if (typeof window === 'undefined') return;
    const onResize = () => setRawWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, [ref]);

  return { effectiveWidth: rawWidth / (uiScale || 1), viewportWidth, uiScale };
}
