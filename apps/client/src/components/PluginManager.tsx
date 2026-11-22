import { useRef, useState } from 'react';
import {
  Download,
  LayoutPanelLeft,
  Puzzle,
  Server,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Upload,
  Wrench,
} from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import {
  MAX_PLUGIN_BYTES,
  PLUGIN_LIMITS,
  hasV3Permissions,
  isModernPluginManifest,
  isV3HighRiskPermission,
  parsePlugin,
  resolvePluginDescription,
  resolvePluginName,
  resolvePluginText,
  type PluginManifest,
} from '../plugins/pluginApi';
import { getPluginLabels, getPluginPermissionLabel } from '../plugins/pluginLabels';
import { installPlugin, removePlugin, setPluginEnabled, type InstalledPlugin } from '../plugins/pluginStore';
import { checkV3RuntimePolicy } from '../plugins/pluginV3Client';
import { AtelierModal, modalButton } from './AtelierModal';

export function PluginManager({
  plugins,
  isCollaborativeRoom = false,
  onOpenV3Console,
  onClose,
}: {
  plugins: InstalledPlugin[];
  isCollaborativeRoom?: boolean;
  onOpenV3Console?: () => void;
  onClose: () => void;
}) {
  const { language } = useI18n();
  const strings = getPluginLabels(language);
  const v3Policy = checkV3RuntimePolicy(isCollaborativeRoom, true);
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PluginManifest | null>(null);
  const [error, setError] = useState('');
  const replacing = Boolean(pending && plugins.some((plugin) => plugin.manifest.id === pending.id));

  const importFile = async (file: File) => {
    setError('');
    setPending(null);
    try {
      if (file.size > MAX_PLUGIN_BYTES) {
        throw new Error(`Maximum package size: ${Math.round(MAX_PLUGIN_BYTES / 1024)} KiB.`);
      }
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

  const renderPermissions = (manifest: PluginManifest) => {
    if (!manifest.permissions.length) {
      return <p className="text-[11px] text-neutral-400">{strings.noPermissions}</p>;
    }
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1 text-[11px] font-medium text-neutral-300">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-cyan-300/80" aria-hidden />
          <span>{strings.scope}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {manifest.permissions.map((permission) => {
            const detail = getPluginPermissionLabel(language, permission);
            const highRisk = isV3HighRiskPermission(permission);
            return (
              <span
                key={permission}
                title={detail}
                data-plugin-perm={permission}
                data-plugin-high-risk={highRisk ? 'true' : undefined}
                className={`inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${
                  highRisk
                    ? 'border-amber-500/50 bg-amber-950/35 text-amber-100'
                    : 'border-neutral-700/80 bg-neutral-900/80 text-neutral-200'
                }`}
              >
                {highRisk && <ShieldAlert className="h-3 w-3 shrink-0 text-amber-300" aria-hidden />}
                <code className={`font-mono text-[10px] ${highRisk ? 'text-amber-300' : 'text-cyan-300'}`}>
                  {permission}
                </code>
                <span className={`truncate ${highRisk ? 'text-amber-200/80' : 'text-neutral-400'}`}>· {detail}</span>
              </span>
            );
          })}
        </div>
      </div>
    );
  };

  const renderContributions = (manifest: PluginManifest) => {
    const commandNames = manifest.commands.map((c) =>
      'i18nLabel' in c ? resolvePluginText(c.label, c.i18nLabel, language) : c.label,
    );
    const filterNames = isModernPluginManifest(manifest)
      ? manifest.filters.map((f) => resolvePluginText(f.label, f.i18nLabel, language))
      : [];
    const panelNames = isModernPluginManifest(manifest)
      ? manifest.panels.map((p) => resolvePluginText(p.title, p.i18nTitle, language))
      : [];
    const toolNames = isModernPluginManifest(manifest)
      ? (manifest.tools ?? []).map((t) => resolvePluginText(t.label, t.i18nLabel, language))
      : [];
    const bridgeNames = manifest.apiVersion === 3
      ? (manifest.bridgeTools ?? []).map((b) => resolvePluginText(b.label, b.i18nLabel, language))
      : [];
    const mcpNames = manifest.apiVersion === 3
      ? (manifest.mcpClients ?? []).map((m) => resolvePluginText(m.label, m.i18nLabel, language))
      : [];

    if (
      !commandNames.length &&
      !filterNames.length &&
      !panelNames.length &&
      !toolNames.length &&
      !bridgeNames.length &&
      !mcpNames.length
    ) return null;

    return (
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[11px]">
        <span className="font-medium text-neutral-400">{strings.contributions}:</span>
        {commandNames.length > 0 && (
          <span
            title={commandNames.join(', ')}
            className="inline-flex items-center gap-1 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-indigo-200"
          >
            <Terminal className="h-3 w-3 shrink-0" aria-hidden />
            <span>{strings.commandsBadge} {commandNames.length}</span>
          </span>
        )}
        {filterNames.length > 0 && (
          <span
            title={filterNames.join(', ')}
            className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-cyan-200"
          >
            <SlidersHorizontal className="h-3 w-3 shrink-0" aria-hidden />
            <span>{strings.filtersBadge} {filterNames.length}</span>
          </span>
        )}
        {panelNames.length > 0 && (
          <span
            title={panelNames.join(', ')}
            className="inline-flex items-center gap-1 rounded-md border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 py-0.5 text-fuchsia-200"
          >
            <LayoutPanelLeft className="h-3 w-3 shrink-0" aria-hidden />
            <span>{strings.panelsBadge} {panelNames.length}</span>
          </span>
        )}
        {toolNames.length > 0 && (
          <span
            title={toolNames.join(', ')}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-200"
          >
            <Sparkles className="h-3 w-3 shrink-0" aria-hidden />
            <span>{strings.toolsBadge} {toolNames.length}</span>
          </span>
        )}
        {bridgeNames.length > 0 && (
          <span
            title={bridgeNames.join(', ')}
            className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-200"
          >
            <Wrench className="h-3 w-3 shrink-0" aria-hidden />
            <span>{strings.v3BridgeBadge} {bridgeNames.length}</span>
          </span>
        )}
        {mcpNames.length > 0 && (
          <span
            title={mcpNames.join(', ')}
            className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-200"
          >
            <Server className="h-3 w-3 shrink-0" aria-hidden />
            <span>{strings.v3McpBadge} {mcpNames.length}</span>
          </span>
        )}
      </div>
    );
  };

  const renderCardHeader = (manifest: PluginManifest, enabled?: boolean) => (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="break-words font-semibold text-neutral-100">
            {resolvePluginName(manifest, language)}
          </span>
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">
            v{manifest.version}
          </span>
          <span
            data-plugin-api-version={manifest.apiVersion}
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
              manifest.apiVersion === 3
                ? 'border border-amber-500/50 bg-amber-500/15 text-amber-200'
                : manifest.apiVersion === 2
                  ? 'border border-cyan-500/40 bg-cyan-500/15 text-cyan-200'
                  : 'border border-neutral-700 bg-neutral-800 text-neutral-300'
            }`}
          >
            {strings.apiVersionBadge}{manifest.apiVersion}
          </span>
          {hasV3Permissions(manifest) && (
            <span
              data-plugin-v3-risk-tag="true"
              className="rounded border border-amber-500/45 bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-200"
            >
              {!v3Policy.allowed
                ? (v3Policy.reason === 'BLOCKED_COLLAB_ROOM' ? strings.v3CollabLocked : strings.v3DesktopOnly)
                : strings.v3HighRiskBadge}
            </span>
          )}
        </div>
        <p className="mt-0.5 break-words text-[11px] text-neutral-400">
          {manifest.author} · <code className="font-mono text-[10px] text-neutral-500">{manifest.id}</code>
        </p>
      </div>
      {enabled !== undefined && (
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
            enabled
              ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
              : 'border border-neutral-700 bg-neutral-800/80 text-neutral-400'
          }`}
        >
          {enabled ? strings.activate : strings.deactivate}
        </span>
      )}
    </div>
  );

  return (
    <AtelierModal
      title={strings.manage.replace(/…$/, '')}
      icon={<Puzzle />}
      onClose={onClose}
      width="lg"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-neutral-500">
            {plugins.length} / {PLUGIN_LIMITS.maxInstalledPlugins}
          </span>
          <button type="button" onClick={onClose} className={modalButton.secondary}>
            {strings.close}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <input
          ref={input}
          type="file"
          hidden
          accept=".lumina-plugin,.json,application/json"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importFile(file);
          }}
        />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={modalButton.primary} onClick={() => input.current?.click()}>
            <Upload />{strings.import}
          </button>
          {onOpenV3Console && (
            <button
              type="button"
              data-plugin-open-v3-console="true"
              className={modalButton.secondary}
              onClick={onOpenV3Console}
            >
              <Wrench />{strings.v3OpenConsole}
            </button>
          )}
          <a
            href={`${import.meta.env.BASE_URL}plugins/lumina-v3-bridge-demo.lumina-plugin`}
            download
            className={modalButton.secondary}
          >
            <Download />{strings.sampleV3}
          </a>
          <a
            href={`${import.meta.env.BASE_URL}plugins/lumina-motion-atelier.lumina-plugin`}
            download
            className={modalButton.secondary}
          >
            <Download />{strings.sampleV25}
          </a>
          <a
            href={`${import.meta.env.BASE_URL}plugins/lumina-drift-studio-kit.lumina-plugin`}
            download
            className={modalButton.secondary}
          >
            <Download />{strings.sampleV2}
          </a>
          <a
            href={`${import.meta.env.BASE_URL}plugins/studio-tools.lumina-plugin`}
            download
            className={modalButton.secondary}
          >
            <Download />{strings.sample}
          </a>
        </div>
        {error && <p role="alert" className="break-words text-rose-300">{error}</p>}
        {pending && (
          <section className="atelier-plugin-sweep space-y-2.5 rounded-xl border border-indigo-500/60 bg-indigo-950/15 p-3">
            {renderCardHeader(pending)}
            {resolvePluginDescription(pending, language) && (
              <p className="break-words text-xs text-neutral-300">{resolvePluginDescription(pending, language)}</p>
            )}
            {renderContributions(pending)}
            {renderPermissions(pending)}
            <p className="text-[11px] text-neutral-400">
              {replacing ? strings.disabledReplace : strings.disabledInstall}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={modalButton.primary}
                onClick={() =>
                  change(() => {
                    installPlugin(pending);
                    setPending(null);
                  })
                }
              >
                {replacing ? strings.replace : strings.install}
              </button>
              <button type="button" className={modalButton.secondary} onClick={() => setPending(null)}>
                {strings.cancel}
              </button>
            </div>
          </section>
        )}
        {plugins.length === 0 && !pending && <p className="py-3 text-neutral-400">{strings.empty}</p>}
        {plugins.map(({ manifest, enabled }) => (
          <section
            key={manifest.id}
            data-plugin-card={manifest.id}
            className={`atelier-plugin-sweep space-y-2.5 rounded-xl border p-3 transition-colors ${
              enabled
                ? 'border-cyan-500/40 bg-neutral-900/75'
                : 'border-neutral-700/70 bg-neutral-900/45'
            }`}
          >
            {renderCardHeader(manifest, enabled)}
            {resolvePluginDescription(manifest, language) && (
              <p className="break-words text-xs text-neutral-300">{resolvePluginDescription(manifest, language)}</p>
            )}
            {renderContributions(manifest)}
            {renderPermissions(manifest)}
            <div className="flex flex-wrap gap-2 pt-0.5">
              <button
                type="button"
                data-plugin-toggle={manifest.id}
                className={enabled ? modalButton.secondary : modalButton.primary}
                onClick={() => change(() => setPluginEnabled(manifest.id, !enabled))}
              >
                {enabled ? strings.deactivate : strings.activate}
              </button>
              <button
                type="button"
                data-plugin-remove={manifest.id}
                className={modalButton.secondary}
                onClick={() => change(() => removePlugin(manifest.id))}
              >
                {strings.remove}
              </button>
            </div>
          </section>
        ))}
      </div>
    </AtelierModal>
  );
}
