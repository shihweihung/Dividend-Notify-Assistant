import moment from "moment-timezone";
import { GoogleGenAI } from "@google/genai";
import { ctx } from "../context";
import { sendTelegramMsg } from "./telegramApi";

// Core Function: Generate Daily "舒洪道" Style Post Draft via Gemini & Telegram Push
export const DAILY_POST_TRIAL_END = "2026-08-11";

export async function generateDailyPostCore() {
  console.log("[Daily Post] Starting daily post draft generation...");

  const taipeiTime = moment().tz("Asia/Taipei");
  const todayStr = taipeiTime.format("YYYY-MM-DD");

  // 1. Trial Period Expiry Check
  if (todayStr > DAILY_POST_TRIAL_END) {
    console.log("[Daily Post] Trial period ended, skipping.");
    return { success: true, skipped: true, reason: "Trial period ended" };
  }

  // 2. Weekday Check (0 is Sunday, 6 is Saturday)
  const dayOfWeek = taipeiTime.day();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log(`[Daily Post] Weekend (${todayStr}, day ${dayOfWeek}), skipping.`);
    return { success: true, skipped: true, reason: "Weekend" };
  }

  if (ctx.firestoreAvailable === false || !ctx.adminDb) {
    console.warn("[Daily Post] Firestore unavailable. Skipping post draft generation.");
    return { success: false, error: "Firestore unavailable" };
  }

  let postsGenerated = 0;
  const processedChatIds = new Set<string>();

  const processAndSendDraftForUser = async (userStocks: any[], chatId: string, botToken: string) => {
    const processed = userStocks.map((s: any) => {
      const currentPrice = Number(s.dividendInfo?.currentPrice || s.currentPrice || 0);
      const shares = Number(s.shares) || 0;
      const marketValue = currentPrice * shares;

      let changePct: number | null = null;
      if (s.dividendInfo?.priceChange !== undefined && s.dividendInfo?.priceChange !== null && currentPrice > 0) {
        const prevPrice = currentPrice - Number(s.dividendInfo.priceChange);
        if (prevPrice > 0) {
          changePct = Number((((currentPrice - prevPrice) / prevPrice) * 100).toFixed(2));
        }
      }

      const exDate = s.dividendInfo?.exDividendDate;
      const payDate = s.dividendInfo?.paymentDate || s.dividendInfo?.payDate;

      return {
        symbol: s.symbol,
        name: s.name || s.symbol,
        shares: shares,
        cost: s.cost !== undefined && s.cost !== null ? Number(s.cost) : null,
        currentPrice: currentPrice,
        changePct: changePct,
        todayIsExDividend: Boolean(exDate && exDate === todayStr),
        todayIsPaymentDate: Boolean(payDate && payDate === todayStr),
        _marketValue: marketValue
      };
    });

    processed.sort((a, b) => b._marketValue - a._marketValue);

    const top10 = processed.slice(0, 10).map(({ _marketValue, ...item }) => item);
    if (top10.length === 0) return;

    const top10Json = JSON.stringify(top10, null, 2);

    const systemPromptTemplate = `你是「舒洪道」，一位中年工程師兼爸爸，用「投資人生」的角度寫股市與生活。
你不是老師、不是分析師，是值得長期追蹤的散戶創作者。
你的讀者喜歡的是你的思考方式和價值觀，不是每天猜對盤勢。
# 核心原則
- 不套公式，每篇切入點不同，不要讓讀者一看開頭就知道走向。
- 語氣像朋友喝咖啡聊天，不是設計過的內容。寧願簡單也不要刻意。
- 不用每篇都製造反轉、金句或感人結尾，可以很輕鬆、很幽默，或只是一個簡單的想法。
# 收尾習慣
不要用抽象的雞湯式收尾（例如泛泛地說「明天的事明天再煩惱」）。
優先用具體、真實的生活細節收尾，讓文章落在一個實際的畫面上，而不是一句感想。
# 用詞細節
- 「翻盤」比「翻臉」更準確傳達市場態度急轉的感覺，優先用「翻盤」。
- 可以用「噴到漲停」這類具體、口語化的描述，比單純「漲停」更有畫面感。
# 格式規則
- 全篇一律用全形標點（，。；），不用半形。
- 不用破折號（—）。
- 短文就保持短，不要為了湊長度硬加內容，字數服從真實素材的量。
# 寫作前自問
「如果今天不是寫文章，而是我跟一位朋友喝咖啡聊天，我會怎麼說？」
用這個問題定調，再開始寫。
---
# 今天的素材（重要限制）
以下是今日持股的原始資料，把它當作「今天可以聊的素材」，不是要你逐一報告：
${top10Json}
從中挑一兩個你覺得有感覺的點來寫（可能是某支漲跌特別明顯、股利剛好入帳、
或是跟平常比有什麼不一樣），像平常聊天一樣自然帶到，不用每支股票都提，
也不用交代完整數字。
如果今天資料都很平淡，沒有特別想聊的點，就寫得平淡、簡短，
不要硬找話題或戲劇性。
絕對不能編造生活情節（不可以寫「跟老婆聊天」「同事說」「粉絲留言」這類
沒有依據的橋段），但可以用「今天看盤」「早上打開 app」這類跟自己動作
有關的自然開場。
請直接輸出貼文內容，不要加任何說明或標題。`;

    const apiKey = process.env.CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn("[Daily Post] GEMINI_API_KEY missing, skipping Gemini call.");
      return;
    }

    try {
      const ai = new GoogleGenAI({ 
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      // Use gemini-flash-lite-latest (strictly Flash / Flash-Lite models, never Pro)
      const draftModelsToTry = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash"];
      let generatedText = "";

      for (const modelName of draftModelsToTry) {
        let timeoutId: NodeJS.Timeout | undefined = undefined;
        try {
          const apiCallPromise = ai.models.generateContent({
            model: modelName,
            contents: systemPromptTemplate,
          });

          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error("Gemini API call timed out after 20 seconds"));
            }, 20000);
          });

          const response = await Promise.race([apiCallPromise, timeoutPromise]);

          generatedText = response.text ? response.text.trim() : "";
          if (generatedText) {
            console.log(`[Daily Post] Successfully generated post using model: ${modelName}`);
            break;
          }
        } catch (modelErr: any) {
          console.warn(`[Daily Post] Model ${modelName} failed, retrying next Flash candidate:`, modelErr.message || modelErr);
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        }
      }

      if (generatedText) {
        const fullMsg = `📝 今日貼文草稿(舒洪道)：\n\n${generatedText}`;
        await sendTelegramMsg(botToken, chatId, fullMsg);
        console.log(`[Daily Post] Successfully sent daily post draft to ChatID ${chatId}`);
      } else {
        console.error(`[Daily Post Error] All Flash model candidates failed for ChatID ${chatId}`);
      }
    } catch (genErr: any) {
      console.error(`[Daily Post Gemini Error] ChatID ${chatId}:`, genErr.message || genErr);
    }
  };

  try {
    // 1. Process authenticated users collection
    const usersSnapshot = await ctx.adminDb.collection("users").get();
    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      const userData = userDoc.data() || {};
      const chatId = userData.telegramChatId ? String(userData.telegramChatId) : null;
      const botToken = userData.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "";

      if (!chatId || !botToken) continue;
      processedChatIds.add(chatId);

      const stocksSnapshot = await ctx.adminDb.collection("users").doc(userId).collection("stocks").get();
      const userStocks = stocksSnapshot.docs.map((d: any) => d.data());

      if (!userStocks || userStocks.length === 0) continue;

      await processAndSendDraftForUser(userStocks, chatId, botToken);
      postsGenerated++;
    }

    // 2. Process telegram_chats collection (for standalone Telegram Bot chats)
    const chatsSnapshot = await ctx.adminDb.collection("telegram_chats").get();
    for (const chatDoc of chatsSnapshot.docs) {
      const chatData = chatDoc.data() || {};
      const chatId = String(chatData.chatId || chatDoc.id);
      if (processedChatIds.has(chatId)) continue;
      const botToken = chatData.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
      const userStocks = chatData.stocks || [];

      if (!chatId || !botToken || !Array.isArray(userStocks) || userStocks.length === 0) continue;

      await processAndSendDraftForUser(userStocks, chatId, botToken);
      postsGenerated++;
    }

    console.log(`[Daily Post Complete] Date: ${todayStr}, Posts Drafts Generated: ${postsGenerated}`);
    return { success: true, date: todayStr, postsGenerated };
  } catch (err: any) {
    console.error("[Daily Post Error]:", err.message || err);
    return { success: false, error: err.message || err };
  }
}
