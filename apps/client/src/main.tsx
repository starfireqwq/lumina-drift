import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import { I18nProvider } from './context/I18nContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';
import { applyTheme, loadSurfaceStyle, loadThemeSettings } from './theme/themes';
import { applyMotionMode } from './theme/motion';
import { applyUiScale } from './theme/uiScale';
import { ApiService } from './services/api';
import { OfflineSessionStore } from './services/offlineStore';
import { sharedRoomFromLocation } from './utils/serverLinks';

// Before the first paint, so the saved theme, surface style, motion mode, and interface size never flash the defaults
const savedTheme = loadThemeSettings();
const savedSurface = loadSurfaceStyle();
applyTheme(savedTheme.id, savedTheme.custom, savedSurface);
applyUiScale();
applyMotionMode();

// A hosted room link points to this origin, including when this browser last drew offline.
if (sharedRoomFromLocation()) {
  OfflineSessionStore.setSessionMode('collaborative');
  ApiService.setServerUrl('');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <AuthProvider>
          <SocketProvider>
            <App />
          </SocketProvider>
        </AuthProvider>
      </I18nProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
