import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  FolderOpen,
  OctagonX,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Terminal,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { getPluginLabels } from '../plugins/pluginLabels';
import {
  checkV3RuntimePolicy,
  getDesktopPluginV3,
  killAllPluginV3Bridges,
  setV3McpServerRunningHint,
  type McpServerStatusView,
  type TrustedBridgeToolProfileView,
  type TrustedMcpClientProfileView,
} from '../plugins/pluginV3Client';
import { AtelierModal, modalButton } from './AtelierModal';

type TabKey = 'tools' | 'mcp-server' | 'mcp-clients';

export function PluginV3BridgeModal({
  isCollaborativeRoom,
  onClose,
  onNotice,
}: {
  isCollaborativeRoom: boolean;
  onClose: () => void;
  onNotice?: (message: string) => void;
}) {
  const { language } = useI18n();
  const strings = getPluginLabels(language);
  const policy = checkV3RuntimePolicy(isCollaborativeRoom, true);
  const desktop = getDesktopPluginV3();

  const [tab, setTab] = useState<TabKey>('tools');
  const [tools, setTools] = useState<TrustedBridgeToolProfileView[]>([]);
  const [mcpClients, setMcpClients] = useState<TrustedMcpClientProfileView[]>([]);
  const [mcpStatus, setMcpStatus] = useState<McpServerStatusView | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  // New tool profile form state
  const [toolId, setToolId] = useState('');
  const [toolLabel, setToolLabel] = useState('');
  const [toolExe, setToolExe] = useState('');
  const [toolSha, setToolSha] = useState('');
  const [toolArgs, setToolArgs] = useState('{{arg:message}}');

  // New MCP client profile form state
  const [clientId, setClientId] = useState('');
  const [clientLabel, setClientLabel] = useState('');
  const [clientUrl, setClientUrl] = useState('http://127.0.0.1:');
  const [clientToken, setClientToken] = useState('');

  const refresh = useCallback(async () => {
    if (!desktop) return;
    try {
      const [profiles, status] = await Promise.all([
        desktop.listProfiles(),
        desktop.mcpServer.getStatus(),
      ]);
      setTools(profiles.tools);
      setMcpClients(profiles.mcpClients);
      setMcpStatus(status);
      setV3McpServerRunningHint(Boolean(status?.running));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [desktop]);

  useEffect(() => {
    if (desktop) void refresh();
  }, [desktop, refresh]);

  const handlePickExe = async () => {
    if (!desktop) return;
    setError('');
    const picked = await desktop.pickExecutable();
    if (picked.error) {
      setError(picked.error);
      return;
    }
    if (!picked.canceled && picked.executablePath) {
      setToolExe(picked.executablePath);
      setToolSha(picked.sha256 ?? '');
    }
  };

  const handleSaveTool = async () => {
    if (!desktop) return;
    setError('');
    try {
      const argTemplate = toolArgs
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      await desktop.saveToolProfile({
        id: toolId.trim(),
        label: toolLabel.trim() || toolId.trim(),
        executablePath: toolExe.trim(),
        argTemplate,
      });
      setToolId('');
      setToolLabel('');
      setToolExe('');
      setToolSha('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveMcpClient = async () => {
    if (!desktop) return;
    setError('');
    try {
      await desktop.mcpClient.saveProfile({
        id: clientId.trim(),
        label: clientLabel.trim() || clientId.trim(),
        endpointUrl: clientUrl.trim(),
        ...(clientToken.trim() ? { bearerToken: clientToken.trim() } : {}),
      });
      setClientId('');
      setClientLabel('');
      setClientUrl('http://127.0.0.1:');
      setClientToken('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleKillAll = async () => {
    setError('');
    await killAllPluginV3Bridges();
    await refresh();
    onNotice?.(strings.v3KillAllDone);
  };

  const handleCopyMcpConfig = async () => {
    if (!mcpStatus?.endpointUrl || !mcpStatus.token) return;
    const snippet = JSON.stringify(
      {
        luminaDriftLocalMcp: {
          url: mcpStatus.endpointUrl,
          headers: { Authorization: `Bearer ${mcpStatus.token}` },
        },
      },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Clipboard unavailable.');
    }
  };

  const unavailableMessage =
    policy.reason === 'UNSUPPORTED_MOBILE'
      ? strings.v3MobileNotice
      : policy.reason === 'BLOCKED_COLLAB_ROOM'
        ? strings.v3CollabNotice
        : strings.v3WebNotice;

  return (
    <AtelierModal
      title={strings.v3ConsoleTitle}
      subtitle={strings.v3ConsoleSubtitle}
      icon={<Wrench className="text-amber-300" />}
      onClose={onClose}
      width="lg"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          {desktop ? (
            <button
              type="button"
              data-plugin-v3-kill-all="true"
              onClick={() => void handleKillAll()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/50 bg-rose-500/15 px-3 py-1.5 text-xs font-medium text-rose-200 transition-colors hover:bg-rose-500/25"
            >
              <OctagonX className="h-3.5 w-3.5 shrink-0" />
              <span>{strings.v3KillAll}</span>
            </button>
          ) : (
            <span className="text-[11px] text-neutral-500">{strings.v3DesktopOnly}</span>
          )}
          <button type="button" onClick={onClose} className={modalButton.secondary}>
            {strings.close}
          </button>
        </div>
      }
    >
      <div className="space-y-3" data-plugin-v3-console="true">
        {!policy.allowed && (
          <div
            data-plugin-v3-blocked={policy.reason}
            className="atelier-plugin-sweep rounded-xl border border-amber-500/40 bg-amber-950/20 p-3 text-xs text-amber-100"
          >
            <div className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden />
              <p className="min-w-0 break-words leading-relaxed">{unavailableMessage}</p>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="break-words rounded-lg border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-1.5 border-b border-neutral-800 pb-2">
          {(
            [
              { key: 'tools', label: strings.v3TabTools, icon: <Terminal className="h-3.5 w-3.5" /> },
              { key: 'mcp-server', label: strings.v3TabMcpServer, icon: <Server className="h-3.5 w-3.5" /> },
              { key: 'mcp-clients', label: strings.v3TabMcpClients, icon: <Plus className="h-3.5 w-3.5" /> },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              data-plugin-v3-tab={item.key}
              onClick={() => setTab(item.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                tab === item.key
                  ? 'border border-cyan-500/45 bg-cyan-500/15 text-cyan-200'
                  : 'border border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        {tab === 'tools' && (
          <div className="space-y-3">
            {desktop && policy.allowed && (
              <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-950/60 p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="space-y-1 text-[11px] text-neutral-400">
                    <span>{strings.v3ToolId}</span>
                    <input
                      type="text"
                      value={toolId}
                      onChange={(e) => setToolId(e.target.value)}
                      placeholder="echo-helper"
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:border-cyan-500"
                    />
                  </label>
                  <label className="space-y-1 text-[11px] text-neutral-400">
                    <span>{strings.v3ToolLabel}</span>
                    <input
                      type="text"
                      value={toolLabel}
                      onChange={(e) => setToolLabel(e.target.value)}
                      placeholder="Local Helper"
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:border-cyan-500"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => void handlePickExe()} className={modalButton.secondary}>
                    <FolderOpen />
                    <span>{strings.v3AddTool}</span>
                  </button>
                  {toolExe && (
                    <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-cyan-200">
                      {toolExe}
                    </span>
                  )}
                </div>
                {toolSha && (
                  <p className="break-all font-mono text-[10px] text-neutral-400">
                    {strings.v3ToolHash}: {toolSha}
                  </p>
                )}
                <label className="block space-y-1 text-[11px] text-neutral-400">
                  <span>{strings.v3ToolArgs}</span>
                  <textarea
                    rows={2}
                    value={toolArgs}
                    onChange={(e) => setToolArgs(e.target.value)}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono text-[11px] text-neutral-100 outline-none focus:border-cyan-500"
                  />
                </label>
                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={!toolId.trim() || !toolExe.trim()}
                    onClick={() => void handleSaveTool()}
                    className={modalButton.primary}
                  >
                    {strings.v3SaveProfile}
                  </button>
                </div>
              </div>
            )}

            {tools.length === 0 ? (
              <p className="py-2 text-xs text-neutral-400">{strings.v3ToolEmpty}</p>
            ) : (
              <div className="space-y-2">
                {tools.map((profile) => (
                  <div
                    key={profile.id}
                    className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-neutral-800 bg-neutral-900/60 p-2.5 text-xs"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-neutral-100">{profile.label}</span>
                        <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300">
                          {profile.id}
                        </code>
                      </div>
                      <p className="break-all font-mono text-[10px] text-neutral-400">
                        {strings.v3ToolExe}: {profile.executablePath}
                      </p>
                      <p className="break-all font-mono text-[10px] text-neutral-500">
                        {strings.v3ToolHash}: {profile.sha256.slice(0, 24)}…
                      </p>
                    </div>
                    {desktop && (
                      <button
                        type="button"
                        onClick={() => {
                          void desktop.removeToolProfile(profile.id).then(() => refresh());
                        }}
                        className={modalButton.secondary}
                        title={strings.remove}
                      >
                        <Trash2 />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'mcp-server' && (
          <div className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-950/60 p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    mcpStatus?.running ? 'bg-emerald-400' : 'bg-neutral-500'
                  }`}
                />
                <span className="font-medium text-neutral-100">
                  {mcpStatus?.running ? strings.v3ServerStatusOn : strings.v3ServerStatusOff}
                </span>
              </div>
              {desktop && policy.allowed && (
                <button
                  type="button"
                  data-plugin-v3-mcp-toggle="true"
                  onClick={() => {
                    setError('');
                    const task = mcpStatus?.running
                      ? desktop.mcpServer.stop()
                      : desktop.mcpServer.start({ allowWrite: false });
                    void task.then((st) => {
                      setMcpStatus(st);
                      setV3McpServerRunningHint(Boolean(st?.running));
                    }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
                  }}
                  className={mcpStatus?.running ? modalButton.secondary : modalButton.primary}
                >
                  {mcpStatus?.running ? strings.v3ServerStop : strings.v3ServerStart}
                </button>
              )}
            </div>

            <p className="text-[11px] text-neutral-400">{strings.v3ServerReadOnlyNote}</p>

            {desktop && policy.allowed && mcpStatus?.running && (
              <div className="space-y-2.5 border-t border-neutral-800 pt-2.5">
                <label className="flex items-center gap-2 text-xs text-neutral-200">
                  <input
                    type="checkbox"
                    checked={mcpStatus.allowWrite}
                    onChange={(e) => {
                      void desktop.mcpServer.setAllowWrite(e.target.checked).then((st) => setMcpStatus(st));
                    }}
                    className="h-3.5 w-3.5 accent-amber-400"
                  />
                  <span>{strings.v3ServerAllowWrite}</span>
                </label>

                <div className="space-y-1">
                  <span className="text-[11px] text-neutral-400">{strings.v3ServerEndpoint}</span>
                  <div className="break-all rounded-lg bg-neutral-900 px-2.5 py-1.5 font-mono text-[11px] text-cyan-200">
                    {mcpStatus.endpointUrl}
                  </div>
                </div>

                <div className="space-y-1">
                  <span className="text-[11px] text-neutral-400">{strings.v3ServerToken}</span>
                  <div className="break-all rounded-lg bg-neutral-900 px-2.5 py-1.5 font-mono text-[11px] text-amber-200">
                    {mcpStatus.token ? `${mcpStatus.token.slice(0, 12)}••••••••••••` : '—'}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyMcpConfig()}
                    className={modalButton.secondary}
                  >
                    {copied ? <Check /> : <Copy />}
                    <span>{copied ? strings.v3ServerCopied : strings.v3ServerCopyConfig}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void desktop.mcpServer.rotateToken().then((st) => setMcpStatus(st));
                    }}
                    className={modalButton.secondary}
                  >
                    <RefreshCw />
                    <span>{strings.v3ServerRotateToken}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'mcp-clients' && (
          <div className="space-y-3">
            {desktop && policy.allowed && (
              <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-950/60 p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="space-y-1 text-[11px] text-neutral-400">
                    <span>{strings.v3McpClientId}</span>
                    <input
                      type="text"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      placeholder="local-helper"
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:border-cyan-500"
                    />
                  </label>
                  <label className="space-y-1 text-[11px] text-neutral-400">
                    <span>{strings.v3ToolLabel}</span>
                    <input
                      type="text"
                      value={clientLabel}
                      onChange={(e) => setClientLabel(e.target.value)}
                      placeholder="Local MCP"
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:border-cyan-500"
                    />
                  </label>
                </div>
                <label className="block space-y-1 text-[11px] text-neutral-400">
                  <span>{strings.v3McpClientUrl}</span>
                  <input
                    type="text"
                    value={clientUrl}
                    onChange={(e) => setClientUrl(e.target.value)}
                    placeholder="http://127.0.0.1:4123/mcp"
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono text-xs text-neutral-100 outline-none focus:border-cyan-500"
                  />
                </label>
                <label className="block space-y-1 text-[11px] text-neutral-400">
                  <span>{strings.v3McpClientToken}</span>
                  <input
                    type="password"
                    value={clientToken}
                    onChange={(e) => setClientToken(e.target.value)}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono text-xs text-neutral-100 outline-none focus:border-cyan-500"
                  />
                </label>
                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={!clientId.trim() || !clientUrl.trim()}
                    onClick={() => void handleSaveMcpClient()}
                    className={modalButton.primary}
                  >
                    {strings.v3AddMcpClient}
                  </button>
                </div>
              </div>
            )}

            {mcpClients.length === 0 ? (
              <p className="py-2 text-xs text-neutral-400">{strings.v3McpClientEmpty}</p>
            ) : (
              <div className="space-y-2">
                {mcpClients.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-neutral-800 bg-neutral-900/60 p-2.5 text-xs"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-neutral-100">{entry.label}</span>
                        <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300">
                          {entry.id}
                        </code>
                      </div>
                      <p className="break-all font-mono text-[10px] text-neutral-400">{entry.endpointUrl}</p>
                    </div>
                    {desktop && (
                      <button
                        type="button"
                        onClick={() => {
                          void desktop.mcpClient.removeProfile(entry.id).then(() => refresh());
                        }}
                        className={modalButton.secondary}
                        title={strings.remove}
                      >
                        <Trash2 />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </AtelierModal>
  );
}
