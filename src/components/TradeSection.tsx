import * as React from 'react';
import { RotateCcw } from 'lucide-react';
import { sortTrades, totalRealizedPnl, type Trade, type TradeSide } from '../../shared/trades';
import { cn } from './utils';

// 持股卡片裡的「交易」區塊：右上角兩顆小的買進 / 賣出，下面列最近幾筆交易。
// 台股慣例：買（漲）用紅色、賣（跌）用綠色。

type Props = {
  shares: number;
  trades?: Trade[];
  darkMode: boolean;
  onTrade: (side: TradeSide) => void;
  onUndo: () => void;
};

const signedMoney = (n: number) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString()}`;

export function TradeSection({ shares, trades = [], darkMode, onTrade, onUndo }: Props) {
  const hasSells = trades.some(t => t.side === 'sell');
  const realized = totalRealizedPnl(trades);
  const recent = sortTrades(trades).reverse().slice(0, 5);

  const pill = (side: TradeSide) => cn(
    'h-9 min-w-[64px] px-4 rounded-full text-xs font-bold border transition-colors disabled:opacity-30',
    side === 'buy'
      ? (darkMode ? 'border-rose-500/40 text-rose-400 hover:bg-rose-500/10' : 'border-rose-200 text-rose-500 hover:bg-rose-50')
      : (darkMode ? 'border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10' : 'border-emerald-200 text-emerald-600 hover:bg-emerald-50')
  );

  return (
    <div className={cn('rounded-2xl px-3 py-2.5', darkMode ? 'bg-slate-800/50' : 'bg-slate-50')}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className={cn('text-xs font-bold', darkMode ? 'text-slate-300' : 'text-slate-600')}>交易</p>
          {hasSells && (
            <p className="text-[11px] text-slate-400 mt-0.5">
              已實現 <span className={cn('font-bold', realized >= 0 ? 'text-rose-500' : 'text-emerald-500')}>{signedMoney(realized)}</span>
            </p>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={() => onTrade('buy')} className={pill('buy')}>買進</button>
          <button onClick={() => onTrade('sell')} disabled={shares <= 0} className={pill('sell')}>賣出</button>
        </div>
      </div>

      {recent.length > 0 && (
        <div className={cn('mt-2 pt-2 border-t space-y-1.5 text-xs', darkMode ? 'border-slate-700/60' : 'border-slate-200/70')}>
          {recent.map(t => (
            <div key={t.id} className="flex items-center gap-2">
              <span className="w-10 text-slate-400 shrink-0">{t.tradeDate.slice(5).replace('-', '/')}</span>
              <span className={cn('font-bold shrink-0', t.side === 'buy' ? 'text-rose-500' : 'text-emerald-600')}>
                {t.side === 'buy' ? '買' : '賣'}
              </span>
              <span className={cn('flex-1 truncate', darkMode ? 'text-slate-300' : 'text-slate-600')}>
                {t.shares.toLocaleString()} 股 @ ${t.price}
              </span>
              {t.side === 'sell' && t.realizedPnl !== null && (
                <span className={cn('font-bold shrink-0', t.realizedPnl >= 0 ? 'text-rose-500' : 'text-emerald-500')}>
                  {signedMoney(t.realizedPnl)}
                </span>
              )}
            </div>
          ))}
          <button
            onClick={onUndo}
            className="h-9 -mb-1 inline-flex items-center gap-1 text-[11px] font-bold text-slate-400 hover:text-slate-600"
          >
            <RotateCcw className="w-3 h-3" />
            復原最後一筆
          </button>
        </div>
      )}
    </div>
  );
}
