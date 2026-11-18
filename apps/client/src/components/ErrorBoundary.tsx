import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Lumina Drift ErrorBoundary caught an unhandled error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  private handleHardReload = () => {
    try {
      localStorage.removeItem('atelier_gateway_resolved');
      localStorage.removeItem('atelier_layer_floating_open');
    } catch {
      // ignore
    }
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950 text-neutral-200 p-4 select-none">
          {/* Ambient Glow */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full bg-rose-600/10 blur-[120px]" />
            <div className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full bg-indigo-600/10 blur-[120px]" />
          </div>

          <div className="relative max-w-lg w-full bg-neutral-950/95 border border-neutral-800 rounded-3xl p-6 shadow-2xl backdrop-blur-xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-base font-bold text-white tracking-wide">
                  {this.props.fallbackTitle || '繪圖工作區載入遇到問題'}
                </h2>
                <p className="text-xs text-neutral-400 mt-0.5">
                  已攔截到渲染異常，您可以點擊重試或恢復畫布環境。
                </p>
              </div>
            </div>

            {/* Error Message Box */}
            <div className="p-3 rounded-2xl bg-black/60 border border-neutral-800/80 font-mono text-xs text-rose-300 max-h-36 overflow-y-auto break-all leading-relaxed">
              {this.state.error?.message || '發生未知錯誤'}
              {this.state.errorInfo?.componentStack && (
                <div className="mt-2 pt-2 border-t border-neutral-800/80 text-[10px] text-neutral-500 whitespace-pre-wrap">
                  {this.state.errorInfo.componentStack.slice(0, 300)}...
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={this.handleReset}
                className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs font-semibold flex items-center gap-1.5 transition active:scale-95"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>重試繪圖區</span>
              </button>

              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-semibold flex items-center gap-1.5 transition active:scale-95"
              >
                <RefreshCw className="w-3.5 h-3.5 text-indigo-400" />
                <span>重新載入頁面</span>
              </button>

              <button
                type="button"
                onClick={this.handleHardReload}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white text-xs font-bold shadow-lg shadow-indigo-600/30 flex items-center gap-1.5 transition active:scale-95"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>修復快取並重整</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
