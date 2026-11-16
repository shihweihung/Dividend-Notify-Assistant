// 前端（網頁）與後端（Telegram 通知）共用的股息計算。
// 這裡只放純函式，不可引用 Firebase、Express、React 或任何會碰網路的套件，
// 以確保網頁上看到的金額與 Telegram 通知的金額永遠用同一套規則算出來。
import { adjustSharesWithTrades, sharesAtExDateFromCurrent, type Trade } from './trades';

// ---------------------------------------------------------------------------
// 基本格式整理
// ---------------------------------------------------------------------------

export function normalizeSymbol(sym: any): string {
  if (!sym) return '';
  return sym.toString().trim().toUpperCase().replace(/\.(TW|TWO)$/i, '');
}

/** 日期統一成 YYYY-MM-DD；無法辨識時回傳空字串（非字串）或清理後的原字串 */
export function normalizeDateStr(d: any): string {
  if (!d || typeof d !== 'string') return '';
  const cleaned = d.trim().replace(/\//g, '-');
  const parts = cleaned.split('-');
  if (parts.length === 3) {
    const y = parts[0];
    const m = parts[1].padStart(2, '0');
    const day = parts[2].padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return cleaned;
}

/** YYYY-MM-DD 加一個月；遇到月底會自動調整（01-31 → 02-28），與 moment().add(1, 'month') 相同 */
export function addOneMonth(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalizeDateStr(dateStr));
  if (!m) return '';
  let year = Number(m[1]);
  let month = Number(m[2]) + 1;
  if (month > 12) { month = 1; year += 1; }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Number(m[3]), lastDay);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 股利紀錄
// ---------------------------------------------------------------------------

export type DividendRecord = {
  exDate: string;            // 除息日 YYYY-MM-DD
  payDate: string;           // 發放日 YYYY-MM-DD（可能是推估）
  payDateEstimated: boolean; // 發放日未公布，以除息日 +1 個月推估
  amount: number;            // 每股現金股利（未知時為 0）
};

/**
 * 取出一檔股票的所有現金股利紀錄（依除息日排序、同一除息日只留一筆）。
 * 來源：history（或舊欄位 dividendHistory），再加上最上層最新一次的 exDividendDate / paymentDate
 * （剛公告、還沒進 history 的配息只會出現在最上層）。
 */
export function getDividendRecords(info: any, stock: any = {}): DividendRecord[] {
  if (!info) return [];
  const list: any[] = Array.isArray(info.history) && info.history.length > 0
    ? info.history
    : Array.isArray(info.dividendHistory) ? info.dividendHistory : [];
  const latest = {
    date: info.exDividendDate || stock?.exDividendDate,
    paymentDate: info.paymentDate || stock?.paymentDate,
    amount: info.amount,
  };

  const byExDate = new Map<string, DividendRecord>();
  const add = (div: any, fillOnly: boolean) => {
    if (!div) return;
    const exDate = normalizeDateStr(div.date || div.exDividendDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exDate)) return;
    const rawPay = normalizeDateStr(div.paymentDate || div.payDate);
    const hasPay = /^\d{4}-\d{2}-\d{2}$/.test(rawPay);
    const existing = byExDate.get(exDate);
    if (existing) {
      // 同一除息日已經有紀錄：只補上缺少的發放日 / 金額
      if (existing.payDateEstimated && hasPay) { existing.payDate = rawPay; existing.payDateEstimated = false; }
      if (!existing.amount && Number(div.amount) > 0) existing.amount = Number(div.amount);
      return;
    }
    if (fillOnly && list.length > 0 && byExDate.size > 0 && exDate < [...byExDate.keys()].sort().slice(-1)[0]) {
      // 最上層資料比 history 最新一筆還舊，視為過期資料，不加入
      return;
    }
    byExDate.set(exDate, {
      exDate,
      payDate: hasPay ? rawPay : addOneMonth(exDate),
      payDateEstimated: !hasPay,
      amount: Number(div.amount) || 0,
    });
  };
  for (const div of list) add(div, false);
  add(latest, true);
  return [...byExDate.values()].sort((a, b) => a.exDate.localeCompare(b.exDate));
}

