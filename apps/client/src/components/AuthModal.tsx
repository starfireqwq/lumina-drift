import React, { useEffect, useRef, useState } from 'react';
import { Lock, LogIn, User, UserPlus } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { AtelierModal, modalButton } from './AtelierModal';
import { useI18n } from '../context/I18nContext';
import { ApiService } from '../services/api';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Sign in / create an account (self-registered accounts are members), or keep browsing as a guest. */
export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose }) => {
  // Subscribe while closed as well, so an open form resets if the server changes.
  useAuth();
  if (!isOpen) return null;
  const origin = ApiService.getServerOrigin();
  return <AuthForm key={origin} origin={origin} onClose={onClose} />;
};

interface DesktopAuthBridge {
  isAvailable: () => Promise<boolean>;
  getSaved: (origin: string) => Promise<{ username: string; password: string } | null>;
  saveCredentials: (origin: string, username: string, password: string) => Promise<boolean>;
  clearCredentials: (origin: string) => Promise<boolean>;
}

const getDesktopAuth = (): DesktopAuthBridge | undefined =>
  typeof window !== 'undefined'
    ? (window as unknown as { atelierDesktop?: { auth?: DesktopAuthBridge } }).atelierDesktop?.auth
    : undefined;

const AuthForm: React.FC<{ origin: string; onClose: () => void }> = ({ origin, onClose }) => {
  const { login, register, continueAsGuest } = useAuth();
  const { t } = useI18n();
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const storageKey = `atelier_remembered_username:${origin}`;
  const [username, setUsername] = useState(() => localStorage.getItem(storageKey) ?? '');
  const [rememberUsername, setRememberUsername] = useState(true);
  const [canRememberPassword, setCanRememberPassword] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(true);
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const dirtyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const desktopAuth = getDesktopAuth();
    if (!desktopAuth) {
      setCanRememberPassword(false);
      return;
    }
    void (async () => {
      const available = await desktopAuth.isAvailable().catch(() => false);
      if (cancelled) return;
      setCanRememberPassword(available);
      if (!available || isRegisterMode) return;
      const saved = await desktopAuth.getSaved(origin).catch(() => null);
      if (cancelled || !saved || dirtyRef.current) return;
      setUsername(saved.username);
      setPassword(saved.password);
      setRememberUsername(true);
      setRememberPassword(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [origin, isRegisterMode]);

  const switchMode = (register: boolean) => {
    dirtyRef.current = false;
    setIsRegisterMode(register);
    setUsername(register ? '' : localStorage.getItem(storageKey) ?? '');
    setPassword('');
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const account = username.trim();
      if (isRegisterMode) await register(account, password, displayName || account);
      else await login(account, password);
      if (rememberUsername || rememberPassword) localStorage.setItem(storageKey, account);
      else localStorage.removeItem(storageKey);
      const desktopAuth = getDesktopAuth();
      if (desktopAuth && canRememberPassword) {
        if (rememberPassword) await desktopAuth.saveCredentials(origin, account, password).catch(() => false);
        else await desktopAuth.clearCredentials(origin).catch(() => false);
      }
      onClose();
    } catch (err: any) {
      setError(err.message || '驗證失敗，請檢查輸入');
    } finally {
      setLoading(false);
    }
  };

  const tab = (register: boolean, label: string) => (
    <button type="button" role="tab" aria-selected={isRegisterMode === register} onClick={() => switchMode(register)}
      className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition ${isRegisterMode === register ? 'bg-indigo-600 text-white' : 'text-neutral-400 hover:text-neutral-200'}`}>
      {label}
    </button>
  );

  return (
    <AtelierModal
      title={isRegisterMode ? t.auth.titleRegister : t.auth.titleLogin}
      icon={isRegisterMode ? <UserPlus /> : <LogIn />}
      subtitle={t.auth.subtitle}
      onClose={onClose}
      onSubmit={handleSubmit}
      footer={
        <>
          <button type="button" onClick={() => { continueAsGuest(); onClose(); }} className={`${modalButton.secondary} mr-auto`}
            title={t.auth.guestTooltip}>
            {t.auth.continueAsGuest}
          </button>
          <button type="submit" disabled={loading || !username.trim() || !password} className={modalButton.primary}>
            {loading ? t.auth.processing : isRegisterMode ? t.auth.registerAndLogin : t.auth.login}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div role="tablist" aria-label="登入或註冊" className="flex gap-1 rounded-lg border border-neutral-800 bg-neutral-950 p-1">
          {tab(false, t.auth.tabLogin)}
          {tab(true, t.auth.tabRegister)}
        </div>

        {error && (
          <div role="alert" className="flex flex-col gap-1.5 rounded-md border border-rose-700 bg-rose-950/60 px-2.5 py-2 text-rose-200">
            <span>{error}</span>
            {error.includes('已存在') && isRegisterMode && (
              <button type="button" onClick={() => switchMode(false)} className="self-start font-semibold text-indigo-300 underline hover:text-indigo-200">
                {t.auth.alreadyRegistered}
              </button>
            )}
          </div>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-neutral-300">{t.auth.username}</span>
          <span className="relative">
            <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input type="text" value={username} onChange={(e) => { dirtyRef.current = true; setUsername(e.target.value); }} required autoFocus
              autoComplete="username" autoCapitalize="none" placeholder={t.auth.usernamePlaceholder}
              className="atelier-field h-10 w-full pl-9 pr-3 text-sm" />
          </span>
        </label>

        {isRegisterMode && (
          <label className="flex flex-col gap-1.5">
            <span className="font-medium text-neutral-300">{t.auth.displayName} <span className="font-normal text-neutral-500">{t.auth.displayNameHint}</span></span>
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="nickname"
              placeholder={username || t.auth.displayNamePlaceholder} className="atelier-field h-10 w-full px-3 text-sm" />
          </label>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-neutral-300">{t.auth.password} {isRegisterMode && <span className="font-normal text-neutral-500">{t.auth.passwordMinHint}</span>}</span>
          <span className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input type="password" value={password} onChange={(e) => { dirtyRef.current = true; setPassword(e.target.value); }} required
              minLength={isRegisterMode ? 6 : undefined} autoComplete={isRegisterMode ? 'new-password' : 'current-password'}
              className="atelier-field h-10 w-full pl-9 pr-3 text-sm" />
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-neutral-300">
            <input
              type="checkbox"
              checked={rememberUsername}
              onChange={(e) => {
                const checked = e.target.checked;
                setRememberUsername(checked);
                if (!checked) setRememberPassword(false);
              }}
            />
            {t.auth.rememberUsername}
          </label>
          {canRememberPassword && (
            <label className="flex items-center gap-2 text-neutral-300">
              <input
                type="checkbox"
                checked={rememberPassword}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setRememberPassword(checked);
                  if (checked) setRememberUsername(true);
                }}
              />
              {t.auth.rememberPassword}
            </label>
          )}
        </div>
      </div>
    </AtelierModal>
  );
};
