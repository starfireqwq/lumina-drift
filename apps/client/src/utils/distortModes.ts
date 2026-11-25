import type { Translations } from '../locales/types';

export type DistortMode = 'mesh' | 'perspective' | 'parallel' | 'free' | 'puppet';

export const DISTORT_MODES: { id: DistortMode; label: string }[] = [
  { id: 'mesh', label: '網格變形' },
  { id: 'perspective', label: '遠近歪斜' },
  { id: 'parallel', label: '平行歪斜' },
  { id: 'free', label: '自由歪斜' },
  { id: 'puppet', label: '操控變形' },
];

export function getDistortModeOptions({ tools, puppetWarp }: Pick<Translations, 'tools' | 'puppetWarp'>): { id: DistortMode | 'transform'; label: string }[] {
  const labels: Record<DistortMode, string> = {
    mesh: tools.meshWarp,
    perspective: puppetWarp.perspective,
    parallel: puppetWarp.parallel,
    free: puppetWarp.free,
    puppet: puppetWarp.title,
  };
  return [
    { id: 'transform', label: tools.transform },
    ...DISTORT_MODES.map(({ id }) => ({ id, label: labels[id] })),
  ];
}