// ---------------------------------------------------------------------------
// 持股與除息日股數
// ---------------------------------------------------------------------------

/** 同代號合併：股數相加、成本加權平均（2330 與 2330.TW 視為同一檔） */
export function dedupeStocksBySymbol(rawStocks: any[]): any[] {
  const stockMap = new Map<string, any>();
  for (const s of rawStocks || []) {
    if (!s || !s.symbol) continue;
    const cleanSym = normalizeSymbol(s.symbol);
    if (!cleanSym) continue;
    if (!stockMap.has(cleanSym)) {
      stockMap.set(cleanSym, { ...s, symbol: cleanSym });
    } else {
      const existing = stockMap.get(cleanSym)!;
      stockMap.set(cleanSym, {
        ...existing,
        symbol: cleanSym,
        shares: (Number(existing.shares) || 0) + (Number(s.shares) || 0),
        cost: (() => {
          const exShares = Number(existing.shares) || 0;
          const newShares = Number(s.shares) || 0;
          const totalShares = exShares + newShares;
          const exCost = Number(existing.cost) || 0;
          const newCost = Number(s.cost) || 0;
          if (totalShares <= 0) return existing.cost ?? s.cost ?? null;
          if (exCost <= 0 && newCost <= 0) return null;
          const weighted = ((exShares * exCost) + (newShares * newCost)) / totalShares;
          return Math.round(weighted * 100) / 100;
        })(),
        dividendInfo: existing.dividendInfo || s.dividendInfo,
        name: (existing.name && existing.name !== cleanSym) ? existing.name : (s.name || cleanSym)
      });
    }
  }
  return Array.from(stockMap.values());
}

export type HoldingSnapshot = { date: string; stocks?: any[] };

function sharesInSnapshot(snap: HoldingSnapshot, symbol: string): number {
  const hit = dedupeStocksBySymbol(snap.stocks || []).find((s) => s.symbol === normalizeSymbol(symbol));
  return hit ? (Number(hit.shares) || 0) : 0;
}

/**
 * 除息日「前一天（含更早）」最後一份快照裡的股數。
 * 除息日當天才買的股票領不到這次股息，所以不能用除息日當天的快照。
 * - 回傳 null：找不到除息日前的快照
 * - 回傳 0：當時沒有持有這檔
 */
export function sharesBeforeExDate(snapshots: HoldingSnapshot[], symbol: string, exDateStr: string): number | null {
  const target = normalizeDateStr(exDateStr);
  if (!target) return null;
  let best: HoldingSnapshot | null = null;
  let bestDate = '';
  for (const snap of snapshots || []) {
    const d = normalizeDateStr(snap?.date);
    if (d && d < target && d > bestDate) {
      best = snap;
      bestDate = d;
    }
  }
  return best ? sharesInSnapshot(best, symbol) : null;
}

export type SharesSource =
  | 'before-ex-date'    // 除息日前一天的快照（準確）
  | 'earliest-snapshot' // 除息日在開始記錄快照之前，用最早一份快照估算
  | 'current';          // 完全沒有快照，用目前持股估算

/**
 * 計算某次股利能領的股數，並標示依據。網頁與 Telegram 通知都用這個函式。
 * @param currentShares 目前持股（已賣光的股票傳 0）
 */
export function resolveSharesAtExDate(
  snapshots: HoldingSnapshot[],
  symbol: string,
  exDateStr: string,
  currentShares: number,
  trades: Trade[] = [],
): { shares: number; source: SharesSource } {
  const exDate = normalizeDateStr(exDateStr);
  let before: HoldingSnapshot | null = null;
  let beforeDate = '';
  let earliest: HoldingSnapshot | null = null;
  let earliestDate = '';
  for (const snap of snapshots || []) {
    const d = normalizeDateStr(snap?.date);
    if (!d) continue;
    if (d < exDate && d > beforeDate) { before = snap; beforeDate = d; }
    if (!earliestDate || d < earliestDate) { earliest = snap; earliestDate = d; }
  }
  // 有交易紀錄時，用成交日修正快照（補登、除息日當天的買賣都能算對）
  if (before) {
    return { shares: adjustSharesWithTrades(sharesInSnapshot(before, symbol), beforeDate, exDate, trades), source: 'before-ex-date' };
  }
  if (earliest) {
    return { shares: adjustSharesWithTrades(sharesInSnapshot(earliest, symbol), earliestDate, exDate, trades), source: 'earliest-snapshot' };
  }
  return { shares: sharesAtExDateFromCurrent(Number(currentShares) || 0, exDate, trades), source: 'current' };
}

