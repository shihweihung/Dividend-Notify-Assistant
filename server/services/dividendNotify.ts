import moment from "moment-timezone";
import { ctx } from "../context";
import { normalizeSymbol } from "../lib/symbols";
import { dedupeStocksBySymbol, findDividendEventsForDate } from "../lib/dividendEvents";
import { sendTelegramMsg } from "./telegramApi";

// Core Function: Run Dividend Ex-Date & Payment Date Push Notifications via Telegram
export async function runDividendNotifyCore() {
  console.log("[Dividend Notify] Starting dividend notification push check...");
  if (ctx.firestoreAvailable === false || !ctx.adminDb) {
    console.warn("[Dividend Notify] Firestore unavailable. Skipping notification push.");
    return { success: false, error: "Firestore unavailable" };
  }

  const taipeiTime = moment().tz("Asia/Taipei");
  const todayStr = taipeiTime.format("YYYY-MM-DD");


  let notificationsSent = 0;
  let logsCreated = 0;
  const processedChatIds = new Set<string>();
  const sentKeysInMemory = new Set<string>();

  try {
    // 1. Process authenticated users collection
    const usersSnapshot = await ctx.adminDb.collection("users").get();
    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      const userData = userDoc.data() || {};
      const chatId = userData.telegramChatId ? String(userData.telegramChatId).trim() : null;
      const botToken = (userData.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "").trim();

      if (!chatId || !botToken) continue;
      processedChatIds.add(chatId);

      const stocksSnapshot = await ctx.adminDb.collection("users").doc(userId).collection("stocks").get();
      const rawStocks = stocksSnapshot.docs.map((d: any) => d.data());
      
      // Deduplicate stocks array by normalized symbol to avoid processing duplicate stock entries
      const userStocks = dedupeStocksBySymbol(rawStocks);

      for (const stock of userStocks) {
        if (!stock) continue;
        const symbol = normalizeSymbol(stock.symbol);
        if (!symbol) continue;
        const stockName = (stock.name && stock.name !== symbol) ? stock.name : symbol;
        const shares = Number(stock.shares) || 0;
        const info = stock.dividendInfo || stock;

        const eventsToNotify = findDividendEventsForDate(info, stock, todayStr);

        for (const evt of eventsToNotify) {
          const dedupDocId = `notify_${chatId}_${symbol}_${evt.type}_${todayStr}`;
          if (sentKeysInMemory.has(dedupDocId)) {
            console.log(`[Dividend Notify Dedup In-Memory] ${dedupDocId} already processed. Skipping.`);
            continue;
          }
          sentKeysInMemory.add(dedupDocId);

          const logRef = ctx.adminDb.collection("dividend_notify_log").doc(dedupDocId);
          const logSnap = await logRef.get();

          if (logSnap.exists) {
            console.log(`[Dividend Notify Dedup DB] ${dedupDocId} already notified. Skipping.`);
            continue;
          }

          let effectiveShares = shares;
          if (evt.type === 'payment' && evt.exDateStr) {
            try {
              const snapsRef = ctx.adminDb.collection("users").doc(userId).collection("snapshots");
              const snapDocs = await snapsRef.where("date", "<=", evt.exDateStr).orderBy("date", "desc").limit(1).get();
              if (!snapDocs.empty) {
                const targetStock = snapDocs.docs[0].data().stocks?.find((s: any) => s.symbol && normalizeSymbol(s.symbol) === symbol);
                if (targetStock && targetStock.shares !== undefined) {
                  effectiveShares = Number(targetStock.shares);
                }
              }
            } catch (snapErr) {
              console.warn(`[Snapshot Lookup Warning] Failed to fetch exDate snapshot for ${symbol}:`, snapErr);
            }
          }

          let msgText = "";
          if (evt.type === 'ex-dividend') {
            msgText = `📅 今天是 ${stockName}(${symbol}) 的除息日！每股 $${evt.amount}`;
          } else {
            const totalEst = Math.round(evt.amount * effectiveShares);
            msgText = `💰 今天是 ${stockName}(${symbol}) 的領息日！預計入帳 $${totalEst.toLocaleString()}`;
          }

          console.log(`[Dividend Notify] Sending ${evt.type} notification for ${symbol} to ChatID ${chatId}`);
          await sendTelegramMsg(botToken, chatId, msgText);
          notificationsSent++;

          await logRef.set({
            userId,
            chatId,
            symbol,
            type: evt.type,
            date: todayStr,
            sentAt: new Date().toISOString()
          });
          logsCreated++;
        }
      }
    }

    // 2. Process telegram_chats collection (for standalone Telegram Bot chats)
    const chatsSnapshot = await ctx.adminDb.collection("telegram_chats").get();
    for (const chatDoc of chatsSnapshot.docs) {
      const chatData = chatDoc.data() || {};
      const chatId = String(chatData.chatId || chatDoc.id).trim();
      if (processedChatIds.has(chatId)) continue;
      const botToken = (chatData.botToken || process.env.TELEGRAM_BOT_TOKEN || "").trim();
      const rawStocks = chatData.stocks || [];
      if (!chatId || !botToken || !Array.isArray(rawStocks) || rawStocks.length === 0) continue;

      const userStocks = dedupeStocksBySymbol(rawStocks);

      for (const stock of userStocks) {
        if (!stock) continue;
        const symbol = normalizeSymbol(stock.symbol);
        if (!symbol) continue;
        const stockName = (stock.name && stock.name !== symbol) ? stock.name : symbol;
        const shares = Number(stock.shares) || 0;
        const info = stock.dividendInfo || stock;

        const eventsToNotify = findDividendEventsForDate(info, stock, todayStr);

        for (const evt of eventsToNotify) {
          const dedupDocId = `notify_${chatId}_${symbol}_${evt.type}_${todayStr}`;
          if (sentKeysInMemory.has(dedupDocId)) {
            console.log(`[Dividend Notify Dedup In-Memory] ${dedupDocId} already processed. Skipping.`);
            continue;
          }
          sentKeysInMemory.add(dedupDocId);

          const logRef = ctx.adminDb.collection("dividend_notify_log").doc(dedupDocId);
          const logSnap = await logRef.get();

          if (logSnap.exists) {
            console.log(`[Dividend Notify Dedup DB] ${dedupDocId} already notified. Skipping.`);
            continue;
          }

          let effectiveShares = shares;
          if (evt.type === 'payment' && evt.exDateStr) {
            try {
              const snapsRef = ctx.adminDb.collection("telegram_chats").doc(chatDoc.id).collection("snapshots");
              const snapDocs = await snapsRef.where("date", "<=", evt.exDateStr).orderBy("date", "desc").limit(1).get();
              if (!snapDocs.empty) {
                const targetStock = snapDocs.docs[0].data().stocks?.find((s: any) => s.symbol && normalizeSymbol(s.symbol) === symbol);
                if (targetStock && targetStock.shares !== undefined) {
                  effectiveShares = Number(targetStock.shares);
                }
              }
            } catch (snapErr) {
              console.warn(`[Snapshot Lookup Warning] Failed to fetch exDate snapshot for ${symbol} in telegram_chats:`, snapErr);
            }
          }

          let msgText = "";
          if (evt.type === 'ex-dividend') {
            msgText = `📅 今天是 ${stockName}(${symbol}) 的除息日！每股 $${evt.amount}`;
          } else {
            const totalEst = Math.round(evt.amount * effectiveShares);
            msgText = `💰 今天是 ${stockName}(${symbol}) 的領息日！預計入帳 $${totalEst.toLocaleString()}`;
          }

          console.log(`[Dividend Notify] Sending ${evt.type} notification for ${symbol} to ChatID ${chatId}`);
          await sendTelegramMsg(botToken, chatId, msgText);
          notificationsSent++;

          await logRef.set({
            chatId,
            symbol,
            type: evt.type,
            date: todayStr,
            sentAt: new Date().toISOString()
          });
          logsCreated++;
        }
      }
    }

    console.log(`[Dividend Notify Complete] Date: ${todayStr}, Notifications Sent: ${notificationsSent}, Logs Created: ${logsCreated}`);
    return {
      success: true,
      date: todayStr,
      notificationsSent,
      logsCreated
    };
  } catch (err: any) {
    console.error("[Dividend Notify Error]:", err.message || err);
    return {
      success: false,
      error: err.message || err
    };
  }
}

// 排程已改由 Cloud Scheduler 透過 POST /api/cron/dividend-notify 觸發
