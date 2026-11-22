import React, { useEffect, useState } from 'react';
import {
  AssignableCanvasRole,
  calculatePainterLevel,
  canManageCanvasMemberRole,
  CanvasRole,
  OfflineMemberInfo,
  RoleActorContext,
  RoleTargetContext,
  RoomMemberInfo,
  ServerRole,
} from '@atelier/shared';
import { Users, ShieldCheck, ShieldAlert, Edit3, Flame, Trophy, Crown, Eye } from 'lucide-react';
import { useSocket, useSocketTelemetry } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import { ApiService } from '../services/api';
import { OfflineSessionStore } from '../services/offlineStore';
import { formatDrawTime, formatDrawTimeExact, formatLastSeen } from '../utils/presenceFormat';
import { useI18n } from '../context/I18nContext';
import { memberCardKey, roomMemberCards } from '../utils/roomMembers';

interface UserListPanelProps {
  members: RoomMemberInfo[];
  totalCanvasStrokes?: number;
  canvasId?: string;
  canvasOwnerId?: string;
}

type Presence = 'online' | 'idle' | 'offline';

const PRESENCE_DOT: Record<Presence, string> = {
  online: 'bg-emerald-400',
  idle: 'bg-amber-400',
  offline: 'bg-neutral-600',
};

const ROLE_SELECT_TONE: Record<AssignableCanvasRole, string> = {
  admin: 'bg-amber-950/90 text-amber-200 border-amber-700/80',
  editor: 'bg-indigo-950/90 text-indigo-200 border-indigo-700/80',
  viewer: 'bg-sky-950/90 text-sky-200 border-sky-700/80',
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

type BadgeRole = 'owner' | 'admin' | 'editor' | 'viewer' | 'guest';

function resolveBadgeRole(params: {
  userId: string;
  canvasOwnerId?: string;
  serverRole?: ServerRole | 'guest';
  canvasRole?: CanvasRole;
  isGuest?: boolean;
}): BadgeRole {
  if (params.isGuest || params.serverRole === 'guest') return 'guest';
  if (params.canvasRole === 'owner' || (params.canvasOwnerId && params.userId === params.canvasOwnerId)) {
    return 'owner';
  }
  if (params.serverRole === 'admin' || params.canvasRole === 'admin') return 'admin';
  if (params.canvasRole === 'viewer') return 'viewer';
  return 'editor';
}

const RoleBadge: React.FC<{ role: BadgeRole; t: ReturnType<typeof useI18n>['t'] }> = ({ role, t }) => {
  switch (role) {
    case 'owner':
      return (
        <span
          data-role-badge="owner"
          className="inline-flex items-center gap-0.5 whitespace-nowrap px-1.5 py-0.5 rounded bg-amber-950/90 text-amber-200 border border-amber-600/80 text-[10px] font-semibold leading-none"
        >
          <Crown className="w-2.5 h-2.5 shrink-0 text-amber-400" />
          {t.collab.roleOwner}
        </span>
      );
    case 'admin':
      return (
        <span
          data-role-badge="admin"
          className="inline-flex items-center gap-0.5 whitespace-nowrap px-1.5 py-0.5 rounded bg-amber-950/75 text-amber-300 border border-amber-700/80 text-[10px] font-semibold leading-none"
        >
          <ShieldCheck className="w-2.5 h-2.5 shrink-0" />
          {t.collab.roleAdmin}
        </span>
      );
    case 'viewer':
      return (
        <span
          data-role-badge="viewer"
          className="inline-flex items-center gap-0.5 whitespace-nowrap px-1.5 py-0.5 rounded bg-sky-950/85 text-sky-300 border border-sky-700/80 text-[10px] font-medium leading-none"
        >
          <Eye className="w-2.5 h-2.5 shrink-0" />
          {t.collab.roleViewer}
        </span>
      );
    case 'guest':
      return (
        <span
          data-role-badge="guest"
          className="inline-flex items-center gap-0.5 whitespace-nowrap px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 border border-neutral-700/70 text-[10px] leading-none"
        >
          <ShieldAlert className="w-2.5 h-2.5 shrink-0" />
          {t.collab.roleGuest}
        </span>
      );
    case 'editor':
    default:
      return (
        <span
          data-role-badge="editor"
          className="inline-flex items-center gap-0.5 whitespace-nowrap px-1.5 py-0.5 rounded bg-indigo-950/90 text-indigo-300 border border-indigo-800/80 text-[10px] leading-none"
        >
          <Edit3 className="w-2.5 h-2.5 shrink-0" />
          {t.collab.roleEditor}
        </span>
      );
  }
};

interface MemberRoleControlProps {
  target: RoleTargetContext;
  badgeRole: BadgeRole;
  actor: RoleActorContext | null;
  canSwitch: boolean;
  pending: boolean;
  onChangeRole: (userId: string, nextRole: AssignableCanvasRole) => void;
  t: ReturnType<typeof useI18n>['t'];
}

const MemberRoleControl: React.FC<MemberRoleControlProps> = ({
  target,
  badgeRole,
  actor,
  canSwitch,
  pending,
  onChangeRole,
  t,
}) => {
  const manage = canSwitch && actor ? canManageCanvasMemberRole(actor, target) : null;
  if (!manage?.allowed || manage.allowedRoles.length === 0) {
    return <RoleBadge role={badgeRole} t={t} />;
  }

  const currentValue: AssignableCanvasRole =
    target.canvasRole === 'admin' || target.canvasRole === 'viewer' ? target.canvasRole : 'editor';

  const labelFor = (r: AssignableCanvasRole) =>
    r === 'admin' ? t.collab.roleAdmin : r === 'viewer' ? t.collab.roleViewer : t.collab.roleEditor;

  return (
    <select
      data-role-select={target.userId}
      aria-label={t.collab.roleSelectAria}
      value={currentValue}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value as AssignableCanvasRole;
        if (next !== currentValue) onChangeRole(target.userId, next);
      }}
      className={`h-5 max-w-[78px] rounded border px-1 text-[10px] font-medium leading-none outline-none transition focus:ring-1 focus:ring-indigo-400 ${
        ROLE_SELECT_TONE[currentValue]
      } ${pending ? 'opacity-50 cursor-wait' : 'cursor-pointer hover:brightness-110'}`}
    >
      {manage.allowedRoles.map((roleOpt) => (
        <option key={roleOpt} value={roleOpt} className="bg-neutral-900 text-neutral-100">
          {labelFor(roleOpt)}
        </option>
      ))}
    </select>
  );
};

