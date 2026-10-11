import React, { useState, useMemo } from 'react';
import { 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip as RechartsTooltip, 
  ResponsiveContainer 
} from 'recharts';
import { TrendingUp, ChevronDown, ChevronUp, Calendar, DollarSign } from 'lucide-react';
import { cn } from './utils';

export interface PortfolioSnapshot {
  date: string; // YYYY-MM-DD
  stocks?: any[];
  cash?: number;
  totalValue?: number;
  updatedAt?: any;
  createdAt?: any;
}

interface PortfolioTrendChartProps {
  snapshots: PortfolioSnapshot[];
  currentStockValue: number;
  darkMode: boolean;
}

type TimeRange = '7d' | '30d' | '90d' | 'all';

export const PortfolioTrendChart: React.FC<PortfolioTrendChartProps> = ({
  snapshots,
  currentStockValue,
  darkMode,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [timeRange, setTimeRange] = useState<TimeRange>('30d');

  // Process and sort chart data focusing exclusively on stock market value
  const chartData = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const map = new Map<string, { date: string; stockValue: number }>();

    // 1. Fill historical snapshots
    snapshots.forEach((snap) => {
      if (!snap || !snap.date) return;
      let snapStock = 0;

      if (snap.stocks && Array.isArray(snap.stocks) && snap.stocks.length > 0) {
        snapStock = snap.stocks.reduce((acc, s) => {
          const shares = Number(s.shares) || 0;
          const p = Number(s.currentPrice ?? s.dividendInfo?.currentPrice) || 0;
          return acc + shares * p;
        }, 0);
      } else if (snap.totalValue !== undefined && snap.totalValue !== null) {
        // Fallback: if stocks array is missing, deduce from totalValue - cash
        const snapCash = Number(snap.cash) || 0;
        const snapTotal = Number(snap.totalValue) || 0;
        snapStock = Math.max(0, snapTotal - snapCash);
      }

      map.set(snap.date, {
        date: snap.date,
        stockValue: Math.round(snapStock),
      });
    });

    // 2. Always ensure today has the latest live stock market value
    map.set(todayStr, {
      date: todayStr,
      stockValue: Math.round(currentStockValue),
    });

    // Sort by date ascending
    const sorted = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));

    // Filter by timeRange
    if (timeRange === 'all' || sorted.length <= 1) {
      return sorted;
    }

    const days = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 90;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);

    const filtered = sorted.filter((d) => d.date >= cutoffStr);
    // If filtered is empty or only 1 item, return at least the last items from sorted if available
    return filtered.length > 0 ? filtered : sorted.slice(-Math.min(days, sorted.length));
  }, [snapshots, currentStockValue, timeRange]);

  // Metric calculation: change and return over selected period
  const stats = useMemo(() => {
    if (chartData.length === 0) {
      return { diff: 0, pct: 0, startValue: currentStockValue, latestValue: currentStockValue };
    }
    const startValue = chartData[0].stockValue;
    const latestValue = chartData[chartData.length - 1].stockValue;
    const diff = latestValue - startValue;
    const pct = startValue > 0 ? (diff / startValue) * 100 : 0;
    return { diff, pct, startValue, latestValue };
  }, [chartData, currentStockValue]);

  // Format date display for X-axis (e.g. 10/06)
  const formatXAxis = (dateStr: string) => {
    if (!dateStr || dateStr.length < 5) return dateStr;
    return dateStr.slice(5).replace('-', '/');
  };

  // Format currency for Y-axis (e.g. 150萬 or $1.5M)
  const formatYAxis = (value: number) => {
    if (value >= 1000000) {
      return `${(value / 10000).toFixed(0)}萬`;
    }
    if (value >= 10000) {
      return `${(value / 10000).toFixed(1)}萬`;
    }
    return `${value.toLocaleString()}`;
  };

  return (
    <div
      className={cn(
        "rounded-2xl shadow-sm border transition-all overflow-hidden",
        darkMode ? "bg-slate-800 border-slate-700" : "bg-white border-slate-100"
      )}
    >
      {/* Card Header: Clickable to toggle collapse */}
      <div className="p-3.5 sm:p-4 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex-1 flex items-center gap-2.5 sm:gap-3 text-left group cursor-pointer min-w-0"
        >
          <div
            className={cn(
              "p-2 sm:p-2.5 rounded-xl shrink-0 transition-colors",
              darkMode ? "bg-indigo-950/40 text-indigo-400 border border-indigo-900/50" : "bg-indigo-50 text-indigo-600 border border-indigo-100"
            )}
          >
            <TrendingUp className="w-4 h-4 sm:w-5 sm:h-5" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className={cn("text-xs sm:text-sm font-black truncate", darkMode ? "text-slate-100" : "text-slate-800")}>
                股票市值趨勢
              </h2>
              <span
                className={cn(
                  "p-0.5 rounded-md transition-colors",
                  darkMode ? "text-slate-400 group-hover:bg-slate-700" : "text-slate-400 group-hover:bg-slate-100"
                )}
              >
                {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </span>
            </div>

            <div className="flex flex-wrap items-baseline gap-1.5 sm:gap-2 mt-0.5">
              <span className={cn("text-base sm:text-xl font-black font-mono", darkMode ? "text-slate-100" : "text-slate-900")}>
                ${Math.round(currentStockValue).toLocaleString()}
              </span>
              {chartData.length > 1 && (
                <span
                  className={cn(
                    "text-[10px] sm:text-xs font-black px-1.5 py-0.5 rounded-md font-mono shrink-0",
                    stats.diff >= 0
                      ? (darkMode ? "bg-rose-500/10 text-rose-400" : "bg-rose-50 text-rose-500")
                      : (darkMode ? "bg-emerald-500/10 text-emerald-400" : "bg-emerald-50 text-emerald-500")
                  )}
                >
                  {stats.diff >= 0 ? '▲ +' : '▼ '}${Math.abs(Math.round(stats.diff)).toLocaleString()} ({stats.pct >= 0 ? '+' : ''}{stats.pct.toFixed(2)}%)
                </span>
              )}
            </div>
          </div>
        </button>

        {/* Time Range Selector */}
        {isExpanded && (
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-700/60 shrink-0">
            {(['7d', '30d', '90d', 'all'] as TimeRange[]).map((r) => {
              const labels: Record<TimeRange, string> = {
                '7d': '7天',
                '30d': '30天',
                '90d': '90天',
                'all': '全部',
              };
              const active = timeRange === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setTimeRange(r)}
                  className={cn(
                    "px-2 py-1 text-[10px] font-black rounded-md transition-all cursor-pointer",
                    active
                      ? (darkMode ? "bg-indigo-600 text-white shadow-sm" : "bg-white text-indigo-600 shadow-sm")
                      : (darkMode ? "text-slate-400 hover:text-slate-200" : "text-slate-500 hover:text-slate-800")
                  )}
                >
                  {labels[r]}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Expandable Chart Content */}
      {isExpanded && (
        <div className="px-3 pb-3 sm:px-4 sm:pb-4 space-y-3 pt-1 border-t border-slate-100 dark:border-slate-700/60">
          {/* Quick Sub-metrics Pill */}
          <div className="grid grid-cols-2 gap-2 pt-2">
            <div
              className={cn(
                "p-2 rounded-xl border flex items-center justify-between",
                darkMode ? "bg-slate-900/40 border-slate-700/40" : "bg-slate-50 border-slate-100"
              )}
            >
              <div className="flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5 text-indigo-500" />
                <span className="text-[10px] font-bold text-slate-400">目前持股現值</span>
              </div>
              <span className="text-xs font-mono font-black text-indigo-500">
                ${Math.round(currentStockValue).toLocaleString()}
              </span>
            </div>

            <div
              className={cn(
                "p-2 rounded-xl border flex items-center justify-between",
                darkMode ? "bg-slate-900/40 border-slate-700/40" : "bg-slate-50 border-slate-100"
              )}
            >
              <div className="flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-[10px] font-bold text-slate-400">歷史紀錄點</span>
              </div>
              <span className="text-xs font-mono font-black text-slate-500 dark:text-slate-400">
                {chartData.length} 筆
              </span>
            </div>
          </div>

          {/* Chart Area */}
          <div className="w-full h-52 sm:h-60 pt-2">
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={chartData}
                  margin={{ top: 10, right: 10, left: -15, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="stockValueGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>

                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke={darkMode ? "rgba(148, 163, 184, 0.1)" : "rgba(226, 232, 240, 0.8)"}
                  />

                  <XAxis
                    dataKey="date"
                    tickFormatter={formatXAxis}
                    tick={{ fontSize: 10, fill: darkMode ? "#94a3b8" : "#64748b" }}
                    axisLine={{ stroke: darkMode ? "#334155" : "#e2e8f0" }}
                    tickLine={false}
                    minTickGap={20}
                  />

                  <YAxis
                    tickFormatter={formatYAxis}
                    tick={{ fontSize: 10, fill: darkMode ? "#94a3b8" : "#64748b" }}
                    axisLine={false}
                    tickLine={false}
                    domain={['auto', 'auto']}
                  />

                  <RechartsTooltip
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload.length) return null;
                      const item = payload[0].payload as {
                        date: string;
                        stockValue: number;
                      };
                      return (
                        <div
                          className={cn(
                            "p-2.5 rounded-xl shadow-xl border text-xs font-mono space-y-1.5",
                            darkMode
                              ? "bg-slate-900/95 border-slate-700 text-slate-100"
                              : "bg-white/95 border-slate-100 text-slate-800"
                          )}
                        >
                          <div className="font-bold border-b border-slate-200 dark:border-slate-800 pb-1 text-[11px] text-slate-500">
                            📅 {item.date}
                          </div>
                          <div className="flex items-center justify-between gap-4 font-black text-indigo-500">
                            <span>持股市值:</span>
                            <span>${item.stockValue.toLocaleString()}</span>
                          </div>
                        </div>
                      );
                    }}
                  />

                  <Area
                    type="monotone"
                    dataKey="stockValue"
                    stroke="#6366f1"
                    strokeWidth={2.5}
                    fillOpacity={1}
                    fill="url(#stockValueGradient)"
                    name="股票市值"
                    activeDot={{ r: 5, fill: "#6366f1", stroke: "#ffffff", strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-slate-400">
                暫無歷史快照資料
              </div>
            )}
          </div>

          {/* Bottom subtle note */}
          <div className="flex items-center justify-between text-[10px] text-slate-400 font-medium pt-1 px-1">
            <span>✨ 每日 08:00 自動記錄持股市值快照</span>
            {chartData.length <= 1 && (
              <span className="text-amber-500 font-bold">累積 2 天以上數據將自動呈現走勢起伏</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
