import axios from 'axios';
import type { DividendInfo } from "../types";
import { fetchStockDataFromTwse } from "./twseService";

/**
 * 核心抓取邏輯：完全移除 Google AI 依賴，改用純 API 模式
 */
export async function fetchDividendData(symbol: string): Promise<DividendInfo | null> {
  const cleanSymbol = symbol.trim().toUpperCase();
  
  // 1. 直接從官方 API 取得基礎資料 (股價、除息日)
  const twseData = await fetchStockDataFromTwse(cleanSymbol);
  
  if (!twseData) {
    throw new Error(`無法從證交所取得 ${cleanSymbol} 的資料，請檢查代號是否正確。`);
  }

  let topComponents: any[] = [];
  const isEtf = (twseData.symbol.startsWith('00') || cleanSymbol.startsWith('00')) && 
                ((twseData.symbol.length >= 4 && twseData.symbol.length <= 6) || (cleanSymbol.length >= 4 && cleanSymbol.length <= 6));

  // 2. 如果是 ETF，從 MoneyDJ 抓成分股
  if (isEtf) {
    const etfUrl = `https://www.moneydj.com/ETF/X/Basic/Basic0007.xdjhtm?etfid=${twseData.symbol}.TW`;
    try {
      console.log(`[MoneyDJ] 正在抓取 ${twseData.symbol} 的成分股...`);
      const etfRes = await axios.get(etfUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: 10000
      });
      
      const cheerio = await import('cheerio');
      const $ = cheerio.load(etfRes.data);
      
      const rows = $('table tr');
      let count = 0;
      
      rows.each((i, el) => {
        const cells = $(el).find('td');
        if (cells.length === 3 && count < 10) {
          const nameCode = $(cells[0]).text().trim();
          const weightText = $(cells[1]).text().trim().replace('%', '');
          const weightNum = parseFloat(weightText);
          
          const match = nameCode.match(/(.*?)\((.*?)\)/);
          if (match && !isNaN(weightNum)) {
            const code = match[2].trim().replace('.TW', '').replace('.TWO', '');
            topComponents.push({
              name: match[1].trim(),
              code: code,
              symbol: code,
              weight: weightNum
            });
            count++;
          }
        }
      });
      console.log(`[MoneyDJ] 成功抓取 ${twseData.symbol} 的成分股 ${topComponents.length} 筆`);
    } catch (error) {
      console.error("[MoneyDJ] 取得成分股失敗，網址:", etfUrl, "錯誤:", error instanceof Error ? error.message : error);
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
    etfComponents: topComponents,
    etfComponentsUpdatedAt: new Date().toISOString(),
    source: "HiStock & 證交所",
    sourceUrl: "https://histock.tw/",
    updatedAt: new Date().toISOString(),
    isPaymentDateEstimated: twseData.isPaymentDateEstimated,
    status: twseData.status,
    history: twseData.history || []
  };
}
