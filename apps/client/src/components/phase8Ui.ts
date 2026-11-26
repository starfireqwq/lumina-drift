/**
 * Small pure helpers behind the Phase 8 UI (export ICC choice, soft proof labels), kept apart from
 * the React components so the logic checks can run them in Node.
 */
import type { ExportFormat } from '../engine/ExportEngine';
import { builtinSrgbEmbedChoice, type IccEmbedChoice } from '../engine/color/iccEmbed';
import type { SoftProofStatus } from '../engine/color/softProofStore';
import type { Translations } from '../locales';

/** Formats whose pixels can carry an embedded RGB profile */
export const ICC_EMBED_FORMATS: ReadonlySet<ExportFormat> = new Set<ExportFormat>(['merged_png', 'transparent_png', 'jpeg', 'psd']);

export const EXPORT_ICC_STORAGE_KEY = 'atelier_export_icc_v1';

export type IccEmbedValue = 'none' | 'srgb' | `icc:${string}`;

type RgbProfile = { id: string; label: string; bytes: Uint8Array };

/** A remembered choice, or "none" when it is unknown or its profile was removed */
export function normalizeIccEmbedValue(raw: unknown, rgbProfiles: ReadonlyArray<{ id: string }>): IccEmbedValue {
  if (raw === 'srgb') return 'srgb';
  if (typeof raw === 'string' && raw.startsWith('icc:') && rgbProfiles.some((p) => p.id === raw)) return raw as IccEmbedValue;
  return 'none';
}

export function resolveIccEmbedChoice(value: IccEmbedValue, rgbProfiles: ReadonlyArray<RgbProfile>): IccEmbedChoice | null {
  if (value === 'srgb') return builtinSrgbEmbedChoice();
  if (value === 'none') return null;
  const profile = rgbProfiles.find((p) => p.id === value);
  return profile ? { name: profile.label, bytes: profile.bytes } : null;
}

export function hasAdjustmentLayers(layers: ReadonlyArray<{ layerType?: string }>): boolean {
  return layers.some((l) => l.layerType === 'adjustment');
}

export function softProofStatusText(status: SoftProofStatus, t: Translations): string {
  if (status.state === 'error') return `${t.softProof.status.error}：${softProofErrorText(status.code, t)}`;
  return t.softProof.status[status.state];
}

export function softProofErrorText(code: string, t: Translations): string {
  const errors = t.softProof.errors as Record<string, string>;
  return errors[code] ?? t.softProof.errors.parse_failed;
}

/** `builtin:fogra39` → `soft-proof-profile-builtin-fogra39` */
export function softProofProfileTestId(id: string): string {
  return `soft-proof-profile-${id.replace(/:/g, '-')}`;
}
