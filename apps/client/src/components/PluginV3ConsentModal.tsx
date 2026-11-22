import { ShieldAlert, Terminal, Server } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { getPluginLabels } from '../plugins/pluginLabels';
import type { V3ConsentDecision, V3ConsentRequest } from '../plugins/pluginV3Client';
import { AtelierModal, modalButton } from './AtelierModal';

export function PluginV3ConsentModal({
  request,
  onResolve,
}: {
  request: V3ConsentRequest;
  onResolve: (decision: V3ConsentDecision) => void;
}) {
  const { language } = useI18n();
  const strings = getPluginLabels(language);

  return (
    <AtelierModal
      title={strings.v3ConsentTitle}
      icon={<ShieldAlert className="text-amber-300" />}
      onClose={() => onResolve('deny')}
      width="md"
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            data-plugin-v3-consent="deny"
            onClick={() => onResolve('deny')}
            className={modalButton.secondary}
          >
            {strings.v3ConsentDeny}
          </button>
          <button
            type="button"
            data-plugin-v3-consent="once"
            onClick={() => onResolve('once')}
            className={modalButton.primary}
          >
            {strings.v3ConsentOnce}
          </button>
          <button
            type="button"
            data-plugin-v3-consent="session"
            onClick={() => onResolve('session')}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-amber-500/45 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/25"
          >
            {strings.v3ConsentSession}
          </button>
        </div>
      }
    >
      <div className="space-y-3" data-plugin-v3-consent-modal="true">
        <div className="atelier-plugin-sweep rounded-xl border border-amber-500/40 bg-amber-950/20 p-3 text-xs text-amber-100">
          <div className="flex items-start gap-2">
            {request.kind === 'bridge:local' ? (
              <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden />
            ) : (
              <Server className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden />
            )}
            <p className="min-w-0 break-words leading-relaxed">{strings.v3ConsentWarning}</p>
          </div>
        </div>

        <dl className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-950/60 p-3 text-xs">
          <div className="space-y-0.5">
            <dt className="text-[11px] font-medium text-neutral-400">{strings.v3ConsentPlugin}</dt>
            <dd className="break-words font-medium text-neutral-100">
              {request.pluginName}{' '}
              <code className="font-mono text-[10px] text-neutral-400">({request.pluginId})</code>
            </dd>
          </div>
          <div className="space-y-0.5">
            <dt className="text-[11px] font-medium text-neutral-400">{strings.v3ConsentTarget}</dt>
            <dd className="break-all font-mono text-[11px] text-cyan-200">{request.targetSummary}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-[11px] font-medium text-neutral-400">{strings.v3ConsentDetail}</dt>
            <dd className="space-y-1">
              {request.detailLines.map((line, idx) => (
                <div
                  key={idx}
                  className="break-all rounded bg-neutral-900/90 px-2 py-1 font-mono text-[11px] text-neutral-300"
                >
                  {line}
                </div>
              ))}
            </dd>
          </div>
        </dl>
      </div>
    </AtelierModal>
  );
}
