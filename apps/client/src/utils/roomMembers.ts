import type { RoomMemberInfo } from '@atelier/shared';

export const memberCardKey = (member: RoomMemberInfo) => member.isGuest ? `guest:${member.socketId}` : `user:${member.userId}`;

/** Collapse connected accounts for display, while each transport retains its own presence. */
export function roomMemberCards(members: RoomMemberInfo[]): RoomMemberInfo[] {
  const byAccount = new Map<string, RoomMemberInfo>();
  for (const member of members) {
    const key = memberCardKey(member);
    const previous = byAccount.get(key);
    if (!previous || (previous.presence === 'idle' && member.presence !== 'idle')) byAccount.set(key, member);
  }
  return [...byAccount.values()].sort((a, b) => Number(a.presence === 'idle') - Number(b.presence === 'idle'));
}
