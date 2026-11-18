import React, { createContext, useContext, useEffect, useState } from 'react';
import { UserPayload, ServerRole } from '@atelier/shared';
import { ApiService } from '../services/api';
import { LOCAL_ARTIST_ID, OfflineSessionStore } from '../services/offlineStore';

interface AuthContextType {
  user: UserPayload | null;
  token: string | null;
  isGuest: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, displayName: string, serverRole?: ServerRole) => Promise<void>;
  logout: () => void;
  continueAsGuest: (customDisplayName?: string) => void;
  setGuestDisplayName: (displayName: string) => void;
  updateProfile: (displayName: string, avatarUrl?: string | null) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Anonymous visitors stay client-side only: registering a server account on every page load filled
// the users table with throwaway guests. A socket without a token is already a read-only guest.
const localGuest = (): UserPayload => ({
  id: `guest_${Math.random().toString(36).substring(2, 9)}`,
  username: 'guest',
  displayName: localStorage.getItem('atelier_guest_name') || '訪客畫師',
  serverRole: 'guest' as ServerRole,
});

const localArtist = (): UserPayload => ({
  id: LOCAL_ARTIST_ID,
  username: 'local_artist',
  displayName: localStorage.getItem('atelier_guest_name') || '本機畫師',
  serverRole: 'admin' as ServerRole,
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserPayload | null>(() =>
    OfflineSessionStore.isOfflineMode() ? localArtist() : null
  );
  const [token, setToken] = useState<string | null>(ApiService.getToken());
  const [isGuest, setIsGuest] = useState<boolean>(() =>
    OfflineSessionStore.isOfflineMode() ? false : !token
  );
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    let requestId = 0;
    async function loadMe() {
      const id = ++requestId;
      if (OfflineSessionStore.isOfflineMode()) {
        setToken(null);
        setUser(localArtist());
        setIsGuest(false);
        setIsLoading(false);
        return;
      }

      const origin = ApiService.getServerOrigin();
      const storedToken = ApiService.getToken(origin);
      setToken(storedToken);
      if (!storedToken) {
        setUser(localGuest());
        setIsGuest(true);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      const stillCurrent = () => id === requestId && origin === ApiService.getServerOrigin()
        && ApiService.getToken(origin) === storedToken && !OfflineSessionStore.isOfflineMode();
      try {
        const { user } = await ApiService.getMe();
        if (!stillCurrent()) return;
        setUser(user);
        setIsGuest(user.serverRole === 'guest');
      } catch (err) {
        if (!stillCurrent()) return;
        console.warn('Unable to verify the stored session:', err);
        setToken(null);
        setUser(localGuest());
        setIsGuest(true);
      } finally {
        if (id === requestId) setIsLoading(false);
      }
    }

    loadMe();
    const onAuthUpdated = (ev: Event) => {
      const detail = (ev as CustomEvent<{ token: string; user: UserPayload }>).detail;
      if (detail?.token && detail?.user) {
        requestId++;
        setToken(detail.token);
        setUser(detail.user);
        setIsGuest(detail.user.serverRole === 'guest');
        setIsLoading(false);
      }
    };
    window.addEventListener('atelier:auth-updated', onAuthUpdated);
    const onServerChanged = () => {
      setUser(null);
      setIsGuest(true);
      void loadMe();
    };
    window.addEventListener('atelier:server-changed', onServerChanged);
    window.addEventListener('atelier:auth-expired', onServerChanged);
    const unsubMode = OfflineSessionStore.subscribeSessionMode(() => void loadMe());
    return () => {
      requestId++;
      window.removeEventListener('atelier:auth-updated', onAuthUpdated);
      window.removeEventListener('atelier:server-changed', onServerChanged);
      window.removeEventListener('atelier:auth-expired', onServerChanged);
      unsubMode();
    };
  }, []);

  const login = async (username: string, password: string) => {
    const origin = ApiService.getServerOrigin();
    const res = await ApiService.login({ username, password });
    if (origin !== ApiService.getServerOrigin() || OfflineSessionStore.isOfflineMode()) throw new DOMException('Server changed', 'AbortError');
    setUser(res.user);
    setToken(res.token);
    setIsGuest(false);
    setIsLoading(false);
  };

  const register = async (username: string, password: string, displayName: string, serverRole?: ServerRole) => {
    const origin = ApiService.getServerOrigin();
    const res = await ApiService.register({ username, password, displayName, serverRole });
    if (origin !== ApiService.getServerOrigin() || OfflineSessionStore.isOfflineMode()) throw new DOMException('Server changed', 'AbortError');
    setUser(res.user);
    setToken(res.token);
    setIsGuest(false);
    setIsLoading(false);
  };

  const logout = () => {
    if (OfflineSessionStore.isOfflineMode()) {
      setUser(localArtist());
      setToken(null);
      setIsGuest(false);
      return;
    }
    if (ApiService.isLocalDesktopServer()) {
      return;
    }
    ApiService.setToken(null);
    setUser(localGuest());
    setToken(null);
    setIsGuest(true);
  };

  const continueAsGuest = (customDisplayName?: string) => {
    logout();
    if (customDisplayName) {
      setGuestDisplayName(customDisplayName);
    }
  };

  const setGuestDisplayName = (displayName: string) => {
    const offline = OfflineSessionStore.isOfflineMode();
    const trimmed = displayName.trim() || (offline ? '本機畫師' : '訪客畫師');
    if (typeof window !== 'undefined') {
      localStorage.setItem('atelier_guest_name', trimmed);
    }
    if (offline) {
      setUser((prev) => ({
        ...localArtist(),
        ...(prev && prev.id === LOCAL_ARTIST_ID ? prev : {}),
        displayName: trimmed,
        serverRole: 'admin' as ServerRole,
      }));
      setIsGuest(false);
      return;
    }
    setUser((prev) => ({
      id: prev?.id || `guest_${Math.random().toString(36).substring(2, 9)}`,
      username: 'guest',
      displayName: trimmed,
      serverRole: 'guest' as ServerRole,
    }));
  };

  const updateProfile = async (displayName: string, avatarUrl?: string | null) => {
    const trimmed = displayName.trim();
    if (OfflineSessionStore.isOfflineMode()) {
      if (typeof window !== 'undefined' && trimmed) {
        localStorage.setItem('atelier_guest_name', trimmed);
      }
      setUser((prev) => ({
        ...localArtist(),
        ...(prev || {}),
        id: prev?.id || LOCAL_ARTIST_ID,
        username: prev?.username || 'local_artist',
        serverRole: 'admin' as ServerRole,
        displayName: trimmed || prev?.displayName || '本機畫師',
        avatarUrl: avatarUrl !== undefined ? avatarUrl : prev?.avatarUrl,
      }));
      setIsGuest(false);
      return;
    }
    const origin = ApiService.getServerOrigin();
    try {
      const res = await ApiService.updateProfile({ displayName, avatarUrl });
      if (origin !== ApiService.getServerOrigin() || ApiService.getToken(origin) !== res.token || OfflineSessionStore.isOfflineMode()) return;
      setUser(res.user);
      setToken(res.token);
    } catch {
      if (origin !== ApiService.getServerOrigin() || OfflineSessionStore.isOfflineMode()) return;
      // If offline or guest mode, update local state
      setUser((prev) => prev ? { ...prev, displayName, avatarUrl: avatarUrl !== undefined ? avatarUrl : prev.avatarUrl } : null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isGuest,
        isLoading,
        login,
        register,
        logout,
        continueAsGuest,
        setGuestDisplayName,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
