import * as React from 'react';
import { Camera, CalendarDays, CloudOff, Home, Layers, Plus, RefreshCw, Settings, TrendingUp } from 'lucide-react';
import { cn } from '../components/utils';

// 外框：頂部標題列 + 導覽（手機在底部、電腦在標題下方）

export type TabKey = 'home' | 'holdings' | 'dividends';

const TABS: { key: TabKey; label: string; icon: React.ElementType }[] = [
  { key: 'home', label: '首頁', icon: Home },
  { key: 'holdings', label: '持股', icon: Layers },
  { key: 'dividends', label: '股息', icon: CalendarDays },
];

export type SyncStatus = 'loading' | 'syncing' | 'synced' | 'offline';

export function Shell({ tab, onTab, onImport, onAdd, onSettings, darkMode, syncStatus = 'synced', onRetrySync, children }: {
  tab: TabKey;
  onTab: (t: TabKey) => void;
  onImport: () => void;
  onAdd: () => void;
  onSettings: () => void;
  darkMode: boolean;
  syncStatus?: SyncStatus;
  onRetrySync?: () => void;
  children: React.ReactNode;
}) {
  const iconBtn = 'w-11 h-11 flex items-center justify-center rounded-full text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800';
  return (
    <div className={cn(darkMode && 'dark')}>
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans">
        <header className="sticky top-0 z-30 bg-white/90 dark:bg-slate-900/90 backdrop-blur border-b border-slate-100 dark:border-slate-800"
          style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
          <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between">
            <h1 className="text-lg font-black text-indigo-600 dark:text-indigo-400 flex items-center gap-1.5 select-none">
              <TrendingUp className="w-5 h-5" /> 息引力
            </h1>
            {(syncStatus === 'loading' || syncStatus === 'syncing') && (
              <span className="mr-auto ml-2 flex items-center gap-1 text-xs font-bold text-slate-400" role="status">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /> 同步中
              </span>
            )}
            {syncStatus === 'offline' && (
              <button onClick={onRetrySync} className="mr-auto ml-1 h-11 px-2 flex items-center gap-1 text-xs font-bold text-amber-600" title="點一下重新同步">
                <CloudOff className="w-3.5 h-3.5" /> 未同步，點此重試
              </button>
            )}
            <div className="flex items-center gap-1">
              <button onClick={onImport} className={iconBtn} aria-label="截圖匯入" title="上傳券商截圖，AI 自動匯入持股"><Camera className="w-5 h-5" /></button>
              <button onClick={onAdd} className={iconBtn} aria-label="新增股票" title="新增股票"><Plus className="w-5 h-5" /></button>
              <button onClick={onSettings} className={iconBtn} aria-label="設定" title="設定"><Settings className="w-5 h-5" /></button>
            </div>
          </div>
          {/* 電腦版：導覽在標題下方 */}
          <nav className="hidden sm:block max-w-3xl mx-auto px-4">
            <div className="flex gap-6">
              {TABS.map(t => (
                <button key={t.key} onClick={() => onTab(t.key)}
                  className={cn('h-11 text-sm font-bold border-b-2 -mb-px',
                    tab === t.key ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400' : 'border-transparent text-slate-400 hover:text-slate-600')}>
                  {t.label}
                </button>
              ))}
            </div>
          </nav>
        </header>

        <main className="max-w-3xl mx-auto px-4 pt-4 pb-[calc(6rem+env(safe-area-inset-bottom))] sm:pb-12">
          {children}
        </main>

        {/* 手機版：導覽在底部，拇指好按 */}
        <nav className="sm:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-t border-slate-100 dark:border-slate-800"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
          <div className="grid grid-cols-3">
            {TABS.map(t => {
              const Icon = t.icon;
              return (
                <button key={t.key} onClick={() => onTab(t.key)}
                  className={cn('h-14 flex flex-col items-center justify-center gap-0.5 text-xs font-bold',
                    tab === t.key ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400')}>
                  <Icon className="w-5 h-5" />
                  {t.label}
                </button>
              );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
}
