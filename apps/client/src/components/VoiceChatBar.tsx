import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Radio,
  Users,
  Volume2,
  Settings2,
} from 'lucide-react';
import type { VoiceChatState } from '../engine/VoiceChatManager';
import { useI18n } from '../context/I18nContext';
import { useSocket } from '../context/SocketContext';

export const VoiceDevices: React.FC<{ voice: VoiceChatState }> = ({ voice }) => {
  const { t } = useI18n();
  const { setVoiceInputDevice, setVoiceOutputDevice } = useSocket();
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 48, right: 8 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const media = navigator.mediaDevices;
  const canSelectOutput = 'setSinkId' in HTMLMediaElement.prototype;
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({
        top: Math.max(4, Math.min(window.innerHeight - 120, r.bottom + 4)),
        right: Math.max(8, Math.min(window.innerWidth - 40, window.innerWidth - r.right)),
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => {
    if (!open || !media) return;
    let active = true;
    const refresh = () => void media.enumerateDevices().then((list) => {
      if (active) setDevices(list);
    }).catch(() => { if (active) setFailed(true); });
    refresh();
    media.addEventListener('devicechange', refresh);
    return () => { active = false; media.removeEventListener('devicechange', refresh); };
  }, [open, media, voice.isInVoice]);
  if (!media) return null;

  const deviceSelect = (kind: MediaDeviceKind, label: string, value: string | undefined, change: (id: string) => Promise<void>) => {
    const list = devices.filter((device) => device.kind === kind && device.deviceId && device.deviceId !== 'default');
    return (
      <label className="grid gap-1">
        {label}
        <select aria-label={label} className="atelier-field min-w-0" value={list.some((device) => device.deviceId === value) ? value : ''} disabled={busy}
          onChange={async (event) => {
            setBusy(true);
            setFailed(false);
            try { await change(event.target.value); } catch { setFailed(true); } finally { setBusy(false); }
          }}>
          <option value="">{t.collab.systemDefaultDevice}</option>
          {list.map((device, i) => <option key={device.deviceId} value={device.deviceId}>{device.label || `${label} ${i + 1}`}</option>)}
        </select>
      </label>
    );
  };
  return (
    <div className="relative">
      <button ref={btnRef} type="button" title={t.collab.audioDevices} aria-label={t.collab.audioDevices}
        aria-expanded={open} onClick={() => setOpen((v) => !v)} className="atelier-btn !h-6 !px-1.5 cursor-pointer">
        <Settings2 className="h-3.5 w-3.5" />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div ref={popRef} style={{ top: pos.top, right: pos.right }}
          className="atelier-popover fixed z-[85] grid w-56 max-w-[calc(100vw-16px)] gap-2 p-3 text-xs">
          {deviceSelect('audioinput', t.collab.microphoneDevice, voice.inputDeviceId, setVoiceInputDevice)}
          {canSelectOutput
            ? deviceSelect('audiooutput', t.collab.outputDevice, voice.outputDeviceId, setVoiceOutputDevice)
            : <span className="whitespace-normal text-neutral-400">{t.collab.outputSelectionUnavailable}</span>}
          {failed && <p role="alert" className="whitespace-normal text-rose-300">{t.collab.deviceSwitchFailed}</p>}
        </div>,
        document.body
      )}
    </div>
  );
};

interface VoiceChatBarProps {
  voiceState: VoiceChatState;
  onJoinVoice: () => void;
  onLeaveVoice: () => void;
  onToggleMute: () => void;
  currentUserName?: string;
  micShortcutKey?: string;
}

