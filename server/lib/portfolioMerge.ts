import { resolveSymbolFromName } from "./symbols";

// Helper: Process parsed stock items, calculate checksum, and merge weighted averages
export function mergeAndValidateStocks(rawList: any[]) {
  const resolvedMap = new Map<string, {
    symbol: string;
    name: string;
    shares: number;
    cost: number | null;
    currentPrice: number | null;
    totalCost: number | null;
  }>();

  const unresolved: Array<{
    name: string;
    shares: number;
    cost: number | null;
    totalCost: number | null;
  }> = [];

  const invalid: Array<{
    symbol?: string;
    name: string;
    shares: number;
    cost: number | null;
    totalCost: number | null;
    expectedTotal: number;
  }> = [];

  for (const item of rawList) {
    if (!item) continue;
    const rawSym = String(item.symbol || '').trim();
    const rawName = String(item.name || '').trim();
    const shares = Number(item.shares) || 0;
    const cost = item.cost !== null && item.cost !== undefined && !isNaN(Number(item.cost)) ? Number(item.cost) : null;
    const currentPrice = item.currentPrice !== null && item.currentPrice !== undefined && !isNaN(Number(item.currentPrice)) ? Number(item.currentPrice) : null;
    const totalCost = item.totalCost !== null && item.totalCost !== undefined && !isNaN(Number(item.totalCost)) ? Number(item.totalCost) : null;

    const cleanSym = resolveSymbolFromName(rawSym, rawName);

    if (!cleanSym) {
      unresolved.push({
        name: rawName || '未知股名',
        shares,
        cost,
        totalCost
      });
      continue;
    }

    // Checksum 檢查：只在 shares > 0, cost > 0, totalCost > 0 時進行
    if (shares > 0 && cost !== null && cost > 0 && totalCost !== null && totalCost > 0) {
      const expectedTotal = shares * cost;
      const diffRatio = Math.abs(expectedTotal - totalCost) / totalCost;
      if (diffRatio > 0.001) {
        invalid.push({
          symbol: cleanSym,
          name: rawName || cleanSym,
          shares,
          cost,
          totalCost,
          expectedTotal: Math.round(expectedTotal)
        });
        continue;
      }
    }

    // 修正 6：同代號合併 (股數相加，成本以加權平均重算)
    if (!resolvedMap.has(cleanSym)) {
      resolvedMap.set(cleanSym, {
        symbol: cleanSym,
        name: rawName || cleanSym,
        shares,
        cost,
        currentPrice,
        totalCost
      });
    } else {
      const existing = resolvedMap.get(cleanSym)!;
      const totalShares = (existing.shares || 0) + shares;
      const existingCost = existing.cost || 0;
      const itemCost = cost || 0;
      const totalCostSum = ((existing.shares || 0) * existingCost) + (shares * itemCost);
      const newCost = totalShares > 0 ? (totalCostSum / totalShares) : null;

      resolvedMap.set(cleanSym, {
        symbol: cleanSym,
        name: existing.name || rawName || cleanSym,
        shares: totalShares,
        cost: newCost !== null ? Math.round(newCost * 100) / 100 : null,
        currentPrice: existing.currentPrice || currentPrice,
        totalCost: (existing.totalCost || 0) + (totalCost || 0)
      });
    }
  }

  return {
    parsedStocks: Array.from(resolvedMap.values()),
    unresolved,
    invalid
  };
}
