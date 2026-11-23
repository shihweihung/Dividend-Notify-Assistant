// 口語記帳：請 Gemini Flash-Lite 從一句話抽出買賣欄位（只抽，不判斷股票代號、不算錢）。
// 只有 looksLikeTradeIntent() 判斷像在講買賣時才會呼叫，一般聊天不多花錢。

import type { ExtractedTrade } from "../lib/tradeCommand";

export type Extraction = { isTrade: boolean; trades: ExtractedTrade[] };

export async function extractTradesWithGemini(text: string, today: string, heldNames: string[]): Promise<Extraction> {
  const apiKey = process.env.CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini 金鑰未設定");
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { "User-Agent": "aistudio-build" } } });

  const prompt =
    `今天是 ${today}（台北時間）。使用者用口語告訴記帳助理他「已經成交」的台股買賣，請抽出欄位。\n` +
    `使用者目前的持股名稱：${heldNames.join("、") || "（無）"}\n\n` +
    `規則：\n` +
    `- 只處理已經成交的買賣；如果是在問問題、考慮要不要買、或只是聊天，isTrade 回 false\n` +
    `- 一句話可能有好幾筆，每筆一個物件\n` +
    `- side：買進/加碼/入手 = "buy"；賣出/減碼/出清/停損/停利 = "sell"\n` +
    `- stock：照使用者說的股名或代號原樣抄下，不要自己換成代號\n` +
    `- 「張」填 lots（兩張 → 2，半張 → 0.5）；「股」填 shares；說全部賣掉、出清填 sellAll true\n` +
    `- price：每股成交價；使用者沒說就填 null，絕對不可以自己猜或用市價\n` +
    `- date：使用者有說才填，可填「昨天」「前天」「11/20」或 YYYY-MM-DD；沒說填 null\n` +
    `- 沒提到的欄位一律填 null，不可編造\n\n` +
    `只回傳 JSON：{"isTrade": true, "trades": [{"side": "sell", "stock": "日月光", "shares": null, "lots": 2, "sellAll": false, "price": 178, "date": null}]}\n\n` +
    `使用者的話：${text}`;

  const models = ["gemini-flash-lite-latest", "gemini-flash-latest"];
  let lastErr: unknown = null;
  for (const model of models) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const call = ai.models.generateContent({ model, contents: prompt, config: { responseMimeType: "application/json", temperature: 0 } });
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 15000); });
      const res: any = await Promise.race([call, timeout]);
      const raw = String(res.text || "").replace(/```json|```/g, "").trim();
      if (!raw) continue;
      const data = JSON.parse(raw);
      return { isTrade: Boolean(data.isTrade), trades: Array.isArray(data.trades) ? data.trades : [] };
    } catch (e) {
      lastErr = e;
      console.warn(`[Trade Extract] ${model} failed`, e);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr || new Error("Gemini 無回應");
}
