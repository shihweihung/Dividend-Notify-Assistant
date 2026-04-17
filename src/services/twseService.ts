import axios from 'axios';
import moment from 'moment-timezone';
import * as cheerio from 'cheerio';

// 取得台北時間今日日期
export function getTaipeiToday(): string {
  return moment().tz('Asia/Taipei').format('YYYY-MM-DD');
}

// 處理民國年轉西元年 (支援 113/04/13, 113年04月13日, 1130413)
export function convertRocDate(rocDate: string): string {
  if (!rocDate || typeof rocDate !== 'string') return "";
  
  if (rocDate.includes('年')) {
    const year = parseInt(rocDate.split('年')[0]) + 1911;
    const month = rocDate.split('年')[1].split('月')[0].padStart(2, '0');
    const day = rocDate.split('月')[1].replace('日', '').padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  if (rocDate.includes('/')) {
    const parts = rocDate.split('/');
    if (parts.length !== 3) return rocDate;
    const year = parseInt(parts[0]) + 1911;
    return `${year}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
  }

  if (rocDate.length === 7) {
    const year = parseInt(rocDate.substring(0, 3)) + 1911;
    const month = rocDate.substring(3, 5);
    const day = rocDate.substring(5, 7);
    return `${year}-${month}-${day}`;
  }

  return rocDate;
}

export interface TwseData {
  symbol: string;
  name: string;
  price: number;
  exDate: string;
  amount: number;
  paymentDate: string;
  isPaymentDateEstimated: boolean;
  yield: number;
  receivedAmount: number; // 今年已領
  pendingAmount: number;  // 今年待領
  status: string;         // 狀態標示
  history?: any[];        // 股利歷史
  monthlyDistribution?: number[]; // 每月股息分佈 (12個月)
  pendingMonthlyDistribution?: number[]; // 每月待領股息分佈 (12個月)
}

/**
 * 從 Yahoo 股市抓取除權息資料
 */
async function fetchDividendFromYahoo(symbol: string, isOtc: boolean): Promise<{ exDate: string, amount: number, paymentDate: string } | null> {
  try {
    const suffix = isOtc ? ".TWO" : ".TW";
    const url = `https://tw.stock.yahoo.com/quote/${symbol}${suffix}/dividend`;
    console.log(`[Yahoo] 正在抓取除權息資料: ${url}`);
    
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      timeout: 10000
    });

    const $ = cheerio.load(res.data);
    
    // Yahoo 股市的結構：
    // 每一列是一個 li，裡面有多個 div
    // 我們找第一個數據列 (通常是最近一次)
    // 結構可能如下:
    // <li class="List(n) ...">
    //   <div ...>2024/04/18</div> <!-- 除息日 -->
    //   <div ...>-</div>          <!-- 除權日 -->
    //   <div ...>0.79</div>       <!-- 現金股利 -->
    //   <div ...>0</div>          <!-- 股票股利 -->
    //   <div ...>2024/05/15</div> <!-- 現金發放日 -->
    // </li>

    const rows = $('ul.List\\(n\\) > li.List\\(n\\)');
    if (rows.length === 0) return null;

    // 排除標題列與年度統計列，尋找包含除息日期的數據列
    let targetRow: any = null;
    rows.each((i, el) => {
      const cells = $(el).find('div');
      // 根據觀察，數據列通常有 10 個以上的 div
      // 索引 8 通常是除息日 (YYYY/MM/DD)
      if (cells.length >= 9) {
        const dateText = $(cells[8]).text().trim();
        if (/\d{4}\/\d{2}\/\d{2}/.test(dateText) && !targetRow) {
          targetRow = el;
        }
      }
    });

    if (!targetRow) return null;

    const cells = $(targetRow).find('div');
    // 修正後的索引：
    // 4: 現金股利
    // 8: 除息日
    // 10: 現金發放日
    
    const exDate = $(cells[8]).text().trim().replace(/\//g, '-');
    const amount = parseFloat($(cells[4]).text().trim()) || 0;
    const paymentDate = $(cells[10]).text().trim().replace(/\//g, '-');

    if (!exDate || isNaN(amount)) return null;

    return {
      exDate,
      amount,
      paymentDate: paymentDate === '-' ? "" : paymentDate
    };
  } catch (error) {
    console.error(`[Yahoo] 抓取 ${symbol} 失敗:`, error);
    return null;
  }
}

export async function fetchDividendFromHiStock(symbol: string): Promise<any[]> {
  try {
    const url = `https://histock.tw/stock/${symbol}/%E9%99%A4%E6%AC%8A%E9%99%A4%E6%81%AF`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    // Target the specific dividend table (usually the first tb-stock table)
    const table = $('table.tb-stock').first();
    const rows = table.find('tr');
    const dividends: any[] = [];

    rows.each((i, el) => {
      if (i === 0 || i === 1) return; // Skip header and empty row
      const cells = $(el).find('td');
      if (cells.length < 7) return;

      const year = $(cells[0]).text().trim();
      const payYear = $(cells[1]).text().trim();
      const exDate = $(cells[3]).text().trim(); // 除息日
      const amount = parseFloat($(cells[6]).text().trim()) || 0; // 現金股利

      if (exDate && exDate !== '--' && amount > 0) {
        // Format date to YYYY-MM-DD
        // HiStock date is MM/DD. We need to determine the correct year.
        // If the ex-dividend date is in the future relative to the current year, it might be next year.
        // For now, let's try to infer the year from the exDate and the payYear.
        // HiStock's 'year' column is the fiscal year, 'payYear' is the year of payment.
        // The exDate is usually in the fiscal year or the year before payment.
        
        // A simple heuristic: if exDate is early in the year (e.g., 01/xx), it's likely the payYear.
        // If it's late in the year (e.g., 10/xx), it's likely the fiscal year.
        
        let yearToUse = parseInt(payYear);
        const month = parseInt(exDate.split('/')[0]);
        if (month >= 4 && month <= 12) {
          // Likely fiscal year
          yearToUse = parseInt(year);
        }
        
        const formattedDate = `${yearToUse}-${exDate.replace(/\//g, '-')}`;
        dividends.push({
          date: formattedDate,
          amount: amount,
          year: parseInt(year)
        });
      }
    });

    return dividends;
  } catch (error) {
    console.error(`[HiStock] 抓取 ${symbol} 失敗:`, error);
    return [];
  }
}

/**
 * 從 Yahoo 股市抓取即時股價
 */
export async function fetchPriceFromYahoo(symbol: string): Promise<{ price: number, name: string } | null> {
  const suffixes = ['.TW', '.TWO'];
  
  for (const suffix of suffixes) {
    try {
      const url = `https://tw.stock.yahoo.com/quote/${symbol}${suffix}`;
      const res = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000
      });
      const $ = cheerio.load(res.data);
      
      // 抓取股價 (通常在 Fz(32px) 的 span 中)
      const priceText = $('span[class*="Fz(32px)"]').first().text().trim();
      const price = parseFloat(priceText.replace(/,/g, ''));
      
      if (!isNaN(price) && price > 0) {
        // 抓取名稱
        let name = "";
        
        // 優先嘗試更精確的選擇器
        const titleText = $('h1[class*="C($c-link-text)"]').first().text().trim();
        if (titleText && !titleText.includes('Yahoo') && !titleText.includes('股市')) {
          name = titleText;
        }

        if (!name) {
          $('h1').each((i, el) => {
            const text = $(el).text().trim();
            if (text && !text.includes('Yahoo') && !text.includes('股市') && !name) {
              name = text;
            }
          });
        }

        if (name.includes('(')) {
          name = name.split('(')[0].trim();
        }
        
        return { price, name: name || "未知股票" };
      }
    } catch (error) {
      console.warn(`[Yahoo Price] 嘗試 ${symbol}${suffix} 失敗`);
    }
  }
  
  return null;
}

