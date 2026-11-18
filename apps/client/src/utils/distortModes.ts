export type DistortMode = 'mesh' | 'perspective' | 'parallel' | 'free';

export const DISTORT_MODES: { id: DistortMode; label: string }[] = [
  { id: 'mesh', label: '網格變形' },
  { id: 'perspective', label: '遠近歪斜' },
  { id: 'parallel', label: '平行歪斜' },
  { id: 'free', label: '自由歪斜' },
];
