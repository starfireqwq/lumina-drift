import { useRef, useState } from 'react';
import { Download, Puzzle, Upload } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { MAX_PLUGIN_BYTES, parsePlugin, type PluginManifest } from '../plugins/pluginApi';
import { getPluginLabels } from '../plugins/pluginLabels';
import { installPlugin, removePlugin, setPluginEnabled, type InstalledPlugin } from '../plugins/pluginStore';
import { AtelierModal, modalButton } from './AtelierModal';

export function PluginManager({ plugins, onClose }: { plugins: InstalledPlugin[]; onClose: () => void }) {
  const { language } = useI18n();
  const strings = getPluginLabels(language);
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PluginManifest | null>(null);
  const [error, setError] = useState('');
  const replacing = Boolean(pending && plugins.some(plugin => plugin.manifest.id === pending.id));

  const importFile = async (file: File) => {
    setError('');
    setPending(null);
    try {
      if (file.size > MAX_PLUGIN_BYTES) throw new Error(`Maximum package size: ${Math.round(MAX_PLUGIN_BYTES / 1024)} KiB.`);
      setPending(parsePlugin(JSON.parse(await file.text())));
    } catch (cause) {
      setError(`${strings.invalid} ${cause instanceof Error ? cause.message : ''}`);
    }
  };

  const change = (action: () => void) => {
    setError('');
    try {
      action();
    } catch (cause) {
      setError(`${strings.failed} ${cause instanceof Error ? cause.message : ''}`);
    }
  };

  const permissionList = (manifest: PluginManifest) => (
    <p className="break-words text-neutral-400">
      {manifest.permissions.length
        ? <><span className="font-medium text-neutral-300">{strings.scope} · </span>{manifest.permissions.map(permission => strings[permission]).join(' · ')}</>
        : strings.noPermissions}
    </p>
  );

  return (
    <AtelierModal title={strings.manage.replace(/…$/, '')} icon={<Puzzle />} onClose={onClose} width="lg"
      footer={<button type="button" onClick={onClose} className={modalButton.secondary}>{strings.close}</button>}>
      <div className="space-y-3">
        <input ref={input} type="file" hidden accept=".lumina-plugin,.json,application/json" onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void importFile(file);
        }} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={modalButton.primary} onClick={() => input.current?.click()}>
            <Upload />{strings.import}
          </button>
          <a href={`${import.meta.env.BASE_URL}plugins/studio-tools.lumina-plugin`} download className={modalButton.secondary}>
            <Download />{strings.sample}
          </a>
        </div>
        {error && <p role="alert" className="break-words text-rose-300">{error}</p>}
        {pending && <section className="space-y-2 rounded-lg border border-indigo-500/60 p-3">
          <p className="break-words font-semibold text-neutral-100">{pending.name} · {pending.version} · {pending.author}</p>
          {pending.description && <p className="break-words text-neutral-300">{pending.description}</p>}
          {permissionList(pending)}
          <p className="text-neutral-400">{replacing ? strings.disabledReplace : strings.disabledInstall}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={modalButton.primary} onClick={() => change(() => {
              installPlugin(pending);
              setPending(null);
            })}>{replacing ? strings.replace : strings.install}</button>
            <button type="button" className={modalButton.secondary} onClick={() => setPending(null)}>{strings.cancel}</button>
          </div>
        </section>}
        {plugins.length === 0 && !pending && <p className="py-3 text-neutral-400">{strings.empty}</p>}
        {plugins.map(({ manifest, enabled }) => <section key={manifest.id} className="space-y-2 rounded-lg border border-neutral-700/70 p-3">
          <p className="break-words font-semibold text-neutral-100">{manifest.name} · {manifest.version} · {manifest.author}</p>
          {manifest.description && <p className="break-words text-neutral-300">{manifest.description}</p>}
          {permissionList(manifest)}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={enabled ? modalButton.secondary : modalButton.primary}
              onClick={() => change(() => setPluginEnabled(manifest.id, !enabled))}>
              {enabled ? strings.deactivate : strings.activate}
            </button>
            <button type="button" className={modalButton.secondary} onClick={() => change(() => removePlugin(manifest.id))}>{strings.remove}</button>
          </div>
        </section>)}
      </div>
    </AtelierModal>
  );
}
