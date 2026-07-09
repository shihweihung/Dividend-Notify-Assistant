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
 * 從 Yahoo 股市抓取除權息歷史資料
 */
async function fetchDividendListFromYahoo(symbol: string, isOtc: boolean): Promise<{ date: string, amount: number, year: number, paymentDate: string }[]> {
  try {
    const suffix = isOtc ? ".TWO" : ".TW";
    const url = `https://tw.stock.yahoo.com/quote/${symbol}${suffix}/dividend`;
    console.log(`[Yahoo History] 正在抓取除權息歷史: ${url}`);
    
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://tw.stock.yahoo.com/',
        'Cache-Control': 'max-age=0'
      },
      timeout: 10000
    });

    const $ = cheerio.load(res.data);
    const rows = $('ul.List\\(n\\) > li.List\\(n\\)');
    const dividends: { date: string, amount: number, year: number, paymentDate: string }[] = [];

    rows.each((i, el) => {
      const cells = $(el).find('div');
      if (cells.length >= 11) {
        const periodText = $(cells[3]).text().trim();
        const dateText = $(cells[8]).text().trim();
        const amountText = $(cells[4]).text().trim();
        const payDateText = $(cells[10]).text().trim();

        // 僅解析帶有季度/年度期別 (例如 "2026Q1") 與有效除息日格式的資料行
        if (periodText && /\d{4}\/\d{2}\/\d{2}/.test(dateText)) {
          const exDate = dateText.replace(/\//g, '-');
          const amount = parseFloat(amountText) || 0;
          const paymentDate = payDateText && payDateText !== '-' ? payDateText.replace(/\//g, '-') : '';
          const year = parseInt(exDate.split('-')[0]) || new Date().getFullYear();

          if (exDate && amount > 0) {
            dividends.push({
              date: exDate,
              amount: amount,
              year: year,
              paymentDate: paymentDate
            });
          }
        }
      }
    });

    return dividends;
  } catch (error: any) {
    console.warn(`[Yahoo History] 抓取 ${symbol} 失敗: ${error.message || error}`);
    return [];
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
        
        // HiStock's 'payYear' column is the Western year of the ex-dividend date.
        // We should always use the Western year 'payYear' to avoid Minguo years (like 114) or string suffixes (like 114Q4).
        let yearToUse = parseInt(payYear);
        if (isNaN(yearToUse) || yearToUse < 1000) {
          const minguoYear = parseInt(year);
          if (!isNaN(minguoYear)) {
            yearToUse = minguoYear < 1000 ? minguoYear + 1911 : minguoYear;
          } else {
            yearToUse = new Date().getFullYear();
          }
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
  } catch (error: any) {
    console.warn(`[HiStock] 抓取 ${symbol} 失敗: ${error.message || error}`);
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
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': 'https://tw.stock.yahoo.com/',
          'Cache-Control': 'max-age=0'
        },
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
    } catch (error: any) {
      console.warn(`[Yahoo Price] 嘗試 ${symbol}${suffix} 失敗: ${error.message || error}`);
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

    // 先從證交所/上櫃清單比對，以取得正確的股號(Code)與股名(Name)
    // 這能解決輸入「長榮」或「上詮」但股號顯示中文名稱而非「2603」/「3363」的問題，也能避免直接用中文去查 Yahoo 報價導致 400 錯誤
    try {
      const priceResTwse = await axios.get("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", { timeout: 10000 });
      if (Array.isArray(priceResTwse.data)) {
        priceTarget = priceResTwse.data.find((item: any) => 
          item.Code === cleanSymbol || 
          item.Name === cleanSymbol || 
          (cleanSymbol.length >= 2 && item.Name.startsWith(cleanSymbol))
        );
        if (priceTarget) {
          currentPrice = parseFloat(priceTarget.ClosingPrice) || 0;
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
            currentPrice = parseFloat(priceTarget.Close) || 0;
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
          priceTarget = priceResTpexBond.data.find((item: any) => 
            item.SecuritiesCompanyCode === cleanSymbol || 
            item.CompanyName === cleanSymbol
          );
          if (priceTarget) {
            currentPrice = parseFloat(priceTarget.ClosePrice) || 0;
            stockName = priceTarget.CompanyName;
            finalSymbol = priceTarget.SecuritiesCompanyCode;
            isOtc = true;
          }
        }
      } catch (e) { console.warn("[TPEx Bond] 列表抓取失敗"); }
    }

    // 當解決正確的 finalSymbol 之後，非 ASCII (例如仍未被解析的中文名字) 則不要直接丟給 Yahoo 查詢，避免 400 錯誤。
    // 如果是乾淨的英文/數字（如已成功解析的 "3363" 或原先輸入的 "0050"），再向 Yahoo 抓取最即時的即時報價與正確完整的股票名稱。
    const hasNonAscii = /[^\x00-\x7F]/.test(finalSymbol);
    if (!hasNonAscii) {
      const yahooPriceData = await fetchPriceFromYahoo(finalSymbol);
      if (yahooPriceData) {
        currentPrice = yahooPriceData.price;
        if (yahooPriceData.name && (!stockName || stockName === "未知股票" || stockName === finalSymbol)) {
          stockName = yahooPriceData.name;
        }
        console.log(`[Yahoo Price] 成功抓取 ${finalSymbol}: ${currentPrice}`);
      }
    } else {
      console.log(`[Yahoo Price] 略過中文/非法字元 ${finalSymbol}（不執行直接查詢以避免 400 錯誤）`);
    }

    if (currentPrice === 0) return null;

    // 2. 抓取除權息資料
    const hiStockDividends = await fetchDividendFromHiStock(finalSymbol);
    const yahooDividends = await fetchDividendListFromYahoo(finalSymbol, isOtc);
    
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
    
    // 如果 Yahoo 有最新或歷史資料，整合進來
    if (yahooDividends && yahooDividends.length > 0) {
      yahooDividends.forEach(yd => {
        const exists = allDividends.some(d => d.date === yd.date);
        if (!exists) {
          allDividends.push({
            date: yd.date,
            amount: yd.amount,
            year: yd.year,
            paymentDate: yd.paymentDate
          });
        } else {
          // 如果已存在，更新發放日資訊
          const existing = allDividends.find(d => d.date === yd.date);
          if (existing && yd.paymentDate) {
            existing.paymentDate = yd.paymentDate;
          }
        }
      });
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
      history: sortedDividends || [],
      monthlyDistribution,
      pendingMonthlyDistribution
    };

  } catch (error: any) {
    console.warn("[twseService] 抓取失敗:", error.message || error);
    return null;
  }
}