export async function fetchStockDataFromTwse(symbol: string): Promise<TwseData | null> {
  try {
    const cleanSymbol = symbol.trim();
    const today = getTaipeiToday();
    
    // 1. 抓取股價並確認上市/上櫃
    let priceTarget = null;
    let currentPrice = 0;
    let stockName = "";
    let finalSymbol = cleanSymbol;
    let isOtc = false;

    // 優先嘗試從 Yahoo 抓取即時股價
    const yahooPriceData = await fetchPriceFromYahoo(cleanSymbol);
    if (yahooPriceData) {
      currentPrice = yahooPriceData.price;
      stockName = yahooPriceData.name;
      console.log(`[Yahoo Price] 成功抓取 ${cleanSymbol}: ${currentPrice}`);
    }

    // 無論 Yahoo 是否成功，都嘗試從證交所/上櫃清單比對，以取得正確的股號(Code)與股名(Name)
    // 這能解決輸入「長榮」但股號顯示「長榮」而非「2603」的問題
    try {
      const priceResTwse = await axios.get("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", { timeout: 10000 });
      if (Array.isArray(priceResTwse.data)) {
        priceTarget = priceResTwse.data.find((item: any) => 
          item.Code === cleanSymbol || 
          item.Name === cleanSymbol || 
          (cleanSymbol.length >= 2 && item.Name.startsWith(cleanSymbol))
        );
        if (priceTarget) {
          if (currentPrice === 0) currentPrice = parseFloat(priceTarget.ClosingPrice);
          stockName = priceTarget.Name;
          finalSymbol = priceTarget.Code;
          isOtc = false;
        }
      }
    } catch (e) { console.warn("[TWSE] 列表抓取失敗"); }

    if (!priceTarget) {
      try {
        const priceResTpex = await axios.get("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes", { timeout: 10000 });
        if (Array.isArray(priceResTpex.data)) {
          priceTarget = priceResTpex.data.find((item: any) => 
            item.SecuritiesCompanyCode === cleanSymbol || 
            item.CompanyName === cleanSymbol ||
            (cleanSymbol.length >= 2 && item.CompanyName.startsWith(cleanSymbol))
          );
          if (priceTarget) {
            if (currentPrice === 0) currentPrice = parseFloat(priceTarget.Close);
            stockName = priceTarget.CompanyName;
            finalSymbol = priceTarget.SecuritiesCompanyCode;
            isOtc = true;
          }
        }
      } catch (e) { console.warn("[TPEx] 列表抓取失敗"); }
    }

    if (!priceTarget) {
      try {
        const priceResTpexBond = await axios.get("https://www.tpex.org.tw/openapi/v1/tpex_bond_etf_quotes", { timeout: 10000 });
        if (Array.isArray(priceResTpexBond.data)) {
          priceTarget = priceResTpexBond.data.find((item: any) => item.SecuritiesCompanyCode === cleanSymbol || item.CompanyName === cleanSymbol);
          if (priceTarget) {
            if (currentPrice === 0) currentPrice = parseFloat(priceTarget.ClosePrice);
            stockName = priceTarget.CompanyName;
            finalSymbol = priceTarget.SecuritiesCompanyCode;
            isOtc = true;
          }
        }
      } catch (e) { console.warn("[TPEx Bond] 列表抓取失敗"); }
    }

    if (currentPrice === 0) return null;

    // 2. 抓取除權息資料
    const hiStockDividends = await fetchDividendFromHiStock(finalSymbol);
    const yahooDividend = await fetchDividendFromYahoo(finalSymbol, isOtc);
    
    let exDate = "";
    let amount = 0;
    let paymentDate = "";
    let isPaymentDateEstimated = false;
    let receivedAmount = 0;
    let pendingAmount = 0;
    let status = "";
    const monthlyDistribution = new Array(12).fill(0);
    const pendingMonthlyDistribution = new Array(12).fill(0);

    const currentYear = moment().tz('Asia/Taipei').year();
    const todayMoment = moment().tz('Asia/Taipei');
    const todayStr = todayMoment.format('YYYY-MM-DD');

    // 整合 HiStock 與 Yahoo 的資料
    const allDividends = [...(hiStockDividends || [])];
    
    // 如果 Yahoo 有最新資料，且不在 HiStock 歷史中，則加入
    if (yahooDividend && yahooDividend.exDate) {
      const exists = allDividends.some(d => d.date === yahooDividend.exDate);
      if (!exists) {
        allDividends.push({
          date: yahooDividend.exDate,
          amount: yahooDividend.amount,
          year: parseInt(yahooDividend.exDate.split('-')[0]),
          paymentDate: yahooDividend.paymentDate // 記錄 Yahoo 的發放日
        });
      } else {
        // 如果已存在，更新發放日資訊
        const existing = allDividends.find(d => d.date === yahooDividend.exDate);
        if (existing && yahooDividend.paymentDate) {
          existing.paymentDate = yahooDividend.paymentDate;
        }
      }
    }

    // 依日期降冪排序 (最新的在前面)
    const sortedDividends = [...allDividends].sort((a, b) => b.date.localeCompare(a.date));

    if (sortedDividends.length > 0) {
      // 找出「今年或未來」最新的除息資訊
      const currentOrFuture = sortedDividends.find(d => {
        const year = parseInt(d.date.split('-')[0]);
        return year >= currentYear;
      });

      if (currentOrFuture) {
        exDate = currentOrFuture.date; 
        amount = currentOrFuture.amount;
        
        if (currentOrFuture.paymentDate) {
          paymentDate = currentOrFuture.paymentDate;
          isPaymentDateEstimated = false;
        } else {
          // 估計發放日 (通常在除息後一個月)
          paymentDate = moment(exDate).add(1, 'month').format('YYYY-MM-DD');
          isPaymentDateEstimated = true;
        }

        if (exDate > todayStr) {
          status = `將於 ${exDate} 除息`;
        } else {
          status = "已除息";
        }
      } else {
        // 如果今年尚未公佈，則不顯示「本次預計領取」的具體資料
        exDate = "";
        amount = 0;
        paymentDate = "";
        status = `${currentYear} 尚未公佈`;
      }

      // 計算今年已領與待領，以及每月分佈
      allDividends.forEach(div => {
        // 決定這筆股息的發放日
        let estPaymentStr = div.paymentDate;
        if (!estPaymentStr) {
          // 如果沒有發放日，預設為除息日後一個月
          estPaymentStr = moment(div.date).add(1, 'month').format('YYYY-MM-DD');
        }
        
        // 確保日期格式正確
        const estPaymentMoment = moment(estPaymentStr);
        const estPaymentFormatted = estPaymentMoment.format('YYYY-MM-DD');
        
        if (estPaymentMoment.year() === currentYear) {
          const monthIdx = estPaymentMoment.month(); // 0-11
          
          // 累加金額到對應月份
          // 區分已領與待領金額
          if (estPaymentFormatted <= todayStr) {
            receivedAmount += div.amount;
            monthlyDistribution[monthIdx] += div.amount; 
          } else {
            pendingAmount += div.amount;
            pendingMonthlyDistribution[monthIdx] += div.amount;
          }
        }
      });

      // 如果上面沒設 status，且有資料，則補設
      if (!status && sortedDividends.length > 0 && !exDate) {
        status = `${currentYear} 尚未公佈`;
      } else if (!status && exDate) {
        if (exDate > todayStr) {
          status = `將於 ${exDate} 除息`;
        } else {
          status = "已除息";
        }
      }
    }

    return {
      symbol: finalSymbol,
      name: stockName,
      price: currentPrice,
      exDate: exDate,
      amount: amount,
      paymentDate: paymentDate,
      isPaymentDateEstimated: isPaymentDateEstimated,
      status: status,
      yield: currentPrice > 0 ? parseFloat(((amount / currentPrice) * 100).toFixed(2)) : 0,
      receivedAmount: receivedAmount,
      pendingAmount: pendingAmount,
      history: hiStockDividends || [],
      monthlyDistribution,
      pendingMonthlyDistribution
    };

  } catch (error) {
    console.error("[twseService] 抓取失敗:", error);
    return null;
  }
}
