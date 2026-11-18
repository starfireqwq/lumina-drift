import React, { useEffect, useRef, useState } from 'react';
import {
  Download,
  Film,
  FastForward,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Video,
  X,
} from 'lucide-react';
import { CanvasModel, LayerModel } from '@atelier/shared';
import { TimeLapseEngine, ReplayProgress, ReplayStatus } from '../engine/TimeLapseEngine';
import { useI18n } from '../context/I18nContext';

interface TimeLapseModalProps {
  isOpen: boolean;
  onClose: () => void;
  canvas: CanvasModel | null;
  layers: LayerModel[];
}

export const TimeLapseModal: React.FC<TimeLapseModalProps> = ({
  isOpen,
  onClose,
  canvas,
  layers,
}) => {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<TimeLapseEngine | null>(null);

  const [status, setStatus] = useState<ReplayStatus>('idle');
  const [progress, setProgress] = useState<ReplayProgress>({
    currentOpIndex: 0,
    totalOps: 0,
    currentSeq: 0,
    progressPercent: 0,
    status: 'idle',
  });
  const [speed, setSpeed] = useState<number>(4);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordProgress, setRecordProgress] = useState<number>(0);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
  const [videoFormat, setVideoFormat] = useState<'webm' | 'mp4'>('webm');

  // Initialize engine when modal opens
  useEffect(() => {
    if (!isOpen || !canvas || !canvasRef.current) return;

    const engine = new TimeLapseEngine(canvasRef.current, {
      onProgress: (p) => setProgress(p),
      onStatusChange: (s) => setStatus(s),
    });

    engineRef.current = engine;
    engine.setSpeed(speed);

    engine.loadCanvasHistory(
      canvas.id,
      canvas.width,
      canvas.height,
      canvas.bgColor,
      layers
    );

    return () => {
      engine.destroy();
      engineRef.current = null;
      if (recordedVideoUrl) {
        URL.revokeObjectURL(recordedVideoUrl);
      }
    };
  }, [isOpen, canvas?.id]);

  const handlePlayPause = () => {
    if (!engineRef.current) return;
    if (status === 'playing') {
      engineRef.current.pause();
    } else {
      engineRef.current.play();
    }
  };

  const handleRewind = () => {
    if (!engineRef.current) return;
    engineRef.current.seek(0);
  };

  const handleSpeedChange = (newSpeed: number) => {
    setSpeed(newSpeed);
    engineRef.current?.setSpeed(newSpeed);
  };

  const handleScrubberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    engineRef.current?.seek(val);
  };

  const handleExportVideo = async () => {
    if (!engineRef.current || progress.totalOps === 0) return;

    try {
      setIsRecording(true);
      setRecordProgress(0);
      setRecordedVideoUrl(null);

      const blob = await engineRef.current.exportTimeLapseVideo(videoFormat, (pct) => {
        setRecordProgress(pct);
      });

      const url = URL.createObjectURL(blob);
      setRecordedVideoUrl(url);
    } catch (err: any) {
      alert(`匯出縮時影片失敗: ${err.message || err}`);
    } finally {
      setIsRecording(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div role="dialog" aria-modal="true" className="atelier-modal-backdrop fixed inset-0 z-[70] flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="atelier-modal w-full max-w-4xl  flex flex-col overflow-hidden max-h-[92vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-800 bg-neutral-900">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-indigo-600/20 text-indigo-400 border border-indigo-500/30">
              <Film className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white tracking-wide">
                {t.replay.title}
              </h3>
              <p className="text-xs text-neutral-400">{t.replay.subtitle}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={t.common.close}
            className="p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 flex flex-col gap-4 overflow-y-auto">
          {/* Canvas Display Viewport */}
          <div className="relative w-full aspect-video bg-neutral-950 rounded-xl border border-neutral-800 flex items-center justify-center overflow-hidden shadow-inner">
            <canvas
              ref={canvasRef}
              className="max-h-full max-w-full object-contain rounded"
              style={{
                aspectRatio: canvas ? `${canvas.width} / ${canvas.height}` : '1 / 1',
              }}
            />

            {status === 'loading' && (
              <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-2 text-neutral-300">
                <Loader2 className="w-7 h-7 animate-spin text-indigo-400" />
                <span className="text-xs font-medium">正在載入歷史操作日誌...</span>
              </div>
            )}

            {progress.totalOps === 0 && status !== 'loading' && (
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center text-neutral-400 text-xs">
                {t.replay.noOpsWarning}
              </div>
            )}
          </div>

          {/* Timeline & Scrubber Bar */}
          <div className="flex flex-col gap-1.5 bg-neutral-900/60 p-3 rounded-xl border border-neutral-800">
            <div className="flex items-center justify-between text-xs text-neutral-400 font-mono">
              <span>
                {t.replay.currentOp}: #{progress.currentOpIndex}
              </span>
              <span className="text-indigo-400 font-semibold">
                {progress.progressPercent}%
              </span>
              <span>
                {t.replay.totalOps}: {progress.totalOps}
              </span>
            </div>

            <input
              type="range"
              min={0}
              max={progress.totalOps}
              value={progress.currentOpIndex}
              onChange={handleScrubberChange}
              disabled={progress.totalOps === 0 || isRecording}
              className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
          </div>

          {/* Playback Controls & Speed Selectors */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Play, Pause, Rewind */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePlayPause}
                disabled={progress.totalOps === 0 || isRecording}
                className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium text-xs rounded-xl shadow-lg shadow-indigo-950 transition"
              >
                {status === 'playing' ? (
                  <>
                    <Pause className="w-4 h-4" />
                    <span>{t.replay.pause}</span>
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    <span>{t.replay.play}</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleRewind}
                disabled={progress.totalOps === 0 || isRecording}
                title={t.replay.restart}
                className="p-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-neutral-300 hover:text-white rounded-xl transition"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>

            {/* Speeds */}
            <div className="flex items-center gap-1 bg-neutral-900 p-1 rounded-xl border border-neutral-800 text-xs">
              <span className="px-2 text-neutral-400 flex items-center gap-1 text-[11px]">
                <FastForward className="w-3.5 h-3.5" />
                {t.replay.speed}:
              </span>
              {[1, 4, 16, 64].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => handleSpeedChange(s)}
                  className={`px-2.5 py-1 rounded-lg font-medium transition ${
                    speed === s
                      ? 'bg-indigo-600 text-white'
                      : 'text-neutral-400 hover:text-white'
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>

            {/* Video Export Button */}
            <div className="flex items-center gap-2">
              <select
                value={videoFormat}
                onChange={(e) => setVideoFormat(e.target.value as 'webm' | 'mp4')}
                disabled={isRecording}
                className="bg-neutral-800 border border-neutral-700 text-neutral-300 rounded-lg text-xs px-2 py-1.5 outline-none font-mono"
              >
                <option value="webm">WebM (VP9 4K支援)</option>
                <option value="mp4">MP4 (AVC相容)</option>
              </select>

              <button
                type="button"
                onClick={handleExportVideo}
                disabled={progress.totalOps === 0 || isRecording}
                className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium text-xs rounded-xl shadow-lg shadow-emerald-950 transition"
              >
                {isRecording ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{t.replay.recording} ({recordProgress}%)</span>
                  </>
                ) : (
                  <>
                    <Video className="w-4 h-4" />
                    <span>{t.replay.exportVideo}</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Download Box if video recorded */}
          {recordedVideoUrl && (
            <div className="mt-2 p-3.5 bg-emerald-950/40 border border-emerald-800/80 rounded-xl flex items-center justify-between text-xs text-emerald-300 animate-in fade-in duration-200">
              <div className="flex items-center gap-2">
                <Video className="w-4 h-4 text-emerald-400" />
                <span className="font-medium">{t.replay.exportComplete}</span>
              </div>
              <a
                href={recordedVideoUrl}
                download={`atelier_timelapse_${canvas?.title || 'drawing'}.${videoFormat}`}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg shadow transition"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{t.replay.downloadVideo}</span>
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
