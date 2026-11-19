import React, { useState } from 'react';
import { Globe, Lock, LogIn, User } from 'lucide-react';
import { AtelierModal, modalButton } from './AtelierModal';
import { useI18n } from '../context/I18nContext';
import { ApiService } from '../services/api';
import { getPrimaryAccount, signInPrimary } from '../services/accountBridge';

/** Signs in to the primary account on the user's own server without switching servers (works in solo mode). */
export const PrimaryAccountDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useI18n();
  const [serverUrl, setServerUrl] = useState(() => getPrimaryAccount()?.homeOrigin || ApiService.getServerUrl() || ApiService.getServerOrigin());
  const [username, setUsername] = useState(() => getPrimaryAccount()?.username ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signInPrimary(serverUrl, username, password);
      onClose();
    } catch (err: any) {
      setError(err?.message || t.auth.processing);
    } finally {
      setLoading(false);
    }
  };

  const field = (label: string, icon: React.ReactNode, input: React.ReactNode) => (
    <label className="flex flex-col gap-1.5">
      <span className="font-medium text-neutral-300">{label}</span>
      <span className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        {input}
      </span>
    </label>
  );

  return (
    <AtelierModal
      title={t.auth.primaryLogin}
      icon={<LogIn />}
      subtitle={t.auth.primaryTooltip}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" onClick={onClose} className={`${modalButton.secondary} mr-auto`}>{t.common.cancel}</button>
          <button type="submit" disabled={loading || !serverUrl.trim() || !username.trim() || !password} className={modalButton.primary}>
            {loading ? t.auth.processing : t.auth.login}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <div role="alert" className="rounded-md border border-rose-700 bg-rose-950/60 px-2.5 py-2 text-rose-200">{error}</div>}
        {field(t.auth.primaryServerUrl, <Globe />, (
          <input type="url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} required autoCapitalize="none"
            placeholder="http://192.168.1.20:3000" className="atelier-field h-10 w-full pl-9 pr-3 font-mono text-xs" />
        ))}
        {field(t.auth.username, <User />, (
          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus
            autoComplete="username" autoCapitalize="none" placeholder={t.auth.usernamePlaceholder} className="atelier-field h-10 w-full pl-9 pr-3 text-sm" />
        ))}
        {field(t.auth.password, <Lock />, (
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
            autoComplete="current-password" className="atelier-field h-10 w-full pl-9 pr-3 text-sm" />
        ))}
      </div>
    </AtelierModal>
  );
};
