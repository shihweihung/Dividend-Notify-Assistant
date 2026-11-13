import moment from "moment-timezone";
import { normalizeSymbol } from "./symbols";

// 原本在 runDividendNotifyCore 內，users 與 telegram_chats 兩段各複製一份；抽出後邏輯完全相同

export type DividendEvent = { type: 'ex-dividend' | 'payment'; amount: number; exDateStr?: string; payDateEstimated?: boolean };

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

// Deduplicate stocks array by normalized symbol (股數相加、成本加權平均)
export function dedupeStocksBySymbol(rawStocks: any[]): any[] {
  const stockMap = new Map<string, any>();
  for (const s of rawStocks) {
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

// 找出某檔持股在 todayStr 當天的除息 / 發放事件
export function findDividendEventsForDate(info: any, stock: any, todayStr: string): DividendEvent[] {
  const eventsToNotify: DividendEvent[] = [];

  if (info.history && Array.isArray(info.history) && info.history.length > 0) {
    const seenEx = new Set<string>();
    const seenPay = new Set<string>();

    for (const div of info.history) {
      const exDateStr = normalizeDateStr(div.date);
      let payDateStr = normalizeDateStr(div.paymentDate || div.payDate);
      let payDateEstimated = false;

      if (!payDateStr && exDateStr) {
        const mEx = moment(exDateStr);
        if (mEx.isValid()) {
          payDateStr = mEx.add(1, 'month').format('YYYY-MM-DD');
          payDateEstimated = true;
        }
      }

      if (exDateStr === todayStr && !seenEx.has(exDateStr)) {
        seenEx.add(exDateStr);
        eventsToNotify.push({
          type: 'ex-dividend',
          amount: Number(div.amount || info.amount || 0),
          exDateStr
        });
      }

      if (payDateStr === todayStr && !seenPay.has(payDateStr)) {
        seenPay.add(payDateStr);
        eventsToNotify.push({
          type: 'payment',
          amount: Number(div.amount || info.amount || 0),
          exDateStr,
          ...(payDateEstimated ? { payDateEstimated: true } : {})
        });
      }
    }
  } else {
    const exDateStr = normalizeDateStr(info.exDividendDate || stock.exDividendDate);
    const payDateStr = normalizeDateStr(info.paymentDate || stock.paymentDate);

    if (exDateStr === todayStr) {
      eventsToNotify.push({
        type: 'ex-dividend',
        amount: Number(info.amount || 0),
        exDateStr
      });
    }
    if (payDateStr === todayStr) {
      eventsToNotify.push({
        type: 'payment',
        amount: Number(info.amount || 0),
        exDateStr
      });
    }
  }
  return eventsToNotify;
}

// ---------------------------------------------------------------------------
// 領息金額計算
// ---------------------------------------------------------------------------

export type HoldingSnapshot = { date: string; stocks?: any[] };

// 每筆現金股利的匯費（使用者設定：只扣匯費，不扣二代健保）
export const REMITTANCE_FEE = 10;

/**
 * 除息日「前一天（含更早）」最後一份快照裡的股數。
 * 除息日當天才買的股票領不到這次股息，所以不能用除息日當天的快照。
 * - 回傳 null：找不到除息日前的快照（無法判斷，呼叫端需註明是估算）
 * - 回傳 0：當時沒有持有這檔
 */
export function sharesBeforeExDate(snapshots: HoldingSnapshot[], symbol: string, exDateStr: string): number | null {
  const target = normalizeDateStr(exDateStr);
  if (!target) return null;
  let best: HoldingSnapshot | null = null;
  let bestDate = '';
  for (const snap of snapshots) {
    const d = normalizeDateStr(snap?.date);
    if (d && d < target && d > bestDate) {
      best = snap;
      bestDate = d;
    }
  }
  if (!best) return null;
  const hit = dedupeStocksBySymbol(best.stocks || []).find((s) => s.symbol === normalizeSymbol(symbol));
  return hit ? (Number(hit.shares) || 0) : 0;
}

/**
 * 要檢查股息事件的股票清單：目前持股 + 近期快照中出現過、但已經賣掉的股票。
 * 除息後才賣掉的股票股息照樣入帳，所以也要通知。
 * 同一檔以「目前持股」的資料為準，其次是最新的快照。
 */
export function collectDividendCandidates(currentStocks: any[], snapshots: HoldingSnapshot[]): { stock: any; holdsNow: boolean }[] {
  const result: { stock: any; holdsNow: boolean }[] = [];
  const seen = new Set<string>();
  for (const stock of dedupeStocksBySymbol(currentStocks || [])) {
    seen.add(stock.symbol);
    result.push({ stock, holdsNow: true });
  }
  const newestFirst = [...(snapshots || [])].sort((a, b) =>
    normalizeDateStr(b?.date).localeCompare(normalizeDateStr(a?.date)));
  for (const snap of newestFirst) {
    for (const stock of dedupeStocksBySymbol(snap?.stocks || [])) {
      if (seen.has(stock.symbol)) continue;
      seen.add(stock.symbol);
      result.push({ stock, holdsNow: false });
    }
  }
  return result;
}

/** 預計入帳金額：股數 × 每股股利，元以下捨去，再扣匯費（不會小於 0） */
export function estimateNetPayment(amountPerShare: number, shares: number): number {
  const gross = Math.floor(amountPerShare * shares + 1e-6);
  return Math.max(gross - REMITTANCE_FEE, 0);
}

export function buildPaymentMessage(opts: {
  stockName: string;
  symbol: string;
  amountPerShare: number;
  shares: number;
  sharesFromCurrentHoldings: boolean;
  payDateEstimated?: boolean;
}): string {
  const net = estimateNetPayment(opts.amountPerShare, opts.shares);
  const lines = [
    `💰 今天是 ${opts.stockName}(${opts.symbol}) 的領息日！預計入帳 $${net.toLocaleString()}`,
    `（${opts.shares.toLocaleString()} 股 × 每股 $${opts.amountPerShare}，已扣匯費 $${REMITTANCE_FEE}）`,
  ];
  if (opts.sharesFromCurrentHoldings) lines.push('⚠️ 找不到除息日前的持股紀錄，以目前持股估算');
  if (opts.payDateEstimated) lines.push('⚠️ 發放日尚未公布，以除息日後一個月推估');
  return lines.join('\n');
}
