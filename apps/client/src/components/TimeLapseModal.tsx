import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Download,
  Film,
  FastForward,
  Loader2,
  MousePointer,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Video,
  X,
} from 'lucide-react';
import { CanvasModel, LayerModel } from '@atelier/shared';
import {
  ReplayParticipantInfo,
  ReplayProgress,
  ReplayStatus,
  SeedParticipantInput,
  TimeLapseEngine,
} from '../engine/TimeLapseEngine';
import { getVideoExtensionFromBlob, unwrapMediaRecorderError } from '../engine/videoExport';
import { useI18n } from '../context/I18nContext';

interface TimeLapseModalProps {
  isOpen: boolean;
  onClose: () => void;
  canvas: CanvasModel | null;
  layers: LayerModel[];
  seedParticipants?: SeedParticipantInput[];
}

export const TimeLapseModal: React.FC<TimeLapseModalProps> = ({
  isOpen,
  onClose,
  canvas,
  layers,
  seedParticipants = [],
}) => {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<TimeLapseEngine | null>(null);
  const recordedVideoUrlRef = useRef<string | null>(null);

  const [status, setStatus] = useState<ReplayStatus>('idle');
  const [progress, setProgress] = useState<ReplayProgress>({
    currentOpIndex: 0,
    totalOps: 0,
    currentSeq: 0,
    progressPercent: 0,
    status: 'idle',
    loadedOps: 0,
    expectedTotalOps: 0,
    error: null,
  });
  const [participants, setParticipants] = useState<ReplayParticipantInfo[]>([]);
  const [showCursors, setShowCursors] = useState<boolean>(true);
  const [speed, setSpeed] = useState<number>(4);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordProgress, setRecordProgress] = useState<number>(0);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
  const [recordedExtension, setRecordedExtension] = useState<'webm' | 'mp4'>('webm');
  const [videoFormat, setVideoFormat] = useState<'webm' | 'mp4'>('webm');

  const seedRef = useRef(seedParticipants);
  seedRef.current = seedParticipants;

  const layersRef = useRef(layers);
  layersRef.current = layers;

  const startLoad = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !canvas) return;
    setParticipants([]);
    setProgress({
      currentOpIndex: 0,
      totalOps: 0,
      currentSeq: 0,
      progressPercent: 0,
      status: 'loading',
      loadedOps: 0,
      expectedTotalOps: 0,
      error: null,
    });
    void engine.loadCanvasHistory(
      canvas.id,
      canvas.width,
      canvas.height,
      canvas.bgColor,
      layersRef.current,
      seedRef.current
    );
  }, [canvas?.id, canvas?.width, canvas?.height, canvas?.bgColor]);

  // Initialize engine when modal opens
  useEffect(() => {
    if (!isOpen || !canvas || !canvasRef.current) return;

    const engine = new TimeLapseEngine(canvasRef.current, {
      onProgress: (p) => setProgress(p),
      onStatusChange: (s) => setStatus(s),
      onParticipantsChange: (list) => setParticipants(list),
      showCursors,
    });

    engineRef.current = engine;
    engine.setSpeed(speed);
    startLoad();

    return () => {
      engine.destroy();
      engineRef.current = null;
      if (recordedVideoUrlRef.current) {
        URL.revokeObjectURL(recordedVideoUrlRef.current);
        recordedVideoUrlRef.current = null;
      }
    };
  }, [isOpen, canvas?.id, startLoad]);

  // Keep seed participants updated while modal stays open
  useEffect(() => {
    engineRef.current?.setSeedParticipants(seedParticipants);
  }, [seedParticipants]);

  // Sync cursor overlay toggle
  useEffect(() => {
    engineRef.current?.setShowCursors(showCursors);
  }, [showCursors]);

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
      if (recordedVideoUrlRef.current) {
        URL.revokeObjectURL(recordedVideoUrlRef.current);
        recordedVideoUrlRef.current = null;
      }
      setRecordedVideoUrl(null);

      const blob = await engineRef.current.exportTimeLapseVideo(videoFormat, (pct) => {
        setRecordProgress(pct);
      });

      const url = URL.createObjectURL(blob);
      recordedVideoUrlRef.current = url;
      setRecordedExtension(getVideoExtensionFromBlob(blob, videoFormat));
      setRecordedVideoUrl(url);
    } catch (err: unknown) {
      const error = unwrapMediaRecorderError(err);
      alert(`匯出縮時影片失敗: ${error.message}`);
    } finally {
      setIsRecording(false);
    }
  };

  if (!isOpen) return null;

  const loadedCount = progress.loadedOps ?? 0;
  const expectedCount = progress.expectedTotalOps ?? 0;

  return (
    <div role="dialog" aria-modal="true" className="atelier-modal-backdrop fixed inset-0 z-[70] flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="atelier-modal w-full max-w-4xl flex flex-col overflow-hidden max-h-[92vh]">
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
              <div className="absolute inset-0 bg-black/65 flex flex-col items-center justify-center gap-2 text-neutral-300 px-4">
                <Loader2 className="w-7 h-7 animate-spin text-indigo-400" />
                <span className="text-xs font-medium">{t.replay.loadingOps}</span>
                {loadedCount > 0 && (
                  <span className="text-[11px] font-mono text-indigo-300">
                    {expectedCount > 0
                      ? `${loadedCount.toLocaleString()} / ${expectedCount.toLocaleString()}`
                      : loadedCount.toLocaleString()}
                  </span>
                )}
              </div>
            )}

            {status === 'error' && (
              <div className="absolute inset-0 bg-black/75 flex flex-col items-center justify-center gap-3 text-center px-6">
                <div className="p-2.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <div className="space-y-1 max-w-md">
                  <p className="text-xs font-semibold text-rose-300">{t.replay.loadError}</p>
                  <p className="text-xs text-neutral-300 break-words">
                    {progress.error || t.replay.loadError}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={startLoad}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>{t.replay.retry}</span>
                </button>
              </div>
            )}

            {progress.totalOps === 0 && status !== 'loading' && status !== 'error' && (
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center text-neutral-400 text-xs">
                {t.replay.noOpsWarning}
              </div>
            )}
          </div>

          {/* Contributors strip */}
          {participants.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-800/80 text-[11px]">
              <span className="text-neutral-400 font-medium mr-1">{t.replay.contributors}:</span>
              {participants.map((p) => (
                <div
                  key={p.userId}
                  className="flex items-center gap-1.5 rounded-full px-2 py-0.5 bg-neutral-800/90 border border-neutral-700/80 text-neutral-200"
                >
                  {p.avatarUrl ? (
                    <img
                      src={p.avatarUrl}
                      alt={p.displayName}
                      className="w-4 h-4 rounded-full object-cover border border-white/40 shrink-0"
                    />
                  ) : (
                    <span
                      className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                      style={{ backgroundColor: p.color }}
                    >
                      {(p.displayName || '畫').charAt(0).toUpperCase()}
                    </span>
                  )}
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: p.color }}
                  />
                  <span className="font-medium max-w-[120px] truncate">{p.displayName}</span>
                  {typeof p.opCount === 'number' && p.opCount > 0 && (
                    <span className="text-neutral-400 font-mono text-[10px]">
                      {p.opCount.toLocaleString()}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Timeline & Scrubber Bar */}
          <div className="flex flex-col gap-1.5 bg-neutral-900/60 p-3 rounded-xl border border-neutral-800">
            <div className="flex items-center justify-between text-xs text-neutral-400 font-mono">
              <span>
                {t.replay.currentOp}: #{progress.currentOpIndex.toLocaleString()}
              </span>
              <span className="text-indigo-400 font-semibold">
                {progress.progressPercent}%
              </span>
              <span>
                {t.replay.totalOps}: {progress.totalOps.toLocaleString()}
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
            {/* Play, Pause, Rewind, Cursor Toggle */}
            <div className="flex flex-wrap items-center gap-2">
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

              <button
                type="button"
                onClick={() => setShowCursors((prev) => !prev)}
                disabled={isRecording}
                aria-pressed={showCursors}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-xl border transition ${
                  showCursors
                    ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-300'
                    : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white'
                }`}
              >
                <MousePointer className="w-3.5 h-3.5" />
                <span>{t.replay.showCursors}</span>
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
                download={`atelier_timelapse_${canvas?.title || 'drawing'}.${recordedExtension}`}
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
