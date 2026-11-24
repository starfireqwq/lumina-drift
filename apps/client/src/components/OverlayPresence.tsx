import React, { useLayoutEffect, useState } from 'react';
import { isReducedMotion } from '../theme/motion';

const EXIT_MS = 180;

export function OverlayPresence({ open, kind = 'dialog', children }: {
  open: boolean;
  kind?: 'dialog' | 'drawer' | 'popover';
  children: React.ReactNode;
}) {
  const [retained, setRetained] = useState(open);
  useLayoutEffect(() => {
    if (open) {
      setRetained(true);
    } else if (retained) {
      if (isReducedMotion()) {
        setRetained(false);
        return;
      }
      const fallback = window.setTimeout(() => setRetained(false), EXIT_MS + 50);
      return () => window.clearTimeout(fallback);
    }
  }, [open, retained]);

  if (!open && !retained) return null;

  const blockClosingInput = (event: React.SyntheticEvent) => {
    if (open) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="contents" data-overlay-motion={kind} data-overlay-phase={open ? 'open' : 'closing'}
      style={{ '--overlay-duration': open ? '230ms' : `${EXIT_MS}ms` } as React.CSSProperties}
      onPointerDownCapture={blockClosingInput} onMouseDownCapture={blockClosingInput} onClickCapture={blockClosingInput}
      onKeyDownCapture={blockClosingInput}
      onTransitionEndCapture={(event) => {
        if (!open && event.propertyName === 'opacity' && (event.target as Element).parentElement === event.currentTarget) {
          setRetained(false);
        }
      }}>
      {children}
    </div>
  );
}
