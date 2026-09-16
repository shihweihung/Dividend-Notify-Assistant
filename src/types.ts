export type EtfComponent = {
  name: string;
  symbol?: string;
  code?: string;
  weight: number | string; // percentage
}

export type DividendInfo = {
  symbol: string;
  name: string;
  exDividendDate: string; // YYYY-MM-DD
  paymentDate: string;    // YYYY-MM-DD
  amount: number; // Next/Latest single payment amount
  receivedAmountCurrentYear?: number; // Sum of dividends already paid in current year
  pendingAmountCurrentYear?: number; // Sum of dividends announced but not yet paid in current year
  monthlyDistribution?: number[]; // Array of 12 numbers representing received dividend amount per share for each month
  pendingMonthlyDistribution?: number[]; // Array of 12 numbers representing pending dividend amount per share for each month
  currentPrice?: number;
  yield?: number;
  updatedAt: string;
  isEtf?: boolean;
  topComponents?: EtfComponent[];
  etfComponents?: EtfComponent[];
  etfComponentsUpdatedAt?: string;
  source?: string;
  sourceUrl?: string;
  isPaymentDateEstimated?: boolean;
  status?: string;
  history?: any[];
}

export type StockEntry = {
  symbol: string;
  name: string;
  shares: number;
  cost?: number; // Average purchase price per share
  sellPrice?: number; // Selling price per share for realized profit calculation
  soldShares?: number; // Shares sold when cleared
  dividendInfo?: DividendInfo;
}

export type CalendarEvent = {
  date: Date;
  type: 'ex-dividend' | 'payment';
  stockName: string;
  symbol: string;
  amount?: number;
}

export function normalizeSymbol(sym: string): string {
  if (!sym) return '';
  return sym.toString().trim().toUpperCase().replace(/\.(TW|TWO)$/i, '');
}

export function deduplicateStocks<T extends StockEntry & { _docId?: string }>(stocks: T[]): {
  uniqueStocks: StockEntry[];
  duplicatesToRemove: string[];
  mergedSurvivingStocks: StockEntry[];
} {
  const map = new Map<string, StockEntry>();
  const mergedSymbols = new Set<string>();
  const duplicatesToRemove: string[] = [];
  const seenDocIds = new Set<string>();

  for (const stock of stocks) {
    if (!stock || !stock.symbol) continue;
    const cleanSym = normalizeSymbol(stock.symbol);
    const docId = stock._docId || stock.symbol;

    if (!map.has(cleanSym)) {
      map.set(cleanSym, {
        ...stock,
        symbol: cleanSym
      });
      seenDocIds.add(cleanSym);
      if (docId !== cleanSym) {
        duplicatesToRemove.push(docId);
        mergedSymbols.add(cleanSym);
      }
    } else {
      mergedSymbols.add(cleanSym);
      if (docId !== cleanSym || seenDocIds.has(docId)) {
        duplicatesToRemove.push(docId);
      } else {
        seenDocIds.add(docId);
      }

      const existing = map.get(cleanSym)!;
      const mergedShares = (existing.shares > 0 && stock.shares > 0)
        ? Math.max(existing.shares, stock.shares)
        : (existing.shares || stock.shares);

      const mergedCost = existing.cost && existing.cost > 0 ? existing.cost : stock.cost;
      const mergedDividendInfo = existing.dividendInfo?.amount ? existing.dividendInfo : (stock.dividendInfo || existing.dividendInfo);
      const mergedName = (existing.name && existing.name !== cleanSym) ? existing.name : (stock.name || cleanSym);

      map.set(cleanSym, {
        ...existing,
        symbol: cleanSym,
        name: mergedName,
        shares: mergedShares,
        ...(mergedCost ? { cost: mergedCost } : {}),
        dividendInfo: mergedDividendInfo
      });
    }
  }

  const uniqueStocks = Array.from(map.values());
  const mergedSurvivingStocks = uniqueStocks.filter(s => mergedSymbols.has(s.symbol));

  return {
    uniqueStocks,
    duplicatesToRemove: Array.from(new Set(duplicatesToRemove)),
    mergedSurvivingStocks
  };
}
