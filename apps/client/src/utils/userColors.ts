export interface UserColorTheme {
  name: string;
  hex: string;
  bgLight: string;
  border: string;
  text: string;
  glow: string;
}

export const USER_COLOR_PALETTE: UserColorTheme[] = [
  { name: '翡翠綠 (Emerald)', hex: '#10B981', bgLight: 'bg-emerald-500/15', border: 'border-emerald-500/50', text: 'text-emerald-400', glow: 'shadow-emerald-500/25' },
  { name: '蔚天藍 (Sky)', hex: '#0EA5E9', bgLight: 'bg-sky-500/15', border: 'border-sky-500/50', text: 'text-sky-400', glow: 'shadow-sky-500/25' },
  { name: '紫羅蘭 (Violet)', hex: '#8B5CF6', bgLight: 'bg-violet-500/15', border: 'border-violet-500/50', text: 'text-violet-400', glow: 'shadow-violet-500/25' },
  { name: '玫瑰紅 (Rose)', hex: '#F43F5E', bgLight: 'bg-rose-500/15', border: 'border-rose-500/50', text: 'text-rose-400', glow: 'shadow-rose-500/25' },
  { name: '琥珀金 (Amber)', hex: '#F59E0B', bgLight: 'bg-amber-500/15', border: 'border-amber-500/50', text: 'text-amber-400', glow: 'shadow-amber-500/25' },
  { name: '霓虹青 (Cyan)', hex: '#06B6D4', bgLight: 'bg-cyan-500/15', border: 'border-cyan-500/50', text: 'text-cyan-400', glow: 'shadow-cyan-500/25' },
  { name: '洋紅紫 (Fuchsia)', hex: '#D946EF', bgLight: 'bg-fuchsia-500/15', border: 'border-fuchsia-500/50', text: 'text-fuchsia-400', glow: 'shadow-fuchsia-500/25' },
  { name: '青檸綠 (Lime)', hex: '#84CC16', bgLight: 'bg-lime-500/15', border: 'border-lime-500/50', text: 'text-lime-400', glow: 'shadow-lime-500/25' },
  { name: '夕陽橘 (Orange)', hex: '#F97316', bgLight: 'bg-orange-500/15', border: 'border-orange-500/50', text: 'text-orange-400', glow: 'shadow-orange-500/25' },
  { name: '星空靛 (Indigo)', hex: '#6366F1', bgLight: 'bg-indigo-500/15', border: 'border-indigo-500/50', text: 'text-indigo-400', glow: 'shadow-indigo-500/25' },
  { name: '櫻花粉 (Pink)', hex: '#EC4899', bgLight: 'bg-pink-500/15', border: 'border-pink-500/50', text: 'text-pink-400', glow: 'shadow-pink-500/25' },
  // Was teal (#14B8A6): between emerald and cyan, two painters looked like the same person
  { name: '鵝黃 (Yellow)', hex: '#EAB308', bgLight: 'bg-yellow-500/15', border: 'border-yellow-500/50', text: 'text-yellow-400', glow: 'shadow-yellow-500/25' },
];

/**
 * Deterministically returns a consistent vibrant theme color for a user ID or username.
 */
export function getUserColor(userId: string | null | undefined): UserColorTheme {
  if (!userId) return USER_COLOR_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % USER_COLOR_PALETTE.length;
  return USER_COLOR_PALETTE[index];
}
