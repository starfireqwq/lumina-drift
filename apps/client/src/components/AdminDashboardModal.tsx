import React, { useEffect, useState } from 'react';
import {
  Crown,
  KeyRound,
  Lock,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  User,
  UserCheck,
  UserX,
  X,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { ApiService } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../context/I18nContext';

interface AdminUserItem {
  id: string;
  username: string;
  displayName: string;
  serverRole: 'admin' | 'member' | 'guest';
  isActive: boolean;
  isTemporaryGuest: boolean;
  createdAt: number;
  updatedAt: number;
}

interface AdminDashboardModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AdminDashboardModal: React.FC<AdminDashboardModalProps> = ({ isOpen, onClose }) => {
  const { user } = useAuth();
  const { t } = useI18n();
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Selected user for password reset
  const [selectedUser, setSelectedUser] = useState<AdminUserItem | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [isResetting, setIsResetting] = useState(false);

  const fetchUsers = async () => {
    setLoading(true);
    setStatusMsg(null);
    try {
      const res = await ApiService.listAdminUsers();
      setUsers(res.users || []);
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || '載入使用者列表失敗' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchUsers();
    }
  }, [isOpen]);

  const handleOpenResetPassword = (target: AdminUserItem) => {
    setSelectedUser(target);
    setNewPassword('');
    setStatusMsg(null);
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser || !newPassword.trim()) return;
    if (newPassword.trim().length < 6) {
      setStatusMsg({ type: 'error', text: '密碼長度至少需 6 個字元' });
      return;
    }

    setIsResetting(true);
    try {
      const res = await ApiService.adminResetPassword(selectedUser.id, newPassword.trim());
      setStatusMsg({ type: 'success', text: res.message || `已成功重設 '${selectedUser.username}' 的密碼！` });
      setSelectedUser(null);
      setNewPassword('');
      fetchUsers();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || '重設密碼失敗' });
    } finally {
      setIsResetting(false);
    }
  };

  const handleToggleRole = async (target: AdminUserItem) => {
    const nextRole = target.serverRole === 'admin' ? 'member' : 'admin';
    try {
      await ApiService.adminUpdateUserRole(target.id, nextRole);
      setStatusMsg({
        type: 'success',
        text: `已將 '${target.username}' 的角色調整為 ${nextRole === 'admin' ? '管理員' : '一般畫師'}`,
      });
      fetchUsers();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || '修改角色失敗' });
    }
  };

  const handleToggleStatus = async (target: AdminUserItem) => {
    const nextActive = !target.isActive;
    try {
      await ApiService.adminToggleUserStatus(target.id, nextActive);
      setStatusMsg({
        type: 'success',
        text: `已${nextActive ? '啟用' : '凍結'}使用者 '${target.username}'`,
      });
      fetchUsers();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || '切換帳號狀態失敗' });
    }
  };

  const handleRemoveGuest = async (target: AdminUserItem) => {
    if (!window.confirm(t.admin.removeGuestConfirm.replace('{name}', target.displayName))) return;
    try {
      await ApiService.adminRemoveGuest(target.id);
      setUsers((prev) => prev.filter((item) => item.id !== target.id));
      setStatusMsg({ type: 'success', text: t.admin.guestRemoved });
    } catch (err) {
      setStatusMsg({ type: 'error', text: err instanceof Error ? err.message : t.admin.removeGuest });
    }
  };

  if (!isOpen) return null;

  const filteredUsers = users.filter(
    (u) =>
      u.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.displayName.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div role="dialog" aria-modal="true" className="atelier-modal-backdrop fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-4xl max-h-[92vh] atelier-modal  flex flex-col overflow-hidden text-neutral-200 animate-in zoom-in-95 duration-200">
        {/* Top Header */}
        <div className="px-5 py-4 border-b border-neutral-800 bg-neutral-900 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-amber-500 to-amber-600 flex items-center justify-center text-white shadow-md shadow-amber-500/30">
              <Crown className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm sm:text-base font-black text-white tracking-wide">
                  {t.admin.title}
                </h2>
                <span className="px-2 py-0.5 text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full">
                  {t.admin.badge}
                </span>
              </div>
              <p className="text-[11px] text-neutral-400">
                {t.admin.subtitle}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={fetchUsers}
              disabled={loading}
              title={t.admin.reload}
              className="p-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white transition disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Status Message Notification */}
        {statusMsg && (
          <div
            className={`px-4 py-2.5 text-xs flex items-center gap-2 border-b shrink-0 ${
              statusMsg.type === 'success'
                ? 'bg-emerald-950/70 border-emerald-800/80 text-emerald-300'
                : 'bg-rose-950/70 border-rose-800/80 text-rose-300'
            }`}
          >
            {statusMsg.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
            )}
            <span className="font-medium">{statusMsg.text}</span>
          </div>
        )}

        {/* Toolbar: Stats & Search */}
        <div className="px-5 py-3 border-b border-neutral-800/80 bg-neutral-900/40 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400">{t.admin.totalRegistered.replace('{count}', String(users.length))}</span>
            <span className="text-neutral-600">|</span>
            <span className="text-xs text-emerald-400">
              {t.admin.active.replace('{count}', String(users.filter((u) => u.isActive).length))}
            </span>
            <span className="text-neutral-600">|</span>
            <span className="text-xs text-amber-400">
              {t.admin.adminCount.replace('{count}', String(users.filter((u) => u.serverRole === 'admin').length))}
            </span>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-neutral-500 absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.admin.searchPlaceholder}
              className="w-full bg-neutral-900 text-xs text-white pl-8 pr-3 py-1.5 rounded-lg border border-neutral-700/80 outline-none focus:border-indigo-500 transition"
            />
          </div>
        </div>

        {/* User List Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading && users.length === 0 ? (
            <div className="text-center py-12 text-neutral-500 text-xs">載入成員資料中...</div>
          ) : filteredUsers.length === 0 ? (
            <div className="text-center py-12 text-neutral-500 text-xs">沒有找到符合條件的成員</div>
          ) : (
            filteredUsers.map((item) => {
              const isAdmin = item.serverRole === 'admin';
              const createdDate = new Date(item.createdAt).toLocaleDateString('zh-TW', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
              });

              return (
                <div
                  key={item.id}
                  className={`flex flex-col sm:flex-row sm:items-center justify-between p-3.5 rounded-xl border transition gap-3 ${
                    isAdmin
                      ? 'bg-amber-950/15 border-amber-800/40'
                      : 'bg-neutral-850/60 border-neutral-800/80 hover:border-neutral-700'
                  }`}
                >
                  {/* Left: User Info */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-sm font-bold shadow ${
                        isAdmin
                          ? 'bg-gradient-to-tr from-amber-600 to-amber-500 text-white'
                          : 'bg-neutral-800 text-neutral-300'
                      }`}
                    >
                      {isAdmin ? <Crown className="w-4 h-4" /> : <User className="w-4 h-4" />}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs sm:text-sm text-white truncate">
                          {item.displayName}
                        </span>
                        <span className="text-[11px] font-mono text-neutral-400">
                          @{item.username}
                        </span>
                        {item.id === user?.id && (
                          <span className="px-1.5 py-0.2 rounded text-[10px] bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 font-semibold">
                            您自己
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 mt-0.5 text-[10px] text-neutral-500">
                        <span>註冊時間: {createdDate}</span>
                        <span>•</span>
                        <span className={item.isActive ? 'text-emerald-400' : 'text-rose-400 font-bold'}>
                          {item.isActive ? '帳號正常' : '已凍結'}
                        </span>
                        <span>•</span>
                        <span className={isAdmin ? 'text-amber-400 font-semibold' : 'text-neutral-400'}>
                          {isAdmin ? '管理員 (Admin)' : item.isTemporaryGuest ? t.admin.guestRole : '一般畫友 (Member)'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Right: Actions */}
                  <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
                    {/* Reset Password Button */}
                    <button
                      type="button"
                      onClick={() => handleOpenResetPassword(item)}
                      title={t.admin.resetPassword}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 text-xs font-semibold transition active:scale-95"
                    >
                      <KeyRound className="w-3.5 h-3.5 text-indigo-400" />
                      <span>{t.admin.resetPassword}</span>
                    </button>

                    {/* Toggle Role Button */}
                    <button
                      type="button"
                      onClick={() => handleToggleRole(item)}
                      disabled={item.id === user?.id}
                      title={isAdmin ? t.admin.rolePainter : t.admin.roleAdmin}
                      className={`p-1.5 rounded-lg text-xs transition disabled:opacity-30 ${
                        isAdmin
                          ? 'bg-amber-600/20 text-amber-300 hover:bg-amber-600/30 border border-amber-500/40'
                          : 'bg-neutral-800 text-neutral-400 hover:text-white'
                      }`}
                    >
                      <Shield className="w-3.5 h-3.5" />
                    </button>

                    {/* Toggle Active Status */}
                    <button
                      type="button"
                      onClick={() => handleToggleStatus(item)}
                      disabled={item.id === user?.id}
                      title={item.isActive ? t.admin.freezeUser : t.admin.activateUser}
                      className={`p-1.5 rounded-lg text-xs transition disabled:opacity-30 ${
                        item.isActive
                          ? 'bg-neutral-800 text-neutral-400 hover:text-rose-400'
                          : 'bg-rose-600/20 text-rose-300 border border-rose-500/40'
                      }`}
                    >
                      {item.isActive ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5 text-emerald-400" />}
                    </button>
                    {item.isTemporaryGuest && item.id !== user?.id && (
                      <button type="button" onClick={() => void handleRemoveGuest(item)}
                        title={t.admin.removeGuest} aria-label={t.admin.removeGuest}
                        className="rounded-lg bg-neutral-800 p-1.5 text-rose-300 transition hover:bg-rose-600/20">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Local CLI / Script Reminder Banner at Bottom */}
        <div className="px-5 py-2.5 border-t border-neutral-800 bg-neutral-950 flex flex-wrap items-center justify-between text-[11px] text-neutral-400 shrink-0">
          <span>
            💡 <code>.\scripts\reset-user-password.bat</code>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white font-medium text-xs transition"
          >
            {t.common.close}
          </button>
        </div>
      </div>

      {/* Password Reset Sub-Dialog */}
      {selectedUser && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-100">
          <div className="w-full max-w-sm bg-neutral-900 border border-indigo-500/60 rounded-2xl shadow-2xl p-5 flex flex-col gap-4 animate-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2 text-white">
              <div className="p-2 rounded-xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/40">
                <KeyRound className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold">{t.admin.resetPassword}</h3>
                <p className="text-[11px] text-neutral-400">
                  <span className="font-mono text-indigo-300 font-bold">@{selectedUser.username}</span> ({selectedUser.displayName})
                </p>
              </div>
            </div>

            <form onSubmit={handleConfirmReset} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-neutral-300 mb-1">
                  {t.admin.passwordMinLength}
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-neutral-500 absolute left-2.5 top-2.5" />
                  <input
                    type="text"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={t.auth.password}
                    required
                    autoFocus
                    className="w-full bg-neutral-900 text-white pl-9 pr-3 py-2 rounded-xl border border-neutral-700 outline-none focus:border-indigo-500 text-xs font-mono"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setSelectedUser(null)}
                  className="px-3 py-1.5 rounded-xl bg-neutral-800 text-neutral-300 hover:text-white text-xs font-medium transition"
                >
                  {t.common.cancel}
                </button>
                <button
                  type="submit"
                  disabled={isResetting || !newPassword.trim()}
                  className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-md transition disabled:opacity-50"
                >
                  {isResetting ? t.common.processing : t.admin.confirmReset}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
