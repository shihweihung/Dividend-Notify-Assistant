// Telegram 記帳指令解析（純函式，不碰網路與資料庫）
//
// 支援的寫法（順序以「買/賣 → 股票 → 股數 → 價格 → 日期」為主，帶單位時順序可調換）：
//   買 2330 1000 1050
//   賣 日月光 200 178
//   買進 0056 2張 36.5
//   賣出 00878 500股 @21.6 11/20
//   買 台積電 1000 1050 昨天
//   復原 日月光            （復原該檔最後一筆交易）
//
// 股數：純數字＝股；「張」＝ 1000 股。價格：可加 @ 或「元」。
// 日期：省略＝今天；可寫 11/20、2026/11/20、2026-11-20、今天、昨天、前天。

import { normalizeName, NAME_MAP } from './symbols';

export type HeldStock = { symbol: string; name?: string; shares?: number };

export type ParsedTrade = {
  kind: 'trade';
  side: 'buy' | 'sell';
  symbol: string;
  name: string;
  shares: number;
  price: number;
  tradeDate: string; // YYYY-MM-DD
  isNewStock: boolean; // 買進目前沒有的股票
};
export type ParsedUndo = { kind: 'undo'; symbol: string; name: string };
export type ParseError = { kind: 'error'; message: string };
export type ParseResult = ParsedTrade | ParsedUndo | ParseError | null; // null = 不是記帳指令

const BUY_WORDS = ['買進', '買入', '買', '/buy', 'buy'];
const SELL_WORDS = ['賣出', '賣', '/sell', 'sell'];
const UNDO_WORDS = ['復原', '撤銷', '取消上一筆', '/undo', 'undo'];

export const TRADE_HELP =
  '📝 記錄買賣的格式：\n' +
  '買 股票 股數 價格 [日期]\n' +
  '賣 股票 股數 價格 [日期]\n\n' +
  '例如：\n' +
  '買 2330 1000 1050\n' +
  '賣 日月光 200 178\n' +
  '買 0056 2張 36.5 11/20\n' +
  '復原 日月光（復原該檔最後一筆）\n\n' +
  '股票可以打代號或名稱；股數打「張」會乘 1000；日期省略就是今天。';