export const VoiceMemberStatus: React.FC<{ isMuted: boolean; isSpeaking: boolean }> = ({ isMuted, isSpeaking }) => {
  const { t } = useI18n();
  if (isMuted) {
    return <span className="inline-flex items-center gap-1 text-rose-400"><MicOff className="h-3 w-3" />{t.collab.voiceMuted}</span>;
  }
  if (isSpeaking) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-medium text-emerald-300">
        <span aria-hidden="true" className="flex h-3 items-center gap-px">
          <span className="h-2 w-0.5 rounded-full bg-current motion-safe:animate-[voiceWave_720ms_ease-in-out_infinite]" />
          <span className="h-3 w-0.5 rounded-full bg-current motion-safe:animate-[voiceWave_530ms_ease-in-out_infinite]" />
          <span className="h-1.5 w-0.5 rounded-full bg-current motion-safe:animate-[voiceWave_640ms_ease-in-out_infinite]" />
        </span>
        {t.collab.speaking}
      </span>
    );
  }
  return <span className="inline-flex items-center gap-1 text-neutral-400"><Mic className="h-3 w-3" />{t.collab.voiceMicOpen}</span>;
};

export const VoiceChatBar: React.FC<VoiceChatBarProps> = ({
  voiceState,
  onJoinVoice,
  onLeaveVoice,
  onToggleMute,
  currentUserName,
  micShortcutKey = 'M',
}) => {
  const { t } = useI18n();
  const { isInVoice, isMuted, isSpeaking, activePeers } = voiceState;

  if (!isInVoice) {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onJoinVoice}
          className="flex items-center gap-1.5 px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-lg bg-neutral-800/90 hover:bg-neutral-700/90 text-neutral-300 hover:text-white border border-neutral-700/60 shadow-sm text-xs font-medium transition shrink-0 whitespace-nowrap active:scale-95"
          title={t.collab.joinVoice}
        >
          <Radio className="w-3.5 h-3.5 text-indigo-400 animate-pulse shrink-0" />
          <span className="hidden sm:inline">{t.collab.joinVoice}</span>
          <span className="sm:hidden">{t.collab.voiceChat}</span>
        </button>
        <VoiceDevices voice={voiceState} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-2.5 py-1 rounded-xl bg-neutral-950/95 border border-indigo-500/50 shadow-lg text-xs backdrop-blur-md text-neutral-200 animate-in fade-in duration-200 shrink-0 whitespace-nowrap">
      {/* 1. Live Voice Indicator & Total In Voice */}
      <div className="flex items-center gap-1 font-medium text-emerald-400 pr-1.5 border-r border-neutral-800 shrink-0">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
        </span>
        <span className="text-[11px] font-semibold hidden sm:inline">{t.collab.voiceChat}</span>
        <span className="text-[10px] text-neutral-400 bg-neutral-800 px-1.5 py-0.2 rounded-full font-mono">
          {activePeers.length + 1}
        </span>
      </div>

      {/* 2. My Mic Toggle */}
      <button
        type="button"
        onClick={onToggleMute}
        title={isMuted ? t.collab.unmute : t.collab.mute}
        className={`flex items-center gap-1 px-2 py-0.5 rounded-md font-medium text-xs transition shrink-0 ${
          isMuted
            ? 'bg-rose-950/70 text-rose-300 hover:bg-rose-900/80 border border-rose-800/80'
            : isSpeaking
            ? 'bg-emerald-600 text-white shadow-md shadow-emerald-500/30'
            : 'bg-neutral-800 text-neutral-200 hover:bg-neutral-700'
        }`}
      >
        {isMuted ? <MicOff className="w-3 h-3 text-rose-400" /> : <Mic className="w-3 h-3 text-emerald-400" />}
        <span className="text-[10px] hidden md:inline">{isMuted ? t.collab.voiceMuted : isSpeaking ? t.collab.speaking : t.collab.voiceMicOpen}</span>
      </button>

      <VoiceDevices voice={voiceState} />
      {/* 3. Leave Call Button */}
      <button
        type="button"
        onClick={onLeaveVoice}
        title={t.collab.leaveVoice}
        className="p-1 rounded-md bg-rose-600/20 text-rose-400 hover:bg-rose-600 hover:text-white transition shrink-0"
      >
        <PhoneOff className="w-3 h-3" />
      </button>
    </div>
  );
};
