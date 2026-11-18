import React, { useEffect, useState } from 'react';
import { calculatePainterLevel, OfflineMemberInfo, RoomMemberInfo } from '@atelier/shared';
import { Users, ShieldCheck, ShieldAlert, Edit3, Flame, Trophy } from 'lucide-react';
import { useSocket, useSocketTelemetry } from '../context/SocketContext';
import { formatDrawTime, formatDrawTimeExact, formatLastSeen } from '../utils/presenceFormat';
import { useI18n } from '../context/I18nContext';
import { memberCardKey, roomMemberCards } from '../utils/roomMembers';

interface UserListPanelProps {
  members: RoomMemberInfo[];
  totalCanvasStrokes?: number;
}

type Presence = 'online' | 'idle' | 'offline';

const PRESENCE_DOT: Record<Presence, string> = {
  online: 'bg-emerald-400',
  idle: 'bg-amber-400',
  offline: 'bg-neutral-600',
};

/** The member's colour with a small status dot (green online, amber idle, grey offline) */
const MemberDot: React.FC<{ color?: string; presence: Presence }> = ({ color, presence }) => (
  <span className="relative w-2.5 h-2.5 shrink-0">
    <span
      style={{ backgroundColor: color || '#525252' }}
      className={`block w-2.5 h-2.5 rounded-full shadow-sm ${presence === 'offline' ? 'opacity-40' : ''}`}
    />
    <span
      className={`absolute -right-0.5 -bottom-0.5 w-1.5 h-1.5 rounded-full ring-2 ring-neutral-900 ${PRESENCE_DOT[presence]}`}
    />
  </span>
);

const SectionTitle: React.FC<{ label: string; count: number }> = ({ label, count }) => (
  <div className="px-1 pt-1 pb-0.5 text-[10px] font-medium text-neutral-500 tracking-wide">
    {label} · {count}
  </div>
);

