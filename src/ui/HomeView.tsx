import * as React from 'react';
import { CalendarClock, Wallet } from 'lucide-react';
import type { DividendEventItem, YearSummary } from '../../shared/dividendCalc';
import { dateLabel, money, num, relativeDay } from './format';
import { cn } from '../components/utils';

// 首頁：今年股息總覽 + 接下來的除息 / 領息

export function SummaryCards({ summary, todayStr }: { summary: YearSummary; todayStr: string }) {
  const isCurrentYear = Number(todayStr.slice(0, 4)) === summary.year;
  return (
    <div className="grid grid-cols-3 gap-2">
      <Stat label={isCurrentYear ? '今年已領' : `${summary.year} 已領`} value={money(summary.received)} tone="green" />
      <Stat label={isCurrentYear ? '今年未領' : `${summary.year} 未領`} value={money(summary.pending)} tone="amber" />
      <Stat label={`${summary.year} 全年`} value={money(summary.total)} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'amber' }) {
  return (
    <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 px-3 py-3">
      <p className="text-xs font-bold text-slate-400">{label}</p>
      <p className={cn(
        'mt-1 text-base sm:text-xl font-black tabular-nums truncate',
        tone === 'green' && 'text-emerald-600 dark:text-emerald-400',
        tone === 'amber' && 'text-amber-600 dark:text-amber-400',
      )}>{value}</p>
    </div>
  );
}

export function EventRow({ ev, todayStr, onClick }: { ev: DividendEventItem; todayStr: string; onClick?: () => void }) {
  const isPay = ev.type === 'payment';
  const past = ev.date < todayStr;
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-3 rounded-2xl text-left transition-colors',
        'bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 hover:border-indigo-200 dark:hover:border-indigo-800',
        past && 'opacity-60'
      )}
    >
      <div className={cn(
        'w-12 shrink-0 rounded-xl py-1.5 text-center',
        isPay ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400'
      )}>
        <p className="text-[11px] font-bold leading-tight">{isPay ? '領息' : '除息'}</p>
        <p className="text-sm font-black leading-tight">{dateLabel(ev.date, false)}</p>
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-black truncate">{ev.name} <span className="text-xs font-bold text-slate-400">{ev.symbol}</span></p>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
          {relativeDay(ev.date, todayStr)}・每股 ${ev.amountPerShare}・{num(ev.shares)} 股
          {ev.sharesSource !== 'before-ex-date' && isPay && '（估）'}
          {ev.payDateEstimated && isPay && '・日期推估'}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className={cn('font-black tabular-nums', isPay ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-200')}>
          {money(ev.net)}
        </p>
        {!isPay && <p className="text-[11px] text-slate-400">預估</p>}
      </div>
    </button>
  );
}

export function HomeView({ summary, upcoming, recent, todayStr, onOpenStock, hasStocks, onAddStock }: {
  summary: YearSummary;
  upcoming: DividendEventItem[];
  recent: DividendEventItem[];
  todayStr: string;
  onOpenStock: (symbol: string) => void;
  hasStocks: boolean;
  onAddStock: () => void;
}) {
  if (!hasStocks) {
    return (
      <div className="text-center py-16 space-y-4">
        <Wallet className="w-12 h-12 mx-auto text-slate-300" />
        <p className="font-bold text-slate-500">還沒有持股，先新增一檔股票吧</p>
        <button onClick={onAddStock} className="h-12 px-6 rounded-xl bg-indigo-600 text-white font-black">新增股票</button>
      </div>
    );
  }
  const upcomingTotal = upcoming.filter(e => e.type === 'payment').reduce((a, e) => a + e.net, 0);
  return (
    <div className="space-y-6">
      <SummaryCards summary={summary} todayStr={todayStr} />

      <section>
        <div className="flex items-baseline justify-between mb-2 px-1">
          <h2 className="text-base font-black flex items-center gap-1.5"><CalendarClock className="w-4 h-4 text-indigo-500" />接下來 60 天</h2>
          {upcomingTotal > 0 && <p className="text-xs font-bold text-slate-400">預計入帳 <span className="text-emerald-600 dark:text-emerald-400">{money(upcomingTotal)}</span></p>}
        </div>
        {upcoming.length === 0 ? (
          <p className="text-sm text-slate-400 px-1 py-6 text-center">近期沒有除息或領息</p>
        ) : (
          <div className="space-y-2">
            {upcoming.map(ev => <EventRow key={`${ev.type}-${ev.symbol}-${ev.date}`} ev={ev} todayStr={todayStr} onClick={() => onOpenStock(ev.symbol)} />)}
          </div>
        )}
      </section>

      {recent.length > 0 && (
        <section>
          <h2 className="text-base font-black mb-2 px-1">最近 30 天領到</h2>
          <div className="space-y-2">
            {recent.map(ev => <EventRow key={`${ev.type}-${ev.symbol}-${ev.date}`} ev={ev} todayStr={todayStr} onClick={() => onOpenStock(ev.symbol)} />)}
          </div>
        </section>
      )}
    </div>
  );
}
