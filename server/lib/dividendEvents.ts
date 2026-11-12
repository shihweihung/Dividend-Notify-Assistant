import moment from "moment-timezone";
import { normalizeSymbol } from "./symbols";

// 原本在 runDividendNotifyCore 內，users 與 telegram_chats 兩段各複製一份；抽出後邏輯完全相同

export type DividendEvent = { type: 'ex-dividend' | 'payment'; amount: number; exDateStr?: string };

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

      if (!payDateStr && exDateStr) {
        const mEx = moment(exDateStr);
        if (mEx.isValid()) {
          payDateStr = mEx.add(1, 'month').format('YYYY-MM-DD');
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
          exDateStr
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
