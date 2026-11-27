import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Download,
  Film,
  FolderOutput,
  Images,
  Layers,
  Loader2,
  Music,
  Plus,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  isAudioLayer,
  normalizeAudioTrackMeta,
  planExportAudioMix,
  type LayerModel,
} from '@atelier/shared';
import { AtelierModal, modalButton } from './AtelierModal';
import { OverlayPresence } from './OverlayPresence';
import { useI18n } from '../context/I18nContext';
import { formatTimecode, type AnimationTrack, type TimecodeMode } from '../engine/AnimationEngine';
import {
  renderMixedAudioTrack,
  type AudioAssetSummary,
  type PlayableAudioTrackItem,
} from '../engine/AudioTrackEngine';
import {
  computeScaledExportDimensions,
  DEFAULT_LINE_COLOR_RULES,
  formatCelFileName,
  formatSequenceFileName,
  resolveExportFrameRange,
  resolveExportRegion,
  type CelExportFormat,
  type CelNamingMode,
  type ExportCropRect,
  type ExportRangeMode,
  type LineColorRule,
  type SequenceFrameMode,
} from '../engine/animationExport';
import {
  buildVideoRecorderCandidates,
  computeVideoExportDimensionsForResolution,
  getVideoExtensionFromBlob,
  isWebCodecsAudioEncoderAvailable,
  isWebCodecsVideoEncoderAvailable,
  unwrapMediaRecorderError,
  type AudioMuxFallbackReason,
  type VideoExportResolution,
} from '../engine/videoExport';
import type {
  AnimationCelExportPlan,
  AnimationExportPlan,
  AnimationExportPlanRequest,
  AnimationExportScope,
} from './AnimationTimelineBar';

export type AnimationExportMode = 'mp4' | 'gif' | 'sequence' | 'cels';

interface DesktopExportFolderBridge {
  pickDirectory: (title?: string) => Promise<{ canceled: boolean; dirId?: string; dirPath?: string }>;
  writeFile: (dirId: string, fileName: string, data: Uint8Array) => Promise<{ ok: boolean; filePath?: string; error?: string }>;
  closeDirectory: (dirId: string) => Promise<boolean>;
}

function getDesktopExportFolder(): DesktopExportFolderBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { atelierDesktop?: { exportFolder?: DesktopExportFolderBridge } })
    .atelierDesktop?.exportFolder;
}

export interface AnimationExportModalProps {
  open: boolean;
  onClose: () => void;
  tracks: AnimationTrack[];
  activeFolderId: string | null;
  fps: number;
  timelineLength: number;
  playbackRange: { start: number; end: number } | null;
  timecodeMode: TimecodeMode;
  canvasWidth: number;
  canvasHeight: number;
  /** Optional D3 camera crop rect (reserved for Phase E1; null = full canvas) */
  cameraCropRect?: ExportCropRect | null;
  /** Phase E1: active 2D camera frame output dimensions when a visible camera layer exists */
  cameraFrameSize?: { width: number; height: number } | null;
  planExport: (opts: AnimationExportPlanRequest) => AnimationExportPlan | null;
  planCelExport?: (opts: { folderIds: string[] }) => AnimationCelExportPlan | null;
  /** Phase 6.1: Audio layers & local asset summaries for MP4/WebM audio mixing */
  audioLayers?: LayerModel[];
  audioAssetSummaries?: Record<string, AudioAssetSummary>;
}

