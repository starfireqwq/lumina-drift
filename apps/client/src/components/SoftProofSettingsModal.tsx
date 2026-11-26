import React, { useRef, useState } from 'react';
import { Check, Printer, Trash2, Upload } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { AtelierModal, modalButton } from './AtelierModal';
import {
  getSoftProofStore, SOFT_PROOF_WARNING_COLORS, useSoftProof,
  type SoftProofProfileOption, type SoftProofSettings,
} from '../engine/color/softProofStore';
import { softProofErrorText, softProofProfileTestId, softProofStatusText } from './phase8Ui';

const Switch: React.FC<{ checked: boolean; label: string; testId: string; onToggle: () => void }> = ({ checked, label, testId, onToggle }) => (
  <button type="button" role="switch" aria-checked={checked} data-testid={testId} onClick={onToggle}
    className="atelier-btn atelier-btn--ghost flex w-full min-w-0 items-center justify-between gap-3 text-left">
    <span className="min-w-0 flex-1 text-xs font-medium text-neutral-200">{label}</span>
    <span aria-hidden="true" className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-neutral-600'}`}>
      <span className={`atelier-motion-transition absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${checked ? 'translate-x-3' : ''}`} />
    </span>
  </button>
);

/** Proof setup (檢視 → 校樣設定): print profile, intent, black point and warning colour. View only. */
export const SoftProofSettingsModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useI18n();
  const { settings, profiles, status } = useSoftProof();
  const store = getSoftProofStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const selected = profiles.find((p) => p.id === settings.profileId);
  const update = (patch: Partial<SoftProofSettings>) => store.update(patch);

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await store.importProfile(file.name, new Uint8Array(await file.arrayBuffer()));
      if (!result.ok) setImportError(softProofErrorText(result.code, t));
    } catch {
      setImportError(t.softProof.errors.parse_failed);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const badge = (p: SoftProofProfileOption) => (p.kind === 'builtin'
    ? t.softProof.builtinBadge
    : `${t.softProof.iccBadge} · ${p.colorSpace}`);

  return (
    <AtelierModal title={t.softProof.title} icon={<Printer />} subtitle={t.softProof.subtitle} width="md" onClose={onClose}
      footer={<button type="button" onClick={onClose} className={modalButton.primary}>{t.common.close}</button>}>
      <div data-testid="soft-proof-settings" className="flex flex-col gap-3 text-xs">
        <div className="flex flex-col gap-1.5">
          <Switch checked={settings.enabled} label={t.softProof.proofToggle} testId="soft-proof-toggle" onToggle={() => store.toggleEnabled()} />
          <Switch checked={settings.gamutWarning} label={t.softProof.gamutToggle} testId="soft-proof-gamut-toggle" onToggle={() => store.toggleGamutWarning()} />
        </div>

        <div role="radiogroup" aria-label={t.softProof.profile} className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-neutral-400">{t.softProof.profile}</span>
          {profiles.map((p) => {
            const isSelected = p.id === settings.profileId;
            return (
              <div key={p.id} className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 transition ${isSelected ? 'border-indigo-500 bg-indigo-600/15' : 'border-neutral-800'} ${p.proofable ? '' : 'opacity-70'}`}>
                <button type="button" role="radio" aria-checked={isSelected} disabled={!p.proofable}
                  data-testid={softProofProfileTestId(p.id)} onClick={() => update({ profileId: p.id })}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed">
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${isSelected ? 'border-indigo-500 bg-indigo-600' : 'border-neutral-600'}`}>
                    {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-medium text-white">{p.label}</span>
                    <span className="block text-[10px] text-neutral-400">{badge(p)}{p.proofable ? '' : ` · ${t.softProof.embedOnly}`}</span>
                  </span>
                </button>
                {p.kind === 'icc' && (
                  <button type="button" aria-label={t.softProof.removeProfile} title={t.softProof.removeProfile}
                    onClick={() => void store.removeProfile(p.id)} className="atelier-icon-btn h-7 w-7 shrink-0">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
          <input ref={fileRef} type="file" accept=".icc,.icm" className="hidden" data-testid="soft-proof-import-input"
            onChange={(e) => void onImport(e.target.files?.[0])} />
          <button type="button" disabled={importing} onClick={() => fileRef.current?.click()}
            className="atelier-btn atelier-btn--ghost inline-flex items-center justify-center gap-1.5 self-start">
            <Upload className="h-3.5 w-3.5" />{t.softProof.importIcc}
          </button>
          {importError && <p role="alert" className="rounded-md border border-rose-700 bg-rose-950/60 px-2.5 py-1.5 text-rose-200">{importError}</p>}
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-semibold text-neutral-400">{t.softProof.intent}</span>
            <select data-testid="soft-proof-intent" value={settings.intent} disabled={selected?.kind !== 'icc'}
              onChange={(e) => update({ intent: e.target.value === 'perceptual' ? 'perceptual' : 'relative' })}
              className="w-full min-w-0 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100 disabled:opacity-50">
              <option value="perceptual">{t.softProof.intentPerceptual}</option>
              <option value="relative">{t.softProof.intentRelative}</option>
            </select>
          </label>
          <label className="flex min-w-0 items-center gap-2 self-end py-1.5">
            <input type="checkbox" data-testid="soft-proof-bpc" checked={settings.blackPointCompensation}
              onChange={(e) => update({ blackPointCompensation: e.target.checked })} />
            <span className="min-w-0 text-neutral-200">{t.softProof.bpc}</span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold text-neutral-400">{t.softProof.warningColor}</span>
          {SOFT_PROOF_WARNING_COLORS.map((hex) => {
            const active = settings.warningColor.toUpperCase() === hex.toUpperCase();
            return (
              <button key={hex} type="button" aria-pressed={active} aria-label={hex} title={hex}
                data-testid={`soft-proof-warning-${hex.slice(1).toUpperCase()}`} onClick={() => update({ warningColor: hex })}
                className={`flex h-6 w-6 items-center justify-center rounded-full border-2 transition ${active ? 'border-white' : 'border-neutral-700'}`}
                style={{ background: hex }}>
                {active && <Check className="h-3 w-3 text-black/70" />}
              </button>
            );
          })}
        </div>

        <p data-testid="soft-proof-status" data-state={status.state} role="status"
          className={`text-[11px] ${status.state === 'error' ? 'text-rose-300' : status.state === 'ready' ? 'text-emerald-300' : 'text-neutral-400'}`}>
          {softProofStatusText(status, t)}
        </p>
        <p className="text-[11px] leading-relaxed text-neutral-400">{t.softProof.localOnly}</p>
      </div>
    </AtelierModal>
  );
};
