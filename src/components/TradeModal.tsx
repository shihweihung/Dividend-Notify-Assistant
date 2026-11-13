import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { format } from 'date-fns';
import { applyTrade, TradeError, type TradeSide } from '../../shared/trades';
import { cn } from './utils';

// 買進 / 賣出輸入視窗：手機上從底部滑出，電腦上置中。
// 費用、成本、已實現損益的計算都在 shared/trades.ts，這裡只負責輸入與預覽。

type Props = {
  open: boolean;
  side: TradeSide;
  stock: { symbol: string; name: string; shares: number; cost?: number | null; currentPrice?: number };
  darkMode: boolean;
  onClose: () => void;
  onSubmit: (input: { side: TradeSide; shares: number; price: number; tradeDate: string }) => Promise<void>;
};

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`;

export function TradeModal({ open, side, stock, darkMode, onClose, onSubmit }: Props) {
  const today = format(new Date(), 'yyyy-MM-dd');
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [tradeDate, setTradeDate] = useState(today);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setShares(side === 'sell' && stock.shares > 0 ? String(stock.shares) : '');
    setPrice(stock.currentPrice ? String(stock.currentPrice) : '');
    setTradeDate(format(new Date(), 'yyyy-MM-dd'));
    setError('');
    setSaving(false);
  }, [open, side, stock.symbol, stock.shares, stock.currentPrice]);

  // 即時預覽：手續費、證交稅、交易後股數與成本、已實現損益
  const preview = useMemo(() => {
    const q = Number(shares);
    const p = Number(price);
    if (!q || !p) return null;
    try {
      return applyTrade(stock.symbol, { shares: stock.shares, cost: stock.cost ?? null }, {
        side, shares: q, price: p, tradeDate, recordedDate: today, recordedAt: new Date().toISOString(), id: 'preview',
      });
    } catch (e) {
      return e instanceof TradeError ? e.message : null;
    }
  }, [shares, price, tradeDate, side, stock.symbol, stock.shares, stock.cost, today]);

  if (!open) return null;

  const isSell = side === 'sell';
  const accent = isSell ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-500 hover:bg-rose-600';
  const inputCls = cn(
    'w-full h-12 px-3 rounded-xl text-base font-bold border focus:outline-none focus:ring-2 focus:ring-indigo-500',
    darkMode ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-slate-900'
  );
  const labelCls = cn('text-xs font-bold mb-1.5 block', darkMode ? 'text-slate-300' : 'text-slate-600');

  const handleSubmit = async () => {
    if (typeof preview === 'string') { setError(preview); return; }
    if (!preview) { setError('請輸入股數和價格'); return; }
    setSaving(true);
    setError('');
    try {
      await onSubmit({ side, shares: Number(shares), price: Number(price), tradeDate });
      onClose();
    } catch (e: any) {
      setError(e?.message || '儲存失敗，請再試一次');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className={cn(
          'w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl',
          darkMode ? 'bg-slate-900 text-slate-100' : 'bg-white text-slate-900'
        )}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-black">{isSell ? '賣出' : '買進'} {stock.name}</h3>
            <p className="text-xs text-slate-400 mt-0.5">{stock.symbol}・目前持有 {stock.shares.toLocaleString()} 股</p>
          </div>
          <button onClick={onClose} className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-slate-500/10" aria-label="關閉">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelCls}>股數</span>
            <input type="number" inputMode="numeric" min={1} step={1} value={shares}
              onChange={(e) => setShares(e.target.value)} onFocus={(e) => e.target.select()} className={inputCls} />
          </label>
          <label className="block">
            <span className={labelCls}>成交價</span>
            <input type="number" inputMode="decimal" min={0} step="any" value={price}
              onChange={(e) => setPrice(e.target.value)} onFocus={(e) => e.target.select()} className={inputCls} />
          </label>
        </div>
        {isSell && stock.shares > 0 && (
          <div className="flex gap-2 mt-2">
            {[0.25, 0.5, 1].map(r => (
              <button key={r} type="button"
                onClick={() => setShares(String(Math.max(Math.floor(stock.shares * r), 1)))}
                className={cn('flex-1 h-9 rounded-lg text-xs font-bold', darkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600')}>
                {r === 1 ? '全部' : `${r * 100}%`}
              </button>
            ))}
          </div>
        )}

        <label className="block mt-3">
          <span className={labelCls}>成交日（晚幾天補登也沒關係，股息會照成交日算）</span>
          <input type="date" value={tradeDate} max={today} onChange={(e) => setTradeDate(e.target.value)} className={inputCls} />
        </label>

        <div className={cn('mt-4 rounded-2xl p-3 text-sm space-y-1.5', darkMode ? 'bg-slate-800/70' : 'bg-slate-50')}>
          {preview && typeof preview !== 'string' ? (
            <>
              <Row label="手續費（估）" value={money(preview.trade.fee)} />
              {isSell && <Row label="證交稅（估）" value={money(preview.trade.tax)} />}
              <Row label="交易後持股" value={`${preview.position.shares.toLocaleString()} 股`} />
              {!isSell && <Row label="新平均成本" value={preview.position.cost !== null ? `$${preview.position.cost}` : '無法計算（原成本未填）'} />}
              {isSell && (
                <Row
                  label="已實現損益（估）"
                  value={preview.trade.realizedPnl !== null ? money(preview.trade.realizedPnl) : '未填成本，無法計算'}
                  valueClass={preview.trade.realizedPnl === null ? 'text-slate-400' : preview.trade.realizedPnl >= 0 ? 'text-rose-500' : 'text-emerald-500'}
                />
              )}
              <p className="text-[11px] text-slate-400 pt-1">手續費以公定 0.1425% 估算，未含券商折扣。</p>
            </>
          ) : (
            <p className="text-slate-400 text-xs">{typeof preview === 'string' ? preview : '輸入股數和成交價後會顯示費用與損益'}</p>
          )}
        </div>

        {error && <p className="mt-3 text-sm font-bold text-rose-500">{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={saving || !preview || typeof preview === 'string'}
          className={cn('mt-4 w-full h-12 rounded-xl text-white text-base font-black disabled:opacity-40', accent)}
        >
          {saving ? '儲存中…' : `確認${isSell ? '賣出' : '買進'}`}
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-400">{label}</span>
      <span className={cn('font-bold', valueClass)}>{value}</span>
    </div>
  );
}
