import { ctx } from "../context";
import { processTelegramMessage } from "./telegramBot";

// Background Telegram Polling System (Bulletproof strategy for authenticated environments / local testing)
const botOffsets: Record<string, number> = {};
const invalidBotTokens = new Set<string>();

async function pollBotUpdates(botToken: string) {
  if (invalidBotTokens.has(botToken)) return;
  try {
    const offset = botOffsets[botToken] || 0;
    const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=1`;
    const response = await fetch(url);
    if (response.status === 401) {
      invalidBotTokens.add(botToken);
      console.log(`[Telegram Bot] Bot token ${botToken.substring(0, 10)}... is invalid or revoked (401). Polling disabled for this token.`);
      return;
    }
    if (!response.ok) return;
    const data: any = await response.json();
    if (data.error_code === 401 || data.ok === false) {
      if (data.error_code === 401) {
        invalidBotTokens.add(botToken);
        console.log(`[Telegram Bot] Bot token ${botToken.substring(0, 10)}... is invalid or revoked (401). Polling disabled for this token.`);
      }
      return;
    }
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
  if (ctx.firestoreAvailable === false) {
    return [defaultBotToken].filter((t) => Boolean(t) && !invalidBotTokens.has(t!)) as string[];
  }

  const tokens = new Set<string>();
  
  let defaultIsWebhook = false;

  try {
    const snapshot = await ctx.adminDb.collection("telegram_chats").get();
    snapshot.docs.forEach((doc: any) => {
      const chat = doc.data();
      if (chat.botToken && !invalidBotTokens.has(chat.botToken)) {
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
    if (ctx.isProduction || ctx.firestoreAvailable === true) {
      console.error("Error retrieving dynamic bot tokens:", e);
    } else {
      if (!ctx.firestoreErrorLogged) {
        console.warn("[Firestore] Cannot retrieve dynamic bot tokens (this is expected in dev environments without Firestore access):", e.message || e);
        ctx.firestoreErrorLogged = true;
      }
    }
  }

  if (defaultBotToken && !defaultIsWebhook && !invalidBotTokens.has(defaultBotToken)) {
    tokens.add(defaultBotToken);
  }

  return Array.from(tokens);
}

export async function startTelegramPolling() {
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
      if (delData.ok) {
        console.log(`🤖 [Telegram Bot] Webhook removal result on boot:`, delData);
      } else if (delData.error_code === 401) {
        invalidBotTokens.add(token);
        console.log(`🤖 [Telegram Bot] Bot token ${token.substring(0, 10)}... is invalid or revoked (401). Webhook removal skipped.`);
      } else {
        console.log(`🤖 [Telegram Bot] Webhook removal result on boot:`, delData);
      }
    } catch (err) {
      console.log(`🤖 [Telegram Bot] Webhook removal info for bot ${token.substring(0, 10)}:`, err);
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