export const AnimationExportModal: React.FC<AnimationExportModalProps> = ({
  open,
  onClose,
  tracks,
  activeFolderId,
  fps,
  timelineLength,
  playbackRange,
  timecodeMode,
  canvasWidth,
  canvasHeight,
  cameraCropRect = null,
  cameraFrameSize = null,
  planExport,
  planCelExport,
  audioLayers = [],
  audioAssetSummaries = {},
}) => {
  const { t } = useI18n();
  const folderBridge = getDesktopExportFolder();
  const hasFolderBridge = Boolean(folderBridge);
  const webCodecsReady = useMemo(() => isWebCodecsVideoEncoderAvailable(), []);
  const audioEncoderReady = useMemo(() => isWebCodecsAudioEncoderAvailable(), []);
  const canRecord = typeof MediaRecorder !== 'undefined';
  const mp4Supported = useMemo(
    () =>
      webCodecsReady ||
      buildVideoRecorderCandidates(canvasWidth, canvasHeight, 'mp4').some((c) => c.extension === 'mp4'),
    [canvasWidth, canvasHeight, webCodecsReady]
  );

  const [mode, setMode] = useState<AnimationExportMode>('mp4');
  const [videoContainer, setVideoContainer] = useState<'mp4' | 'webm'>('mp4');
  const [includeAudio, setIncludeAudio] = useState<boolean>(true);
  const [videoResolution, setVideoResolution] = useState<VideoExportResolution>('4k');
  const [scope, setScope] = useState<AnimationExportScope>('folder');
  const [useCameraFrame, setUseCameraFrame] = useState<boolean>(Boolean(cameraFrameSize));
  const [rangeMode, setRangeMode] = useState<ExportRangeMode>('all');
  const [customStartText, setCustomStartText] = useState('1');
  const [customEndText, setCustomEndText] = useState('1');

  // D1 Sequence options
  const [seqDestination, setSeqDestination] = useState<'zip' | 'folder'>(() => (hasFolderBridge ? 'folder' : 'zip'));
  const [seqPrefix, setSeqPrefix] = useState('frame');
  const [seqSuffix, setSeqSuffix] = useState('');
  const [seqSeparator, setSeqSeparator] = useState('_');
  const [seqStartNum, setSeqStartNum] = useState(1);
  const [seqZeroPad, setSeqZeroPad] = useState(4);
  const [seqTransparent, setSeqTransparent] = useState(true);
  const [seqFrameMode, setSeqFrameMode] = useState<SequenceFrameMode>('every-frame');
  const [sizeMode, setSizeMode] = useState<'original' | 'scale'>('original');
  const [scalePercent, setScalePercent] = useState(100);

  // D4 Per-cel options
  const [celDestination, setCelDestination] = useState<'zip' | 'folder'>(() => (hasFolderBridge ? 'folder' : 'zip'));
  const [selectedFolderIds, setSelectedFolderIds] = useState<string[]>([]);
  const [celNamingMode, setCelNamingMode] = useState<CelNamingMode>('folder-cel');
  const [celPrefix, setCelPrefix] = useState('');
  const [celSuffix, setCelSuffix] = useState('');
  const [celSeparator, setCelSeparator] = useState('_');
  const [celFormat, setCelFormat] = useState<CelExportFormat>('png');
  const [celTgaBpp, setCelTgaBpp] = useState<24 | 32>(24);
  const [celTransparent, setCelTransparent] = useState(true);
  const [binarizeEnabled, setBinarizeEnabled] = useState(false);
  const [binarizeBg, setBinarizeBg] = useState<'white' | 'transparent'>('white');
  const [lineRules, setLineRules] = useState<LineColorRule[]>(() => DEFAULT_LINE_COLOR_RULES.map((r) => ({ ...r })));

  // Progress / feedback / abort
  const [progressText, setProgressText] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Sync defaults when opening modal
  useEffect(() => {
    if (!open) return;
    setStatusNotice(null);
    setUseCameraFrame(Boolean(cameraFrameSize));
    const len = Math.max(1, timelineLength);
    setCustomStartText(formatTimecode(playbackRange?.start ?? 0, fps, timecodeMode));
    setCustomEndText(formatTimecode(playbackRange?.end ?? len - 1, fps, timecodeMode));
    if (selectedFolderIds.length === 0 || !selectedFolderIds.some((id) => tracks.some((tr) => tr.folderId === id))) {
      setSelectedFolderIds(activeFolderId ? [activeFolderId] : tracks.map((tr) => tr.folderId));
    }
  }, [open, activeFolderId, tracks, timelineLength, playbackRange, fps, timecodeMode, cameraFrameSize]);

  const activeTrack = tracks.find((tr) => tr.folderId === activeFolderId) ?? tracks[0];
  const applyingCamera = Boolean(cameraFrameSize) && useCameraFrame && mode !== 'cels';
  const exportRegion = useMemo(
    () =>
      applyingCamera && cameraFrameSize
        ? { x: 0, y: 0, width: cameraFrameSize.width, height: cameraFrameSize.height }
        : resolveExportRegion(canvasWidth, canvasHeight, cameraCropRect),
    [applyingCamera, cameraFrameSize, canvasWidth, canvasHeight, cameraCropRect]
  );

  const scaledDims = useMemo(
    () =>
      sizeMode === 'scale'
        ? computeScaledExportDimensions(exportRegion.width, exportRegion.height, { scalePercent })
        : { width: exportRegion.width, height: exportRegion.height },
    [exportRegion.width, exportRegion.height, sizeMode, scalePercent]
  );

  const resolvedRange = useMemo(
    () =>
      resolveExportFrameRange(Math.max(1, timelineLength), {
        mode: rangeMode,
        playbackRange,
        customStartText,
        customEndText,
        fps,
      }),
    [timelineLength, rangeMode, playbackRange, customStartText, customEndText, fps]
  );

  const seqPreviewName = useMemo(
    () =>
      formatSequenceFileName(0, {
        prefix: seqPrefix,
        suffix: seqSuffix,
        separator: seqSeparator,
        startNumber: seqStartNum,
        zeroPad: seqZeroPad,
        extension: 'png',
      }),
    [seqPrefix, seqSuffix, seqSeparator, seqStartNum, seqZeroPad]
  );

  const firstSelectedTrack = tracks.find((tr) => selectedFolderIds.includes(tr.folderId)) ?? activeTrack;
  const firstSelectedCel = firstSelectedTrack?.entries.find((e) => e.ref === undefined);
  const celPreviewName = useMemo(
    () =>
      formatCelFileName(
        firstSelectedTrack?.name ?? 'Folder',
        firstSelectedCel?.label ?? '1',
        {
          mode: celNamingMode,
          prefix: celPrefix,
          suffix: celSuffix,
          separator: celSeparator,
          extension: celFormat,
        }
      ),
    [firstSelectedTrack?.name, firstSelectedCel?.label, celNamingMode, celPrefix, celSuffix, celSeparator, celFormat]
  );

  const selectedCelCount = useMemo(() => {
    const picked = new Set(selectedFolderIds);
    let count = 0;
    for (const tr of tracks) {
      if (!picked.has(tr.folderId)) continue;
      for (const e of tr.entries) {
        if (e.ref === undefined) count++;
      }
    }
    return count;
  }, [tracks, selectedFolderIds]);

  const celFormatForcesWhite = celFormat === 'bmp' || (celFormat === 'tga' && celTgaBpp === 24);
  const busy = progressText !== null;

  const canExportNow = (() => {
    if (busy) return false;
    if (mode === 'mp4') return (webCodecsReady || canRecord) && resolvedRange.valid;
    if (mode === 'gif' || mode === 'sequence') return resolvedRange.valid;
    if (mode === 'cels') return Boolean(planCelExport) && selectedCelCount > 0;
    return false;
  })();

  const toggleFolderSelection = (folderId: string) => {
    setSelectedFolderIds((prev) =>
      prev.includes(folderId) ? prev.filter((id) => id !== folderId) : [...prev, folderId]
    );
  };

  const addCustomLineRule = () => {
    if (lineRules.length >= 8) return;
    setLineRules((prev) => [
      ...prev,
      { id: `custom_${Date.now()}`, hex: '#FF00FF', enabled: true, threshold: 160 },
    ]);
  };

  const handleStopExport = () => {
    abortRef.current?.abort();
  };

  const handleRunExport = async () => {
    if (!canExportNow) return;
    setStatusNotice(null);
    const controller = new AbortController();
    abortRef.current = controller;

    let pickedDirId: string | null = null;
    const ensureFolderWriter = async (dest: 'zip' | 'folder') => {
      if (dest !== 'folder' || !folderBridge) return undefined;
      const pick = await folderBridge.pickDirectory(t.animation.exportPickFolder);
      if (pick.canceled || !pick.dirId) return null;
      pickedDirId = pick.dirId;
      return async (fileName: string, data: Uint8Array) => {
        const res = await folderBridge.writeFile(pick.dirId!, fileName, data);
        if (!res.ok) throw new Error(res.error || 'Write failed');
      };
    };

    try {
      setProgressText(t.animation.preparing);
      const { ExportEngine } = await import('../engine/ExportEngine');

      if (mode === 'mp4' || mode === 'gif') {
        const plan = planExport({
          scope,
          useRange: rangeMode === 'playback',
          range: { start: resolvedRange.start, end: resolvedRange.end },
          transparent: false,
          useCamera: applyingCamera,
        });
        if (!plan || plan.segments.length === 0) {
          setStatusNotice({ kind: 'error', text: t.animation.noFramesToExport });
          return;
        }
        try {
          const total = plan.segments.length;
          const next = async (i: number) => {
            setProgressText(
              t.animation.renderingFrame.replace('{current}', String(i + 1)).replace('{total}', String(total))
            );
            await new Promise((r) => setTimeout(r, 0));
            return { canvas: plan.render(plan.segments[i].time), hold: plan.segments[i].hold };
          };
          let blob: Blob;
          const effectiveCrop = applyingCamera ? null : cameraCropRect;
          if (mode === 'gif') {
            blob = await ExportEngine.exportGifAnimation(next, total, plan.width, plan.height, fps, {
              signal: controller.signal,
              cropRegion: effectiveCrop,
            });
          } else {
            const playableAudioTracks: PlayableAudioTrackItem[] = audioLayers
              .filter((layer) => isAudioLayer(layer) && layer.isVisible)
              .map((layer) => ({
                layerId: layer.id,
                meta: normalizeAudioTrackMeta(layer.meta?.audio),
              }));
            const audioMix =
              includeAudio && playableAudioTracks.length > 0
                ? await renderMixedAudioTrack(
                    playableAudioTracks,
                    resolvedRange.start,
                    resolvedRange.end,
                    fps,
                    48000
                  )
                : null;
            const audioFallbackRef: { reason: AudioMuxFallbackReason } = { reason: 'none' };
            blob = await ExportEngine.exportVideoAnimation(
              next,
              total,
              plan.width,
              plan.height,
              fps,
              videoContainer,
              videoResolution,
              {
                signal: controller.signal,
                cropRegion: effectiveCrop,
                includeAudio,
                audioMix,
                onAudioFallback: (reason) => {
                  audioFallbackRef.reason = reason;
                },
                onProgress: ({ currentFrame, totalFrames }) => {
                  setProgressText(
                    t.animation.exportEncodingFrame
                      .replace('{current}', String(currentFrame))
                      .replace('{total}', String(totalFrames))
                  );
                },
              }
            );
            const ext = getVideoExtensionFromBlob(blob, videoContainer);
            ExportEngine.downloadBlob(blob, `animation_${Date.now()}.${ext}`);
            if (
              includeAudio &&
              audioMix &&
              audioMix.mixedTrackCount > 0 &&
              (audioFallbackRef.reason === 'encoder-unsupported' || audioFallbackRef.reason === 'encode-failed')
            ) {
              setStatusNotice({
                kind: 'success',
                text:
                  audioFallbackRef.reason === 'encoder-unsupported'
                    ? t.animation.exportAudioEncoderUnsupported
                    : t.animation.exportAudioMixFallback,
              });
            } else {
              onClose();
            }
            return;
          }
          const ext = mode === 'gif' ? 'gif' : getVideoExtensionFromBlob(blob, videoContainer);
          ExportEngine.downloadBlob(blob, `animation_${Date.now()}.${ext}`);
          onClose();
        } finally {
          plan.done();
        }
        return;
      }

      if (mode === 'sequence') {
        const writer = await ensureFolderWriter(seqDestination);
        if (writer === null) return; // User cancelled directory picker
        const plan = planExport({
          scope,
          useRange: rangeMode === 'playback',
          range: { start: resolvedRange.start, end: resolvedRange.end },
          transparent: seqTransparent,
          useCamera: applyingCamera,
        });
        if (!plan || plan.segments.length === 0) {
          setStatusNotice({ kind: 'error', text: t.animation.noFramesToExport });
          return;
        }
        try {
          const res = await ExportEngine.exportImageSequence({
            segments: plan.segments,
            renderFrame: (time) => plan.render(time),
            srcWidth: plan.width,
            srcHeight: plan.height,
            targetWidth: scaledDims.width,
            targetHeight: scaledDims.height,
            cropRegion: applyingCamera ? null : cameraCropRect,
            transparent: seqTransparent,
            bgColor: plan.bgColor,
            frameMode: seqFrameMode,
            naming: {
              prefix: seqPrefix,
              suffix: seqSuffix,
              separator: seqSeparator,
              startNumber: seqStartNum,
              zeroPad: seqZeroPad,
              extension: 'png',
            },
            signal: controller.signal,
            onProgress: (cur, tot) => {
              setProgressText(
                t.animation.renderingFrame.replace('{current}', String(cur)).replace('{total}', String(tot))
              );
            },
            onWriteFile: writer,
          });
          if (res.blob) {
            ExportEngine.downloadBlob(res.blob, `${seqPrefix || 'sequence'}_${Date.now()}.zip`);
            onClose();
          } else {
            setStatusNotice({
              kind: 'success',
              text: t.animation.exportFolderDone.replace('{count}', String(res.fileCount)),
            });
          }
        } finally {
          plan.done();
        }
        return;
      }

      if (mode === 'cels') {
        if (!planCelExport) return;
        const writer = await ensureFolderWriter(celDestination);
        if (writer === null) return;
        const plan = planCelExport({ folderIds: selectedFolderIds });
        if (!plan || plan.items.length === 0) {
          setStatusNotice({ kind: 'error', text: t.animation.exportNoCels });
          return;
        }
        try {
          const res = await ExportEngine.exportAnimationCels({
            items: plan.items,
            renderCel: (celId) => plan.renderCel(celId),
            srcWidth: plan.width,
            srcHeight: plan.height,
            targetWidth: scaledDims.width,
            targetHeight: scaledDims.height,
            cropRegion: cameraCropRect,
            format: celFormat,
            tgaBitsPerPixel: celFormat === 'tga' ? celTgaBpp : undefined,
            transparentBackground: celFormatForcesWhite ? false : celTransparent,
            binarize: {
              enabled: binarizeEnabled,
              rules: lineRules,
              background: celFormatForcesWhite ? 'white' : binarizeBg,
            },
            naming: {
              mode: celNamingMode,
              prefix: celPrefix,
              suffix: celSuffix,
              separator: celSeparator,
              extension: celFormat,
            },
            signal: controller.signal,
            onProgress: (cur, tot) => {
              setProgressText(
                t.animation.renderingFrame.replace('{current}', String(cur)).replace('{total}', String(tot))
              );
            },
            onWriteFile: writer,
          });
          if (res.blob) {
            ExportEngine.downloadBlob(res.blob, `cels_${Date.now()}.zip`);
            onClose();
          } else {
            setStatusNotice({
              kind: 'success',
              text: t.animation.exportFolderDone.replace('{count}', String(res.fileCount)),
            });
          }
        } finally {
          plan.done();
        }
      }
    } catch (err) {
      const isAbort =
        (err instanceof DOMException && err.name === 'AbortError') ||
        (err instanceof Error && err.name === 'AbortError');
      if (isAbort) {
        setStatusNotice({ kind: 'error', text: t.animation.exportCancelled });
      } else {
        setStatusNotice({ kind: 'error', text: `${t.animation.exportFailed}: ${unwrapMediaRecorderError(err).message}` });
      }
    } finally {
      if (pickedDirId && folderBridge) {
        void folderBridge.closeDirectory(pickedDirId).catch(() => {});
      }
      abortRef.current = null;
      setProgressText(null);
    }
  };

  const primaryButtonLabel = (() => {
    if (progressText) return progressText;
    if (mode === 'mp4' && !mp4Supported && canRecord) return t.animation.exportWebm;
    if ((mode === 'sequence' && seqDestination === 'folder') || (mode === 'cels' && celDestination === 'folder')) {
      return hasFolderBridge ? t.animation.exportPickFolder : t.animation.exportDownload;
    }
    return t.animation.exportDownload;
  })();

  const modeCards: ReadonlyArray<{
    id: AnimationExportMode;
    label: string;
    hint: string;
    icon: React.ReactNode;
  }> = [
    { id: 'mp4', label: t.animation.exportVideo, hint: 'MP4 / WebM', icon: <Film className="h-3.5 w-3.5" /> },
    { id: 'gif', label: 'GIF', hint: 'GIF', icon: <Sparkles className="h-3.5 w-3.5" /> },
    { id: 'sequence', label: t.animation.exportSequence, hint: 'PNG', icon: <Images className="h-3.5 w-3.5" /> },
    { id: 'cels', label: t.animation.exportCels, hint: 'PNG / TGA / BMP', icon: <Layers className="h-3.5 w-3.5" /> },
  ];

  const inputCls =
    'w-full min-w-0 rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-indigo-500 disabled:opacity-50';

  const modalNode = (
    <OverlayPresence open={open}>
      <AtelierModal
        width="lg"
        title={t.animation.exportModalTitle}
        icon={<Film />}
        onClose={() => {
          if (!busy) onClose();
        }}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] text-neutral-400">
              {applyingCamera ? t.animation.exportRegionCamera : t.animation.exportRegionFull} ·{' '}
              {mode === 'sequence' || mode === 'cels'
                ? `${scaledDims.width}×${scaledDims.height}`
                : `${exportRegion.width}×${exportRegion.height}`}
              {mode === 'cels'
                ? ` · ${selectedCelCount}`
                : ` · ${resolvedRange.frameCount}f (${(resolvedRange.frameCount / Math.max(1, fps)).toFixed(1)}${t.common.seconds})`}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              {busy ? (
                <button type="button" className={modalButton.danger} onClick={handleStopExport}>
                  {t.animation.exportCancelAction}
                </button>
              ) : (
                <button type="button" className={modalButton.secondary} onClick={onClose}>
                  {t.common.cancel}
                </button>
              )}
              <button
                type="button"
                data-testid="anim-export-submit"
                className={modalButton.primary}
                onClick={() => void handleRunExport()}
                disabled={!canExportNow}
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (mode === 'sequence' && seqDestination === 'folder' && hasFolderBridge) ||
                  (mode === 'cels' && celDestination === 'folder' && hasFolderBridge) ? (
                  <FolderOutput className="h-3.5 w-3.5" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                <span className="truncate">{primaryButtonLabel}</span>
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-3 overflow-x-hidden" data-testid="anim-export-modal">
          <div className="atelier-filter-refine !mx-0 !mt-0 !mb-1" data-on={busy ? 'true' : 'false'} />

          {/* 4-mode selector with Lumina Drift light-sweep */}
          <div
            role="radiogroup"
            aria-label={t.animation.exportFormat}
            className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
          >
            {modeCards.map((card) => {
              const active = mode === card.id;
              return (
                <button
                  key={card.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-pressed={active}
                  disabled={busy}
                  data-testid={`anim-export-mode-${card.id}`}
                  onClick={() => {
                    setMode(card.id);
                    setStatusNotice(null);
                  }}
                  className={`atelier-filter-card flex min-w-0 flex-col gap-0.5 rounded-xl border px-2.5 py-2 text-left transition ${
                    active
                      ? 'border-indigo-400/80 bg-indigo-600/20 text-white'
                      : 'border-neutral-800 bg-neutral-900/40 text-neutral-400 hover:bg-neutral-800/70'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-xs font-semibold">
                    <span className="shrink-0">{card.icon}</span>
                    <span className="truncate">{card.label}</span>
                  </span>
                  <span className="truncate text-[10px] text-neutral-500">{card.hint}</span>
                </button>
              );
            })}
          </div>

          {statusNotice && (
            <div
              role="status"
              data-testid="anim-export-status"
              className={`rounded-lg border px-3 py-2 text-xs ${
                statusNotice.kind === 'error'
                  ? 'border-rose-700/60 bg-rose-950/40 text-rose-200'
                  : 'border-emerald-700/60 bg-emerald-950/40 text-emerald-200'
              }`}
            >
              {statusNotice.text}
            </div>
          )}

          {/* Mode: Video (D2 + Phase 6.1 Audio Mixing) */}
          {mode === 'mp4' && (() => {
            const playableAudioTracks: PlayableAudioTrackItem[] = audioLayers
              .filter((layer) => isAudioLayer(layer) && layer.isVisible)
              .map((layer) => ({
                layerId: layer.id,
                meta: normalizeAudioTrackMeta(layer.meta?.audio),
              }));
            const mixPlan = planExportAudioMix(
              playableAudioTracks,
              resolvedRange.start,
              resolvedRange.end,
              fps
            );
            const linkedActiveCount = mixPlan.clips.filter(
              (c) => audioAssetSummaries[c.localAssetId]?.linked
            ).length;
            const unlinkedActiveCount = mixPlan.clips.length - linkedActiveCount;

            return (
              <div className="space-y-2.5 rounded-xl border border-neutral-800 bg-neutral-900/50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-neutral-300">{t.animation.exportVideoContainer}</span>
                  <div className="flex items-center gap-1" role="radiogroup" aria-label={t.animation.exportVideoContainer}>
                    {(['mp4', 'webm'] as const).map((fmt) => (
                      <button
                        key={fmt}
                        type="button"
                        role="radio"
                        aria-checked={videoContainer === fmt}
                        data-testid={`anim-export-container-${fmt}`}
                        disabled={busy}
                        onClick={() => setVideoContainer(fmt)}
                        className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium uppercase transition ${
                          videoContainer === fmt
                            ? 'border-indigo-400/80 bg-indigo-500/20 text-white'
                            : 'border-neutral-700 bg-neutral-900/70 text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        {fmt}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-neutral-300">{t.replay.resolution}</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-[10px] text-indigo-300">
                      {webCodecsReady ? t.animation.exportOfflineEncoder : t.animation.exportFallbackRecorder}
                    </span>
                    <select
                      aria-label={t.replay.resolution}
                      value={videoResolution}
                      onChange={(e) => setVideoResolution(e.target.value as VideoExportResolution)}
                      disabled={busy}
                      className="rounded-lg border border-neutral-700 bg-neutral-800 px-2 py-1 font-mono text-xs text-neutral-200 outline-none"
                    >
                      {(['1080p', '2k', '4k'] as const).map((tier) => {
                        const dims = computeVideoExportDimensionsForResolution(
                          exportRegion.width,
                          exportRegion.height,
                          tier
                        );
                        const label = tier === '1080p' ? '1080p' : tier.toUpperCase();
                        return (
                          <option key={tier} value={tier}>
                            {label} ({dims.width}×{dims.height})
                          </option>
                        );
                      })}
                    </select>
                  </div>
                </div>
                <div className="border-t border-neutral-800/80 pt-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-200">
                      <input
                        type="checkbox"
                        data-testid="anim-export-include-audio"
                        checked={includeAudio}
                        onChange={(e) => setIncludeAudio(e.target.checked)}
                        disabled={busy}
                        className="h-3.5 w-3.5 rounded border-neutral-600 bg-neutral-800 accent-emerald-500"
                      />
                      <span className="flex items-center gap-1.5">
                        {includeAudio ? (
                          <Volume2 className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <VolumeX className="h-3.5 w-3.5 text-neutral-500" />
                        )}
                        {t.animation.exportIncludeAudio}
                      </span>
                    </label>
                    <span
                      data-testid="anim-export-audio-status"
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${
                        includeAudio && linkedActiveCount > 0
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                          : 'border-neutral-700 bg-neutral-800/60 text-neutral-400'
                      }`}
                    >
                      <Music className="h-2.5 w-2.5" />
                      {linkedActiveCount > 0
                        ? t.animation.exportAudioTracksActive.replace('{count}', String(linkedActiveCount))
                        : t.animation.exportAudioTracksNone}
                    </span>
                  </div>
                  {includeAudio && unlinkedActiveCount > 0 && (
                    <p className="mt-1 text-[10px] text-amber-300/90">
                      {t.animation.exportAudioUnlinkedHint}
                    </p>
                  )}
                  {includeAudio && linkedActiveCount > 0 && !audioEncoderReady && webCodecsReady && (
                    <p className="mt-1 text-[10px] text-amber-300/90">
                      {t.animation.exportAudioEncoderUnsupported}
                    </p>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Phase E1: Camera framing region toggle when a visible camera layer exists */}
          {mode !== 'cels' && cameraFrameSize && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-500/30 bg-sky-500/10 px-2.5 py-2">
              <span className="text-[11px] font-medium text-sky-200">
                {t.animation.camera} ({cameraFrameSize.width}×{cameraFrameSize.height})
              </span>
              <div className="flex items-center gap-1" role="radiogroup" aria-label={t.animation.camera}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={useCameraFrame}
                  disabled={busy}
                  data-testid="anim-export-region-camera"
                  onClick={() => setUseCameraFrame(true)}
                  className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                    useCameraFrame
                      ? 'border-sky-400/80 bg-sky-500/25 text-white'
                      : 'border-neutral-700 bg-neutral-900/70 text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  {t.animation.exportRegionCamera}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={!useCameraFrame}
                  disabled={busy}
                  data-testid="anim-export-region-full"
                  onClick={() => setUseCameraFrame(false)}
                  className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                    !useCameraFrame
                      ? 'border-indigo-400/80 bg-indigo-500/25 text-white'
                      : 'border-neutral-700 bg-neutral-900/70 text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  {t.animation.exportRegionFull}
                </button>
              </div>
            </div>
          )}

          {/* Timeline Scope & Range (shared by Video, GIF, Image Sequence) */}
          {mode !== 'cels' && (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="space-y-1.5 rounded-xl border border-neutral-800 bg-neutral-900/40 p-2.5">
                <div className="text-[11px] font-medium text-neutral-400">{t.animation.exportContent}</div>
                <div role="radiogroup" aria-label={t.animation.exportContent} className="space-y-1">
                  {([
                    ['folder', activeTrack?.name ?? t.animation.timeline],
                    ['folders', `${t.animation.timeline} (${tracks.length})`],
                    ['all', t.animation.rangeAll],
                  ] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={scope === id}
                      disabled={busy}
                      onClick={() => setScope(id)}
                      className={`flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-left text-xs transition ${
                        scope === id
                          ? 'border-indigo-500/80 bg-indigo-600/20 text-white'
                          : 'border-neutral-800 text-neutral-400 hover:bg-neutral-800/70'
                      }`}
                    >
                      <span className="truncate">{label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5 rounded-xl border border-neutral-800 bg-neutral-900/40 p-2.5">
                <div className="text-[11px] font-medium text-neutral-400">{t.animation.exportRangeMode}</div>
                <div className="grid grid-cols-3 gap-1">
                  {([
                    ['all', t.animation.rangeAll, false],
                    ['playback', t.animation.exportRangePlayback, !playbackRange],
                    ['custom', t.animation.exportRangeCustom, false],
                  ] as const).map(([id, label, disabled]) => (
                    <button
                      key={id}
                      type="button"
                      disabled={busy || disabled}
                      onClick={() => setRangeMode(id)}
                      className={`truncate rounded-lg border px-1.5 py-1.5 text-[11px] transition disabled:opacity-40 ${
                        rangeMode === id
                          ? 'border-indigo-500/80 bg-indigo-600/20 text-white'
                          : 'border-neutral-800 text-neutral-400 hover:bg-neutral-800/70'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {rangeMode === 'playback' && playbackRange && (
                  <p className="font-mono text-[11px] text-neutral-400">
                    {formatTimecode(playbackRange.start, fps, timecodeMode)} –{' '}
                    {formatTimecode(playbackRange.end, fps, timecodeMode)}
                  </p>
                )}
                {rangeMode === 'custom' && (
                  <div className="space-y-1">
                    <div className="grid grid-cols-2 gap-1.5">
                      <input
                        type="text"
                        aria-label="Start frame"
                        data-testid="anim-export-range-start"
                        value={customStartText}
                        onChange={(e) => setCustomStartText(e.target.value)}
                        disabled={busy}
                        className={`${inputCls} font-mono`}
                        placeholder="1+1"
                      />
                      <input
                        type="text"
                        aria-label="End frame"
                        data-testid="anim-export-range-end"
                        value={customEndText}
                        onChange={(e) => setCustomEndText(e.target.value)}
                        disabled={busy}
                        className={`${inputCls} font-mono`}
                        placeholder={formatTimecode(Math.max(0, timelineLength - 1), fps, timecodeMode)}
                      />
                    </div>
                    {!resolvedRange.valid && (
                      <p className="text-[10px] text-rose-400">{t.animation.exportRangeInvalid}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Mode: Image Sequence (D1) */}
          {mode === 'sequence' && (
            <div className="space-y-2.5">
              {hasFolderBridge && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-neutral-800 bg-neutral-900/40 px-3 py-2">
                  <span className="text-xs text-neutral-300">{t.animation.exportDestination}</span>
                  <div className="flex gap-1.5">
                    {(['folder', 'zip'] as const).map((dest) => (
                      <button
                        key={dest}
                        type="button"
                        disabled={busy}
                        onClick={() => setSeqDestination(dest)}
                        className={`rounded-lg border px-2.5 py-1 text-xs ${
                          seqDestination === dest
                            ? 'border-indigo-500/80 bg-indigo-600/20 text-white'
                            : 'border-neutral-800 text-neutral-400 hover:bg-neutral-800'
                        }`}
                      >
                        {dest === 'folder' ? t.animation.exportDestFolder : t.animation.exportDestZip}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Naming */}
              <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/40 p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-neutral-400">{t.animation.exportNaming}</span>
                  <span
                    data-testid="anim-seq-preview-name"
                    className="rounded bg-neutral-950 px-2 py-0.5 font-mono text-[11px] text-indigo-300"
                  >
                    {t.animation.exportPreviewName}: {seqPreviewName}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <label className="space-y-0.5 text-[10px] text-neutral-400">
                    <span>{t.animation.exportPrefix}</span>
                    <input
                      type="text"
                      data-testid="anim-seq-prefix"
                      value={seqPrefix}
                      onChange={(e) => setSeqPrefix(e.target.value)}
                      disabled={busy}
                      className={inputCls}
                    />
                  </label>
                  <label className="space-y-0.5 text-[10px] text-neutral-400">
                    <span>{t.animation.exportSuffix}</span>
                    <input
                      type="text"
                      value={seqSuffix}
                      onChange={(e) => setSeqSuffix(e.target.value)}
                      disabled={busy}
                      className={inputCls}
                    />
                  </label>
                  <label className="space-y-0.5 text-[10px] text-neutral-400">
                    <span>{t.animation.exportSeparator}</span>
                    <input
                      type="text"
                      value={seqSeparator}
                      maxLength={3}
                      onChange={(e) => setSeqSeparator(e.target.value)}
                      disabled={busy}
                      className={`${inputCls} font-mono`}
                    />
                  </label>
                  <label className="space-y-0.5 text-[10px] text-neutral-400">
                    <span>{t.animation.exportStartNum}</span>
                    <input
                      type="number"
                      min={0}
                      max={99999}
                      value={seqStartNum}
                      onChange={(e) => setSeqStartNum(Math.max(0, Number(e.target.value) || 0))}
                      disabled={busy}
                      className={`${inputCls} font-mono`}
                    />
                  </label>
                  <label className="space-y-0.5 text-[10px] text-neutral-400">
                    <span>{t.animation.exportZeroPad}</span>
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={seqZeroPad}
                      onChange={(e) => setSeqZeroPad(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                      disabled={busy}
                      className={`${inputCls} font-mono`}
                    />
                  </label>
                </div>
              </div>

              {/* Frame mode, Size, Transparent BG */}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div className="space-y-1.5 rounded-xl border border-neutral-800 bg-neutral-900/40 p-2.5">
                  <div className="text-[11px] font-medium text-neutral-400">{t.animation.exportFrameMode}</div>
                  <div className="flex flex-col gap-1">
                    {([
                      ['every-frame', t.animation.exportEveryFrame],
                      ['distinct-frames', t.animation.exportDistinctFrames],
                    ] as const).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        disabled={busy}
                        data-testid={`anim-seq-mode-${id}`}
                        onClick={() => setSeqFrameMode(id)}
                        className={`rounded-lg border px-2.5 py-1.5 text-left text-xs ${
                          seqFrameMode === id
                            ? 'border-indigo-500/80 bg-indigo-600/20 text-white'
                            : 'border-neutral-800 text-neutral-400 hover:bg-neutral-800/70'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/40 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-neutral-400">{t.animation.exportSize}</span>
                    <div className="flex gap-1">
                      {(['original', 'scale'] as const).map((sm) => (
                        <button
                          key={sm}
                          type="button"
                          disabled={busy}
                          onClick={() => setSizeMode(sm)}
                          className={`rounded-md border px-2 py-0.5 text-[11px] ${
                            sizeMode === sm
                              ? 'border-indigo-500/80 bg-indigo-600/20 text-white'
                              : 'border-neutral-800 text-neutral-400'
                          }`}
                        >
                          {sm === 'original' ? t.animation.exportSizeOriginal : t.animation.exportSizeScale}
                        </button>
                      ))}
                    </div>
                  </div>
                  {sizeMode === 'scale' && (
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={10}
                        max={400}
                        value={scalePercent}
                        onChange={(e) => setScalePercent(Math.max(10, Math.min(400, Number(e.target.value) || 100)))}
                        disabled={busy}
                        className={`${inputCls} w-20 font-mono`}
                      />
                      <span className="font-mono text-[11px] text-neutral-400">
                        % → {scaledDims.width}×{scaledDims.height}
                      </span>
                    </div>
                  )}
                  <label className="flex items-center gap-2 pt-0.5 text-xs text-neutral-200">
                    <input
                      type="checkbox"
                      data-testid="anim-seq-transparent"
                      checked={seqTransparent}
                      disabled={busy}
                      onChange={(e) => setSeqTransparent(e.target.checked)}
                    />
                    <span>{t.animation.exportTransparentBg}</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Mode: Per-Cel Export (D4) */}
          {mode === 'cels' && (
            <div className="space-y-2.5">
              {hasFolderBridge && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-neutral-800 bg-neutral-900/40 px-3 py-2">
                  <span className="text-xs text-neutral-300">{t.animation.exportDestination}</span>
                  <div className="flex gap-1.5">
                    {(['folder', 'zip'] as const).map((dest) => (
                      <button
                        key={dest}
                        type="button"
                        disabled={busy}
                        onClick={() => setCelDestination(dest)}
                        className={`rounded-lg border px-2.5 py-1 text-xs ${
                          celDestination === dest
                            ? 'border-indigo-500/80 bg-indigo-600/20 text-white'
                            : 'border-neutral-800 text-neutral-400 hover:bg-neutral-800'
                        }`}
                      >
                        {dest === 'folder' ? t.animation.exportDestFolder : t.animation.exportDestZip}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Animation folder selection + format */}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div className="space-y-1.5 rounded-xl border border-neutral-800 bg-neutral-900/40 p-2.5">
                  <div className="text-[11px] font-medium text-neutral-400">{t.animation.exportCelFolders}</div>
                  <div className="max-h-24 space-y-1 overflow-y-auto pr-1">
                    {tracks.map((tr) => {
                      const realCount = tr.entries.filter((e) => e.ref === undefined).length;
                      const checked = selectedFolderIds.includes(tr.folderId);
                      return (
                        <label
                          key={tr.folderId}
                          className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-neutral-800/80 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800/60"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={busy}
                              onChange={() => toggleFolderSelection(tr.folderId)}
                            />
                            <span className="truncate">{tr.name}</span>
                          </span>
                          <span className="shrink-0 font-mono text-[10px] text-neutral-500">{realCount}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/40 p-2.5">
                  <div className="text-[11px] font-medium text-neutral-400">{t.animation.exportCelFormat}</div>
                  <div className="grid grid-cols-2 gap-1">
                    {([
                      ['png', 32, 'PNG'],
                      ['tga', 24, 'TGA 24-bit'],
                      ['tga', 32, 'TGA 32-bit'],
                      ['bmp', 24, 'BMP 24-bit'],
                    ] as const).map(([fmt, bpp, label]) => {
                      const active = celFormat === fmt && (fmt !== 'tga' || celTgaBpp === bpp);
                      return (
                        <button
                          key={`${fmt}-${bpp}`}
                          type="button"
                          disabled={busy}
                          data-testid={`anim-cel-fmt-${fmt}-${bpp}`}
                          onClick={() => {
                            setCelFormat(fmt);
                            if (fmt === 'tga') setCelTgaBpp(bpp);
                          }}
                          className={`rounded-lg border px-2 py-1 text-xs font-mono ${
                            active
                              ? 'border-indigo-500/80 bg-indigo-600/20 text-white'
                              : 'border-neutral-800 text-neutral-400 hover:bg-neutral-800'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  {!binarizeEnabled && !celFormatForcesWhite && (
                    <label className="flex items-center gap-2 text-xs text-neutral-200">
                      <input
                        type="checkbox"
                        checked={celTransparent}
                        disabled={busy}
                        onChange={(e) => setCelTransparent(e.target.checked)}
                      />
                      <span>{t.animation.exportTransparentBg}</span>
                    </label>
                  )}
                </div>
              </div>

              {/* Cel Naming */}
              <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/40 p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {([
                      ['folder-cel', t.animation.exportCelNamingFolder],
                      ['cel-only', t.animation.exportCelNamingOnly],
                    ] as const).map(([nm, label]) => (
                      <button
                        key={nm}
                        type="button"
                        disabled={busy}
                        onClick={() => setCelNamingMode(nm)}
                        className={`rounded-md border px-2 py-0.5 text-[11px] ${
                          celNamingMode === nm
                            ? 'border-indigo-500/80 bg-indigo-600/20 text-white'
                            : 'border-neutral-800 text-neutral-400'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <span
                    data-testid="anim-cel-preview-name"
                    className="rounded bg-neutral-950 px-2 py-0.5 font-mono text-[11px] text-indigo-300"
                  >
                    {t.animation.exportPreviewName}: {celPreviewName}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-0.5 text-[10px] text-neutral-400">
                    <span>{t.animation.exportPrefix}</span>
                    <input
                      type="text"
                      value={celPrefix}
                      onChange={(e) => setCelPrefix(e.target.value)}
                      disabled={busy}
                      className={inputCls}
                    />
                  </label>
                  <label className="space-y-0.5 text-[10px] text-neutral-400">
                    <span>{t.animation.exportSuffix}</span>
                    <input
                      type="text"
                      value={celSuffix}
                      onChange={(e) => setCelSuffix(e.target.value)}
                      disabled={busy}
                      className={inputCls}
                    />
                  </label>
                  <label className="space-y-0.5 text-[10px] text-neutral-400">
                    <span>{t.animation.exportSeparator}</span>
                    <input
                      type="text"
                      value={celSeparator}
                      maxLength={3}
                      onChange={(e) => setCelSeparator(e.target.value)}
                      disabled={busy}
                      className={`${inputCls} font-mono`}
                    />
                  </label>
                </div>
              </div>

              {/* Paint-ready Line Art Binarization */}
              <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/40 p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-neutral-100">
                    <input
                      type="checkbox"
                      data-testid="anim-cel-binarize-toggle"
                      checked={binarizeEnabled}
                      disabled={busy}
                      onChange={(e) => setBinarizeEnabled(e.target.checked)}
                    />
                    <span>{t.animation.exportBinarize}</span>
                  </label>
                  {binarizeEnabled && (
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="text-neutral-400">{t.animation.exportBinarizeBg}:</span>
                      {(['white', 'transparent'] as const).map((bg) => {
                        const disabledBg = bg === 'transparent' && celFormatForcesWhite;
                        const effectiveBg = celFormatForcesWhite ? 'white' : binarizeBg;
                        return (
                          <button
                            key={bg}
                            type="button"
                            disabled={busy || disabledBg}
                            onClick={() => setBinarizeBg(bg)}
                            className={`rounded-md border px-2 py-0.5 disabled:opacity-40 ${
                              effectiveBg === bg
                                ? 'border-indigo-500/80 bg-indigo-600/20 text-white'
                                : 'border-neutral-800 text-neutral-400'
                            }`}
                          >
                            {bg === 'white' ? t.animation.exportBinarizeWhite : t.animation.exportBinarizeTransparent}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {binarizeEnabled && (
                  <div className="space-y-1.5 pt-1">
                    {lineRules.map((rule) => (
                      <div
                        key={rule.id}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800/80 bg-neutral-950/60 px-2 py-1.5"
                      >
                        <input
                          type="checkbox"
                          data-testid={`anim-cel-rule-check-${rule.id}`}
                          checked={rule.enabled}
                          disabled={busy}
                          onChange={(e) =>
                            setLineRules((prev) =>
                              prev.map((r) => (r.id === rule.id ? { ...r, enabled: e.target.checked } : r))
                            )
                          }
                        />
                        <input
                          type="color"
                          value={rule.hex}
                          disabled={busy}
                          onChange={(e) =>
                            setLineRules((prev) =>
                              prev.map((r) => (r.id === rule.id ? { ...r, hex: e.target.value.toUpperCase() } : r))
                            )
                          }
                          className="h-5 w-7 cursor-pointer rounded border border-neutral-700 bg-transparent p-0"
                        />
                        <span className="w-16 font-mono text-[11px] text-neutral-300">{rule.hex}</span>
                        <span className="text-[10px] text-neutral-400">{t.animation.exportThreshold}</span>
                        <input
                          type="range"
                          min={0}
                          max={255}
                          value={rule.threshold}
                          disabled={busy || !rule.enabled}
                          onChange={(e) =>
                            setLineRules((prev) =>
                              prev.map((r) => (r.id === rule.id ? { ...r, threshold: Number(e.target.value) } : r))
                            )
                          }
                          className="min-w-[80px] flex-1 accent-indigo-500"
                        />
                        <span className="w-7 text-right font-mono text-[11px] text-neutral-300">{rule.threshold}</span>
                        {rule.id.startsWith('custom_') && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setLineRules((prev) => prev.filter((r) => r.id !== rule.id))}
                            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-rose-400"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    ))}
                    {lineRules.length < 8 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={addCustomLineRule}
                        className="inline-flex items-center gap-1 rounded-lg border border-dashed border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-300 hover:border-indigo-500 hover:text-white"
                      >
                        <Plus className="h-3 w-3" />
                        <span>{t.animation.exportAddLineColor}</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </AtelierModal>
    </OverlayPresence>
  );

  return typeof document !== 'undefined' ? createPortal(modalNode, document.body) : modalNode;
};