export const UserListPanel: React.FC<UserListPanelProps> = ({
  members,
  totalCanvasStrokes: propTotalCanvasStrokes,
  canvasId,
  canvasOwnerId,
}) => {
  const { t } = useI18n();
  const { user, isGuest } = useAuth();
  const { totalCanvasStrokes: telemetryTotal, memberStats } = useSocketTelemetry();
  const { offlineMembers } = useSocket();
  const totalCanvasStrokes = propTotalCanvasStrokes ?? telemetryTotal;

  // "12 分鐘前" has to move on by itself
  const [now, setNow] = useState(() => Date.now());
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!roleError) return;
    const timer = setTimeout(() => setRoleError(null), 4000);
    return () => clearTimeout(timer);
  }, [roleError]);

  const online = roomMemberCards(members);
  const connectedIds = new Set(online.filter((member) => !member.isGuest).map((member) => member.userId));
  const offline = offlineMembers.filter((member) => !connectedIds.has(member.userId));

  const isOfflineMode = !canvasId || OfflineSessionStore.isOfflineCanvas(canvasId);
  const selfOnline = user ? members.find((m) => m.userId === user.id) : undefined;
  const actorCtx: RoleActorContext | null =
    user && !isGuest
      ? {
          userId: user.id,
          serverRole: user.serverRole,
          canvasRole: selfOnline?.canvasRole ?? (canvasOwnerId === user.id ? 'owner' : undefined),
          isCanvasOwner: Boolean(canvasOwnerId && canvasOwnerId === user.id),
        }
      : null;

  const handleChangeRole = async (targetUserId: string, nextRole: AssignableCanvasRole) => {
    if (!canvasId || isOfflineMode || pendingUserId) return;
    setPendingUserId(targetUserId);
    setRoleError(null);
    try {
      await ApiService.updateCanvasMemberRole(canvasId, targetUserId, nextRole);
    } catch (err: any) {
      setRoleError(err?.message || t.collab.roleUpdateFailed);
    } finally {
      setPendingUserId((curr) => (curr === targetUserId ? null : curr));
    }
  };

  return (
    <div className="w-full min-w-0 bg-atelier-panel flex flex-col h-full text-xs select-none">
      {/* Header with Canvas Total Strokes Counter */}
      <div className="h-10 px-3 border-b border-atelier-border flex items-center justify-between gap-2 text-neutral-300 font-medium min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <Users className="w-3.5 h-3.5 shrink-0 text-indigo-400" />
          <span className="truncate">{t.collab.members}</span>
        </div>
        <div
          className="flex shrink-0 items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-950/70 text-amber-300 border border-amber-800/80 font-mono shadow-sm whitespace-nowrap"
          title={t.collab.totalStrokes}
        >
          <Flame className="w-3 h-3 text-amber-400 animate-pulse shrink-0" />
          <span>{totalCanvasStrokes.toLocaleString()} {t.collab.strokesUnit}</span>
        </div>
      </div>

      {roleError && (
        <div
          role="alert"
          className="mx-2 mt-2 px-2 py-1 rounded border border-rose-700/70 bg-rose-950/80 text-[10px] text-rose-200 flex items-center justify-between gap-1.5"
        >
          <span className="min-w-0 truncate">{roleError}</span>
          <button
            type="button"
            onClick={() => setRoleError(null)}
            className="shrink-0 text-rose-300 hover:text-white leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
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
              const badgeRole = resolveBadgeRole({
                userId: m.userId,
                canvasOwnerId,
                serverRole: m.serverRole,
                canvasRole: m.canvasRole,
                isGuest: m.isGuest,
              });
              const targetCtx: RoleTargetContext = {
                userId: m.userId,
                serverRole: m.serverRole,
                canvasRole: m.canvasRole,
                isCanvasOwner: Boolean(canvasOwnerId && m.userId === canvasOwnerId),
                isGuest: m.isGuest,
              };

              return (
                <div
                  key={memberCardKey(m)}
                  data-presence={presence}
                  data-member-id={m.userId}
                  className={`p-2 rounded-lg bg-neutral-900/60 hover:bg-neutral-800/70 border border-neutral-800/80 transition flex flex-col gap-1.5 min-w-0 ${
                    presence === 'idle' ? 'opacity-70' : ''
                  }`}
                >
                  {/* Top Row: Status, Name, Role */}
                  <div className="flex items-center justify-between gap-1.5 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <MemberDot color={m.color} presence={presence} />
                      <span className="truncate text-neutral-200 font-medium">{m.displayName}</span>
                      {presence === 'idle' && (
                        <span className="shrink-0 text-[10px] text-amber-400/90" title={t.collab.idleTooltip}>
                          {t.collab.idle}
                        </span>
                      )}
                    </div>

                    <div className="shrink-0">
                      <MemberRoleControl
                        target={targetCtx}
                        badgeRole={badgeRole}
                        actor={actorCtx}
                        canSwitch={!isOfflineMode}
                        pending={pendingUserId === m.userId}
                        onChangeRole={handleChangeRole}
                        t={t}
                      />
                    </div>
                  </div>

                  {/* Bottom Row: Painter Level & Stroke Count */}
                  <div className="flex items-center justify-between gap-1.5 text-[10px] min-w-0">
                    <div
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded border font-medium min-w-0"
                      style={{
                        borderColor: `${levelInfo.badgeColor}55`,
                        backgroundColor: `${levelInfo.badgeColor}18`,
                        color: levelInfo.badgeColor,
                      }}
                      title={`Lv.${levelInfo.level} ${levelInfo.title}\n${strokes.toLocaleString()} ${t.collab.strokesUnit}`}
                    >
                      <Trophy className="w-2.5 h-2.5 shrink-0" />
                      <span className="shrink-0">Lv.{levelInfo.level}</span>
                      <span className="truncate max-w-[85px] text-[9px] opacity-90">
                        {levelInfo.title.split(' ')[0]}
                      </span>
                    </div>

                    <div className="shrink-0 font-mono text-neutral-400 font-medium whitespace-nowrap">
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
                      className="text-[10px] text-neutral-500 truncate"
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
              <OfflineRow
                key={m.userId}
                member={m}
                now={now}
                t={t}
                canvasOwnerId={canvasOwnerId}
                actor={actorCtx}
                canSwitch={!isOfflineMode}
                pending={pendingUserId === m.userId}
                onChangeRole={handleChangeRole}
              />
            ))}
          </section>
        )}
      </div>
    </div>
  );
};

