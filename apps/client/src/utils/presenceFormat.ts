import type { Translations } from '../locales';

/** Member list wording: when someone was last online and how long they have drawn */

const pad = (n: number) => String(n).padStart(2, '0');
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** 剛剛 / 12 分鐘前 / 3 小時前 / 昨天 21:05 / 4 天前 / 3/8 14:20 / 2024/3/8 */
export function formatLastSeen(at: number | null | undefined, now = Date.now(), t?: Translations): string {
  if (!at) return t ? t.collab.noRecord : '尚無紀錄';
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return t ? t.collab.justNow : '剛剛';
  if (diff < 3_600_000) {
    const mins = Math.floor(diff / 60_000);
    return t ? t.collab.minutesAgo.replace('{n}', String(mins)) : `${mins} 分鐘前`;
  }
  const d = new Date(at);
  const n = new Date(now);
  const days = Math.round((dayStart(n) - dayStart(d)) / 86_400_000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days <= 0) {
    const hours = Math.floor(diff / 3_600_000);
    return t ? t.collab.hoursAgo.replace('{n}', String(hours)) : `${hours} 小時前`;
  }
  if (days === 1) return t ? t.collab.yesterday.replace('{time}', hm) : `昨天 ${hm}`;
  if (days < 7) return t ? t.collab.daysAgo.replace('{n}', String(days)) : `${days} 天前`;
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 尚未作畫 / 畫了不到 1 分 / 畫了 12 分 / 畫了 3 小時 12 分 */
export function formatDrawTime(ms: number | null | undefined, t?: Translations): string {
  const total = Math.max(0, ms ?? 0);
  if (total === 0) return t ? t.collab.notDrawnYet : '尚未作畫';
  const minutes = Math.floor(total / 60_000);
  if (minutes < 1) return t ? t.collab.drawLessThanOneMin : '畫了不到 1 分';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (t) {
    if (h && m) return t.collab.drawHoursMinutes.replace('{h}', String(h)).replace('{m}', String(m));
    if (h) return t.collab.drawHoursOnly.replace('{h}', String(h));
    return t.collab.drawMinutes.replace('{m}', String(m));
  }
  return h ? `畫了 ${h} 小時${m ? ` ${m} 分` : ''}` : `畫了 ${m} 分`;
}

/** Exact figure for a tooltip: 1 小時 02 分 05 秒 */
export function formatDrawTimeExact(ms: number | null | undefined, t?: Translations): string {
  const s = Math.floor(Math.max(0, ms ?? 0) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const unitH = t ? t.collab.unitHours : '小時';
  const unitM = t ? t.collab.unitMinutes : '分';
  const unitS = t ? t.collab.unitSeconds : '秒';
  return `${h ? `${h} ${unitH} ` : ''}${pad(m)} ${unitM} ${pad(sec)} ${unitS}`;
}