function startsWithAny(text: string, words: string[]): string | null {
  const lower = text.toLowerCase();
  for (const w of words) {
    if (lower.startsWith(w.toLowerCase())) return w;
  }
  return null;
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** 解析日期字詞，失敗回 null */
export function parseDateToken(token: string, today: string): string | null {
  if (token === '今天' || token === '今日') return today;
  if (token === '昨天' || token === '昨日') return addDays(today, -1);
  if (token === '前天') return addDays(today, -2);
  let m = token.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = token.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (m) {
    const year = Number(today.slice(0, 4));
    let date = `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    if (date > today) date = `${year - 1}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; // 1/3 在 12 月打 → 視為去年
    return date;
  }
  return null;
}

function isValidDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 找股票：先比對持股（代號完全相同 → 名稱相同 → 名稱包含），再查股名對照表，最後接受合法代號。
 * 對到多檔時回錯誤，不自己猜。
 */
export function resolveStock(query: string, held: HeldStock[]): { symbol: string; name: string; held: boolean } | { error: string } {
  const q = query.trim().toUpperCase().replace(/\.(TW|TWO)$/i, '');
  const bySymbol = held.find(s => String(s.symbol).toUpperCase() === q);
  if (bySymbol) return { symbol: bySymbol.symbol, name: bySymbol.name || bySymbol.symbol, held: true };

  const nq = normalizeName(query);
  if (nq) {
    const exact = held.filter(s => s.name && normalizeName(s.name) === nq);
    if (exact.length === 1) return { symbol: exact[0].symbol, name: exact[0].name!, held: true };
    const partial = held.filter(s => s.name && normalizeName(s.name).includes(nq));
    if (partial.length === 1) return { symbol: partial[0].symbol, name: partial[0].name!, held: true };
    if (partial.length > 1) {
      return { error: `「${query}」對到好幾檔：${partial.map(s => `${s.name}(${s.symbol})`).join('、')}，請改打代號` };
    }
    if (NAME_MAP[nq]) return { symbol: NAME_MAP[nq], name: query.trim(), held: false };
  }

  if (/^\d{4,6}[A-Z]?$/.test(q)) return { symbol: q, name: q, held: false };
  return { error: `找不到「${query}」，請改打股票代號（例如 2330）` };
}

export function parseTradeCommand(rawText: string, today: string, held: HeldStock[]): ParseResult {
  const text = (rawText || '').trim().replace(/\s+/g, ' ');
  if (!text) return null;

  const undoWord = startsWithAny(text, UNDO_WORDS);
  if (undoWord) {
    const rest = text.slice(undoWord.length).trim();
    if (!rest) return { kind: 'error', message: '要復原哪一檔？例如：復原 日月光' };
    const found = resolveStock(rest, held);
    if ('error' in found) return { kind: 'error', message: found.error };
    if (!found.held) return { kind: 'error', message: `你沒有持有 ${found.name}，沒有交易可以復原` };
    return { kind: 'undo', symbol: found.symbol, name: found.name };
  }

  // 「賣」要先比，避免「買賣」之類的字被當成買
  const sellWord = startsWithAny(text, SELL_WORDS);
  const buyWord = sellWord ? null : startsWithAny(text, BUY_WORDS);
  const word = sellWord || buyWord;
  if (!word) return null;
  const side: 'buy' | 'sell' = sellWord ? 'sell' : 'buy';

  // 「賣日月光200股178元」這種完全沒空格的寫法：在中文與數字之間補空格
  // （有空格時不動，避免把「元大台灣50」這種股名拆開）
  let rest = text.slice(word.length).trim();
  if (!rest.includes(' ')) {
    rest = rest.replace(/([一-鿿])(?=[@\d])/g, '$1 ').replace(/([張股])(?=[@\d])/g, '$1 ');
  }
  const tokens = rest.split(' ').filter(Boolean);
  if (tokens.length === 0) return { kind: 'error', message: TRADE_HELP };

  let shares: number | null = null;
  let price: number | null = null;
  let tradeDate: string | null = null;
  const bare: number[] = [];
  const nameParts: string[] = [];

  for (const tk of tokens) {
    let m: RegExpMatchArray | null;
    if ((m = tk.match(/^(\d+(?:\.\d+)?)張$/))) { shares = Math.round(Number(m[1]) * 1000); continue; }
    if ((m = tk.match(/^(\d+)股$/))) { shares = Number(m[1]); continue; }
    if ((m = tk.match(/^@(\d+(?:\.\d+)?)$/)) || (m = tk.match(/^(\d+(?:\.\d+)?)元$/))) { price = Number(m[1]); continue; }
    const d = parseDateToken(tk, today);
    if (d) { tradeDate = d; continue; }
    if (/^\d+(?:\.\d+)?$/.test(tk) && (nameParts.length > 0)) { bare.push(Number(tk)); continue; }
    if (nameParts.length === 0 || bare.length === 0) { nameParts.push(tk); continue; }
    return { kind: 'error', message: `看不懂「${tk}」\n\n${TRADE_HELP}` };
  }

  // 沒帶單位的數字：先補股數、再補價格
  for (const n of bare) {
    if (shares === null) shares = n;
    else if (price === null) price = n;
    else return { kind: 'error', message: `數字太多了，看不出哪個是股數、哪個是價格\n\n${TRADE_HELP}` };
  }

  const stockQuery = nameParts.join(' ');
  if (!stockQuery) return { kind: 'error', message: `沒有看到股票\n\n${TRADE_HELP}` };
  if (shares === null || price === null) return { kind: 'error', message: `需要股數和價格\n\n${TRADE_HELP}` };
  if (!Number.isInteger(shares) || shares <= 0) return { kind: 'error', message: '股數必須是正整數' };
  if (!(price > 0)) return { kind: 'error', message: '價格必須大於 0' };

  tradeDate = tradeDate || today;
  if (!isValidDate(tradeDate)) return { kind: 'error', message: `日期 ${tradeDate} 不存在` };
  if (tradeDate > today) return { kind: 'error', message: '成交日不能晚於今天' };

  const found = resolveStock(stockQuery, held);
  if ('error' in found) return { kind: 'error', message: found.error };
  if (side === 'sell' && !found.held) return { kind: 'error', message: `你沒有持有 ${found.name}，不能賣出` };

  return { kind: 'trade', side, symbol: found.symbol, name: found.name, shares, price, tradeDate, isNewStock: !found.held };
}
