import axios from 'axios';
import type { DividendInfo } from "../types";
import { fetchStockDataFromTwse } from "./twseService.ts";

/**
 * 核心抓取邏輯：完全移除 Google AI 依賴，改用純 API 模式
 */
export async function fetchDividendData(symbol: string): Promise<DividendInfo | null> {
  const cleanSymbol = symbol.trim();
  
  // 1. 直接從官方 API 取得基礎資料 (股價、除息日)
  const twseData = await fetchStockDataFromTwse(cleanSymbol);
  
  if (!twseData) {
    throw new Error(`無法從證交所取得 ${cleanSymbol} 的資料，請檢查代號是否正確。`);
  }

  let topComponents: any[] = [];
  const isEtf = twseData.symbol.startsWith('00') && (twseData.symbol.length >= 4 && twseData.symbol.length <= 6);

  // 2. 如果是 ETF，從 MoneyDJ 抓成分股
  if (isEtf) {
    try {
      console.log(`[MoneyDJ] 正在抓取 ${twseData.symbol} 的成分股...`);
      const etfUrl = `https://www.moneydj.com/ETF/X/Basic/Basic0007.xdjhtm?etfid=${twseData.symbol}.TW`;
      const etfRes = await axios.get(etfUrl, { timeout: 10000 });
      
      const cheerio = await import('cheerio');
      const $ = cheerio.load(etfRes.data);
      
      const rows = $('table tbody tr');
      let count = 0;
      
      rows.each((i, el) => {
        const cells = $(el).find('td');
        if (cells.length === 3 && count < 10) {
          const nameCode = $(cells[0]).text().trim();
          const weight = $(cells[1]).text().trim();
          
          const match = nameCode.match(/(.*?)\((.*?)\)/);
          if (match) {
            topComponents.push({
              name: match[1].trim(),
              code: match[2].trim().replace('.TW', '').replace('.TWO', ''),
              weight: weight + '%'
            });
            count++;
          }
        }
      });
    } catch (error) {
      console.warn("[MoneyDJ] 取得成分股失敗，跳過此步驟:", error instanceof Error ? error.message : error);
    }
  }

  // 3. 回傳組合後的資料 (結構與 types 保持一致)
  return {
    symbol: twseData.symbol,
    name: twseData.name,
    exDividendDate: twseData.exDate,
    paymentDate: twseData.paymentDate || "", 
    amount: twseData.amount,
    receivedAmountCurrentYear: twseData.receivedAmount || 0, 
    pendingAmountCurrentYear: twseData.pendingAmount || 0, 
    monthlyDistribution: twseData.monthlyDistribution || new Array(12).fill(0), 
    pendingMonthlyDistribution: twseData.pendingMonthlyDistribution || new Array(12).fill(0),
    currentPrice: twseData.price,
    yield: twseData.yield,
    isEtf: isEtf,
    topComponents: topComponents,
    source: "HiStock & 證交所",
    sourceUrl: "https://histock.tw/",
    updatedAt: new Date().toISOString(),
    isPaymentDateEstimated: twseData.isPaymentDateEstimated,
    status: twseData.status
  };
}
