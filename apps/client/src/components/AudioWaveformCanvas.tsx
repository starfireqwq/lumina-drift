import React, { useEffect, useMemo, useRef } from 'react';
import { AudioTrackMeta, sliceWaveformPeaksForClip } from '@atelier/shared';

export interface AudioWaveformCanvasProps {
  peaks: readonly number[];
  meta: AudioTrackMeta;
  fps: number;
  widthPx: number;
  heightPx?: number;
  /** Optional playhead progress [0..1] across this clip; -1 if outside */
  playheadProgress?: number;
  testId?: string;
}

/**
 * High-DPI `<canvas>` waveform renderer for animation timeline audio tracks.
 * Visualizes trimmed source peaks, volume attenuation (with ghost peak outline),
 * muted state, and playhead progress tint.
 */
export const AudioWaveformCanvas: React.FC<AudioWaveformCanvasProps> = ({
  peaks,
  meta,
  fps,
  widthPx,
  heightPx = 24,
  playheadProgress = -1,
  testId,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const safeWidth = Math.max(20, Math.round(widthPx));
  const safeHeight = Math.max(14, Math.round(heightPx));
  const barCount = Math.max(8, Math.min(320, Math.floor(safeWidth / 3)));

  const sliced = useMemo(
    () => sliceWaveformPeaksForClip(peaks, meta, fps, barCount),
    [peaks, meta, fps, barCount]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? Math.max(1, Math.min(2, window.devicePixelRatio || 1)) : 1;
    const targetW = Math.round(safeWidth * dpr);
    const targetH = Math.round(safeHeight * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, safeWidth, safeHeight);

    const midY = safeHeight / 2;
    const maxHalfH = Math.max(2, safeHeight / 2 - 2);
    const stepX = safeWidth / sliced.rawBars.length;
    const barW = Math.max(1.25, Math.min(2.6, stepX * 0.68));

    // Center axis hairline
    ctx.fillStyle = meta.muted ? 'rgba(163, 163, 163, 0.25)' : 'rgba(52, 211, 153, 0.22)';
    ctx.fillRect(0, midY - 0.5, safeWidth, 1);

    const showGhost = meta.muted || meta.volume < 0.96;
    const clampedProgress =
      playheadProgress >= 0 && playheadProgress <= 1 ? playheadProgress : -1;

    for (let i = 0; i < sliced.rawBars.length; i++) {
      const x = i * stepX + (stepX - barW) * 0.5;
      const rawAmp = Math.max(0.05, sliced.rawBars[i] ?? 0);
      const scaledAmp = sliced.scaledBars[i] ?? 0;

      // Ghost outline of original source amplitude when attenuated or muted
      if (showGhost) {
        const ghostH = Math.max(2, rawAmp * maxHalfH * 2);
        ctx.fillStyle = meta.muted ? 'rgba(163, 163, 163, 0.26)' : 'rgba(52, 211, 153, 0.2)';
        ctx.fillRect(x, midY - ghostH / 2, barW, ghostH);
      }

      if (!meta.muted && scaledAmp > 0.001) {
        const h = Math.max(2, Math.max(0.06, scaledAmp) * maxHalfH * 2);
        const barFrac = (i + 0.5) / sliced.rawBars.length;
        const passed = clampedProgress >= 0 && barFrac <= clampedProgress;
        ctx.fillStyle = passed ? '#6ee7b7' : '#34d399';
        ctx.fillRect(x, midY - h / 2, barW, h);
      }
    }

    // Playhead progress cursor inside clip
    if (clampedProgress >= 0) {
      const px = clampedProgress * safeWidth;
      ctx.fillStyle = 'rgba(244, 63, 94, 0.85)';
      ctx.fillRect(px - 0.75, 0, 1.5, safeHeight);
    }

    ctx.restore();
  }, [safeWidth, safeHeight, sliced, meta.muted, meta.volume, playheadProgress]);

  return (
    <canvas
      ref={canvasRef}
      width={safeWidth}
      height={safeHeight}
      style={{ width: '100%', height: '100%', display: 'block' }}
      data-testid={testId}
      data-peak-count={sliced.rawBars.length}
      data-muted={meta.muted ? 'true' : 'false'}
      data-volume={Math.round(meta.volume * 100)}
      data-start-frame={meta.startFrame}
      aria-hidden="true"
    />
  );
};
