import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { fetchStockDataFromTwse } from "./src/services/twseService";
import moment from "moment-timezone";

const __dirname = process.cwd();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // 1. Module/Function level variables for Firestore connection health
  let firestoreAvailable: boolean | null = null;
  let firestoreErrorLogged = false;
  const isProduction = process.env.NODE_ENV === "production" || !!process.env.K_SERVICE;

  // In-memory fallback caches
  const inMemoryProcessedMessages = new Set<string>();
  const inMemoryRateLimits = new Map<string, number[]>();
  const inMemoryTelegramChats = new Map<string, any>();

  function logFirestoreError(context: string, error: any) {
    if (isProduction) {
      console.error(`[Firestore Error] ${context}:`, error);
    } else {
      if (!firestoreErrorLogged) {
        console.warn(`[Firestore Warning] ${context} (this is expected in dev environments without Firestore access):`, error.message || error);
        firestoreErrorLogged = true;
      }
    }
  }

  // Initialize Firebase Admin dynamically securely connected to Firestore
  const fbConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
  let adminDb: any = null;
  if (fs.existsSync(fbConfigPath)) {
    try {
      const firebaseConfig = JSON.parse(fs.readFileSync(fbConfigPath, "utf-8"));
      const firebaseApp = admin.initializeApp({
        projectId: firebaseConfig.projectId,
      });
      adminDb = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);
      console.log(`[Firebase Admin] Fully initialized with Project ID: ${firebaseConfig.projectId}, Database ID: ${firebaseConfig.firestoreDatabaseId}`);

      // 2. Perform connection check at startup
      try {
        await adminDb.collection("telegram_chats").limit(1).get();
        firestoreAvailable = true;
        console.log("[Firestore] Health check passed");
      } catch (hcErr: any) {
        firestoreAvailable = false;
        console.warn("[Firestore] Not accessible in this environment. Some features will be disabled.", hcErr.message || hcErr);
      }
    } catch (fbErr) {
      console.error("[Firebase Admin] Initialization failed:", fbErr);
      firestoreAvailable = false;
    }
  } else {
    firestoreAvailable = false;
  }

  async function sendTelegramMsg(botToken: string, toChatId: number, textToSend: string) {
    if (textToSend.length > 4000) {
      console.log(`[Telegram Send] Text length ${textToSend.length} exceeds 4000, splitting into multiple messages...`);
      const chunks: string[] = [];
      for (let i = 0; i < textToSend.length; i += 4000) {
        chunks.push(textToSend.substring(i, i + 4000));
      }
      let lastResponse: any = null;
      for (let idx = 0; idx < chunks.length; idx++) {
        console.log(`[Telegram Send] Sending chunk ${idx + 1}/${chunks.length} for ChatID ${toChatId}`);
        lastResponse = await sendSingleTelegramMsg(botToken, toChatId, chunks[idx]);
      }
      return lastResponse;
    } else {
      return sendSingleTelegramMsg(botToken, toChatId, textToSend);
    }
  }

  async function sendSingleTelegramMsg(botToken: string, toChatId: number, textToSend: string) {
    console.log(`[Telegram Send] Attempting to send to ChatID ${toChatId}, message length: ${textToSend.length}`);
    try {
      // First attempt with Markdown
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: toChatId,
          text: textToSend,
          parse_mode: "Markdown",
        }),
      });

      if (response.ok) {
        console.log(`[Telegram Send Success] Delivered to ChatID ${toChatId}`);
        return response;
      }

      // First attempt failed
      let errDetails: any = null;
      try {
        errDetails = await response.json();
      } catch (jsonErr) {
        errDetails = "Unparseable JSON response";
      }

      console.warn(`[Telegram Send Warning] Markdown failed for ChatID ${toChatId}, status: ${response.status}, response: ${JSON.stringify(errDetails)}`);

      // Second attempt (plain text fallback, no parse_mode)
      console.log(`[Telegram Send] Attempting plain-text fallback for ChatID ${toChatId}`);
      const fallbackResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: toChatId,
          text: textToSend,
        }),
      });

      if (fallbackResponse.ok) {
        console.log(`[Telegram Send Success] Plain text fallback delivered to ChatID ${toChatId}`);
        return fallbackResponse;
      }

      // Fallback failed too
      let fallbackErrDetails: any = null;
      try {
        fallbackErrDetails = await fallbackResponse.json();
      } catch (jsonErr) {
        fallbackErrDetails = "Unparseable JSON response";
      }

      console.error(`[Telegram Send Fatal] Both attempts failed for ChatID ${toChatId}, status: ${fallbackResponse.status}, response: ${JSON.stringify(fallbackErrDetails)}`);
      return fallbackResponse;

    } catch (err: any) {
      console.error(`[Telegram Send Exception] ChatID ${toChatId}:`, err instanceof Error ? err.stack : err);
    }
  }

  const getChatFromFirestore = async (chatId: string) => {
    if (firestoreAvailable === false) {
      return inMemoryTelegramChats.get(chatId) || null;
    }
    try {
      const doc = await adminDb.collection("telegram_chats").doc(chatId).get();
      return doc.exists ? doc.data() : null;
    } catch (e: any) {
      logFirestoreError(`getChatFromFirestore for chatId ${chatId}`, e);
      return inMemoryTelegramChats.get(chatId) || null;
    }
  };

  const saveChatToFirestore = async (chatId: string, data: any) => {
    inMemoryTelegramChats.set(chatId, data);
    if (firestoreAvailable === false) {
      return;
    }
    try {
      await adminDb.collection("telegram_chats").doc(chatId).set({
        ...data,
        updatedAt: new Date().toISOString()
      }, { merge: true });
    } catch (e: any) {
      logFirestoreError(`saveChatToFirestore for chatId ${chatId}`, e);
    }
  };

  // Migrate JSON DB to Firestore
  const dbPath = path.join(process.cwd(), "telegram_chats_db.json");
  if (fs.existsSync(dbPath)) {
    try {
      const dbData = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
      for (const chatId in dbData) {
        if (firestoreAvailable !== false) {
          try {
            await adminDb.collection("telegram_chats").doc(chatId).set(dbData[chatId]);
          } catch (e: any) {
            logFirestoreError(`Migrate JSON DB element for ${chatId}`, e);
          }
        }
        inMemoryTelegramChats.set(chatId, dbData[chatId]);
      }
      fs.unlinkSync(dbPath);
      console.log("Migration complete: telegram_chats_db.json -> Firestore/InMemory fallback");
    } catch (e) {
      console.error("Migration error:", e);
    }
  }

  app.use(express.json());

  const apiKeyAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === process.env.API_SECRET_KEY) {
      next();
    } else {
      res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
    }
  };

  async function updateAllUserStocks() {
    if (!adminDb || firestoreAvailable === false) {
      console.warn("[Stock Update] Firestore not accessible or initialized in this environment. Skipping global stock update.");
      return;
    }

    console.log("[Stock Update] Starting global stock data update...");
    const fetchCache = new Map<string, any>();

    try {
      // 1. Get all users
      const usersSnap = await adminDb.collection("users").get();
      console.log(`[Stock Update] Found ${usersSnap.size} users to update.`);

      for (const userDoc of usersSnap.docs) {
        const userId = userDoc.id;
        const stocksSnap = await adminDb.collection("users").doc(userId).collection("stocks").get();
        console.log(`[Stock Update] User ${userId} has ${stocksSnap.size} stocks.`);

        for (const stockDoc of stocksSnap.docs) {
          const stock = stockDoc.data();
          const symbol = stockDoc.id; // Stock symbol is the document ID

          if (!symbol) continue;

          console.log(`[Stock Update] Updating stock ${symbol} for user ${userId}`);

          let data = fetchCache.get(symbol);
          if (data === undefined) {
            try {
              console.log(`[Stock Update] Fetching fresh data for ${symbol} from TWSE/Yahoo/HiStock...`);
              data = await fetchStockDataFromTwse(symbol);
              fetchCache.set(symbol, data);
              // Wait a bit to avoid hitting endpoints too rapidly
              await new Promise(resolve => setTimeout(resolve, 1500));
            } catch (err: any) {
              console.error(`[Stock Update] Error fetching data for ${symbol}:`, err.message || err);
              data = null;
              fetchCache.set(symbol, null);
            }
          } else {
            console.log(`[Stock Update] Using cached data for ${symbol}`);
          }

          if (data) {
            try {
              const dividendInfo = {
                symbol: data.symbol,
                name: data.name,
                exDividendDate: data.exDate,
                paymentDate: data.paymentDate,
                amount: data.amount,
                receivedAmountCurrentYear: data.receivedAmount,
                pendingAmountCurrentYear: data.pendingAmount,
                monthlyDistribution: data.monthlyDistribution,
                pendingMonthlyDistribution: data.pendingMonthlyDistribution,
                currentPrice: data.price,
                yield: data.yield,
                isPaymentDateEstimated: data.isPaymentDateEstimated,
                status: data.status,
                history: data.history,
                updatedAt: new Date().toISOString()
              };

              await adminDb.collection("users").doc(userId).collection("stocks").doc(symbol).set({
                dividendInfo,
                updatedAt: new Date().toISOString()
              }, { merge: true });

              console.log(`[Stock Update Success] Updated ${symbol} for user ${userId}`);
            } catch (updateErr: any) {
              console.error(`[Stock Update Error] Failed to write ${symbol} to Firestore for user ${userId}:`, updateErr.message || updateErr);
            }
          }
        }
      }
      console.log("[Stock Update] Global stock data update completed successfully!");
    } catch (err: any) {
      console.error("[Stock Update Fatal] Global stock update failed:", err.message || err);
    }
  }

  let lastUpdateRunDate = "";

  function startDailyUpdateScheduler() {
    console.log("[Scheduler] Daily stock update scheduler started.");
    
    setInterval(async () => {
      try {
        const taipeiTime = moment().tz("Asia/Taipei");
        const todayStr = taipeiTime.format("YYYY-MM-DD");
        const hourMinute = taipeiTime.format("HH:mm");
        const dayOfWeek = taipeiTime.day(); // 0 is Sunday, 6 is Saturday
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        // Check if it's 2:00 PM (14:00) Taipei time and hasn't run today yet
        if (hourMinute === "14:00" && lastUpdateRunDate !== todayStr) {
          lastUpdateRunDate = todayStr;
          if (isWeekend) {
            console.log(`[Scheduler] It is 14:00 Taipei time on weekend (${todayStr}). Skipping stock update as market is closed.`);
          } else {
            console.log(`[Scheduler] It is 14:00 Taipei time on weekday (${todayStr}). Triggering daily stock update...`);
            await updateAllUserStocks();
          }
        }
      } catch (err: any) {
        console.error("[Scheduler Error] Error in daily update check:", err.message || err);
      }
    }, 60000); // Check every minute
  }

  // Start the daily update scheduler
  startDailyUpdateScheduler();

  // API: Manually trigger update of all user stock prices & dividends
  app.get("/api/admin/trigger-stock-update", async (req, res) => {
    const key = req.query.key || req.headers['x-api-key'];
    if (!process.env.API_SECRET_KEY || key === process.env.API_SECRET_KEY) {
      console.log("[API] Manual stock update triggered via API.");
      updateAllUserStocks().catch(err => {
        console.error("[API Stock Update Error]", err);
      });
      return res.json({ success: true, message: "Stock update process triggered in background." });
    } else {
      return res.status(401).json({ error: "Unauthorized" });
    }
  });

  // API: Save / Sync Telegram Chat Data
  app.post("/api/telegram/save-chat-data", apiKeyAuth, async (req, res) => {
    try {
      const { chatId, botToken, cash, stocks, username } = req.body;
      if (!chatId) {
        return res.status(400).json({ error: "缺少必要參數：chatId" });
      }

      const existing = (await getChatFromFirestore(String(chatId))) || {};
      const updatedData = {
        chatId: String(chatId),
        botToken: botToken || existing.botToken || process.env.TELEGRAM_BOT_TOKEN,
        cash: cash !== undefined ? Number(cash) : (existing.cash || 0),
        stocks: stocks !== undefined ? stocks : (existing.stocks || []),
        username: username || existing.username || "投資大師",
        isWebhookMode: existing.isWebhookMode || false,
        baseUrl: existing.baseUrl || "",
      };

      await saveChatToFirestore(String(chatId), updatedData);
      return res.json({ success: true });
    } catch (err: any) {
      console.error("Error saving chat data:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  // API: Send Telegram Alert / Report
  app.post("/api/telegram/send", apiKeyAuth, async (req, res) => {
    const { botToken, chatId, message } = req.body;

    if (!botToken || !chatId || !message) {
      return res.status(400).json({ error: "缺少必要參數：botToken、chatId 或 message" });
    }

    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "Markdown",
        }),
      });

      const data: any = await response.json();
      if (response.ok && data.ok) {
        return res.json({ success: true });
      } else {
        return res.status(response.status || 400).json({
          error: data.description || "Telegram API 原始錯誤",
        });
      }
    } catch (err: any) {
      console.error("Telegram forwarding error:", err);
      return res.status(500).json({ error: `連線 Telegram 失敗：${err.message}` });
    }
  });

  // Helper: Process Telegram Message (shared by Webhook and Polling)
  async function processTelegramMessage(botToken: string, msg: any) {
    if (!msg || !msg.chat || !msg.chat.id) return;
    const chatId = msg.chat.id;
    const msgId = msg.message_id;

    // 1. Deduplication & Rate Limiting with Fallbacks
    const now = Date.now();
    const dedupKey = `${chatId}_${msgId}`;
    let isDuplicate = false;

    if (firestoreAvailable !== false) {
      try {
        const dedupDocRef = adminDb.collection("processed_messages").doc(dedupKey);
        const dedupDoc = await dedupDocRef.get();
        if (dedupDoc.exists && now - dedupDoc.data()!.timestamp < 600000) {
          isDuplicate = true;
        } else {
          await dedupDocRef.set({ timestamp: now });
        }
      } catch (e: any) {
        logFirestoreError("Deduplication check", e);
        if (inMemoryProcessedMessages.has(dedupKey)) {
          isDuplicate = true;
        } else {
          inMemoryProcessedMessages.add(dedupKey);
        }
      }
    } else {
      if (inMemoryProcessedMessages.has(dedupKey)) {
        isDuplicate = true;
      } else {
        inMemoryProcessedMessages.add(dedupKey);
      }
    }

    if (isDuplicate) {
      console.log(`[Telegram Bot Dedup] Already processed message ${msgId} for ChatID ${chatId}. Discarding duplicate.`);
      return;
    }

    let timestamps: number[] = [];
    if (firestoreAvailable !== false) {
      try {
        const rateLimitRef = adminDb.collection("rate_limits").doc(String(chatId));
        const rateLimitDoc = await rateLimitRef.get();
        timestamps = rateLimitDoc.exists ? (rateLimitDoc.data()!.timestamps || []) : [];
        timestamps = timestamps.filter((ts: number) => now - ts < 60000);
        if (timestamps.length >= 3) {
          await sendTelegramMsg(botToken, chatId, "請稍後再試");
          return;
        }
        timestamps.push(now);
        await rateLimitRef.set({ timestamps });
      } catch (e: any) {
        logFirestoreError("Rate limit check", e);
        timestamps = inMemoryRateLimits.get(String(chatId)) || [];
        timestamps = timestamps.filter((ts: number) => now - ts < 60000);
        if (timestamps.length >= 3) {
          await sendTelegramMsg(botToken, chatId, "請稍後再試");
          return;
        }
        timestamps.push(now);
        inMemoryRateLimits.set(String(chatId), timestamps);
      }
    } else {
      timestamps = inMemoryRateLimits.get(String(chatId)) || [];
      timestamps = timestamps.filter((ts: number) => now - ts < 60000);
      if (timestamps.length >= 3) {
        await sendTelegramMsg(botToken, chatId, "請稍後再試");
        return;
      }
      timestamps.push(now);
      inMemoryRateLimits.set(String(chatId), timestamps);
    }

    const text = (msg.text || "").trim();
    const username = msg.from?.first_name || msg.from?.username || msg.from?.last_name || "投資大師";

    console.log(`[Telegram Bot] Processing message from ChatID ${chatId}: "${text}"`);

    let stocks: any[] = [];
    let cash = 0;
    let foundInFirestore = false;
    let finalUsername = username;

    // 1. Lookup: Firestore
    const chatInfo = await getChatFromFirestore(String(chatId));
    if (chatInfo && (chatInfo.stocks?.length > 0 || chatInfo.cash > 0 || (chatInfo.username && chatInfo.username !== "投資大師"))) {
      stocks = chatInfo.stocks || [];
      cash = Number(chatInfo.cash || 0);
      finalUsername = chatInfo.username || username;
      foundInFirestore = true;
      console.log(`[Telegram Bot DB Lookup] Loaded ${stocks.length} stocks and $${cash} cash from Firestore.`);
    }

    // 2. Secondary Fallback: Cloud Firestore DB
    if (!foundInFirestore && firestoreAvailable !== false && adminDb) {
      try {
        console.log(`[Telegram Bot DB Lookup] Querying Firestore fallback for telegramChatId = "${chatId}"`);
        const usersRef = adminDb.collection("users");
        const querySnapshot = await usersRef.where("telegramChatId", "==", String(chatId)).get();
        
        if (!querySnapshot.empty) {
          const userDoc = querySnapshot.docs[0];
          const userData = userDoc.data();
          cash = userData.cash !== undefined ? Number(userData.cash) : 0;
          finalUsername = userData.username || userData.displayName || msg.from?.first_name || msg.from?.username || msg.from?.last_name || "投資大師";
          
          console.log(`[Telegram Bot DB Lookup] Found user document: ${userDoc.id}. Fetching live stocks...`);
          const stocksSnapshot = await usersRef.doc(userDoc.id).collection("stocks").get();
          stocks = stocksSnapshot.docs.map((doc: any) => doc.data());
          foundInFirestore = true;
          console.log(`[Telegram Bot DB Lookup] Loaded ${stocks.length} stocks and $${cash} cash dynamically from Firestore.`);
        } else {
          console.log(`[Telegram Bot DB Lookup] No user document matches telegramChatId: "${chatId}" in Firestore.`);
        }
      } catch (err: any) {
        logFirestoreError("Secondary User Lookup", err);
      }
    }


    // Send welcome message if user not found
    if (!foundInFirestore) {
      // User is not connected yet
      const helpMessage = `👋 哈囉 ${username}！\n\n` +
        `目前您的 Telegram 帳號尚未與「息引力」投資管理網站進行連結狀態同步。\n\n` +
        `您的 Telegram Chat ID 是：\n` +
        `\`${chatId}\` (👈 點擊即可複製)\n\n` +
        `請依照以下步驟完成連結：\n` +
        `1️⃣ 複製上方的 Chat ID。\n` +
        `2️⃣ 前往「息引力」網頁，點擊右上角「通知偏好」或「通知與推播設定」按鈕。\n` +
        `3️⃣ 在「Telegram Chat ID」輸入框中貼上，點擊「儲存設定」，即可立即喚醒您的雙向智慧對話大門！🚀`;
      
      await sendTelegramMsg(botToken, chatId, helpMessage);
      return;
    }

    // Welcome/start command
    if (text.startsWith("/start")) {
      const welcomeText = `🎉 恭喜連線成功，${finalUsername}！\n\n` +
        `我是您的專屬「息引力」資產守護助理 🤖。我已成功連結您的息引力專屬帳戶與持股資料！\n\n` +
        `您可以隨時在 Telegram 上對我發言或詢問任何資產與配置問題，例如：\n` +
        `📊 *「我目前的資產現況與配置建議」*\n` +
        `💰 *「我現在有多少閒置現金？」*\n` +
        `📈 *「分析我的持股持倉」*\n` +
        `🎯 *「如何做好我的動態資產平衡？」*\n\n` +
        `直接在下方輸入區輸入您的問題，隨時看子彈到位、聽策略叮嚀！👇`;
      await sendTelegramMsg(botToken, chatId, welcomeText);
      return;
    }

    try {
      // Query Gemini AI
      const { GoogleGenAI } = await import("@google/genai");
      const apiKey = process.env.CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("系統或個人自訂 AI 金鑰（CUSTOM_GEMINI_API_KEY 或 GEMINI_API_KEY）未設定，請在 Settings 內設定。");
      }
      const ai = new GoogleGenAI({ 
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      const stocksList = stocks || [];
      const isTruncated = stocksList.length > 20;
      const stocksSummary = stocksList.length > 0
        ? stocksList.slice(0, 20).map((s: any) => {
            const name = s.name || s.symbol;
            const shares = s.shares || 0;
            const divInfo = s.dividendInfo;
            let extra = "";
            if (divInfo) {
              if (divInfo.currentPrice) {
                extra += `, 現價: ${divInfo.currentPrice}元`;
              }
              if (divInfo.yield) {
                extra += `, 殖利率: ${Number(divInfo.yield).toFixed(2)}%`;
              }
            }
            return `- ${name} (${s.symbol}): ${shares} 股${extra}`;
          }).join("\n") + (isTruncated ? "\n... (省略其餘持股)" : "")
        : "目前持股列表中尚無持股數據（若您剛加入，可返回網頁重新加載以觸發最新的同步）。";

      const backgroundSection = `## 當前個人資產背景\n` +
        `📊 帳戶：${finalUsername} | 現金：${cash.toLocaleString()} 元\n` +
        `持股明細：\n` +
        `${stocksSummary}\n\n`;

      const systemInstruction =
        `# Role: 息引力資產守護助理\n\n` +
        `你是一位專業的股息投資組合分析師,服務對象是有 20+ 檔持股、關注股息現金流與台美股 AI 供應鏈的成熟投資人。\n\n` +
        `## 核心行為準則\n` +
        `- 使用純文字回覆,絕對禁止使用 * # _ 等 Markdown 符號,避免 Telegram 解析失敗\n` +
        `- 直切核心,不客套、不重複、不下總結廢話\n` +
        `- 用「數字 + 事實」說話,少用形容詞\n` +
        `- 段落之間用兩個換行分隔,一段講一個重點\n\n` +
        backgroundSection +
        `## 回覆模式判斷\n\n` +
        `### 模式 A:資產概況查詢(關鍵字:資產、現況、我的股票、現金、閒錢、目前)\n` +
        `限制 3 段落內,約 150-200 字。內容:\n` +
        `1. 總資產快照:市值 + 現金 + 現金比重百分比\n` +
        `2. 前三大部位是哪些股票、佔比多少,是否有集中風險\n` +
        `3. 近 30 定內的除息事件或關鍵行事曆(若有)\n\n` +
        `### 模式 B:組合層級的策略提問(關鍵字:配置、平衡、加碼、減碼、部位、輪動、風險)\n` +
        `300-500 字,分段回答:\n` +
        `1. 現況診斷:目前組合的產業曝險、股息集中度、現金水位是否合理\n` +
        `2. 具體建議:該加碼/減碼哪類部位,說明理由(產業循環位置、估值、殖利率)\n` +
        `3. 執行細節:操作時點的觸發條件(例如「等 XXX 除息後」「季報公布後」)\n` +
        `4. 風險提示:這個建議背後的假設,以及打臉的訊號\n\n` +
        `### 模式 C:個股/ETF 深度分析(關鍵字:分析、看法、值不值得買、XXXX 股號)\n` +
        `300-500 字,三軸分析:\n\n` +
        `【產業鏈位置】\n` +
        `- 這家公司在產業鏈的哪一段?上下游是誰?\n` +
        `- 主要競品是哪幾家?差異化在哪?\n` +
        `- 若為 AI infra 相關,說明與 CPO/光模組/HBM/ASIC 等主軸的連動關係\n\n` +
        `【基本面數據】\n` +
        `- 最近一季/一年 EPS、營收成長率、毛利率(給實際數字)\n` +
        `- 估值:目前 PE、殖利率、與同業比較\n` +
        `- 股息紀錄:近 3-5 年配息連續性、成長率\n\n` +
        `【近期催化劑】\n` +
        `- 已知的法說會、財報公布時點\n` +
        `- 除息日期、預估配息金額\n` +
        `- 產業層級的關鍵事件(新品發表、大廠 capex、政策)\n\n` +
        `結論用 1 句話:結合本人現有部位,建議該加碼/續抱/減碼/觀望,理由一句話。\n\n` +
        `## 資料來源與誠實原則\n` +
        `- 若不確定的財務數字,直接說「這個數字我沒把握,建議查證」,絕對不編造\n` +
        `- 產業鏈與競品關係可用你的知識回答,但明確年份可以說「以近期公開資訊」\n` +
        `- 不預測股價漲跌幅百分比,只講「方向」與「觸發條件」\n\n` +
        `## 禁止事項\n` +
        `- 不要說「投資有風險、請自行判斷」這類套話,使用者是專業投資人\n` +
        `- 不要用 emoji 過度裝飾,重點處用一個即可\n` +
        `- 不要在回覆開頭問候使用者名字,直接進入分析`;

      console.log(`[Process] About to call Gemini for ChatID ${chatId}`);
      let response;
      const modelsToTry = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-pro"];
      let lastErr: any = null;

      for (const modelName of modelsToTry) {
        let retries = 2;
        while (retries > 0) {
          try {
            let timeoutId: NodeJS.Timeout | undefined = undefined;
            const apiCallPromise = ai.models.generateContent({
              model: modelName,
              contents: text,
              config: {
                systemInstruction: systemInstruction,
                temperature: 0.7,
                maxOutputTokens: 2500,
              },
            });

            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                reject(new Error("Gemini API call timed out after 20 seconds"));
              }, 20000);
            });

            response = await Promise.race([apiCallPromise, timeoutPromise]);
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            console.log(`[Gemini Finish Reason] model: ${modelName}, finishReason: ${response.candidates?.[0]?.finishReason || 'unknown'}`);
            break;
          } catch (err: any) {
            retries--;
            lastErr = err;
            console.warn(`[Gemini Backoff] Busy status for model ${modelName} (retries left: ${retries}):`, err.message || err);
            if (retries > 0) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }
        }
        if (response) {
          console.log(`Successfully generated content using model: ${modelName}`);
          break;
        }
      }

      if (!response) {
        throw lastErr || new Error("All Gemini model candidates failed.");
      }

      const replyText = response.text || "抱歉，我的思考核心目前忙碌中，請稍候再試。";
      console.log(`[Process] Gemini done, reply length: ${replyText.length}, about to send`);
      await sendTelegramMsg(botToken, chatId, replyText);
      console.log(`[Process] sendTelegramMsg returned for ChatID ${chatId}`);

    } catch (err: any) {
      console.error("Gemini Telegram answering error:", err.message || err);
      try {
        const errMsg = `⚠️ *機器人服務暫時出現小狀況* ⚠️\n\n` +
          `我們在處理您的提問時遇到異常，可能原因為：\n` +
          `1. 系統或自訂 AI 金鑰設定有誤\n` +
          `2. AI 思考連線逾時\n\n` +
          `*錯誤明細：*\n\`${err.message || err}\`\n\n` +
          `💡 請您返回「息引力」頁面，檢查您的自訂 AI 金鑰設定、或是稍微等候再嘗試向我提問。謝謝您的體諒！`;
        await sendTelegramMsg(botToken, chatId, errMsg);
      } catch (sendErr) {
        console.error("Failed to forward Telegram error message back to user:", sendErr);
      }
    }
  }

  // API: Telegram Webhook Receiver (Bidirectional Interaction - Webhook Mode / Callback fallback)
  app.post("/api/telegram/webhook", async (req, res) => {
    try {
      if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.API_SECRET_KEY) {
        return res.sendStatus(403);
      }
      const { message, edited_message } = req.body;
      const msg = message || edited_message;
      if (!msg || !msg.chat || !msg.chat.id) {
        return res.sendStatus(200);
      }

      const chatId = String(msg.chat.id);
      
      // Look up bot token in DB for this Chat ID to support custom bot tokens
      let botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatInfo = await getChatFromFirestore(chatId);
      if (chatInfo && chatInfo.botToken) {
        botToken = chatInfo.botToken;
      }

      if (!botToken) {
        console.warn(`[Webhook Error] No bot token found for ChatID ${chatId}`);
        return res.sendStatus(200);
      }
      
      // Process the message synchronously
      await processTelegramMessage(botToken, msg);
      return res.sendStatus(200);
    } catch (err: any) {
      console.error("Error inside Webhook receiver middleware:", err instanceof Error ? err.stack : err);
      return res.sendStatus(200);
    }
  });

  // API: Register Telegram Webhook (Dynamic Selection based on Host Environment)
  app.post("/api/telegram/register-webhook", apiKeyAuth, async (req, res) => {
    let { botToken, baseUrl } = req.body;
    if (!botToken) {
      return res.status(400).json({ error: "缺少 botToken" });
    }
    try {
      const isDev = !baseUrl || baseUrl.includes("localhost") || baseUrl.includes("-dev-") || baseUrl.includes("127.0.0.1");
      
      const dbPath = path.join(process.cwd(), "telegram_chats_db.json");
      let dbData: Record<string, any> = {};
      if (fs.existsSync(dbPath)) {
        try {
          dbData = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
        } catch (e) {}
      }

      // Find any chats matching this bot token and update their mode
      const snapshot = await adminDb.collection("telegram_chats").where("botToken", "==", botToken).get();
      for (const doc of snapshot.docs) {
        await doc.ref.update({
          isWebhookMode: !isDev,
          baseUrl: baseUrl || ""
        });
      }

      if (isDev) {
        // Dev: Remove webhook and use polling mode
        const delUrl = `https://api.telegram.org/bot${botToken}/deleteWebhook`;
        const delRes = await fetch(delUrl);
        const delData: any = await delRes.json();
        console.log(`[Telegram Register Dev] Webhook deleted. Polling fallback. details:`, delData);
        return res.json({ 
          success: true, 
          description: "開發測試環境：系統已為您切換至【長輪詢 Polling 模式】。\n\n⚠️ 提示：由於 AI Studio 開發環境會自動休眠，當您關閉瀏覽器分頁時，背景容器預期會在 1~2 分鐘後暫停運作。只要維持分頁開啟，就能維持通訊！若需 24 小時不中斷，請使用「部署網頁」(Shared App) 喔！" 
        });
      } else {
        // Prod / Shared link: Register a public webhook url
        const webhookUrl = `${baseUrl.replace(/\/$/, "")}/api/telegram/webhook`;
        const setUrl = `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}&secret_token=${process.env.API_SECRET_KEY}`;
        const setRes = await fetch(setUrl);
        const setData: any = await setRes.json();
        
        if (setData.ok) {
          console.log(`[Telegram Register Prod] Webhook registered successfully to ${webhookUrl}`);
          return res.json({
            success: true,
            description: "🎉 部署網域 Webhook 已成功註冊！\n\n現在即使您關閉 AI Studio 網頁，當用戶在 Telegram 傳送訊息時，Telegram 伺服器會自動發送請求喚醒您的部署容器。完全實現 24 小時免開啟網頁主動回覆！🤖"
          });
        } else {
          throw new Error(setData.description || "Telegram API 錯誤");
        }
      }
    } catch (err: any) {
      return res.status(500).json({ error: `設定 Webhook 失敗: ${err.message}` });
    }
  });

  // Background Telegram Polling System (Bulletproof strategy for authenticated environments / local testing)
  const botOffsets: Record<string, number> = {};

  async function pollBotUpdates(botToken: string) {
    try {
      const offset = botOffsets[botToken] || 0;
      const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=1`;
      const response = await fetch(url);
      if (!response.ok) return;
      const data: any = await response.json();
      if (data.ok && data.result && data.result.length > 0) {
        for (const update of data.result) {
          botOffsets[botToken] = update.update_id + 1;
          const msg = update.message || update.edited_message;
          if (msg) {
            await processTelegramMessage(botToken, msg);
          }
        }
      }
    } catch (err) {
      // Quiet fail to avoid spamming server logs during workspace sleep cycles
    }
  }

  async function getActivePollingBotTokens(): Promise<string[]> {
    const defaultBotToken = process.env.TELEGRAM_BOT_TOKEN;
    if (firestoreAvailable === false) {
      return [defaultBotToken].filter(Boolean) as string[];
    }

    const tokens = new Set<string>();
    
    let defaultIsWebhook = false;

    try {
      const snapshot = await adminDb.collection("telegram_chats").get();
      snapshot.docs.forEach((doc: any) => {
        const chat = doc.data();
        if (chat.botToken) {
          if (chat.isWebhookMode) {
            if (chat.botToken === defaultBotToken) {
              defaultIsWebhook = true;
            }
          } else {
            tokens.add(chat.botToken);
          }
        }
      });
    } catch (e: any) {
      if (isProduction || firestoreAvailable === true) {
        console.error("Error retrieving dynamic bot tokens:", e);
      } else {
        if (!firestoreErrorLogged) {
          console.warn("[Firestore] Cannot retrieve dynamic bot tokens (this is expected in dev environments without Firestore access):", e.message || e);
          firestoreErrorLogged = true;
        }
      }
    }

    if (defaultBotToken && !defaultIsWebhook) {
      tokens.add(defaultBotToken);
    }

    return Array.from(tokens);
  }

  async function startTelegramPolling() {
    if (process.env.NODE_ENV === "production") {
      console.log("🚀 [Telegram Bot] Production environment detected (NODE_ENV=production). Background Polling (getUpdates) is completely disabled to protect Webhook mode and prevent dual-instance double-replies.");
      return;
    }

    console.log("🤖 [Telegram Bot] Activating multi-bot outbound long polling loop... Immune to 302 Redirect!");
    
    // Explicitly delete webhook on startup ONLY for polling bots (do not break production Webhook)
    const tokens = await getActivePollingBotTokens();
    for (const token of tokens) {
      try {
        console.log(`🤖 [Telegram Bot] Deactivating Webhooks to switch to getUpdates for bot: ${token.substring(0, 12)}...`);
        const delRes = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
        const delData = await delRes.json();
        console.log(`🤖 [Telegram Bot] Webhook removal result on boot:`, delData);
      } catch (err) {
        console.error(`🤖 [Telegram Bot] Webhook removal error for bot ${token.substring(0, 10)}:`, err);
      }
    }

    const pollingEngineLoop = async () => {
      const activeTokens = await getActivePollingBotTokens();
      for (const token of activeTokens) {
        await pollBotUpdates(token);
      }
      setTimeout(pollingEngineLoop, 1000);
    };

    setTimeout(pollingEngineLoop, 2000);
  }

  // Trigger background poller for non-webhook bots
  startTelegramPolling();

  // API: Fetch Dividend Data via Gemini
  app.get("/api/dividend/:symbol", apiKeyAuth, async (req, res) => {
    const { symbol } = req.params;
    const apiKey = process.env.CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      console.error("SERVER ERROR: API Key is missing.");
      return res.status(500).json({ error: "伺服器尚未設定 AI 金鑰，請聯繫管理員。" });
    }

    try {
      const servicePath = path.join(__dirname, "src", "services", "geminiService.ts");
      const { fetchDividendData } = await import(servicePath);
      const data = await fetchDividendData(symbol);
      if (!data) {
        return res.status(404).json({ error: "找不到該股票的資料" });
      }
      res.json(data);
    } catch (error) {
      console.error("Server-side Gemini error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "AI 查詢失敗" });
    }
  });

  // API: Daily Batch for price updates and portfolio snapshots (Triggered daily at 14:00 Taipei time by Cloud Scheduler)
  app.post("/api/cron/daily-batch", apiKeyAuth, async (req, res) => {
    const startTime = Date.now();
    
    if (!adminDb || firestoreAvailable === false) {
      return res.status(503).json({
        success: false,
        error: "Firestore is not available or initialized."
      });
    }

    try {
      // Step 1: Get all users and collect unique stock symbols
      const usersSnap = await adminDb.collection("users").get();
      const allStocksToUpdate: { userId: string, symbol: string, docId: string }[] = [];
      const uniqueSymbolsSet = new Set<string>();

      for (const userDoc of usersSnap.docs) {
        const userId = userDoc.id;
        const stocksSnap = await adminDb.collection("users").doc(userId).collection("stocks").get();
        for (const stockDoc of stocksSnap.docs) {
          const symbol = stockDoc.id;
          if (symbol) {
            allStocksToUpdate.push({ userId, symbol, docId: stockDoc.id });
            uniqueSymbolsSet.add(symbol);
          }
        }
      }

      const uniqueSymbols = Array.from(uniqueSymbolsSet);
      console.log(`[Daily Batch] Starting, users=${usersSnap.size}, unique_stocks=${uniqueSymbols.length}`);

      // Step 2: Query FinMind API for each unique symbol (Parallel calls, 5s timeout each)
      const todayStr = moment().tz("Asia/Taipei").format("YYYY-MM-DD");
      const priceMap = new Map<string, number>();
      let pricesUpdated = 0;
      let pricesFailed = 0;

      await Promise.all(uniqueSymbols.map(async (symbol) => {
        const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${symbol}&start_date=${todayStr}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timeoutId);

          if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
          }

          const json = await response.json() as any;
          if (json && json.status === 200 && Array.isArray(json.data) && json.data.length > 0) {
            const latestData = json.data[json.data.length - 1];
            const closePrice = Number(latestData.close);
            if (!isNaN(closePrice) && closePrice > 0) {
              priceMap.set(symbol, closePrice);
              console.log(`[Price Refresh] Success: ${symbol} = ${closePrice} 元`);
              pricesUpdated++;
            } else {
              console.error(`[Price Refresh] Failed: ${symbol}, reason: Invalid close price`);
              pricesFailed++;
            }
          } else {
            console.log(`[Price Refresh] No data returned from FinMind for ${symbol} on date ${todayStr} (could be weekend/before market close)`);
            pricesFailed++;
          }
        } catch (err: any) {
          clearTimeout(timeoutId);
          console.error(`[Price Refresh] Failed: ${symbol}, reason: ${err.message || err}`);
          pricesFailed++;
        }
      }));

      // Step 3: Batch update prices in Firestore (merge: true)
      const priceBatches: any[] = [];
      let currentPriceBatch = adminDb.batch();
      let priceBatchOpCount = 0;
      priceBatches.push(currentPriceBatch);

      const nowIso = new Date().toISOString();

      for (const stockInfo of allStocksToUpdate) {
        const { userId, symbol } = stockInfo;
        const newPrice = priceMap.get(symbol);
        if (newPrice !== undefined) {
          const stockDocRef = adminDb.collection("users").doc(userId).collection("stocks").doc(symbol);
          
          currentPriceBatch.set(stockDocRef, {
            currentPrice: newPrice,
            priceUpdatedAt: nowIso,
            dividendInfo: {
              currentPrice: newPrice,
              updatedAt: nowIso
            }
          }, { merge: true });

          priceBatchOpCount++;
          if (priceBatchOpCount >= 400) {
            currentPriceBatch = adminDb.batch();
            priceBatches.push(currentPriceBatch);
            priceBatchOpCount = 0;
          }
        }
      }

      for (const b of priceBatches) {
        await b.commit();
      }

      // Step 4: Take snapshots of portfolio values (user by user)
      let snapshotsCreated = 0;
      let snapshotsSkipped = 0;

      const snapshotBatches: any[] = [];
      let currentSnapshotBatch = adminDb.batch();
      let snapshotBatchOpCount = 0;
      snapshotBatches.push(currentSnapshotBatch);

      for (const userDoc of usersSnap.docs) {
        const userId = userDoc.id;
        try {
          const snapshotRef = adminDb.collection("users").doc(userId).collection("snapshots").doc(todayStr);
          const existingSnapshotDoc = await snapshotRef.get();
          
          if (existingSnapshotDoc.exists) {
            const existingData = existingSnapshotDoc.data();
            if (existingData && existingData.createdAt) {
              let createdAtDate: Date;
              if (existingData.createdAt.toDate) {
                createdAtDate = existingData.createdAt.toDate();
              } else {
                createdAtDate = new Date(existingData.createdAt);
              }
              const diffMs = Date.now() - createdAtDate.getTime();
              const fourHoursMs = 4 * 60 * 60 * 1000;
              if (diffMs < fourHoursMs) {
                console.log(`[Snapshot] Skipped for user ${userId} (recent snapshot exists)`);
                snapshotsSkipped++;
                continue;
              }
            }
          }

          // Fetch user profile and cash
          const userData = userDoc.exists ? userDoc.data() : {};
          const cash = userData.cash !== undefined ? Number(userData.cash) : 0;

          // Query stock documents (after price update commit)
          const userStocksSnap = await adminDb.collection("users").doc(userId).collection("stocks").get();
          const stocksList: any[] = [];
          let totalStocksValue = 0;

          for (const stockDoc of userStocksSnap.docs) {
            const stockData = stockDoc.data();
            const symbol = stockDoc.id;

            const price = stockData.currentPrice !== undefined 
              ? Number(stockData.currentPrice) 
              : (stockData.dividendInfo?.currentPrice !== undefined ? Number(stockData.dividendInfo.currentPrice) : 0);

            const shares = stockData.shares !== undefined ? Number(stockData.shares) : 0;
            const stockValue = price * shares;
            totalStocksValue += stockValue;

            stocksList.push({
              symbol,
              shares,
              currentPrice: price,
              ...stockData
            });
          }

          const totalValue = totalStocksValue + cash;

          // Add user snapshot write to batch (overwrite/set)
          currentSnapshotBatch.set(snapshotRef, {
            date: todayStr,
            stocks: stocksList,
            cash: cash,
            totalValue: totalValue,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });

          console.log(`[Snapshot] Created for user ${userId} (stocks=${stocksList.length}, totalValue=${totalValue})`);
          snapshotsCreated++;

          snapshotBatchOpCount++;
          if (snapshotBatchOpCount >= 400) {
            currentSnapshotBatch = adminDb.batch();
            snapshotBatches.push(currentSnapshotBatch);
            snapshotBatchOpCount = 0;
          }
        } catch (userErr: any) {
          console.error(`[Snapshot Error] Failed to generate snapshot for user ${userId}:`, userErr.message || userErr);
        }
      }

      for (const b of snapshotBatches) {
        await b.commit();
      }

      const elapsed = Date.now() - startTime;
      console.log(`[Daily Batch] Complete: prices_updated=${pricesUpdated}, prices_failed=${pricesFailed}, snapshots_created=${snapshotsCreated}, elapsed=${elapsed} ms`);

      return res.json({
        success: true,
        users: usersSnap.size,
        prices: { updated: pricesUpdated, failed: pricesFailed },
        snapshots: { created: snapshotsCreated, skipped: snapshotsSkipped },
        elapsedMs: elapsed
      });

    } catch (err: any) {
      console.error("[Daily Batch Fatal Error]:", err.message || err);
      return res.status(500).json({
        success: false,
        error: err.message || err
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
