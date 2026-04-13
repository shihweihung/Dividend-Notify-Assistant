import { GoogleGenAI, Type } from "@google/genai";
import type { DividendInfo } from "../types";

let aiInstance: GoogleGenAI | null = null;

function getAi() {
  if (!aiInstance) {
    // 優先順序：1. 使用者自訂金鑰 (CUSTOM_GEMINI_API_KEY) -> 2. 系統金鑰 (GEMINI_API_KEY) -> 3. 硬編碼備用金鑰
    let apiKey = process.env.CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "AIzaSyAS5DTm2hGz9VKd8BPWQKkRQy_Oo_Zvnqk";
    
    // 強制清除可能存在的空白或換行符號
    if (apiKey) {
      apiKey = apiKey.trim();
    }

    if (!apiKey || apiKey === "undefined" || apiKey.length < 10) {
      throw new Error("找不到有效的 API 金鑰。請在右側選單的 'Secrets' 中新增一個名為 CUSTOM_GEMINI_API_KEY 的金鑰。");
    }
    
    console.log(`[Gemini] 初始化金鑰，前綴: ${apiKey.substring(0, 4)}...`);
    aiInstance = new GoogleGenAI({ apiKey });
  }
  return aiInstance;
}

export async function fetchDividendData(symbol: string): Promise<DividendInfo | null> {
  const now = new Date();
  const currentYear = now.getFullYear();
  const today = now.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
  
  const cleanSymbol = symbol.trim();
  const timestamp = Date.now();
  const prompt = `你是一個專業的台灣股市數據分析師。今天的真實日期是 ${today}（${currentYear}年）。現在的時間戳記是 ${timestamp}。
      請針對台股代號「${cleanSymbol}」查詢最新的市場資訊。
      
      查詢要求 (極度嚴格，請完全依照搜尋結果，禁止編造)：
      1. **最新股價 (極度重要)**：請務必執行 Google 搜尋「TPE: ${cleanSymbol}」或「${cleanSymbol} 最新股價」。請直接從 Google 搜尋結果最上方的「財經資訊面板」提取當下最新的「成交價」。
      2. **股利資訊 (極度嚴格，必須包含全年歷史)**：
         - 請搜尋「${cleanSymbol} 股利」、「${cleanSymbol} 除權息紀錄」或參考 https://tw.stock.yahoo.com/quote/${cleanSymbol}.TW/dividend。
         - **重要：年份處理**：如果搜尋結果中 ${currentYear} 年的資料尚未完整（例如現在是年初），請參考最近一個完整年份（如 2024 或 2025 年）的配息慣例來填寫，但必須以「已公佈」的資訊為優先。
         - **amount (本次配息)**：請提供「最近一次（不論已過或未過）」或「即將到來」的單次配息金額。
         - **exDividendDate / paymentDate**：提供與上述 amount 對應的日期。
         - **receivedAmountCurrentYear (${currentYear}已領總和)**：請加總 ${currentYear} 年 1 月 1 日至今，該股票「所有」已經發放 (Payment Date <= ${today}) 的現金股利。
         - **pendingAmountCurrentYear (${currentYear}未領總和)**：請加總 ${currentYear} 年「所有」已經公佈但尚未發放 (Payment Date > ${today}) 的現金股利。
         - **monthlyDistribution (每月分配)**：請提供一個長度為 12 的陣列，代表 1 月到 12 月「每一股」可領到的現金股利金額。
           - **重要原則**：請務必找出該股票在 ${currentYear} 年「所有已發生」的配息。例如 00981A 是月配息債券 ETF，在 4 月 10 日有發放配息，則陣列第 4 個元素（索引 3）必須填入該金額。
           - 對於尚未公佈且非固定配息的未來月份，請填寫 0。
         - **注意**：對於 00981A、00772B 等月配息債券 ETF，請務必精確抓取每個月的發放紀錄。
      3. **資料來源連結**：請務必提供你查到這些資訊的「確切網址 (URL)」。
      4. **ETF 判斷**：若為 ETF（代號 00 開頭），請務必列出前十大成分股及其權重。若非 ETF，請將 topComponents 設為空陣列 []。
      
      回傳欄位說明：
      - name: 股票/ETF 全名 (簡短即可)
      - exDividendDate: 本次除息日期 (YYYY-MM-DD)
      - paymentDate: 本次領息日期 (YYYY-MM-DD)
      - amount: 本次單次配發金額 (數字)
      - receivedAmountCurrentYear: ${currentYear}年已領取的現金股利總和 (數字)
      - pendingAmountCurrentYear: ${currentYear}年已公佈但未領取的現金股利總和 (數字)
      - monthlyDistribution: 長度為 12 的數字陣列 (1-12月每股配息金額)
      - currentPrice: 最新市場價格 (數字)
      - yield: 殖利率 (百分比，如 5.5)
      - isEtf: 是否為 ETF (boolean)
      - source: 資料來源名稱 (例如 "Yahoo")
      - sourceUrl: 資料來源網址
      - topComponents: 成分股列表 (Array，非 ETF 請回傳 [])
      
      請嚴格遵守 JSON 格式回傳，務必確保 JSON 結構完整，不要包含任何額外文字。若搜尋結果過多，請優先確保股利數據完整，成分股可縮減至前 5 名。
      
      請直接回傳如下格式的 JSON (若非 ETF，topComponents 請務必給空陣列 [])：
      {
        "name": "...",
        "exDividendDate": "YYYY-MM-DD",
        "paymentDate": "YYYY-MM-DD",
        "amount": 0.0,
        "receivedAmountCurrentYear": 0.0,
        "pendingAmountCurrentYear": 0.0,
        "monthlyDistribution": [0,0,0,0,0,0,0,0,0,0,0,0],
        "currentPrice": 0.0,
        "yield": 0.0,
        "isEtf": false,
        "source": "...",
        "sourceUrl": "...",
        "topComponents": []
      }`;

  const config = {
    tools: [{ googleSearch: {} }],
  };

  async function tryModel(modelName: string, useSearch: boolean = true) {
    const ai = getAi();
    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: useSearch ? config : {},
    });

    let text = response.text;
    if (!text) {
      console.error("Gemini returned empty text. Response object:", JSON.stringify(response));
      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason === "MALFORMED_FUNCTION_CALL") {
        throw new Error("AI 工具調用異常，請再試一次。");
      }
      throw new Error("Gemini 回傳內容為空，可能是因為安全過濾器攔截。");
    }
    
    let data;
    let retryCount = 0;
    const maxRetries = 1;

    while (retryCount <= maxRetries) {
      try {
        let cleanText = text;
        const jsonMatch = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
        if (jsonMatch && jsonMatch[1]) {
          cleanText = jsonMatch[1];
        } else {
          cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        }
        
        const startIndex = cleanText.indexOf('{');
        const endIndex = cleanText.lastIndexOf('}');
        if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
          cleanText = cleanText.substring(startIndex, endIndex + 1);
        }
        
        data = JSON.parse(cleanText);
        break;
      } catch (parseErr) {
        if (retryCount === maxRetries) throw new Error("解析 AI 回傳格式失敗。");
        retryCount++;
        const retryResponse = await ai.models.generateContent({
          model: modelName,
          contents: prompt + "\n\n請務必確保回傳完整的 JSON 格式。",
          config: useSearch ? config : {},
        });
        text = retryResponse.text || "";
      }
    }
    
    const isLikelyEtf = cleanSymbol.startsWith('00') && (cleanSymbol.length >= 4 && cleanSymbol.length <= 6);
    const finalIsEtf = data.isEtf || isLikelyEtf;

    return {
      symbol: cleanSymbol,
      name: data.name,
      exDividendDate: data.exDividendDate,
      paymentDate: data.paymentDate,
      amount: data.amount,
      receivedAmountCurrentYear: data.receivedAmountCurrentYear,
      pendingAmountCurrentYear: data.pendingAmountCurrentYear,
      monthlyDistribution: data.monthlyDistribution,
      currentPrice: data.currentPrice,
      yield: data.yield,
      isEtf: finalIsEtf,
      topComponents: data.topComponents,
      source: `${data.source} (${modelName.includes('pro') ? 'Pro' : 'Flash'}${useSearch ? '' : '-無搜尋'})`,
      sourceUrl: data.sourceUrl,
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    // 優先使用 Flash 模型
    return await tryModel("gemini-3-flash-preview");
  } catch (error: any) {
    const errorMessage = error?.message || "";
    const isQuotaError = errorMessage.includes("429") || 
                        errorMessage.toLowerCase().includes("quota") || 
                        errorMessage.toLowerCase().includes("resource_exhausted");

    if (isQuotaError) {
      console.warn("API rate limited, trying fallback strategies for", symbol);
      
      // 策略 1: 等待 2 秒後嘗試 Pro 模型 (帶搜尋)
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        return await tryModel("gemini-3.1-pro-preview", true);
      } catch (proError: any) {
        // 如果 Pro 也滿了，直接報錯，不要使用「無搜尋」模式，因為會導致數據錯誤
        throw new Error("AI 查詢次數已達上限。這通常是因為 Google 免費版金鑰的限制。請稍等 1 分鐘後再試，或使用「手動輸入」功能。");
      }
    }
    throw error;
  }
}
