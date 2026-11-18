import React, { useEffect, useRef, useState } from 'react';
import {
  CanvasModel,
  LayerModel,
  AtelierSyncCapsuleData,
  CapsuleContent,
} from '@atelier/shared';
import {
  TimeCapsuleEngine,
  ColdBackupEntry,
} from '../engine/TimeCapsuleEngine';
import type { LayerCanvasItem } from '../engine/layerComposite';
import { useSocketTelemetry } from '../context/SocketContext';
import { useI18n } from '../context/I18nContext';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock,
  Download,
  HardDrive,
  Key,
  Layers,
  Lock,
  Network,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';

interface TimeCapsuleModalProps {
  isOpen: boolean;
  onClose: () => void;
  canvas: CanvasModel | null;
  layers: LayerModel[];
  getLayerCanvases: (() => Promise<LayerCanvasItem[]>) | null;
  /** Rebuilds the capsule (as a new canvas); progress is shown while it runs */
  onRestoreCanvas?: (content: CapsuleContent, onProgress: (done: number, total: number) => void, preserveAuthors: boolean) => void | Promise<void>;
}

export const TimeCapsuleModal: React.FC<TimeCapsuleModalProps> = ({
  isOpen,
  onClose,
  canvas,
  layers,
  getLayerCanvases,
  onRestoreCanvas,
}) => {
  const { t } = useI18n();
  const { p2pStats, totalCanvasStrokes, personalStrokes, painterLevel } = useSocketTelemetry();

  const [activeTab, setActiveTab] = useState<'capsule' | 'coldBackup' | 'p2p'>('capsule');

  // Encryption state
  const [encryptPassword, setEncryptPassword] = useState<string>('');
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportSuccessMsg, setExportSuccessMsg] = useState<string | null>(null);

  // Import / Recovery state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [decryptPassword, setDecryptPassword] = useState<string>('');
  const [pendingEncryptedFile, setPendingEncryptedFile] = useState<AtelierSyncCapsuleData | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoverySuccess, setRecoverySuccess] = useState<string | null>(null);
  const [isRecovering, setIsRecovering] = useState<boolean>(false);
  const [preserveAuthors, setPreserveAuthors] = useState(false);

  // Cold backup state
  const [coldBackups, setColdBackups] = useState<ColdBackupEntry[]>([]);
  const [backupInterval, setBackupInterval] = useState<number>(15); // default 15m
  const [isBackingUp, setIsBackingUp] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen && canvas) {
      loadBackups();
    }
  }, [isOpen, canvas?.id]);

  // Handle ESC key to dismiss modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const loadBackups = async () => {
    if (!canvas) return;
    try {
      const list = await TimeCapsuleEngine.listColdBackups(canvas.id);
      setColdBackups(list);
    } catch (err) {
      console.warn('Failed to load cold backups:', err);
    }
  };

  // Setup auto-backup interval
  useEffect(() => {
    if (!canvas || !getLayerCanvases) return;
    TimeCapsuleEngine.configureAutoBackup(backupInterval, async () => {
      await TimeCapsuleEngine.saveColdBackup(
        canvas,
        layers,
        getLayerCanvases,
        totalCanvasStrokes || personalStrokes
      );
      loadBackups();
    });
  }, [canvas?.id, layers, backupInterval, totalCanvasStrokes, personalStrokes]);

  if (!isOpen || !canvas) return null;

  // Handle Export Capsule
  const handleExportCapsule = async () => {
    if (!getLayerCanvases) return;
    setIsExporting(true);
    setExportSuccessMsg(null);
    setRecoveryError(null);

    try {
      const { capsule, filename } = await TimeCapsuleEngine.createCapsule(
        canvas,
        layers,
        getLayerCanvases,
        totalCanvasStrokes || personalStrokes,
        encryptPassword.trim() || undefined
      );

      TimeCapsuleEngine.downloadCapsuleFile(capsule, filename);
      setExportSuccessMsg(`✅ 成功打包並匯出畫布時光膠囊 (${filename})！`);
    } catch (err: any) {
      setRecoveryError(`打包失敗: ${err.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  // Handle Manual Cold Backup
  const handleCreateColdBackup = async () => {
    if (!getLayerCanvases) return;
    setIsBackingUp(true);
    try {
      await TimeCapsuleEngine.saveColdBackup(
        canvas,
        layers,
        getLayerCanvases,
        totalCanvasStrokes || personalStrokes,
        encryptPassword.trim() || undefined
      );
      await loadBackups();
      setExportSuccessMsg('✅ 本機冷備份建立成功！已妥善保存於 IndexedDB 離線資料庫。');
    } catch (err: any) {
      setRecoveryError(`冷備份建立失敗: ${err.message}`);
    } finally {
      setIsBackingUp(false);
    }
  };

  // Delete Cold Backup
  const handleDeleteColdBackup = async (id: string) => {
    await TimeCapsuleEngine.deleteColdBackup(id);
    await loadBackups();
  };

  // Handle File Upload for Disaster Recovery
  const handleCapsuleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setRecoveryError(null);
    setRecoverySuccess(null);
    setIsRecovering(true);

    try {
      const text = await file.text();
      const capsuleData: AtelierSyncCapsuleData = JSON.parse(text);

      if ('isEncrypted' in capsuleData && capsuleData.isEncrypted) {
        setPendingEncryptedFile(capsuleData);
        setIsRecovering(false);
        return;
      }

      // Plaintext capsule: restore directly
      await executeDisasterRecovery(capsuleData);
    } catch (err: any) {
      setRecoveryError(`膠囊解析失敗: ${err.message}`);
      setIsRecovering(false);
    } finally {
      e.target.value = '';
    }
  };

  // Execute Disaster Recovery
  const executeDisasterRecovery = async (
    capsuleData: AtelierSyncCapsuleData,
    passphrase?: string
  ) => {
    setIsRecovering(true);
    setRecoveryError(null);

    try {
      const content = await TimeCapsuleEngine.restoreFromCapsule(capsuleData, passphrase);

      if (onRestoreCanvas) {
        await onRestoreCanvas(content, (done, total) => setRecoverySuccess(`重建畫布中… ${done} / ${total}`), preserveAuthors);
      }

      setRecoverySuccess(
        `🎉 已把「${content.manifest.canvas.title}」重建成新畫布：${content.manifest.layers.length} 個圖層（含蒙版、圖層組、動畫格）與像素都已還原。`
      );
      setPendingEncryptedFile(null);
      setDecryptPassword('');
    } catch (err: any) {
      setRecoveryError(err.message);
    } finally {
      setIsRecovering(false);
    }
  };

  return (
    <div
      role="dialog" aria-modal="true" className="atelier-modal-backdrop fixed inset-0 z-[70] flex items-center justify-center p-2 sm:p-4 select-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="atelier-modal w-full max-w-2xl max-h-[92vh] md:max-h-[85vh] overflow-hidden flex flex-col text-neutral-200 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-4 py-3 sm:px-5 sm:py-4 border-b border-neutral-800 flex items-center justify-between shrink-0 bg-neutral-950 z-10">
          <div className="flex items-center gap-2.5 min-w-0 pr-2">
            <div className="p-2 rounded-xl bg-indigo-950/60 border border-indigo-800/80 shrink-0">
              <Archive className="w-5 h-5 text-indigo-400" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-bold text-white flex flex-wrap items-center gap-1.5 sm:gap-2">
                <span>{t.capsule.title}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800 font-mono">
                  BitTorrent / WebRTC Mesh
                </span>
              </h2>
              <p className="text-[11px] text-neutral-400 truncate">
                {t.capsule.subtitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl bg-neutral-800/80 hover:bg-rose-900/60 hover:text-rose-200 text-neutral-300 transition shrink-0 flex items-center justify-center border border-neutral-700/60 shadow-sm"
            title={t.common.close}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Tabs - Responsive Scrollable Row */}
        <div className="flex flex-nowrap px-2 sm:px-5 pt-2.5 border-b border-neutral-800 gap-1 sm:gap-2 bg-neutral-900/60 text-xs font-medium overflow-x-auto no-scrollbar shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('capsule')}
            className={`pb-2.5 px-2.5 sm:px-3 border-b-2 flex items-center gap-1.5 transition shrink-0 whitespace-nowrap ${
              activeTab === 'capsule'
                ? 'border-indigo-500 text-white font-semibold'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Archive className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
            <span className="whitespace-nowrap">{t.capsule.tabCapsule}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('coldBackup')}
            className={`pb-2.5 px-2.5 sm:px-3 border-b-2 flex items-center gap-1.5 transition shrink-0 whitespace-nowrap ${
              activeTab === 'coldBackup'
                ? 'border-indigo-500 text-white font-semibold'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span className="whitespace-nowrap">{t.capsule.tabColdBackup}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('p2p')}
            className={`pb-2.5 px-2.5 sm:px-3 border-b-2 flex items-center gap-1.5 transition shrink-0 whitespace-nowrap ${
              activeTab === 'p2p'
                ? 'border-indigo-500 text-white font-semibold'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Network className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span className="whitespace-nowrap">{t.capsule.tabP2p}</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="p-4 sm:p-5 flex-1 overflow-y-auto space-y-4 text-xs">
          {activeTab !== 'p2p' && (
            <label className="flex items-center gap-2 text-neutral-200">
              <input type="checkbox" checked={preserveAuthors} disabled={isRecovering} onChange={(e) => setPreserveAuthors(e.target.checked)} />
              {t.capsule.preserveAuthors}
            </label>
          )}
          {/* Alerts */}
          {exportSuccessMsg && (
            <div className="p-3 rounded-lg bg-emerald-950/60 border border-emerald-800/80 text-emerald-300 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{exportSuccessMsg}</span>
            </div>
          )}

          {recoverySuccess && (
            <div className="p-3 rounded-lg bg-emerald-950/60 border border-emerald-800/80 text-emerald-300 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{recoverySuccess}</span>
            </div>
          )}

          {recoveryError && (
            <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-rose-300 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{recoveryError}</span>
            </div>
          )}

          {/* TAB 1: Capsule Export & File Import */}
          {activeTab === 'capsule' && (
            <div className="space-y-4">
              {/* Packaging Section */}
              <div className="p-4 rounded-xl bg-neutral-900/80 border border-neutral-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-white text-sm flex items-center gap-1.5">
                    <Download className="w-4 h-4 text-indigo-400" />
                    <span>{t.capsule.exportCapsule}</span>
                  </div>
                </div>

                <p className="text-[11px] text-neutral-400 leading-relaxed">
                  {t.capsule.exportCapsuleDesc}
                </p>

                {/* Password Protection */}
                <div className="space-y-1.5">
                  <label className="text-[11px] text-neutral-300 font-medium flex items-center gap-1">
                    <Lock className="w-3 h-3 text-indigo-400" />
                    <span>{t.capsule.encryptPassword}</span>
                  </label>
                  <input
                    type="password"
                    placeholder={t.auth.password}
                    value={encryptPassword}
                    onChange={(e) => setEncryptPassword(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleExportCapsule}
                  disabled={isExporting}
                  className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 transition disabled:opacity-50"
                >
                  <Download className="w-4 h-4" />
                  <span>{isExporting ? t.common.processing : t.capsule.exportButton}</span>
                </button>
              </div>

              {/* Import & Disaster Recovery Section */}
              <div className="p-4 rounded-xl bg-neutral-900/80 border border-neutral-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-white text-sm flex items-center gap-1.5">
                    <Upload className="w-4 h-4 text-emerald-400" />
                    <span>{t.capsule.importCapsule}</span>
                  </div>
                </div>

                <p className="text-[11px] text-neutral-400 leading-relaxed">
                  可上傳以往備份的 <code className="text-indigo-300">.ateliersync-capsule</code> 檔案進行完全無損復原。
                </p>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".ateliersync-capsule,.json"
                  onChange={handleCapsuleFileSelect}
                  className="hidden"
                />

                {pendingEncryptedFile ? (
                  <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-800/80 space-y-2 animate-in fade-in">
                    <div className="text-[11px] text-amber-300 font-medium flex items-center gap-1.5">
                      <Key className="w-3.5 h-3.5" />
                      <span>此膠囊已加密，請輸入密碼解密復原：</span>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        placeholder="請輸入解密密碼..."
                        value={decryptPassword}
                        onChange={(e) => setDecryptPassword(e.target.value)}
                        className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2.5 py-1 text-xs text-white focus:outline-none focus:border-amber-500"
                      />
                      <button
                        type="button"
                        onClick={() => executeDisasterRecovery(pendingEncryptedFile, decryptPassword)}
                        disabled={isRecovering || !decryptPassword}
                        className="px-4 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-medium disabled:opacity-40"
                      >
                        {isRecovering ? '解密中...' : '解密並還原'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isRecovering}
                    className="w-full py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700/80 font-medium flex items-center justify-center gap-2 transition disabled:opacity-50"
                  >
                    <Upload className="w-4 h-4 text-emerald-400" />
                    <span>{isRecovering ? '正在復原畫布...' : '選取本機膠囊檔案進行災難復原'}</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: Local Cold Backups (IndexedDB) */}
          {activeTab === 'coldBackup' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded-xl bg-neutral-900/80 border border-neutral-800">
                <div className="space-y-0.5">
                  <div className="font-semibold text-white flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-emerald-400" />
                    <span>{t.capsule.backupInterval}</span>
                  </div>
                  <div className="text-[10px] text-neutral-400">
                    {t.capsule.tabColdBackup}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={backupInterval}
                    onChange={(e) => setBackupInterval(parseInt(e.target.value, 10))}
                    className="bg-neutral-800 border border-neutral-700 rounded-lg px-2.5 py-1 text-xs text-neutral-200 focus:outline-none cursor-pointer"
                  >
                    <option value={0}>0 min</option>
                    <option value={5}>5 min</option>
                    <option value={15}>15 min</option>
                    <option value={30}>30 min</option>
                  </select>

                  <button
                    type="button"
                    onClick={handleCreateColdBackup}
                    disabled={isBackingUp}
                    className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1 shadow-sm transition disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${isBackingUp ? 'animate-spin' : ''}`} />
                    <span>{t.capsule.createColdBackup}</span>
                  </button>
                </div>
              </div>

              {/* List of Previous Backups */}
              <div className="space-y-2">
                <div className="text-[11px] font-semibold text-neutral-400 flex items-center justify-between">
                  <span>{t.capsule.tabColdBackup} ({coldBackups.length})</span>
                </div>

                {coldBackups.length === 0 ? (
                  <div className="p-8 text-center text-neutral-500 bg-neutral-900/40 rounded-xl border border-neutral-800">
                    {t.layers.empty}
                  </div>
                ) : (
                  coldBackups.map((b) => (
                    <div
                      key={b.id}
                      className="p-3 rounded-xl bg-neutral-900/70 border border-neutral-800 flex items-center justify-between hover:border-neutral-700 transition"
                    >
                      <div className="flex items-center gap-3">
                        {b.thumbnailUrl ? (
                          <img
                            src={b.thumbnailUrl}
                            alt="thumb"
                            className="w-12 h-12 rounded object-cover border border-neutral-700 bg-black/40"
                          />
                        ) : (
                          <div className="w-12 h-12 rounded bg-neutral-800 flex items-center justify-center">
                            <Layers className="w-5 h-5 text-neutral-500" />
                          </div>
                        )}

                        <div className="space-y-0.5">
                          <div className="font-semibold text-neutral-200 flex items-center gap-1.5">
                            <span>{new Date(b.timestamp).toLocaleString()}</span>
                            {b.isEncrypted && (
                              <span className="px-1 py-0.2 rounded bg-amber-950 text-amber-300 text-[9px] border border-amber-800">
                                🔒
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-neutral-400 flex items-center gap-3 font-mono">
                            <span>{b.totalStrokes.toLocaleString()} {t.collab.strokesUnit}</span>
                            <span>{b.totalLayers} {t.layers.layerCount}</span>
                            <span>{Math.round(b.dataSize / 1024)} KB</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => executeDisasterRecovery(b.capsuleData)}
                          className="px-2.5 py-1 rounded bg-indigo-600/80 hover:bg-indigo-600 text-white font-medium text-xs transition"
                        >
                          {t.capsule.restore}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            TimeCapsuleEngine.downloadCapsuleFile(
                              b.capsuleData,
                              `${b.canvasTitle}_${new Date(b.timestamp).toISOString().slice(0, 10)}.ateliersync-capsule`
                            )
                          }
                          title={t.common.export}
                          className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white transition"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteColdBackup(b.id)}
                          title={t.capsule.deleteBackup}
                          className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-rose-400 transition"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* TAB 3: WebRTC DataChannel P2P Swarm Offload Dashboard */}
          {activeTab === 'p2p' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-gradient-to-br from-cyan-950/40 via-neutral-900/60 to-indigo-950/40 border border-cyan-800/40 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-cyan-400" />
                    <span className="font-bold text-white text-sm">
                      {t.capsule.p2pMeshTitle}
                    </span>
                  </div>
                  <span className="px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800 text-[10px] font-semibold flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                    點對點分流運作中
                  </span>
                </div>

                <p className="text-[11px] text-neutral-300 leading-relaxed">
                  畫師之間直接傳送圖塊，減輕伺服器上傳負擔。
                </p>

                {/* Metrics Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                  <div className="p-2.5 rounded-lg bg-neutral-900/80 border border-neutral-800 text-center">
                    <div className="text-[10px] text-neutral-400">在線 P2P 節點</div>
                    <div className="text-lg font-bold text-cyan-400 font-mono">
                      {p2pStats.peersConnected} / {p2pStats.totalPeers}
                    </div>
                  </div>

                  <div className="p-2.5 rounded-lg bg-neutral-900/80 border border-neutral-800 text-center">
                    <div className="text-[10px] text-neutral-400">房主頻寬節省率</div>
                    <div className="text-lg font-bold text-emerald-400 font-mono">
                      {p2pStats.offloadRatio}%
                    </div>
                  </div>

                  <div className="p-2.5 rounded-lg bg-neutral-900/80 border border-neutral-800 text-center">
                    <div className="text-[10px] text-neutral-400">P2P 傳輸 Tile 數</div>
                    <div className="text-lg font-bold text-indigo-400 font-mono">
                      {p2pStats.tilesSent + p2pStats.tilesReceived}
                    </div>
                  </div>

                  <div className="p-2.5 rounded-lg bg-neutral-900/80 border border-neutral-800 text-center">
                    <div className="text-[10px] text-neutral-400">P2P 分流總流量</div>
                    <div className="text-lg font-bold text-amber-400 font-mono">
                      {Math.round((p2pStats.bytesSent + p2pStats.bytesReceived) / 1024)} KB
                    </div>
                  </div>
                </div>
              </div>

              {/* Painter Level Gamification Info */}
              <div className="p-4 rounded-xl bg-neutral-900/80 border border-neutral-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-white flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-amber-400" />
                    <span>流光勳章與筆數體系 (萬筆畫布成長公式)</span>
                  </div>
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-bold"
                    style={{
                      backgroundColor: `${painterLevel.badgeColor}22`,
                      color: painterLevel.badgeColor,
                      border: `1px solid ${painterLevel.badgeColor}66`,
                    }}
                  >
                    Lv.{painterLevel.level} {painterLevel.title}
                  </span>
                </div>

                <p className="text-[11px] text-neutral-400 leading-relaxed">
                  依累積筆數升級，最高 Lv.10。
                </p>

                <div className="space-y-1 bg-neutral-800/60 p-2.5 rounded-lg border border-neutral-700/60">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-neutral-300">個人當前累積筆數</span>
                    <span className="font-mono text-amber-400 font-semibold">
                      {personalStrokes.toLocaleString()} 筆
                    </span>
                  </div>

                  <div className="flex justify-between text-[10px] text-neutral-400 pt-0.5">
                    <span>
                      當前階段: Lv.{painterLevel.level} {painterLevel.title}
                    </span>
                    <span>
                      {painterLevel.nextLevelThreshold
                        ? `下一階: ${painterLevel.nextLevelThreshold.toLocaleString()} 筆 (${painterLevel.progressPercent}%)`
                        : '已達神話巔峰 (100k+)'}
                    </span>
                  </div>

                  <div className="w-full bg-neutral-700/80 rounded-full h-1.5 overflow-hidden mt-1">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${painterLevel.progressPercent}%`,
                        backgroundColor: painterLevel.badgeColor,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 sm:px-5 border-t border-neutral-800 flex items-center justify-between bg-neutral-900/80 shrink-0">
          <span className="text-[11px] text-neutral-500 hidden sm:inline">
            按 Esc 鍵或點擊外部任意處即可關閉
          </span>
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto px-5 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-semibold transition active:scale-95 shadow"
          >
            關閉視窗
          </button>
        </div>
      </div>
    </div>
  );
};
