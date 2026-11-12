import express from "express";
import path from "path";
import fs from "fs";
import { ctx } from "../context";
import { firebaseAuth } from "../middleware/auth";
import { getChatFromFirestore, saveChatToFirestore } from "../services/chatStore";
import { processTelegramMessage } from "../services/telegramBot";

export const router = express.Router();

// API: Save / Sync Telegram Chat Data
router.post("/api/telegram/save-chat-data", firebaseAuth, async (req, res) => {
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
router.post("/api/telegram/send", firebaseAuth, async (req, res) => {
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

// API: Telegram Webhook Receiver (Bidirectional Interaction - Webhook Mode / Callback fallback)
router.post("/api/telegram/webhook", async (req, res) => {
  try {
    if (!process.env.API_SECRET_KEY) {
      console.error("[Webhook] API_SECRET_KEY 未設定，拒絕所有 webhook 請求");
      return res.sendStatus(500);
    }
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
router.post("/api/telegram/register-webhook", firebaseAuth, async (req, res) => {
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
    const snapshot = await ctx.adminDb.collection("telegram_chats").where("botToken", "==", botToken).get();
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