interface OfflineRowProps {
  member: OfflineMemberInfo;
  now: number;
  t: ReturnType<typeof useI18n>['t'];
  canvasOwnerId?: string;
  actor: RoleActorContext | null;
  canSwitch: boolean;
  pending: boolean;
  onChangeRole: (userId: string, nextRole: AssignableCanvasRole) => void;
}

const OfflineRow: React.FC<OfflineRowProps> = ({
  member: m,
  now,
  t,
  canvasOwnerId,
  actor,
  canSwitch,
  pending,
  onChangeRole,
}) => {
  const badgeRole = resolveBadgeRole({
    userId: m.userId,
    canvasOwnerId,
    serverRole: m.serverRole,
    canvasRole: m.canvasRole,
    isGuest: false,
  });
  const targetCtx: RoleTargetContext = {
    userId: m.userId,
    serverRole: m.serverRole,
    canvasRole: m.canvasRole,
    isCanvasOwner: Boolean(canvasOwnerId && m.userId === canvasOwnerId),
    isGuest: false,
  };

  return (
    <div
      data-presence="offline"
      data-member-id={m.userId}
      className="px-2 py-1.5 rounded-lg border border-neutral-800/60 bg-neutral-900/30 flex flex-col gap-1 min-w-0"
    >
      <div className="flex items-center justify-between gap-1.5 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <MemberDot presence="offline" />
          <span className="truncate text-neutral-400">{m.displayName}</span>
        </div>
        <div className="shrink-0">
          <MemberRoleControl
            target={targetCtx}
            badgeRole={badgeRole}
            actor={actor}
            canSwitch={canSwitch}
            pending={pending}
            onChangeRole={onChangeRole}
            t={t}
          />
        </div>
      </div>
      <div className="pl-[18px] flex items-center justify-between gap-2 text-[10px] min-w-0">
        <span
          className="truncate text-neutral-600"
          data-draw-time
          title={`${t.collab.drawTimePrefix} ${formatDrawTimeExact(m.drawTimeMs, t)}`}
        >
          {formatDrawTime(m.drawTimeMs, t)}
        </span>
        <span
          className="shrink-0 text-neutral-500 whitespace-nowrap"
          data-last-seen
          title={m.lastSeenAt ? `${t.collab.lastSeenPrefix} ${new Date(m.lastSeenAt).toLocaleString()}` : undefined}
        >
          {formatLastSeen(m.lastSeenAt, now, t)}
        </span>
      </div>
    </div>
  );
};
