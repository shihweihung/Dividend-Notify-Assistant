// Helper: Normalize name for dictionary matching (removes spaces, fullwidth to halfwidth, uppercase)
export function normalizeName(str: string): string {
  if (!str) return '';
  return str
    .replace(/\s+/g, '')
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, '')
    .toUpperCase();
}

const RAW_NAME_MAP: Record<string, string> = {
  '元大高股息': '0056',
  '中信美國公債20年': '00795B',
  '國泰台灣科技龍頭': '00881',
  '群益台灣精選高息': '00919',
  '鴻海': '2317',
  '台積電': '2330',
  '台新新光金': '2887',
  '台新金': '2887',
  '新光金': '2887', // 新光金與台新金於2025/07併入2887
  '國泰永續高股息': '00878',
  '復華台灣科技優息': '00929',
  '元大台灣50': '0050',
  '富邦台50': '006208',
  '群益半導體收益': '00927',
  '元大台灣高息低波': '00713',
  '元大美債20年': '00679B',
  '國泰20年美債': '00687B',
  '中信高評級公司債': '00772B',
  '凱基優選高股息30': '00915',
  '大華優利高股息30': '00918',
  '統一台灣高息動能': '00939',
  '元大台灣價值高息': '00940',
  '聯發科': '2454',
  '廣達': '2382',
  '緯創': '3231',
  '長榮': '2603',
  '陽明': '2609',
  '萬海': '2615',
  '中華電': '2412',
  '富邦金': '2881',
  '國泰金': '2882',
  '玉山金': '2884',
  '兆豐金': '2886',
  '中信金': '2891',
  '第一金': '2892'
};

export const NAME_MAP: Record<string, string> = {};
for (const [k, v] of Object.entries(RAW_NAME_MAP)) {
  NAME_MAP[normalizeName(k)] = v;
}

// Helper: Name-to-Symbol mapping resolution
export function resolveSymbolFromName(rawSymbol: string, rawName: string): string | null {
  const sym = (rawSymbol || '').toString().trim().toUpperCase().replace(/\.(TW|TWO)$/i, '');
  const name = normalizeName(rawName);

  // 1. 名稱完全比對優先（名稱是畫面上抄下來的，比 LLM 推導的代號可信）
  if (name && NAME_MAP[name]) {
    return NAME_MAP[name];
  }

  // 2. 名稱查不到，才退回 Gemini 的代號，且必須符合台股代號格式（例如 4-6 碼數字 + 可選尾綴 A-Z）
  if (/^\d{4,6}[A-Z]?$/.test(sym)) {
    return sym;
  }

  // 3. 美股代號（純英文字母 1-5 碼）
  if (/^[A-Z]{1,5}$/.test(sym)) {
    return sym;
  }

  // 4. 都不成立回 null，交由上層處理，不可靜默丟棄
  return null;
}

export function normalizeSymbol(sym: any): string {
  if (!sym) return '';
  return String(sym).trim().toUpperCase().replace(/\.(TW|TWO)$/i, '');
}