export const UserListPanel: React.FC<UserListPanelProps> = ({
  members,
  totalCanvasStrokes: propTotalCanvasStrokes,
}) => {
  const { t } = useI18n();
  const { totalCanvasStrokes: telemetryTotal, memberStats } = useSocketTelemetry();
  const { offlineMembers } = useSocket();
  const totalCanvasStrokes = propTotalCanvasStrokes ?? telemetryTotal;

  // "12 分鐘前" has to move on by itself
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const online = roomMemberCards(members);
  const connectedIds = new Set(online.filter((member) => !member.isGuest).map((member) => member.userId));
  const offline = offlineMembers.filter((member) => !connectedIds.has(member.userId));

  return (
    <div className="w-full bg-atelier-panel flex flex-col h-full text-xs select-none">
      {/* Header with Canvas Total Strokes Counter */}
      <div className="h-10 px-3 border-b border-atelier-border flex items-center justify-between text-neutral-300 font-medium">
        <div className="flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-indigo-400" />
          <span>{t.collab.members}</span>
        </div>
        <div
          className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-950/70 text-amber-300 border border-amber-800/80 font-mono shadow-sm"
          title={t.collab.totalStrokes}
        >
          <Flame className="w-3 h-3 text-amber-400 animate-pulse" />
          <span>{totalCanvasStrokes.toLocaleString()} {t.collab.strokesUnit}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        <section aria-label={t.collab.onlineMembers} className="space-y-1.5">
          <SectionTitle label={t.collab.onlineMembers} count={online.length} />
          {online.length === 0 ? (
            <div className="text-neutral-500 text-center py-4">{t.collab.noOnlineMembers}</div>
          ) : (
            online.map((m) => {
              const stat = memberStats.get(m.userId);
              const strokes = stat?.strokeCount ?? m.strokeCount ?? 0;
              const drawTimeMs = stat?.drawTimeMs ?? m.drawTimeMs;
              const levelInfo = calculatePainterLevel(strokes);
              const presence: Presence = m.presence === 'idle' ? 'idle' : 'online';

              return (
                <div
                  key={memberCardKey(m)}
                  data-presence={presence}
                  className={`p-2 rounded-lg bg-neutral-900/60 hover:bg-neutral-800/70 border border-neutral-800/80 transition flex flex-col gap-1.5 ${
                    presence === 'idle' ? 'opacity-70' : ''
                  }`}
                >
                  {/* Top Row: Status, Name, Role */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 truncate">
                      <MemberDot color={m.color} presence={presence} />
                      <span className="truncate text-neutral-200 font-medium">{m.displayName}</span>
                      {presence === 'idle' && (
                        <span className="shrink-0 text-[10px] text-amber-400/90" title={t.collab.idleTooltip}>
                          {t.collab.idle}
                        </span>
                      )}
                    </div>

                    <div className="shrink-0 ml-1">
                      {m.serverRole === 'admin' || m.canvasRole === 'owner' || m.canvasRole === 'admin' ? (
                        <span className="flex items-center gap-0.5 px-1.5 py-0.2 rounded bg-amber-950 text-amber-300 border border-amber-700 text-[10px] font-semibold">
                          <ShieldCheck className="w-2.5 h-2.5" />
                          {t.collab.adminRole}
                        </span>
                      ) : m.isGuest ? (
                        <span className="flex items-center gap-0.5 px-1.5 py-0.2 rounded bg-neutral-800 text-neutral-400 text-[10px]">
                          <ShieldAlert className="w-2.5 h-2.5" />
                          {t.collab.guest}
                        </span>
                      ) : (
                        <span className="flex items-center gap-0.5 px-1.5 py-0.2 rounded bg-indigo-950 text-indigo-300 border border-indigo-800 text-[10px]">
                          <Edit3 className="w-2.5 h-2.5" />
                          {t.collab.painter}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Bottom Row: Painter Level & Stroke Count */}
                  <div className="flex items-center justify-between text-[10px]">
                    <div
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded border font-medium"
                      style={{
                        borderColor: `${levelInfo.badgeColor}55`,
                        backgroundColor: `${levelInfo.badgeColor}18`,
                        color: levelInfo.badgeColor,
                      }}
                      title={`Lv.${levelInfo.level} ${levelInfo.title}\n${strokes.toLocaleString()} ${t.collab.strokesUnit}`}
                    >
                      <Trophy className="w-2.5 h-2.5" />
                      <span>Lv.{levelInfo.level}</span>
                      <span className="truncate max-w-[85px] text-[9px] opacity-90">
                        {levelInfo.title.split(' ')[0]}
                      </span>
                    </div>

                    <div className="font-mono text-neutral-400 font-medium">
                      {strokes.toLocaleString()} {t.collab.strokesUnit}
                    </div>
                  </div>

                  {/* Progress bar to next level */}
                  <div
                    className="w-full bg-neutral-800 rounded-full h-1 overflow-hidden"
                    title={`${levelInfo.progressPercent}%`}
                  >
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${levelInfo.progressPercent}%`,
                        backgroundColor: levelInfo.badgeColor,
                      }}
                    />
                  </div>

                  {!m.isGuest && (
                    <div
                      className="text-[10px] text-neutral-500"
                      data-draw-time
                      title={`${t.collab.drawTimePrefix} ${formatDrawTimeExact(drawTimeMs, t)}`}
                    >
                      {formatDrawTime(drawTimeMs, t)}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </section>

        {offline.length > 0 && (
          <section aria-label={t.collab.offlineMembers} className="space-y-1 pt-1">
            <SectionTitle label={t.collab.offlineMembers} count={offline.length} />
            {offline.map((m) => (
              <OfflineRow key={m.userId} member={m} now={now} t={t} />
            ))}
          </section>
        )}
      </div>
    </div>
  );
};

const OfflineRow: React.FC<{ member: OfflineMemberInfo; now: number; t: ReturnType<typeof useI18n>['t'] }> = ({ member: m, now, t }) => (
  <div
    data-presence="offline"
    className="px-2 py-1.5 rounded-lg border border-neutral-800/60 bg-neutral-900/30 flex flex-col gap-0.5"
  >
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 truncate">
        <MemberDot presence="offline" />
        <span className="truncate text-neutral-400">{m.displayName}</span>
      </div>
      <span
        className="shrink-0 text-[10px] text-neutral-500"
        data-last-seen
        title={m.lastSeenAt ? `${t.collab.lastSeenPrefix} ${new Date(m.lastSeenAt).toLocaleString()}` : undefined}
      >
        {formatLastSeen(m.lastSeenAt, now, t)}
      </span>
    </div>
    <div className="pl-[18px] text-[10px] text-neutral-600" data-draw-time title={`${t.collab.drawTimePrefix} ${formatDrawTimeExact(m.drawTimeMs, t)}`}>
      {formatDrawTime(m.drawTimeMs, t)}
    </div>
  </div>
);
