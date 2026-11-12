import { mergeAndValidateStocks } from "../lib/portfolioMerge";

// Helper: Gemini Vision OCR for Portfolio Screenshots
export async function parsePortfolioScreenshotWithGemini(imageBase64: string, mimeType: string = "image/png") {
  const apiKey = process.env.CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("伺服器尚未設定 AI 金鑰，請聯繫管理員。");
  }

  const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  const prompt = `你是一位精通台灣股市與各大券商 APP（例如：國泰樹精靈、富邦 e 點通、元大證券、三竹股市、永豐金、國泰 CUBE、Firstrade 等）庫存畫面辨識的 AI 專家。
請仔細辨識這張券商持股/庫存截圖，精準提取出所有股票或 ETF 的持股資料：

⚠️ 欄位填寫指示：
1. "symbol": 只填畫面上實際看得到的代號（例如 "2330", "0056"）。畫面上若沒有數字/英文代號就填 null，絕對不要推測或依記憶補上。
2. "name": 完全照抄畫面上的股名，不翻譯、不補字、不展開簡稱。
3. "shares": 持有股數（⚠️ 若畫面單位顯示「張」，請務必轉換為「股數」，1 張 = 1000 股！例如 15 張填 15000；若顯示「股」或無單位數字，請填數字，例如 1,050 股填 1050）。
4. "cost": 平均成本單價（若畫面顯示均價/買價請填數字；若無顯示填 null）。
5. "currentPrice": 現價/成交價（若畫面顯示請填數字；若無顯示填 null）。
6. "totalCost": 畫面上的「投資成本」或「總投資成本」欄位數字（例如 572239），若畫面無此欄位填 null。

請只回傳合法的 JSON 格式，不要加入任何 Markdown 標記，格式範例如下：
{
"parsedStocks": [
  {
    "symbol": null,
    "name": "元大高股息",
    "shares": 15000,
    "cost": 38.15,
    "currentPrice": null,
    "totalCost": 572239
  }
],
"note": "成功辨識出 1 檔持股"
}`;

  const modelsToTry = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash"];
  let resultText = "";
  let lastErr: any = null;

  for (const m of modelsToTry) {
    let timeoutId: NodeJS.Timeout | undefined = undefined;
    try {
      const apiCallPromise = ai.models.generateContent({
        model: m,
        contents: [
          {
            inlineData: {
              mimeType: mimeType || "image/png",
              data: cleanBase64
            }
          },
          prompt
        ],
        config: {
          responseMimeType: "application/json"
        }
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Gemini API call for model ${m} timed out after 20 seconds`));
        }, 20000);
      });

      const response = await Promise.race([apiCallPromise, timeoutPromise]);
      if (response.text) {
        resultText = response.text;
        break;
      }
    } catch (e) {
      lastErr = e;
      console.warn(`[Screenshot OCR] Model ${m} failed, trying next...`, e);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  if (!resultText) {
    throw lastErr || new Error("AI 截圖解析無回應");
  }

  const cleanJsonStr = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
  const parsedData = JSON.parse(cleanJsonStr);

  const rawList = Array.isArray(parsedData.parsedStocks) ? parsedData.parsedStocks : [];
  const mergedResult = mergeAndValidateStocks(rawList);

  return {
    parsedStocks: mergedResult.parsedStocks,
    unresolved: mergedResult.unresolved,
    invalid: mergedResult.invalid,
    note: parsedData.note || `成功辨識出 ${mergedResult.parsedStocks.length} 檔持股`
  };
}
