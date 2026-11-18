import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { MousePointer } from 'lucide-react';
import { useSocket } from '../../context/SocketContext';
import { CanvasViewport, ViewportState } from '../../engine/Viewport';
import { getUserColor } from '../../utils/userColors';

interface SpeechBubble {
  id: string;
  userId: string;
  displayName: string;
  avatarUrl?: string | null;
  color: string;
  text: string;
  timestamp: number;
}

/**
 * Other painters' cursors and their chat bubbles, drawn over the canvas.
 * Steady cursor motion mutates DOM transforms via refs so React never re-renders on cursor packets;
 * React only commits when painters appear/disappear or metadata/chat bubbles change.
 */
export const RemoteCursorsLayer: React.FC<{
  viewport: CanvasViewport | null;
  viewportState: ViewportState; // re-render on zoom / pan
  selfId?: string;
}> = ({ viewport, viewportState, selfId }) => {
  const { getRemoteCursors, subscribeRemoteCursors, chatMessages, members } = useSocket();
  // Cursor packets carry no avatar (a data URL 30 times a second); the member list has it
  const avatarOf = new Map(members.map((m) => [m.userId, m.avatarUrl]));
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const cursorElsRef = useRef(new Map<string, HTMLDivElement>());
  const ringElsRef = useRef(new Map<string, HTMLSpanElement>());
  const pencilElsRef = useRef(new Map<string, HTMLSpanElement>());
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const zoomRef = useRef(viewportState.zoom);
  zoomRef.current = viewportState.zoom;
  const selfIdRef = useRef(selfId);
  selfIdRef.current = selfId;
  const renderedSigRef = useRef('');

  const buildSignature = useCallback(() => {
    const entries = Array.from(getRemoteCursors().values()).filter((c) => c.userId !== selfIdRef.current);
    if (!entries.length) return '';
    entries.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    return entries.map((c) => `${c.userId}\0${c.displayName}\0${c.color ?? ''}\0${c.avatarUrl ?? ''}`).join('\n');
  }, [getRemoteCursors]);

  const syncCursorDom = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const zoom = zoomRef.current;
    const remote = getRemoteCursors();
    for (const c of remote.values()) {
      if (c.userId === selfIdRef.current) continue;
      const el = cursorElsRef.current.get(c.userId);
      if (el) {
        const pos = vp.canvasToScreen(c.x, c.y);
        el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
      }
      const ring = ringElsRef.current.get(c.userId);
      if (ring) {
        const showRing = Boolean(c.brushSize && c.isDrawing);
        ring.style.display = showRing ? 'inline-block' : 'none';
        if (showRing) {
          const px = `${Math.max(6, Math.min(48, c.brushSize! * zoom))}px`;
          if (ring.style.width !== px) ring.style.width = px;
          if (ring.style.height !== px) ring.style.height = px;
        }
      }
      const pencil = pencilElsRef.current.get(c.userId);
      if (pencil) {
        pencil.style.display = c.isDrawing ? '' : 'none';
      }
    }
  }, [getRemoteCursors]);

  useEffect(() => {
    let raf = 0;
    const unsubscribe = subscribeRemoteCursors(() => {
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          const sig = buildSignature();
          if (sig !== renderedSigRef.current) redraw();
          else syncCursorDom();
        });
      }
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    };
  }, [subscribeRemoteCursors, buildSignature, syncCursorDom]);
  const remoteCursors = getRemoteCursors();
  const [bubbles, setBubbles] = useState<SpeechBubble[]>([]);

  useEffect(() => {
    const latest = chatMessages[chatMessages.length - 1];
    if (!latest || Date.now() - latest.timestamp >= 6000) return;
    setBubbles((prev) => [...prev.filter((b) => b.id !== latest.id && Date.now() - b.timestamp < 6000), latest as SpeechBubble]);
    const timer = setTimeout(() => setBubbles((prev) => prev.filter((b) => b.id !== latest.id)), 5500);
    return () => clearTimeout(timer);
  }, [chatMessages]);

  const cursors = Array.from(remoteCursors.values())
    .filter((c) => c.userId !== selfId)
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  renderedSigRef.current = cursors.map((c) => `${c.userId}\0${c.displayName}\0${c.color ?? ''}\0${c.avatarUrl ?? ''}`).join('\n');

  return (
    <>
      {viewport && cursors.map((c) => {
        const pos = viewport.canvasToScreen(c.x, c.y);
        const color = c.color || getUserColor(c.userId).hex;
        const bubble = bubbles.find((b) => b.userId === c.userId);
        const ringSize = c.brushSize ? Math.max(6, Math.min(48, c.brushSize * viewportState.zoom)) : 8;
        return (
          <div key={c.userId}
            ref={(node) => { if (node) cursorElsRef.current.set(c.userId, node); else cursorElsRef.current.delete(c.userId); }}
            style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`, transition: 'transform 0.04s linear' }}
            className="pointer-events-none absolute left-0 top-0 z-20 flex flex-col items-start">
            <div className="flex items-center gap-1">
              <MousePointer className="h-4 w-4 drop-shadow" style={{ color, fill: color }} />
              <span
                ref={(node) => { if (node) ringElsRef.current.set(c.userId, node); else ringElsRef.current.delete(c.userId); }}
                className="inline-block rounded-full border border-dashed border-white/60"
                style={{
                  display: c.brushSize && c.isDrawing ? 'inline-block' : 'none',
                  width: ringSize,
                  height: ringSize,
                  backgroundColor: `${color}44`,
                }} />
            </div>
            <div style={{ backgroundColor: color, color: '#fff' }}
              className="mt-0.5 flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold shadow-lg">
              {(c.avatarUrl ?? avatarOf.get(c.userId))
                ? <img src={(c.avatarUrl ?? avatarOf.get(c.userId))!} alt="" className="h-3.5 w-3.5 shrink-0 rounded-full border border-white/40 object-cover" />
                : <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-black/20 text-[8px] font-black">{(c.displayName || '畫')[0].toUpperCase()}</span>}
              <span>{c.displayName}</span>
              <span
                ref={(node) => { if (node) pencilElsRef.current.set(c.userId, node); else pencilElsRef.current.delete(c.userId); }}
                style={{ display: c.isDrawing ? '' : 'none' }}
                aria-hidden>✏️</span>
            </div>
            {bubble && (
              <div className="pointer-events-none absolute bottom-full left-0 mb-2">
                <div className="max-w-[220px] break-words rounded-2xl rounded-bl-sm border border-indigo-400/80 bg-neutral-900/95 px-3 py-1.5 text-xs text-white shadow-2xl">
                  {bubble.text}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Messages from painters whose cursor is not on this canvas */}
      <div className="pointer-events-none absolute bottom-4 left-4 z-30 flex max-w-xs flex-col gap-2">
        {bubbles.filter((b) => !cursors.some((c) => c.userId === b.userId)).slice(-3).map((b) => (
          <div key={b.id} className="flex items-center gap-2 rounded-2xl border border-indigo-500/60 bg-neutral-900/95 px-3 py-2 text-xs text-white shadow-2xl">
            <span className="shrink-0 text-[11px] font-bold" style={{ color: b.color || '#818CF8' }}>{b.displayName}:</span>
            <span className="truncate">{b.text}</span>
          </div>
        ))}
      </div>
    </>
  );
};