// ---------------------------------------------------------------------------
// 金額
// ---------------------------------------------------------------------------

/** 每筆現金股利的匯費（使用者設定：只扣匯費，不扣二代健保） */
export const REMITTANCE_FEE = 10;

/** 實際入帳金額：股數 × 每股股利，元以下捨去，再扣匯費（不會小於 0） */
export function estimateNetPayment(amountPerShare: number, shares: number): number {
  const gross = Math.floor((Number(amountPerShare) || 0) * (Number(shares) || 0) + 1e-6);
  return Math.max(gross - REMITTANCE_FEE, 0);
}

// ---------------------------------------------------------------------------
// 年度彙總（網頁的「今年已領 / 未領」、月股息圖、歷年股息都用這個）
// ---------------------------------------------------------------------------

export type PaymentItem = {
  symbol: string;
  name: string;
  exDate: string;
  payDate: string;
  payDateEstimated: boolean;
  amountPerShare: number;
  shares: number;
  sharesSource: SharesSource;
  net: number;        // 實際入帳（已扣匯費）
  isPending: boolean; // 發放日在今天之後
};

export type StockYearSummary = {
  symbol: string;
  name: string;
  received: number;
  pending: number;
  total: number;
  payments: number;      // 這一年領幾次
  perShareTotal: number; // 這一年每股股利合計
};

export type YearSummary = {
  year: number;
  received: number;
  pending: number;
  total: number;
  monthly: { received: number; pending: number; items: PaymentItem[] }[]; // 12 個月，依發放月份
  byStock: StockYearSummary[]; // 依全年金額由大到小
  items: PaymentItem[];
};

/**
 * 算出某一年（依發放日）的股息：已領、未領、每月、每檔。
 * 「已領 / 未領」用 todayStr 即時判斷，過了發放日就自動算已領。
 * @param stocks 目前的持股清單（含已清倉、股數為 0 的股票，才能算到賣掉前領的股息）
 */
export function computeYearDividends(params: {
  stocks: any[];
  snapshots: HoldingSnapshot[];
  year: number;
  todayStr: string;
}): YearSummary {
  const { stocks, snapshots, year, todayStr } = params;
  const yearPrefix = `${year}-`;
  const monthly = Array.from({ length: 12 }, () => ({ received: 0, pending: 0, items: [] as PaymentItem[] }));
  const items: PaymentItem[] = [];
  const byStockMap = new Map<string, StockYearSummary>();

  for (const stock of dedupeStocksBySymbol(stocks)) {
    const symbol = stock.symbol;
    const name = (stock.name && stock.name !== symbol) ? stock.name : (stock.dividendInfo?.name || symbol);
    for (const rec of getDividendRecords(stock.dividendInfo, stock)) {
      if (!rec.payDate.startsWith(yearPrefix) || rec.amount <= 0) continue;
      const { shares, source } = resolveSharesAtExDate(snapshots, symbol, rec.exDate, Number(stock.shares) || 0, stock.trades || []);
      if (shares <= 0) continue;
      const net = estimateNetPayment(rec.amount, shares);
      if (net <= 0) continue;

      const item: PaymentItem = {
        symbol,
        name,
        exDate: rec.exDate,
        payDate: rec.payDate,
        payDateEstimated: rec.payDateEstimated,
        amountPerShare: rec.amount,
        shares,
        sharesSource: source,
        net,
        isPending: rec.payDate > todayStr,
      };
      items.push(item);

      const monthIdx = Number(rec.payDate.slice(5, 7)) - 1;
      if (item.isPending) monthly[monthIdx].pending += net;
      else monthly[monthIdx].received += net;
      monthly[monthIdx].items.push(item);

      const s = byStockMap.get(symbol) || { symbol, name, received: 0, pending: 0, total: 0, payments: 0, perShareTotal: 0 };
      if (item.isPending) s.pending += net;
      else s.received += net;
      s.total += net;
      s.payments += 1;
      s.perShareTotal = Math.round((s.perShareTotal + rec.amount) * 10000) / 10000;
      byStockMap.set(symbol, s);
    }
  }

  for (const m of monthly) m.items.sort((a, b) => b.net - a.net);
  const byStock = [...byStockMap.values()].sort((a, b) => b.total - a.total);
  const received = byStock.reduce((a, s) => a + s.received, 0);
  const pending = byStock.reduce((a, s) => a + s.pending, 0);
  return { year, received, pending, total: received + pending, monthly, byStock, items };
}

