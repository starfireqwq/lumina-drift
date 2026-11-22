import React, { useRef, useState } from 'react';
import {
  AudioTrackMeta,
  LayerModel,
  MAX_AUDIO_START_FRAME,
  normalizeAudioTrackMeta,
  resolveAudioClipFrameRange,
} from '@atelier/shared';
import {
  Headphones,
  Link2,
  Music,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import {
  AudioAssetSummary,
  importLocalAudioFile,
} from '../engine/AudioTrackEngine';
import { ToolWindow } from './workspace/ToolWindow';

export interface AudioTrackWindowProps {
  open: boolean;
  onClose: () => void;
  audioLayers: LayerModel[];
  assetSummaries: Record<string, AudioAssetSummary>;
  fps: number;
  currentFrame: number;
  canCreate: boolean;
  canEditLayer: (layer: LayerModel) => boolean;
  scrubEnabled: boolean;
  onToggleScrub: () => void;
  onCreateAudioTrack: (name: string, meta: AudioTrackMeta) => void;
  onUpdateAudioTrack: (layerId: string, patch: { name?: string; meta: AudioTrackMeta }) => void;
  onDeleteAudioTrack: (layerId: string) => void;
}

export const AudioTrackWindow: React.FC<AudioTrackWindowProps> = ({
  open,
  onClose,
  audioLayers,
  assetSummaries,
  fps,
  currentFrame,
  canCreate,
  canEditLayer,
  scrubEnabled,
  onToggleScrub,
  onCreateAudioTrack,
  onUpdateAudioTrack,
  onDeleteAudioTrack,
}) => {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkingAssetId, setLinkingAssetId] = useState<string | null>(null);
  const addFileRef = useRef<HTMLInputElement>(null);
  const linkFileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const handleImportNew = async (file: File | undefined) => {
    if (!file || !canCreate) return;
    setError(null);
    setBusy(true);
    try {
      const asset = await importLocalAudioFile(file);
      const cleanName = asset.fileName.replace(/\.[^.]+$/, '').slice(0, 60) || t.animation.audioTrack;
      const meta: AudioTrackMeta = normalizeAudioTrackMeta({
        localAssetId: asset.id,
        fileName: asset.fileName,
        durationSec: asset.durationSec,
        startFrame: Math.max(0, Math.round(currentFrame)),
        volume: 1,
        muted: false,
      });
      onCreateAudioTrack(cleanName, meta);
    } catch {
      setError(t.animation.audioDecodeError);
    } finally {
      setBusy(false);
    }
  };

  const handleLinkExisting = async (file: File | undefined) => {
    if (!file || !linkingAssetId) return;
    setError(null);
    setBusy(true);
    try {
      await importLocalAudioFile(file, linkingAssetId);
    } catch {
      setError(t.animation.audioDecodeError);
    } finally {
      setLinkingAssetId(null);
      setBusy(false);
    }
  };

  const chip = (active: boolean) =>
    `inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition disabled:opacity-40 ${
      active
        ? 'border-emerald-400/70 bg-emerald-500/20 text-emerald-100'
        : 'border-neutral-700/80 bg-neutral-900/70 text-neutral-300 hover:bg-neutral-800 hover:text-white'
    }`;

  const numInputCls =
    'w-full min-w-0 rounded-md border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-right font-mono text-[11px] text-neutral-100 outline-none focus:border-emerald-400 disabled:opacity-45';

  return (
    <ToolWindow
      id="anim_audio"
      title={t.animation.audioTrack}
      icon={<Music className="h-3.5 w-3.5 text-emerald-400" />}
      onClose={onClose}
      initial={{ x: -20, y: 120, w: 320, h: 0 }}
      minW={276}
      minH={200}
      bodyClassName="p-3 space-y-2.5 max-h-[75vh] overflow-y-auto"
    >
      <div className="space-y-2.5 text-xs" data-testid="audio-track-window">
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] leading-snug text-emerald-200/90">
          {t.animation.audioLocalOnlyHint}
        </div>

        {/* Top controls: Import local audio + Scrubbing toggle */}
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            ref={addFileRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              void handleImportNew(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <input
            ref={linkFileRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              void handleLinkExisting(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={!canCreate || busy}
            data-testid="audio-import-btn"
            onClick={() => addFileRef.current?.click()}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-emerald-400/60 bg-emerald-500/20 px-2.5 py-1.5 text-[11px] font-medium text-emerald-100 transition hover:bg-emerald-500/30 disabled:opacity-40"
          >
            <Upload className="h-3.5 w-3.5" />
            <span className="truncate">{t.animation.audioAdd}</span>
          </button>

          <button
            type="button"
            aria-pressed={scrubEnabled}
            data-testid="audio-scrub-toggle"
            onClick={onToggleScrub}
            className={chip(scrubEnabled)}
          >
            <Headphones className="h-3.5 w-3.5" />
            <span>{t.animation.audioScrub}</span>
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/15 px-2.5 py-1.5 text-[11px] text-red-200">
            {error}
          </div>
        )}

        {/* Audio tracks list */}
        {audioLayers.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-3 text-center text-[11px] text-neutral-500">
            {t.animation.audioNoTracks}
          </div>
        ) : (
          <div className="space-y-2">
            {audioLayers.map((layer) => {
              const meta = normalizeAudioTrackMeta(layer.meta?.audio);
              const editable = canEditLayer(layer);
              const range = resolveAudioClipFrameRange(meta, fps);
              const summary = assetSummaries[meta.localAssetId];
              const linked = Boolean(summary?.linked);

              const updateMeta = (patch: Partial<AudioTrackMeta>) => {
                if (!editable) return;
                onUpdateAudioTrack(layer.id, {
                  meta: normalizeAudioTrackMeta({ ...meta, ...patch }),
                });
              };

              return (
                <div
                  key={layer.id}
                  data-testid={`audio-track-card-${layer.id}`}
                  className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/60 p-2.5"
                >
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={!editable}
                      aria-pressed={meta.muted}
                      data-testid={`audio-mute-btn-${layer.id}`}
                      title={meta.muted ? t.animation.audioUnmute : t.animation.audioMute}
                      onClick={() => updateMeta({ muted: !meta.muted })}
                      className={`shrink-0 rounded-md border p-1 transition disabled:opacity-45 ${
                        meta.muted
                          ? 'border-red-500/50 bg-red-500/15 text-red-300'
                          : 'border-neutral-700 bg-neutral-800 text-emerald-300 hover:bg-neutral-700'
                      }`}
                    >
                      {meta.muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                    </button>
                    <input
                      type="text"
                      disabled={!editable}
                      value={layer.name}
                      data-testid={`audio-name-input-${layer.id}`}
                      onChange={(e) => {
                        if (!editable) return;
                        onUpdateAudioTrack(layer.id, { name: e.target.value, meta });
                      }}
                      className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xs font-medium text-neutral-100 outline-none focus:border-emerald-400/70 focus:bg-neutral-950 disabled:opacity-70"
                    />
                    <button
                      type="button"
                      disabled={!editable}
                      data-testid={`audio-delete-btn-${layer.id}`}
                      title={t.animation.audioRemove}
                      onClick={() => onDeleteAudioTrack(layer.id)}
                      className="shrink-0 rounded-md p-1 text-neutral-500 transition hover:bg-red-500/15 hover:text-red-300 disabled:opacity-35"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Local link status */}
                  {!linked && (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-200">
                      <span className="truncate">{t.animation.audioUnlinked} ({meta.fileName})</span>
                      <button
                        type="button"
                        disabled={busy}
                        data-testid={`audio-link-local-${layer.id}`}
                        onClick={() => {
                          setLinkingAssetId(meta.localAssetId);
                          linkFileRef.current?.click();
                        }}
                        className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-400/60 bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-100 hover:bg-amber-500/30"
                      >
                        <Link2 className="h-3 w-3" />
                        <span>{t.animation.audioLinkLocal}</span>
                      </button>
                    </div>
                  )}

                  {!editable && (
                    <div className="text-[10px] text-neutral-400">{t.animation.audioReadOnly}</div>
                  )}

                  {/* Volume */}
                  <label className="flex items-center gap-2 text-[11px] text-neutral-400">
                    <span className="w-11 shrink-0 truncate">{t.animation.audioVolume}</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      disabled={!editable}
                      data-testid={`audio-volume-slider-${layer.id}`}
                      value={Math.round(meta.volume * 100)}
                      onChange={(e) => updateMeta({ volume: Number(e.target.value) / 100 })}
                      className="min-w-0 flex-1 accent-emerald-400"
                    />
                    <span className="w-9 shrink-0 text-right font-mono text-[10px] text-neutral-200">
                      {Math.round(meta.volume * 100)}%
                    </span>
                  </label>

                  {/* Start frame, End frame, Trim offset */}
                  <div className="grid grid-cols-3 gap-1.5">
                    <label className="space-y-0.5 text-[10px] text-neutral-400">
                      <span className="block truncate">{t.animation.audioStartFrame}</span>
                      <input
                        type="number"
                        min={1}
                        max={MAX_AUDIO_START_FRAME + 1}
                        disabled={!editable}
                        data-testid={`audio-start-input-${layer.id}`}
                        value={range.startFrame + 1}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) {
                            const nextStart = Math.max(0, Math.min(MAX_AUDIO_START_FRAME, Math.round(v) - 1));
                            const delta = nextStart - range.startFrame;
                            updateMeta({
                              startFrame: nextStart,
                              ...(meta.endFrame !== undefined ? { endFrame: Math.max(nextStart, meta.endFrame + delta) } : {}),
                            });
                          }
                        }}
                        className={numInputCls}
                      />
                    </label>
                    <label className="space-y-0.5 text-[10px] text-neutral-400">
                      <span className="block truncate">{t.animation.audioEndFrame}</span>
                      <input
                        type="number"
                        min={range.startFrame + 1}
                        max={MAX_AUDIO_START_FRAME + 1}
                        disabled={!editable}
                        data-testid={`audio-end-input-${layer.id}`}
                        value={range.endFrame + 1}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) {
                            const nextEnd = Math.max(range.startFrame, Math.min(MAX_AUDIO_START_FRAME, Math.round(v) - 1));
                            updateMeta({ endFrame: nextEnd });
                          }
                        }}
                        className={numInputCls}
                      />
                    </label>
                    <label className="space-y-0.5 text-[10px] text-neutral-400">
                      <span className="block truncate">{t.animation.audioTrimStart}</span>
                      <input
                        type="number"
                        min={0}
                        max={Math.max(0, Math.floor((meta.durationSec - 0.1) * 10) / 10)}
                        step={0.1}
                        disabled={!editable}
                        value={Math.round((meta.trimStartSec ?? 0) * 10) / 10}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v >= 0) {
                            updateMeta({ trimStartSec: v });
                          }
                        }}
                        className={numInputCls}
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ToolWindow>
  );
};
