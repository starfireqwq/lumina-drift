import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface FloatingPosition {
  top: number;
  left: number;
  maxHeight: number;
}

export function computeClampedPopoverPosition(
  anchor: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  floating: { width: number; height: number },
  viewport: { width: number; height: number },
  options?: { align?: 'left' | 'right'; gap?: number; margin?: number },
): FloatingPosition {
  const align = options?.align ?? 'left';
  const gap = options?.gap ?? 6;
  const margin = options?.margin ?? 8;
  const maxW = Math.max(120, viewport.width - margin * 2);
  const fullMaxH = Math.max(120, viewport.height - margin * 2);
  const width = Math.min(floating.width || maxW, maxW);
  const height = Math.min(floating.height || fullMaxH, fullMaxH);

  const preferredLeft = align === 'right' ? anchor.right - width : anchor.left;
  const left = Math.max(margin, Math.min(viewport.width - width - margin, preferredLeft));

  const spaceBelow = viewport.height - anchor.bottom - gap - margin;
  const spaceAbove = anchor.top - gap - margin;
  const preferAbove = spaceBelow < Math.min(height, 180) && spaceAbove > spaceBelow;

  if (preferAbove) {
    const availAbove = Math.max(120, Math.min(fullMaxH, spaceAbove));
    const clampedH = Math.min(height, availAbove);
    const top = Math.max(margin, Math.min(viewport.height - clampedH - margin, anchor.top - gap - clampedH));
    return { top, left, maxHeight: Math.min(fullMaxH, viewport.height - top - margin) };
  }

  const top = Math.max(margin, Math.min(viewport.height - margin - 120, anchor.bottom + gap));
  const maxHeight = Math.max(120, viewport.height - top - margin);
  return { top, left, maxHeight };
}

/**
 * Keeps a fixed/portaled popover anchored to its trigger while clamping all four edges inside the visual viewport.
 * Tracks delayed mounts (e.g. OverlayPresence) via the returned `setPopoverEl` callback ref.
 */
export function useAnchoredPopover(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  externalPopRef?: RefObject<HTMLElement | null> | null,
  options?: { align?: 'left' | 'right'; gap?: number; margin?: number; fallbackWidth?: number; fallbackHeight?: number },
): FloatingPosition & { setPopoverEl: (el: HTMLElement | null) => void } {
  const [pos, setPos] = useState<FloatingPosition>({ top: 52, left: 8, maxHeight: 480 });
  const [popEl, setPopElState] = useState<HTMLElement | null>(null);
  const internalPopRef = useRef<HTMLElement | null>(null);

  const setPopoverEl = useCallback((el: HTMLElement | null) => {
    internalPopRef.current = el;
    if (externalPopRef && 'current' in externalPopRef) {
      (externalPopRef as { current: HTMLElement | null }).current = el;
    }
    setPopElState(el);
  }, [externalPopRef]);

  const align = options?.align ?? 'left';
  const gap = options?.gap ?? 6;
  const margin = options?.margin ?? 8;
  const fallbackWidth = options?.fallbackWidth ?? 320;
  const fallbackHeight = options?.fallbackHeight ?? 260;

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchorEl = anchorRef.current;
      if (!anchorEl) return;
      const anchorRect = anchorEl.getBoundingClientRect();
      const targetPop = popEl ?? externalPopRef?.current ?? internalPopRef.current;
      const popRect = targetPop?.getBoundingClientRect();
      const vw = window.visualViewport?.width ?? window.innerWidth;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      setPos(computeClampedPopoverPosition(
        anchorRect,
        {
          width: popRect && popRect.width > 0 ? popRect.width : fallbackWidth,
          height: popRect && popRect.height > 0 ? popRect.height : fallbackHeight,
        },
        { width: vw, height: vh },
        { align, gap, margin },
      ));
    };
    update();
    const targetPop = popEl ?? externalPopRef?.current ?? internalPopRef.current;
    const ro = typeof ResizeObserver !== 'undefined' && targetPop
      ? new ResizeObserver(update)
      : null;
    if (ro && targetPop) ro.observe(targetPop);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [open, popEl, anchorRef, externalPopRef, align, gap, margin, fallbackWidth, fallbackHeight]);

  return { ...pos, setPopoverEl };
}