/** 有股息資料的年份（依發放日），由小到大 */
export function yearsWithDividends(stocks: any[]): number[] {
  const years = new Set<number>();
  for (const stock of stocks || []) {
    for (const rec of getDividendRecords(stock?.dividendInfo, stock)) {
      if (rec.amount > 0) years.add(Number(rec.payDate.slice(0, 4)));
    }
  }
  return [...years].filter((y) => y > 2000).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 除息 / 領息事件清單（首頁「接下來」、月曆、每檔股票的下一個事件都用這個）
// ---------------------------------------------------------------------------

export type DividendEventItem = {
  date: string;            // 事件日期 YYYY-MM-DD
  type: 'ex-dividend' | 'payment';
  symbol: string;
  name: string;
  amountPerShare: number;
  exDate: string;
  payDate: string;
  payDateEstimated: boolean;
  shares: number;          // 能領的股數（除息日前一天）；除息事件為目前持股
  sharesSource: SharesSource;
  net: number;             // 預計入帳（已扣匯費）；除息事件為依目前持股估算的金額
};

/**
 * 列出 [from, to] 期間的除息與領息事件（含頭尾），依日期排序。
 * - 除息：只列目前還持有的股票，金額以目前股數估算
 * - 領息：以除息日前一天的股數計算；當時沒持有就不列
 */
export function listDividendEvents(params: {
  stocks: any[];
  snapshots: HoldingSnapshot[];
  from: string;
  to: string;
}): DividendEventItem[] {
  const { stocks, snapshots, from, to } = params;
  const events: DividendEventItem[] = [];
  for (const stock of dedupeStocksBySymbol(stocks)) {
    const symbol = stock.symbol;
    const name = (stock.name && stock.name !== symbol) ? stock.name : (stock.dividendInfo?.name || symbol);
    const currentShares = Number(stock.shares) || 0;
    for (const rec of getDividendRecords(stock.dividendInfo, stock)) {
      const amount = rec.amount || Number(stock.dividendInfo?.amount) || 0;
      if (rec.exDate >= from && rec.exDate <= to && currentShares > 0) {
        events.push({
          date: rec.exDate, type: 'ex-dividend', symbol, name, amountPerShare: amount,
          exDate: rec.exDate, payDate: rec.payDate, payDateEstimated: rec.payDateEstimated,
          shares: currentShares, sharesSource: 'current', net: estimateNetPayment(amount, currentShares),
        });
      }
      if (rec.payDate >= from && rec.payDate <= to && amount > 0) {
        const { shares, source } = resolveSharesAtExDate(snapshots, symbol, rec.exDate, currentShares, stock.trades || []);
        if (shares <= 0) continue;
        events.push({
          date: rec.payDate, type: 'payment', symbol, name, amountPerShare: amount,
          exDate: rec.exDate, payDate: rec.payDate, payDateEstimated: rec.payDateEstimated,
          shares, sharesSource: source, net: estimateNetPayment(amount, shares),
        });
      }
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || b.net - a.net);
}

/** YYYY-MM-DD 加減天數 */
export function addDays(dateStr: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalizeDateStr(dateStr));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}
