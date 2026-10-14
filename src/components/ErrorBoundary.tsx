import * as React from 'react';
import { AlertTriangle, RefreshCw, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  showDetails: boolean;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ errorInfo });
    console.error('[ErrorBoundary] Caught runtime error:', error, errorInfo);

    // If it is a ChunkLoadError (e.g., after an app update while user is browsing on mobile)
    const isChunkError = 
      error.name === 'ChunkLoadError' || 
      /Loading chunk .* failed/i.test(error.message) ||
      /Failed to fetch dynamically imported module/i.test(error.message);

    if (isChunkError) {
      try {
        const hasReloaded = sessionStorage.getItem('chunk_load_auto_reloaded');
        if (!hasReloaded) {
          sessionStorage.setItem('chunk_load_auto_reloaded', 'true');
          console.warn('[ErrorBoundary] Detected outdated chunk/bundle. Auto-reloading page...');
          window.location.reload();
        }
      } catch {
        // ignore storage errors
      }
    }
  }

  handleReload = () => {
    try {
      sessionStorage.removeItem('chunk_load_auto_reloaded');
    } catch {
      // ignore
    }
    window.location.reload();
  };

  handleHardReset = () => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then((registrations) => {
          registrations.forEach((r) => r.unregister());
        });
      }
    } catch (e) {
      console.warn('Error clearing storage:', e);
    }
    window.location.reload();
  };

  override render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const errorMessage = this.state.error?.message || '發生未知錯誤';

      return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-100 flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white dark:bg-slate-800 rounded-3xl p-6 sm:p-8 shadow-xl border border-slate-100 dark:border-slate-700/60 text-center space-y-6">
            <div className="w-16 h-16 bg-amber-50 dark:bg-amber-950/40 text-amber-500 rounded-2xl flex items-center justify-center mx-auto shadow-inner">
              <AlertTriangle className="w-8 h-8" />
            </div>

            <div className="space-y-2">
              <h2 className="text-xl font-black text-slate-900 dark:text-white">
                頁面載入異常
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                在行動裝置上可能是因暫時性網路中斷、版本快取更新或手機內建瀏覽器環境限制。請點擊下方按鈕重新整理。
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              <button
                onClick={this.handleReload}
                className="flex-1 py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl flex items-center justify-center gap-2 shadow-md shadow-indigo-500/20 active:scale-95 transition-all text-sm cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
                重新整理頁面
              </button>
              <button
                onClick={this.handleHardReset}
                className="py-3 px-4 bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-bold rounded-xl flex items-center justify-center gap-2 active:scale-95 transition-all text-sm cursor-pointer"
                title="清除手機本機快取並重載"
              >
                <Trash2 className="w-4 h-4 text-slate-400" />
                清除快取重開
              </button>
            </div>

            <div className="pt-2 border-t border-slate-100 dark:border-slate-700/60 text-left">
              <button
                onClick={() => this.setState({ showDetails: !this.state.showDetails })}
                className="w-full flex items-center justify-between text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 py-1 cursor-pointer"
              >
                <span>技術細節資訊</span>
                {this.state.showDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>

              {this.state.showDetails && (
                <div className="mt-2 p-3 bg-slate-900 text-slate-300 rounded-xl text-[11px] font-mono overflow-auto max-h-40 whitespace-pre-wrap break-all leading-tight">
                  <div className="text-rose-400 font-bold mb-1">{errorMessage}</div>
                  {this.state.errorInfo?.componentStack}
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
