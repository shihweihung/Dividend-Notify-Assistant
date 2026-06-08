import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import admin from "firebase-admin";

const __dirname = process.cwd();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Initialize Firebase Admin dynamically securely connected to Firestore
  const fbConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
  let adminDb: any = null;
  if (fs.existsSync(fbConfigPath)) {
    try {
      const firebaseConfig = JSON.parse(fs.readFileSync(fbConfigPath, "utf-8"));
      admin.initializeApp({
        projectId: firebaseConfig.projectId,
      });
      adminDb = admin.firestore(firebaseConfig.firestoreDatabaseId);
      console.log(`[Firebase Admin] Fully initialized with Database ID: ${firebaseConfig.firestoreDatabaseId}`);
    } catch (fbErr) {
      console.error("[Firebase Admin] Initialization failed:", fbErr);
    }
  }

  app.use(express.json());

  app.get("/api/debug-env", (req, res) => {
    res.json({
      customKeyLength: process.env.CUSTOM_GEMINI_API_KEY?.length,
      customKeyPrefix: process.env.CUSTOM_GEMINI_API_KEY?.substring(0, 4),
      systemKeyLength: process.env.GEMINI_API_KEY?.length,
      systemKeyPrefix: process.env.GEMINI_API_KEY?.substring(0, 4),
    });
  });

  // API: Save / Sync Telegram Chat Data
  app.post("/api/telegram/save-chat-data", (req, res) => {
    try {
      const { chatId, botToken, cash, stocks, username } = req.body;
      if (!chatId) {
        return res.status(400).json({ error: "缺少必要參數：chatId" });
      }

      const dbPath = path.join(process.cwd(), "telegram_chats_db.json");
      let dbData: Record<string, any> = {};
      if (fs.existsSync(dbPath)) {
        try {
          dbData = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
        } catch (e) {
          console.error("Error reading telegram JSON db:", e);
        }
      }

      const existing = dbData[String(chatId)] || {};
      dbData[String(chatId)] = {
        chatId: String(chatId),
        botToken: botToken || existing.botToken || process.env.TELEGRAM_BOT_TOKEN,
        cash: cash !== undefined ? Number(cash) : (existing.cash || 0),
        stocks: stocks !== undefined ? stocks : (existing.stocks || []),
        username: username || existing.username || "投資大師",
        isWebhookMode: existing.isWebhookMode || false,
        baseUrl: existing.baseUrl || "",
        updatedAt: new Date().toISOString()
      };

      fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), "utf-8");
      return res.json({ success: true });
    } catch (err: any) {
      console.error("Error saving chat data:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  // API: Send Telegram Alert / Report
  app.post("/api/telegram/send", async (req, res) => {
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
    const text = (msg.text || "").trim();
    const username = msg.from?.first_name || msg.from?.username || msg.from?.last_name || "投資大師";

    console.log(`[Telegram Bot] Processing message from ChatID ${chatId}: "${text}"`);

    let stocks: any[] = [];
    let cash = 0;
    let foundInFirestore = false;
    let finalUsername = username;

    // 1. Primary Lookup: Local JSON database (Highly synchronized with React frontend active state, supports both guest & logged in users)
    const dbPath = path.join(process.cwd(), "telegram_chats_db.json");
    let dbData: Record<string, any> = {};
    if (fs.existsSync(dbPath)) {
      try {
        dbData = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
      } catch (e) {
        console.error("Error reading JSON db during message processing:", e);
      }
    }
    const chatInfo = dbData[String(chatId)];
    // Make sure we have a real record with actual active assets or custom username to prioritize it
    if (chatInfo && (chatInfo.stocks?.length > 0 || chatInfo.cash > 0 || (chatInfo.username && chatInfo.username !== "投資大師"))) {
      stocks = chatInfo.stocks || [];
      cash = Number(chatInfo.cash || 0);
      finalUsername = chatInfo.username || username;
      foundInFirestore = true;
      console.log(`[Telegram Bot DB Lookup] Loaded ${stocks.length} stocks and $${cash} cash from local JSON file (primary/cache).`);
    }

    // 2. Secondary Fallback: Cloud Firestore DB
    if (!foundInFirestore && adminDb) {
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
      } catch (err) {
        console.error("[Telegram Bot DB Lookup] Firestore look up error:", err);
      }
    }

    const sendTelegramMsg = async (toChatId: number, textToSend: string) => {
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: toChatId,
            text: textToSend,
            parse_mode: "Markdown",
          }),
        });
      } catch (err) {
        console.error("Error sending message back to Telegram:", err);
      }
    };

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
      
      await sendTelegramMsg(chatId, helpMessage);
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
      await sendTelegramMsg(chatId, welcomeText);
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

      const stocksSummary = stocks && stocks.length > 0
        ? stocks.map((s: any) => {
            const name = s.name || s.symbol;
            const shares = s.shares || 0;
            const divInfo = s.dividendInfo;
            let extra = "";
            if (divInfo) {
              if (divInfo.currentPrice) {
                extra += `, 現價: ${divInfo.currentPrice}元`;
              }
              if (divInfo.yield) {
                extra += `, 殖利率: ${(divInfo.yield * 100).toFixed(2)}%`;
              }
            }
            return `- ${name} (${s.symbol}): ${shares} 股${extra}`;
          }).join("\n")
        : "目前持股列表中尚無持股數據（若您剛加入，可返回網頁重新加載以觸發最新的同步）。";

      const systemInstruction = 
        `# Role: 專業個人理財與股票分析助理\n\n` +
        `## 核心行為準則\n` +
        `- **直切核心**：嚴禁任何問候、招呼、客套話、結論性廢話 or 結語，直接輸出分析結果。\n` +
        `- **極致精簡**：不長篇大論、不說廢話、避免重複。字數控制在最精簡範圍，只提供高密度的硬核資訊。\n` +
        `- **條列重點**：所有分析一律提煉精華，以粗體與條列式呈現，確保 1 分鐘內能快速讀完。\n\n` +
        `## 當前個人資產背景\n` +
        `📊 帳戶：${finalUsername} | 現金：${cash.toLocaleString()} 元\n` +
        `持股明細：\n` +
        `${stocksSummary}\n\n` +
        `## 分析框架\n` +
        `當我提供特定股票、ETF 或市場新聞時，請結合上述「個人資產背景」，快速評估：\n` +
        `1. **基本面**：營收成長、毛利、EPS、估值合理性。\n` +
        `2. **技術與籌碼面**：均線趨勢、支撐/壓力位、大戶資金流向。\n` +
        `3. **風險評估**：產業下行風險、總經環境變化。\n\n` +
        `## 輸出格式規範（嚴格遵守，禁止超出此框架）\n` +
        `- **核心結論**：[看多/看空/中立觀望] + 一句話主因。\n` +
        `- **關鍵重點**：粗體條列 2-3 個關鍵數據或事實，刪除所有修飾詞。\n` +
        `- **實際操作建議**：\n` +
        `  - 長線：結合目前資產與持股狀況，給出具體加減碼或續抱策略。\n` +
        `  - 短線：明確的進場觀察點、支撐位與壓力位。\n` +
        `- **關鍵風險提示**：1 個最需緊盯的警訊或明確的轉弱停損觸發條件。`;

      let response;
      const modelsToTry = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];
      let lastErr: any = null;

      for (const modelName of modelsToTry) {
        let retries = 2;
        while (retries > 0) {
          try {
            response = await ai.models.generateContent({
              model: modelName,
              contents: text,
              config: {
                systemInstruction: systemInstruction,
                temperature: 0.7,
              },
            });
            break;
          } catch (err: any) {
            retries--;
            lastErr = err;
            console.error(`Gemini call failed for model ${modelName} (retries left: ${retries}):`, err.message || err);
            if (retries > 0) {
              await new Promise(resolve => setTimeout(resolve, 3000));
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
      await sendTelegramMsg(chatId, replyText);

    } catch (err: any) {
      console.error("Gemini Telegram answering error:", err);
      try {
        const errMsg = `⚠️ *機器人服務暫時出現小狀況* ⚠️\n\n` +
          `我們在處理您的提問時遇到異常，可能原因為：\n` +
          `1. 系統或自訂 AI 金鑰設定有誤\n` +
          `2. AI 思考連線逾時\n\n` +
          `*錯誤明細：*\n\`${err.message || err}\`\n\n` +
          `💡 請您返回「息引力」頁面，檢查您的自訂 AI 金鑰設定、或是稍微等候再嘗試向我提問。謝謝您的體諒！`;
        await sendTelegramMsg(chatId, errMsg);
      } catch (sendErr) {
        console.error("Failed to forward Telegram error message back to user:", sendErr);
      }
    }
  }

  // API: Telegram Webhook Receiver (Bidirectional Interaction - Webhook Mode / Callback fallback)
  app.post("/api/telegram/webhook", async (req, res) => {
    try {
      const { message, edited_message } = req.body;
      const msg = message || edited_message;
      if (!msg || !msg.chat || !msg.chat.id) {
        return res.sendStatus(200);
      }

      const chatId = String(msg.chat.id);
      
      // Look up bot token in DB for this Chat ID to support custom bot tokens
      let botToken = process.env.TELEGRAM_BOT_TOKEN;
      try {
        const dbPath = path.join(process.cwd(), "telegram_chats_db.json");
        if (fs.existsSync(dbPath)) {
          const dbData = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
          if (dbData[chatId] && dbData[chatId].botToken) {
            botToken = dbData[chatId].botToken;
          }
        }
      } catch (dbErr) {
        console.error("Error reading db in webhook look up:", dbErr);
      }

      if (!botToken) {
        console.warn(`[Webhook Error] No bot token found for ChatID ${chatId}`);
        return res.sendStatus(200);
      }
      
      await processTelegramMessage(botToken, msg);
    } catch (err) {
      console.error("Error inside Webhook receiver middleware:", err);
    }
    return res.sendStatus(200);
  });

  // API: Register Telegram Webhook (Dynamic Selection based on Host Environment)
  app.post("/api/telegram/register-webhook", async (req, res) => {
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
      for (const chatId in dbData) {
        if (dbData[chatId].botToken === botToken) {
          dbData[chatId].isWebhookMode = !isDev;
          dbData[chatId].baseUrl = baseUrl || "";
        }
      }
      fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), "utf-8");

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
        const setUrl = `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
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

  function getActivePollingBotTokens(): string[] {
    const defaultBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const tokens = new Set<string>();
    
    let defaultIsWebhook = false;

    try {
      const dbPath = path.join(process.cwd(), "telegram_chats_db.json");
      if (fs.existsSync(dbPath)) {
        const dbData = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
        for (const key in dbData) {
          const chat = dbData[key];
          if (chat.botToken) {
            if (chat.isWebhookMode) {
              if (chat.botToken === defaultBotToken) {
                defaultIsWebhook = true;
              }
            } else {
              tokens.add(chat.botToken);
            }
          }
        }
      }
    } catch (e) {
      console.error("Error retrieving dynamic bot tokens:", e);
    }

    if (defaultBotToken && !defaultIsWebhook) {
      tokens.add(defaultBotToken);
    }

    return Array.from(tokens);
  }

  async function startTelegramPolling() {
    console.log("🤖 [Telegram Bot] Activating multi-bot outbound long polling loop... Immune to 302 Redirect!");
    
    // Explicitly delete webhook on startup ONLY for polling bots (do not break production Webhook)
    const tokens = getActivePollingBotTokens();
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
      const activeTokens = getActivePollingBotTokens();
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
  app.get("/api/dividend/:symbol", async (req, res) => {
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
