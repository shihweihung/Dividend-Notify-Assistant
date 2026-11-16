import * as React from 'react';
import { Camera, Loader2, LogIn, LogOut, Moon, RefreshCw, Send } from 'lucide-react';
import { cn } from '../components/utils';
import { Sheet, inputCls, labelCls, primaryBtn } from './Sheet';

export function AddStockSheet({ open, onClose, symbol, shares, cost, onSymbol, onShares, onCost, onSubmit, onImport, loading, error }: {
  open: boolean; onClose: () => void;
  symbol: string; shares: number; cost: number;
  onSymbol: (v: string) => void; onShares: (v: number) => void; onCost: (v: number) => void;
  onSubmit: (e: React.FormEvent) => void; onImport: () => void;
  loading: boolean; error: string | null;
}) {
  return (
    <Sheet open={open} title="新增股票" onClose={onClose}>
      <button onClick={onImport}
        className="w-full h-14 mb-4 px-4 rounded-2xl flex items-center gap-3 text-left bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 font-bold">
        <Camera className="w-5 h-5 shrink-0" />
        <span className="flex-1">上傳券商截圖，一次匯入全部持股</span>
      </button>
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block">
          <span className={labelCls}>股票代號</span>
          <input value={symbol} onChange={(e) => onSymbol(e.target.value)} placeholder="例如 2330、0056" className={inputCls} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelCls}>持有股數</span>
            <input type="number" inputMode="numeric" value={shares || ''} onFocus={(e) => e.target.select()}
              onChange={(e) => onShares(e.target.value === '' ? 0 : Number(e.target.value))} className={inputCls} />
          </label>
          <label className="block">
            <span className={labelCls}>平均成本（選填）</span>
            <input type="number" inputMode="decimal" step="0.01" value={cost || ''} onFocus={(e) => e.target.select()}
              onChange={(e) => onCost(e.target.value === '' ? 0 : Number(e.target.value))} className={inputCls} />
          </label>
        </div>
        {error && <p className="text-sm font-bold text-red-500">{error}</p>}
        <button type="submit" disabled={loading || !symbol} className={primaryBtn}>
          {loading ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : '新增'}
        </button>
      </form>
    </Sheet>
  );
}

export function SettingsSheet({ open, onClose, user, darkMode, onToggleDark, botToken, chatId, onBotToken, onChatId,
  onSaveTelegram, onTestTelegram, sendingTelegram, onRefreshAll, refreshingAll, onLogin, onLogout }: {
  open: boolean; onClose: () => void;
  user: { displayName?: string | null; email?: string | null; photoURL?: string | null } | null;
  darkMode: boolean; onToggleDark: () => void;
  botToken: string; chatId: string; onBotToken: (v: string) => void; onChatId: (v: string) => void;
  onSaveTelegram: () => void; onTestTelegram: () => void; sendingTelegram: boolean;
  onRefreshAll: () => void; refreshingAll: boolean;
  onLogin: () => void; onLogout: () => void;
}) {
  const row = 'w-full h-12 px-3 rounded-xl flex items-center gap-3 font-bold hover:bg-slate-100 dark:hover:bg-slate-800';
  return (
    <Sheet open={open} title="設定" onClose={onClose}>
      <div className="space-y-4">
        {user && (
          <div className="flex items-center gap-3 px-1">
            {user.photoURL
              ? <img src={user.photoURL} alt="" className="w-10 h-10 rounded-full" referrerPolicy="no-referrer" />
              : <div className="w-10 h-10 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-black">{(user.displayName || user.email || '?')[0]}</div>}
            <div className="min-w-0">
              <p className="font-black truncate">{user.displayName || '使用者'}</p>
              <p className="text-xs text-slate-400 truncate">{user.email}</p>
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-slate-100 dark:border-slate-800 p-1">
          <button onClick={onToggleDark} className={row}>
            <Moon className="w-5 h-5 text-slate-400" />
            <span className="flex-1 text-left">深色模式</span>
            <span className={cn('w-11 h-6 rounded-full relative transition-colors', darkMode ? 'bg-indigo-600' : 'bg-slate-300')}>
              <span className={cn('absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all', darkMode ? 'left-[22px]' : 'left-0.5')} />
            </span>
          </button>
          <button onClick={onRefreshAll} disabled={refreshingAll} className={cn(row, 'disabled:opacity-50')}>
            <RefreshCw className={cn('w-5 h-5 text-slate-400', refreshingAll && 'animate-spin')} />
            <span className="flex-1 text-left">{refreshingAll ? '更新中…' : '更新全部股息資料'}</span>
          </button>
        </div>

        <div className="rounded-2xl border border-slate-100 dark:border-slate-800 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-black flex items-center gap-1.5"><Send className="w-4 h-4 text-sky-500" />Telegram 通知</p>
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-xs font-bold text-sky-500">申請機器人 ↗</a>
          </div>
          <label className="block">
            <span className={labelCls}>Bot Token</span>
            <input type="password" value={botToken} onChange={(e) => onBotToken(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className={labelCls}>Chat ID</span>
            <input value={chatId} inputMode="numeric" onChange={(e) => onChatId(e.target.value)} className={inputCls} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={onSaveTelegram} className="h-11 rounded-xl border border-slate-200 dark:border-slate-700 font-bold">儲存</button>
            <button onClick={onTestTelegram} disabled={sendingTelegram} className="h-11 rounded-xl bg-sky-500 text-white font-bold disabled:opacity-50">
              {sendingTelegram ? '發送中…' : '測試發送'}
            </button>
          </div>
        </div>

        {user ? (
          <button onClick={onLogout} className={cn(row, 'text-red-500')}><LogOut className="w-5 h-5" />登出</button>
        ) : (
          <button onClick={onLogin} className={cn(row, 'text-indigo-600')}><LogIn className="w-5 h-5" />Google 登入同步</button>
        )}
      </div>
    </Sheet>
  );
}

export function DeleteStockSheet({ target, onClose, onClear, onDelete }: {
  target: { symbol: string; name: string } | null;
  onClose: () => void; onClear: () => void; onDelete: () => void;
}) {
  return (
    <Sheet open={!!target} title={target ? `${target.name}（${target.symbol}）` : ''} onClose={onClose}>
      <div className="space-y-3">
        <button onClick={onClear} className="w-full rounded-2xl p-4 text-left bg-indigo-50 dark:bg-indigo-500/10">
          <p className="font-black text-indigo-700 dark:text-indigo-300">設為已清倉（建議）</p>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">股數改為 0，今年已領的股息、還沒入帳的股息與交易紀錄都會保留。</p>
        </button>
        <button onClick={onDelete} className="w-full rounded-2xl p-4 text-left border border-red-200 dark:border-red-500/30">
          <p className="font-black text-red-500">徹底刪除</p>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">這檔股票今年領過的股息、未入帳的股息和交易紀錄都會從統計中消失，無法復原。</p>
        </button>
        <button onClick={onClose} className="w-full h-12 rounded-xl font-bold text-slate-500">取消</button>
      </div>
    </Sheet>
  );
}
