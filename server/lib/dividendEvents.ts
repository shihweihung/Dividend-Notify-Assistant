// 股息事件判斷（Telegram 通知用）。
// 金額、股數、發放日推估等規則都在 shared/dividendCalc.ts，與網頁共用同一份。
import {
  normalizeDateStr,
  dedupeStocksBySymbol,
  getDividendRecords,
  sharesBeforeExDate,
  resolveSharesAtExDate,
  estimateNetPayment,
  REMITTANCE_FEE,
  type HoldingSnapshot,
  type SharesSource,
} from "../../shared/dividendCalc";

export {
  normalizeDateStr,
  dedupeStocksBySymbol,
  sharesBeforeExDate,
  resolveSharesAtExDate,
  estimateNetPayment,
  REMITTANCE_FEE,
  type HoldingSnapshot,
  type SharesSource,
};

export type DividendEvent = { type: 'ex-dividend' | 'payment'; amount: number; exDateStr?: string; payDateEstimated?: boolean };

// 找出某檔持股在 todayStr 當天的除息 / 發放事件
export function findDividendEventsForDate(info: any, stock: any, todayStr: string): DividendEvent[] {
  const events: DividendEvent[] = [];
  if (!info) return events;
  const fallbackAmount = Number(info.amount) || 0;
  let exNotified = false;
  let payNotified = false;
  for (const rec of getDividendRecords(info, stock)) {
    const amount = rec.amount || fallbackAmount;
    if (rec.exDate === todayStr && !exNotified) {
      exNotified = true;
      events.push({ type: 'ex-dividend', amount, exDateStr: rec.exDate });
    }
    if (rec.payDate === todayStr && !payNotified) {
      payNotified = true;
      events.push({
        type: 'payment',
        amount,
        exDateStr: rec.exDate,
        ...(rec.payDateEstimated ? { payDateEstimated: true } : {}),
      });
    }
  }
  return events;
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

export function buildPaymentMessage(opts: {
  stockName: string;
  symbol: string;
  amountPerShare: number;
  shares: number;
  sharesSource: SharesSource;
  payDateEstimated?: boolean;
}): string {
  const net = estimateNetPayment(opts.amountPerShare, opts.shares);
  const lines = [
    `💰 今天是 ${opts.stockName}(${opts.symbol}) 的領息日！預計入帳 $${net.toLocaleString()}`,
    `（${opts.shares.toLocaleString()} 股 × 每股 $${opts.amountPerShare}，已扣匯費 $${REMITTANCE_FEE}）`,
  ];
  if (opts.sharesSource === 'current') lines.push('⚠️ 找不到除息日前的持股紀錄，以目前持股估算');
  if (opts.sharesSource === 'earliest-snapshot') lines.push('⚠️ 找不到除息日前的持股紀錄，以最早的持股紀錄估算');
  if (opts.payDateEstimated) lines.push('⚠️ 發放日尚未公布，以除息日後一個月推估');
  return lines.join('\n');
}
