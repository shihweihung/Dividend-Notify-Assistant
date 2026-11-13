// 買進 / 賣出交易紀錄（前後端共用的純函式）。
// 交易存在每檔股票文件的 trades 陣列裡（users/{uid}/stocks/{symbol}.trades），
// 不需要新的 Firestore 集合，也不會多讀文件。

export type TradeSide = 'buy' | 'sell';

export type Trade = {
  id: string;
  side: TradeSide;
  shares: number;
  price: number;
  tradeDate: string;    // 成交日 YYYY-MM-DD（使用者輸入，可補登過去的日期）
  recordedDate: string; // 記錄日 YYYY-MM-DD（按下儲存的那天）
  recordedAt: string;   // ISO 時間
  fee: number;          // 手續費（估算）
  tax: number;          // 證交稅（估算，只有賣出）
  prevShares: number;   // 交易前股數（用來還原）
  prevCost: number | null; // 交易前平均成本（用來還原）
  realizedPnl: number | null; // 賣出的已實現損益（已扣費用）；成本未知時為 null
};

// ---------------------------------------------------------------------------
// 費用估算（使用者選擇自動估算，不輸入實際費用）
// ---------------------------------------------------------------------------

export const FEE_RATE = 0.001425;   // 手續費公定費率，不含券商折扣
export const FEE_MIN_BOARD_LOT = 20; // 整股最低手續費
export const FEE_MIN_ODD_LOT = 1;    // 零股最低手續費（多數券商）

/** 手續費：成交金額 × 0.1425%，元以下捨去；整股最低 20 元、零股最低 1 元 */
export function estimateFee(price: number, shares: number): number {
  const amount = price * shares;
  if (amount <= 0) return 0;
  const min = shares % 1000 === 0 ? FEE_MIN_BOARD_LOT : FEE_MIN_ODD_LOT;
  return Math.max(Math.floor(amount * FEE_RATE + 1e-6), min);
}

/**
 * 證交稅（賣出才有）：股票 0.3%、ETF 0.1%、債券 ETF（代號 B 結尾）免徵。
 * 代號 00 開頭視為 ETF。
 */
export function taxRateFor(symbol: string): number {
  const s = (symbol || '').toUpperCase();
  if (/^00\d+B$/.test(s)) return 0;
  if (/^00/.test(s)) return 0.001;
  return 0.003;
}

export function estimateTax(symbol: string, price: number, shares: number): number {
  return Math.floor(price * shares * taxRateFor(symbol) + 1e-6);
}

// ---------------------------------------------------------------------------
// 套用交易到持股
// ---------------------------------------------------------------------------

export type Position = { shares: number; cost: number | null };

export type TradeInput = {
  side: TradeSide;
  shares: number;
  price: number;
  tradeDate: string;
  recordedAt: string;   // ISO
  recordedDate: string; // YYYY-MM-DD
  id: string;
};

export class TradeError extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 依一筆交易更新持股，並回傳要存下來的交易紀錄。
 * - 買進：股數相加，平均成本含手續費重新加權
 * - 賣出：股數減少，平均成本不變；已實現損益 = 賣出金額 − 手續費 − 證交稅 − 平均成本 × 股數
 */
