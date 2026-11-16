import * as React from 'react';
import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { listDividendEvents, type HoldingSnapshot, type YearSummary } from '../../shared/dividendCalc';
import { cn } from '../components/utils';
import { EventRow, SummaryCards } from './HomeView';
import { money } from './format';

// 股息分頁：年份 → 總覽、每月長條圖、每檔明細、月曆

export function DividendsView({ years, selectedYear, onSelectYear, summary, stocks, snapshots, todayStr, onOpenStock }: {
  years: number[];
  selectedYear: number;
  onSelectYear: (y: number) => void;
  summary: YearSummary;
  stocks: any[];
  snapshots: HoldingSnapshot[];
  todayStr: string;
  onOpenStock: (symbol: string) => void;
}) {
  const monthly = summary.monthly.map((m, i) => ({ month: `${i + 1}月`, received: m.received, pending: m.pending }));
  const maxMonth = Math.max(...monthly.map(m => m.received + m.pending), 0);

  return (
    <div className="space-y-6">
      {years.length > 1 && (
        <div className="flex gap-2 overflow-x-auto -mx-1 px-1 pb-1">
          {years.map(y => (
            <button key={y} onClick={() => onSelectYear(y)}
              className={cn('h-10 px-4 rounded-full text-sm font-bold shrink-0 border',
                y === selectedYear ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-200 dark:border-slate-700 text-slate-500')}>
              {y}
            </button>
          ))}
        </div>
      )}

      <SummaryCards summary={summary} todayStr={todayStr} />

      <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-black">每月股息</h2>
          <div className="flex gap-3 text-xs font-bold text-slate-400">
            <span className="inline-flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />已領</span>
            <span className="inline-flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm bg-amber-400" />未領</span>
          </div>
        </div>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthly} margin={{ top: 4, right: 0, left: -12, bottom: 0 }}>
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} interval={0}
                tickFormatter={(v: string) => v.replace('月', '')} />
              <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={44}
                domain={[0, Math.ceil(maxMonth * 1.1) || 1]}
                tickFormatter={(v: number) => v >= 10000 ? `${Math.round(v / 1000)}k` : String(v)} />
              <Tooltip cursor={{ fill: 'rgba(148,163,184,0.12)' }}
                formatter={(v: number, k: string) => [money(v), k === 'received' ? '已領' : '未領']}
                contentStyle={{ borderRadius: 12, fontSize: 12 }} />
              <Bar dataKey="received" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} />
              <Bar dataKey="pending" stackId="a" fill="#fbbf24" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-4">
        <h2 className="text-base font-black mb-2">各檔股息</h2>
        {summary.byStock.length === 0 ? (
          <p className="text-sm text-slate-400 py-4 text-center">這一年沒有股息資料</p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {summary.byStock.map(s => (
              <button key={s.symbol} onClick={() => onOpenStock(s.symbol)} className="w-full flex items-center gap-3 py-3 text-left">
                <div className="flex-1 min-w-0">
                  <p className="font-bold truncate">{s.name} <span className="text-xs text-slate-400">{s.symbol}</span></p>
                  <p className="text-xs text-slate-400 mt-0.5">領 {s.payments} 次・每股合計 ${Number(s.perShareTotal.toFixed(4))}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-black tabular-nums">{money(s.total)}</p>
                  {s.pending > 0 && <p className="text-[11px] font-bold text-amber-600">未領 {money(s.pending)}</p>}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <CalendarSection stocks={stocks} snapshots={snapshots} todayStr={todayStr} onOpenStock={onOpenStock} />
    </div>
  );
}

function CalendarSection({ stocks, snapshots, todayStr, onOpenStock }: {
  stocks: any[]; snapshots: HoldingSnapshot[]; todayStr: string; onOpenStock: (symbol: string) => void;
}) {
  const [ym, setYm] = useState(() => todayStr.slice(0, 7));
  const [selected, setSelected] = useState<string>(todayStr);
  const [y, m] = ym.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();

  const events = useMemo(() => listDividendEvents({
    stocks, snapshots, from: `${ym}-01`, to: `${ym}-${String(daysInMonth).padStart(2, '0')}`,
  }), [stocks, snapshots, ym, daysInMonth]);
  const byDay = useMemo(() => {
    const map = new Map<string, typeof events>();
    for (const e of events) map.set(e.date, [...(map.get(e.date) || []), e]);
    return map;
  }, [events]);

  const shift = (delta: number) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    const next = d.toISOString().slice(0, 7);
    setYm(next);
    setSelected(next === todayStr.slice(0, 7) ? todayStr : `${next}-01`);
  };
  const selectedEvents = selected.startsWith(ym) ? (byDay.get(selected) || []) : [];
  const monthList = selectedEvents.length > 0 ? selectedEvents : [];

  return (
    <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-black">{y} 年 {m} 月</h2>
        <div className="flex gap-1">
          <button onClick={() => shift(-1)} aria-label="上個月" className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-800"><ChevronLeft className="w-5 h-5" /></button>
          <button onClick={() => shift(1)} aria-label="下個月" className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-800"><ChevronRight className="w-5 h-5" /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-xs font-bold text-slate-400 mb-1">
        {['日', '一', '二', '三', '四', '五', '六'].map(d => <div key={d} className="py-1">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: firstWeekday }).map((_, i) => <div key={`e${i}`} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const date = `${ym}-${String(i + 1).padStart(2, '0')}`;
          const evs = byDay.get(date) || [];
          const hasPay = evs.some(e => e.type === 'payment');
          const hasEx = evs.some(e => e.type === 'ex-dividend');
          return (
            <button key={date} onClick={() => setSelected(date)}
              className={cn('h-11 rounded-xl flex flex-col items-center justify-center text-sm font-bold tabular-nums',
                date === selected ? 'bg-indigo-600 text-white' : date === todayStr ? 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600' : 'hover:bg-slate-100 dark:hover:bg-slate-800')}>
              {i + 1}
              <span className="flex gap-0.5 h-1.5 mt-0.5">
                {hasEx && <i className={cn('w-1.5 h-1.5 rounded-full', date === selected ? 'bg-white' : 'bg-amber-400')} />}
                {hasPay && <i className={cn('w-1.5 h-1.5 rounded-full', date === selected ? 'bg-white' : 'bg-emerald-500')} />}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex gap-3 text-xs font-bold text-slate-400 mt-2">
        <span className="inline-flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-amber-400" />除息</span>
        <span className="inline-flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-emerald-500" />領息</span>
      </div>
      <div className="mt-3 space-y-2">
        {monthList.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-3">這天沒有除息或領息</p>
        ) : monthList.map(ev => (
          <EventRow key={`${ev.type}-${ev.symbol}-${ev.date}`} ev={ev} todayStr={todayStr} onClick={() => onOpenStock(ev.symbol)} />
        ))}
      </div>
    </section>
  );
}
