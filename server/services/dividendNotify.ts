import moment from "moment-timezone";
import { ctx } from "../context";
import { normalizeSymbol } from "../lib/symbols";
import {
  findDividendEventsForDate,
  collectDividendCandidates,
  resolveSharesAtExDate,
  buildPaymentMessage,
  type HoldingSnapshot,
} from "../lib/dividendEvents";
import { sendTelegramMsg } from "./telegramApi";

// 除息日到發放日通常 1～3 個月，最長約半年；多抓一些保險
const SNAPSHOT_LOOKBACK_DAYS = 200;

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

  // 快照只讀最近這段期間：涵蓋「除息日前一天」到「發放日」之間的間隔，也用來找出已賣掉的持股
  const snapshotCutoff = taipeiTime.clone().subtract(SNAPSHOT_LOOKBACK_DAYS, "days").format("YYYY-MM-DD");

  const notifyHolder = async (holder: {
    chatId: string;
    botToken: string;
    rawStocks: any[];
    snapshotsRef: any;
    logExtra: Record<string, any>;
  }) => {
    const { chatId, botToken, rawStocks, snapshotsRef, logExtra } = holder;

    let snapshots: HoldingSnapshot[] = [];
    try {
      const snapDocs = await snapshotsRef.where("date", ">=", snapshotCutoff).get();
      snapshots = snapDocs.docs.map((d: any) => d.data());
    } catch (snapErr) {
      console.warn(`[Snapshot Lookup Warning] Failed to load snapshots for ChatID ${chatId}:`, snapErr);
    }

    for (const { stock, holdsNow } of collectDividendCandidates(rawStocks, snapshots)) {
      const symbol = normalizeSymbol(stock.symbol);
      if (!symbol) continue;
      const stockName = (stock.name && stock.name !== symbol) ? stock.name : symbol;
      const info = stock.dividendInfo || stock;

      for (const evt of findDividendEventsForDate(info, stock, todayStr)) {
        // 除息提醒只發給目前還持有的股票；領息提醒則看除息日前的持股
        if (evt.type === 'ex-dividend' && !holdsNow) continue;

        let msgText = "";
        if (evt.type === 'ex-dividend') {
          msgText = `📅 今天是 ${stockName}(${symbol}) 的除息日！每股 $${evt.amount}`;
        } else {
          // 已賣光的股票目前持股算 0；能領幾股以除息日前一天的快照為準（規則與網頁共用）
          const { shares, source } = resolveSharesAtExDate(
            snapshots, symbol, evt.exDateStr || todayStr, holdsNow ? (Number(stock.shares) || 0) : 0);
          if (shares <= 0) {
            console.log(`[Dividend Notify] ${symbol} not held before ex-date ${evt.exDateStr} for ChatID ${chatId}, no payment notice.`);
            continue;
          }
          msgText = buildPaymentMessage({
            stockName,
            symbol,
            amountPerShare: evt.amount,
            shares,
            sharesSource: source,
            payDateEstimated: evt.payDateEstimated,
          });
        }

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

        console.log(`[Dividend Notify] Sending ${evt.type} notification for ${symbol} to ChatID ${chatId}`);
        await sendTelegramMsg(botToken, chatId, msgText);
        notificationsSent++;

        await logRef.set({
          ...logExtra,
          chatId,
          symbol,
          type: evt.type,
          date: todayStr,
          sentAt: new Date().toISOString()
        });
        logsCreated++;
      }
    }
  };

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

      const userRef = ctx.adminDb.collection("users").doc(userId);
      const stocksSnapshot = await userRef.collection("stocks").get();
      await notifyHolder({
        chatId,
        botToken,
        rawStocks: stocksSnapshot.docs.map((d: any) => d.data()),
        snapshotsRef: userRef.collection("snapshots"),
        logExtra: { userId },
      });
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

      await notifyHolder({
        chatId,
        botToken,
        rawStocks,
        snapshotsRef: ctx.adminDb.collection("telegram_chats").doc(chatDoc.id).collection("snapshots"),
        logExtra: {},
      });
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
