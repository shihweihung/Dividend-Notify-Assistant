import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, RefreshCw, Trash2 } from 'lucide-react';
import type { DividendEventItem, StockYearSummary } from '../../shared/dividendCalc';
import type { TradeSide } from '../../shared/trades';
import type { StockEntry } from '../types';
import { TradeSection } from '../components/TradeSection';
import { cn } from '../components/utils';
import { dateLabel, money, num } from './format';

// 持股分頁：一檔一行，點開看詳情。已清倉收在最下面。

export type HoldingItem = {
  stock: StockEntry;
  price: number;
  value: number;
  weight: number;            // 佔持股市值比例 %
  yieldPct: number | null;   // 殖利率 %
  nextEvent?: DividendEventItem;
  year?: StockYearSummary;   // 今年股息（依發放日）
  updatedLabel?: string | null;
};

type Handlers = {
  onUpdateShares: (symbol: string, shares: number) => void;
  onUpdateCost: (symbol: string, cost: number) => void;
  onTrade: (symbol: string, side: TradeSide) => void;
  onUndoTrade: (symbol: string) => void;
  onRefresh: (symbol: string) => void;
  onDelete: (symbol: string, name: string) => void;
  refreshing: Set<string>;
};

export function HoldingsView({ active, cleared, totalValue, totalYearDividend, focusSymbol, onExportCsv, ...h }: Handlers & {
  active: HoldingItem[];
  cleared: HoldingItem[];
  totalValue: number;
  totalYearDividend: number;
  focusSymbol: string | null;
  onExportCsv: () => void;
}) {
  const [openSymbol, setOpenSymbol] = useState<string | null>(focusSymbol);
  const [showCleared, setShowCleared] = useState(false);
  useEffect(() => {
    if (!focusSymbol) return;
    setOpenSymbol(focusSymbol);
    if (cleared.some(c => c.stock.symbol === focusSymbol)) setShowCleared(true);
  }, [focusSymbol]);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 px-4 py-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold text-slate-400">持股市值・{active.length} 檔</p>
          <p className="text-xl font-black tabular-nums">{money(totalValue)}</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-bold text-slate-400">今年股息</p>
          <p className="text-xl font-black tabular-nums text-emerald-600 dark:text-emerald-400">{money(totalYearDividend)}</p>
        </div>
      </div>

      <div className="space-y-2">
        {active.map(item => (
          <HoldingRow key={item.stock.symbol} item={item} open={openSymbol === item.stock.symbol}
            onToggle={() => setOpenSymbol(openSymbol === item.stock.symbol ? null : item.stock.symbol)} {...h} />
        ))}
      </div>

      {cleared.length > 0 && (
        <div>
          <button
            onClick={() => setShowCleared(!showCleared)}
            className="w-full h-12 px-4 rounded-2xl flex items-center justify-between text-sm font-bold text-slate-500 bg-slate-100 dark:bg-slate-800/60"
          >
            <span>已清倉 {cleared.length} 檔</span>
            <ChevronDown className={cn('w-4 h-4 transition-transform', showCleared && 'rotate-180')} />
          </button>
          {showCleared && (
            <div className="space-y-2 mt-2">
              {cleared.map(item => (
                <HoldingRow key={item.stock.symbol} item={item} open={openSymbol === item.stock.symbol}
                  onToggle={() => setOpenSymbol(openSymbol === item.stock.symbol ? null : item.stock.symbol)} {...h} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-center pt-2">
        <button onClick={onExportCsv} className="h-10 px-4 inline-flex items-center gap-1.5 text-xs font-bold text-slate-400 hover:text-slate-600">
          <Download className="w-4 h-4" /> 匯出 CSV
        </button>
      </div>
    </div>
  );
}

function nextEventText(ev?: DividendEventItem) {
  if (!ev) return null;
  return ev.type === 'payment' ? `${dateLabel(ev.date, false)} 領 ${money(ev.net)}` : `${dateLabel(ev.date, false)} 除息 $${ev.amountPerShare}`;
}

function HoldingRow({ item, open, onToggle, ...h }: Handlers & { item: HoldingItem; open: boolean; onToggle: () => void }) {
  const { stock } = item;
  const cleared = stock.shares <= 0;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [open]);
  const next = nextEventText(item.nextEvent);

  return (
    <div ref={ref} className={cn(
      'rounded-2xl bg-white dark:bg-slate-900 border transition-colors',
      open ? 'border-indigo-200 dark:border-indigo-800' : 'border-slate-100 dark:border-slate-800'
    )}>
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-3 text-left">
        <div className="flex-1 min-w-0">
          <p className="font-black truncate">
            {stock.name} <span className="text-xs font-bold text-slate-400">{stock.symbol}</span>
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
            {cleared ? '已清倉' : `${num(stock.shares)} 股`}
            {next && <span className={cn('ml-1.5 font-bold', item.nextEvent?.type === 'payment' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>・{next}</span>}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="font-black tabular-nums">{money(item.year?.total || 0)}</p>
          <p className="text-[11px] text-slate-400">今年股息</p>
        </div>
        <ChevronDown className={cn('w-4 h-4 text-slate-300 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open && <HoldingDetail item={item} {...h} />}
    </div>
  );
}

function HoldingDetail({ item, ...h }: Handlers & { item: HoldingItem }) {
  const { stock } = item;
  const info = stock.dividendInfo;
  const cleared = stock.shares <= 0;
  const [showEtf, setShowEtf] = useState(false);
  const components = info?.etfComponents || info?.topComponents || [];
  const unrealized = stock.cost && stock.cost > 0 && stock.shares > 0 ? item.value - stock.cost * stock.shares : null;

  return (
    <div className="px-4 pb-4 space-y-3 border-t border-slate-100 dark:border-slate-800 pt-3">
      {/* 股數與成本（可直接修改） */}
      <div className="grid grid-cols-2 gap-2">
        <EditableNumber label="持有股數" value={stock.shares} onCommit={(v) => h.onUpdateShares(stock.symbol, v)} integer />
        <EditableNumber label="平均成本" value={stock.cost ?? 0} onCommit={(v) => h.onUpdateCost(stock.symbol, v)} placeholder="未填" />
      </div>

      {/* 股息 */}
      <div className="rounded-2xl bg-slate-50 dark:bg-slate-800/50 p-3 space-y-2 text-sm">
        <Line label="今年已領" value={money(item.year?.received || 0)} valueCls="text-emerald-600 dark:text-emerald-400" />
        <Line label="今年未領" value={money(item.year?.pending || 0)} valueCls="text-amber-600 dark:text-amber-400" />
        {info?.exDividendDate && <Line label="最近除息" value={`${dateLabel(info.exDividendDate)}・每股 $${info.amount ?? '-'}`} />}
        {info?.paymentDate && <Line label="最近發放" value={dateLabel(info.paymentDate)} />}
      </div>

      {/* 市值（參考） */}
      {!cleared && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <Mini label="現價" value={item.price ? `$${item.price}` : '-'} />
          <Mini label="殖利率" value={item.yieldPct !== null ? `${item.yieldPct.toFixed(2)}%` : '-'} />
          <Mini label="佔比" value={`${item.weight.toFixed(1)}%`} />
          <Mini label="市值" value={money(item.value)} />
          <Mini label="未實現" value={unrealized === null ? '-' : `${unrealized >= 0 ? '+' : ''}${money(unrealized)}`}
            valueCls={unrealized === null ? '' : unrealized >= 0 ? 'text-rose-500' : 'text-emerald-600'} />
          <Mini label="報酬率" value={unrealized === null || !stock.cost ? '-' : `${(unrealized / (stock.cost * stock.shares) * 100).toFixed(1)}%`}
            valueCls={unrealized === null ? '' : unrealized >= 0 ? 'text-rose-500' : 'text-emerald-600'} />
        </div>
      )}

      <TradeSection
        shares={stock.shares}
        trades={stock.trades}
        onTrade={(side) => h.onTrade(stock.symbol, side)}
        onUndo={() => h.onUndoTrade(stock.symbol)}
      />

      {info?.isEtf && components.length > 0 && (
        <div>
          <button onClick={() => setShowEtf(!showEtf)} className="h-10 text-sm font-bold text-slate-500 inline-flex items-center gap-1">
            主要成分股 <ChevronDown className={cn('w-4 h-4 transition-transform', showEtf && 'rotate-180')} />
          </button>
          {showEtf && (
            <div className="rounded-2xl bg-slate-50 dark:bg-slate-800/50 p-3 space-y-1.5 text-sm">
              {components.slice(0, 10).map((c, i) => (
                <div key={i} className="flex justify-between gap-2">
                  <span className="truncate">{c.name}</span>
                  <span className="tabular-nums text-slate-500">{typeof c.weight === 'number' ? `${c.weight}%` : c.weight}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 底部：資料時間、重新整理、刪除（刪除與其他按鈕分開，避免誤按） */}
      <div className="flex items-center justify-between pt-1">
        <p className="text-[11px] text-slate-400 truncate">{item.updatedLabel ? `更新於 ${item.updatedLabel}` : ''}</p>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => h.onRefresh(stock.symbol)} aria-label="重新整理"
            className="w-11 h-11 flex items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            <RefreshCw className={cn('w-4 h-4', h.refreshing.has(stock.symbol) && 'animate-spin')} />
          </button>
          <span className="w-4" />
          <button onClick={() => h.onDelete(stock.symbol, stock.name)} aria-label="刪除"
            className="w-11 h-11 flex items-center justify-center rounded-full text-slate-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Line({ label, value, valueCls }: { label: string; value: string; valueCls?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className={cn('font-bold tabular-nums text-right', valueCls)}>{value}</span>
    </div>
  );
}

function Mini({ label, value, valueCls }: { label: string; value: string; valueCls?: string }) {
  return (
    <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 py-2 px-1">
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className={cn('text-sm font-bold tabular-nums truncate', valueCls)}>{value}</p>
    </div>
  );
}

function EditableNumber({ label, value, onCommit, integer, placeholder }: {
  label: string; value: number; onCommit: (v: number) => void; integer?: boolean; placeholder?: string;
}) {
  return (
    <label className="block rounded-2xl bg-slate-50 dark:bg-slate-800/50 px-3 py-2">
      <span className="text-xs font-bold text-slate-400">{label}</span>
      <input
        key={`${label}-${value}`}
        type="number"
        inputMode={integer ? 'numeric' : 'decimal'}
        step="any"
        defaultValue={value || ''}
        placeholder={placeholder}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => {
          const v = e.target.value === '' ? 0 : Number(e.target.value);
          if (Number.isFinite(v) && v !== value) onCommit(integer ? Math.floor(v) : v);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="w-full h-9 bg-transparent text-lg font-black tabular-nums focus:outline-none placeholder:text-slate-300"
      />
    </label>
  );
}