export function applyTrade(symbol: string, position: Position, input: TradeInput): { position: Position; trade: Trade } {
  const shares = Math.floor(Number(input.shares));
  const price = Number(input.price);
  if (!Number.isFinite(shares) || shares <= 0) throw new TradeError('股數必須大於 0');
  if (!Number.isFinite(price) || price <= 0) throw new TradeError('價格必須大於 0');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.tradeDate)) throw new TradeError('成交日格式錯誤');
  if (input.tradeDate > input.recordedDate) throw new TradeError('成交日不能晚於今天');

  const prevShares = Math.max(Number(position.shares) || 0, 0);
  const prevCost = position.cost !== null && position.cost !== undefined && Number(position.cost) > 0 ? Number(position.cost) : null;
  const fee = estimateFee(price, shares);

  if (input.side === 'buy') {
    const newShares = prevShares + shares;
    let newCost: number | null = null;
    if (prevShares === 0) newCost = round2((shares * price + fee) / shares);
    else if (prevCost !== null) newCost = round2((prevShares * prevCost + shares * price + fee) / newShares);
    return {
      position: { shares: newShares, cost: newCost },
      trade: { ...baseTrade(input, shares, price), fee, tax: 0, prevShares, prevCost, realizedPnl: null },
    };
  }

  if (shares > prevShares) throw new TradeError(`賣出股數（${shares}）超過目前持股（${prevShares}）`);
  const tax = estimateTax(symbol, price, shares);
  const proceeds = Math.floor(shares * price + 1e-6) - fee - tax;
  const realizedPnl = prevCost !== null ? Math.round(proceeds - prevCost * shares) : null;
  return {
    position: { shares: prevShares - shares, cost: prevCost },
    trade: { ...baseTrade(input, shares, price), fee, tax, prevShares, prevCost, realizedPnl },
  };
}

function baseTrade(input: TradeInput, shares: number, price: number) {
  return {
    id: input.id,
    side: input.side,
    shares,
    price,
    tradeDate: input.tradeDate,
    recordedDate: input.recordedDate,
    recordedAt: input.recordedAt,
  };
}

/** 復原最後一筆交易：回到交易前的股數與成本（只允許復原最新一筆，避免成本算錯） */
export function undoLastTrade(trades: Trade[]): { position: Position; trades: Trade[] } | null {
  if (!trades || trades.length === 0) return null;
  const sorted = sortTrades(trades);
  const last = sorted[sorted.length - 1];
  return {
    position: { shares: last.prevShares, cost: last.prevCost },
    trades: sorted.slice(0, -1),
  };
}

/** 依記錄時間排序（套用順序） */
export function sortTrades(trades: Trade[]): Trade[] {
  return [...(trades || [])].sort((a, b) => (a.recordedAt || '').localeCompare(b.recordedAt || ''));
}

/** 已實現損益合計（只算有成本資料的賣出） */
export function totalRealizedPnl(trades: Trade[]): number {
  return (trades || []).reduce((sum, t) => sum + (t.side === 'sell' && t.realizedPnl !== null ? t.realizedPnl : 0), 0);
}

// ---------------------------------------------------------------------------
// 除息日的股數：用交易紀錄修正快照
// ---------------------------------------------------------------------------

const signed = (t: Trade) => (t.side === 'buy' ? 1 : -1) * (Number(t.shares) || 0);

/**
 * 以某份快照（日期 snapshotDate、當時股數 snapshotShares）為基準，推算除息日能領的股數。
 * 快照會包含「記錄日 <= 快照日」的交易，但交易的成交日才是決定能不能領息的依據：
 * - 已包含在快照、但成交日在除息日（含）之後 → 扣回來（除息日當天買的領不到；當天賣的仍領得到）
 * - 不在快照裡、但成交日在除息日之前 → 加上去（晚幾天才補登也能算對）
 */
export function adjustSharesWithTrades(
  snapshotShares: number,
  snapshotDate: string,
  exDate: string,
  trades: Trade[],
): number {
  let shares = Number(snapshotShares) || 0;
  for (const t of trades || []) {
    const inSnapshot = t.recordedDate <= snapshotDate;
    const entitled = t.tradeDate < exDate;
    if (inSnapshot && !entitled) shares -= signed(t);
    if (!inSnapshot && entitled) shares += signed(t);
  }
  return Math.max(shares, 0);
}

/** 沒有快照時，用目前股數倒推除息日的股數（扣掉除息日之後成交的交易） */
export function sharesAtExDateFromCurrent(currentShares: number, exDate: string, trades: Trade[]): number {
  let shares = Number(currentShares) || 0;
  for (const t of trades || []) {
    if (t.tradeDate >= exDate) shares -= signed(t);
  }
  return Math.max(shares, 0);
}
