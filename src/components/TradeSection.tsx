import * as React from 'react';
import { useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { sortTrades, type Trade, type TradeSide } from '../../shared/trades';
import { cn } from './utils';

// 持股詳情裡的「交易」區塊：
// - 一行標題（交易紀錄 N 筆）＋ 右側兩顆小的買進 / 賣出
// - 交易明細預設收起，點標題才展開，買賣再多次版面也不會變長
// - 不顯示已實現損益（使用者決定：損益看券商 App；交易只用來算除息日股數）
// 台股慣例：買用紅色、賣用綠色。

type Props = {
  shares: number;
  trades?: Trade[];
  onTrade: (side: TradeSide) => void;
  onUndo: () => void;
};

export function TradeSection({ shares, trades = [], onTrade, onUndo }: Props) {
  const [open, setOpen] = useState(false);
  const all = sortTrades(trades).reverse();

  const pill = (side: TradeSide) => cn(
    'h-10 min-w-[64px] px-4 rounded-full text-sm font-bold border transition-colors disabled:opacity-30',
    side === 'buy'
      ? 'border-rose-200 text-rose-500 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-400 dark:hover:bg-rose-500/10'
      : 'border-emerald-200 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-500/40 dark:text-emerald-400 dark:hover:bg-emerald-500/10'
  );

  return (
    <div className="rounded-2xl px-3 py-2 bg-slate-50 dark:bg-slate-800/50">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => all.length > 0 && setOpen(!open)}
          className="h-10 flex items-center gap-1 text-sm font-bold text-slate-600 dark:text-slate-300 min-w-0"
        >
          交易紀錄
          {all.length > 0 ? (
            <>
              <span className="text-slate-400 font-medium">{all.length} 筆</span>
              <ChevronDown className={cn('w-4 h-4 text-slate-400 transition-transform', open && 'rotate-180')} />
            </>
          ) : (
            <span className="text-slate-400 font-medium text-xs">尚無</span>
          )}
        </button>
        <div className="flex gap-2 shrink-0">
          <button onClick={() => onTrade('buy')} className={pill('buy')}>買進</button>
          <button onClick={() => onTrade('sell')} disabled={shares <= 0} className={pill('sell')}>賣出</button>
        </div>
      </div>

      {open && all.length > 0 && (
        <div className="mt-1 pt-2 border-t border-slate-200/70 dark:border-slate-700/60 space-y-2 text-sm">
          {all.map(t => (
            <div key={t.id} className="flex items-center gap-2">
              <span className="w-12 text-slate-400 shrink-0 tabular-nums">{t.tradeDate.slice(5).replace('-', '/')}</span>
              <span className={cn('font-bold shrink-0', t.side === 'buy' ? 'text-rose-500' : 'text-emerald-600')}>
                {t.side === 'buy' ? '買' : '賣'}
              </span>
              <span className="flex-1 truncate text-slate-600 dark:text-slate-300 tabular-nums">
                {t.shares.toLocaleString()} 股 @ ${t.price}
              </span>
            </div>
          ))}
          <button
            onClick={onUndo}
            className="h-10 inline-flex items-center gap-1 text-xs font-bold text-slate-400 hover:text-slate-600"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            復原最後一筆
          </button>
        </div>
      )}
    </div>
  );
}
