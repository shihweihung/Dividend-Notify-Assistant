// Telegram 記帳：使用者傳「買 2330 1000 1050」→ 回確認卡 → 按「確認」才寫入 Firestore。
// 規則與網頁相同（shared/trades.ts）：手續費與證交稅自動估算、依成交日算除息股數、只能復原最後一筆。
// 寫入一律在 transaction 內重新讀取最新股數，不用確認卡上算的數字（CLAUDE.md 規則 8）。

import moment from "moment-timezone";
import { ctx, logFirestoreError } from "../context";
import { parseTradeCommand, TRADE_HELP, type HeldStock, type ParsedTrade } from "../lib/tradeCommand";
import { applyTrade, undoLastTrade, sortTrades, TradeError, type Trade } from "../../shared/trades";
import { sendTelegramMsg, sendTelegramButtons, editTelegramMessage, answerCallbackQuery } from "./telegramApi";

const PENDING_TTL_MS = 15 * 60 * 1000; // 確認卡 15 分鐘內有效
const today = () => moment().tz("Asia/Taipei").format("YYYY-MM-DD");
const money = (n: number) => Math.round(n).toLocaleString("en-US");

async function findUserByChatId(chatId: string): Promise<string | null> {
  const snap = await ctx.adminDb.collection("users").where("telegramChatId", "==", chatId).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

async function loadHeld(uid: string): Promise<(HeldStock & { docId: string; cost: number | null; trades: Trade[] })[]> {
  const snap = await ctx.adminDb.collection("users").doc(uid).collection("stocks").get();
  return snap.docs.map((d: any) => {
    const data = d.data() || {};
    return {
      docId: d.id,
      symbol: String(data.symbol || d.id).toUpperCase(),
      name: data.name || data.dividendInfo?.name || d.id,
      shares: Number(data.shares) || 0,
      cost: data.cost !== undefined && data.cost !== null ? Number(data.cost) : null,
      trades: Array.isArray(data.trades) ? data.trades : [],
    };
  });
}

function tradeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 處理文字訊息；是記帳指令就回 true（呼叫端不要再丟給 Gemini 聊天） */
export async function handleTradeText(botToken: string, chatIdRaw: number | string, text: string): Promise<boolean> {
  const t = today();
  // 先用空持股判斷是不是記帳指令，不是就不查資料庫
  if (parseTradeCommand(text, t, []) === null) return false;
  const chatId = String(chatIdRaw);

  if (!ctx.adminDb || ctx.firestoreAvailable === false) {
    await sendTelegramMsg(botToken, chatId, "⚠️ 資料庫暫時連不上，這筆沒有記錄，請稍後再試。");
    return true;
  }

  try {
    const uid = await findUserByChatId(chatId);
    if (!uid) {
      await sendTelegramMsg(botToken, chatId, `還沒有連結息引力帳號。請到網頁的通知設定填入 Chat ID：${chatId}`);
      return true;
    }
    const held = await loadHeld(uid);
    const parsed = parseTradeCommand(text, t, held);
    if (!parsed) return false;
    if (parsed.kind === "error") {
      await sendTelegramMsg(botToken, chatId, parsed.message);
      return true;
    }

    const pendingRef = ctx.adminDb.collection("pending_trades").doc();

    if (parsed.kind === "undo") {
      const stock = held.find(s => s.symbol === parsed.symbol)!;
      const sorted = sortTrades(stock.trades);
      const last = sorted[sorted.length - 1];
      if (!last || !undoLastTrade(stock.trades)) {
        await sendTelegramMsg(botToken, chatId, `${stock.name} 沒有交易紀錄可以復原。`);
        return true;
      }
      await pendingRef.set({ uid, chatId, kind: "undo", docId: stock.docId, expectedLastId: last.id, createdAt: Date.now() });
      const card =
        `↩️ 復原 ${stock.name}（${stock.symbol}）最後一筆交易\n` +
        `${last.side === "buy" ? "買進" : "賣出"} ${money(last.shares)} 股 @${last.price}（成交日 ${last.tradeDate}）\n` +
        `復原後股數：${money(stock.shares)} → ${money(last.prevShares)}`;
      await sendTelegramButtons(botToken, chatId, card, [
        { text: "✅ 確認復原", data: `trade:ok:${pendingRef.id}` },
        { text: "取消", data: `trade:no:${pendingRef.id}` },
      ]);
      return true;
    }

    // 預覽：用目前股數算一次，讓使用者看到費用與交易後股數
    const stock = held.find(s => s.symbol === parsed.symbol);
    const position = { shares: stock?.shares || 0, cost: stock?.cost ?? null };
    let preview;
    try {
      preview = applyTrade(parsed.symbol, position, {
        side: parsed.side, shares: parsed.shares, price: parsed.price, tradeDate: parsed.tradeDate,
        recordedAt: new Date().toISOString(), recordedDate: t, id: "preview",
      });
    } catch (err) {
      await sendTelegramMsg(botToken, chatId, err instanceof TradeError ? `⚠️ ${err.message}` : "⚠️ 無法計算這筆交易");
      return true;
    }

    await pendingRef.set({
      uid, chatId, kind: "trade", docId: stock?.docId || parsed.symbol, trade: parsed, createdAt: Date.now(),
    });

    const sideText = parsed.side === "buy" ? "買進" : "賣出";
    const amount = Math.floor(parsed.shares * parsed.price + 1e-6);
    const fees = preview.trade.side === "sell"
      ? `手續費 ${money(preview.trade.fee)} 元、證交稅 ${money(preview.trade.tax)} 元`
      : `手續費 ${money(preview.trade.fee)} 元`;
    const card =
      `📝 ${sideText} ${parsed.name}（${parsed.symbol}）${parsed.isNewStock ? "【新增持股】" : ""}\n` +
      `${money(parsed.shares)} 股 @${parsed.price}，成交金額 ${money(amount)} 元\n` +
      `${fees}（估算）\n` +
      `成交日 ${parsed.tradeDate}${parsed.tradeDate !== t ? "（補登）" : ""}\n` +
      `股數：${money(position.shares)} → ${money(preview.position.shares)}` +
      (parsed.side === "buy" && preview.position.cost !== null ? `\n平均成本：${preview.position.cost}` : "");
    await sendTelegramButtons(botToken, chatId, card, [
      { text: "✅ 確認記錄", data: `trade:ok:${pendingRef.id}` },
      { text: "取消", data: `trade:no:${pendingRef.id}` },
    ]);
    return true;
  } catch (err: any) {
    logFirestoreError("Telegram trade command", err);
    await sendTelegramMsg(botToken, chatId, "⚠️ 記錄時發生錯誤，這筆沒有寫入，請稍後再試。");
    return true;
  }
}

/** 處理確認卡上的按鈕 */
export async function handleTradeCallback(botToken: string, cq: any): Promise<void> {
  const data: string = cq?.data || "";
  const m = data.match(/^trade:(ok|no):([A-Za-z0-9]+)$/);
  if (!m) return;
  const [, action, pendingId] = m;
  const chatId = String(cq.message?.chat?.id ?? "");
  const messageId = cq.message?.message_id;
  const done = async (toast: string, text?: string) => {
    await answerCallbackQuery(botToken, cq.id, toast);
    if (text && messageId) await editTelegramMessage(botToken, chatId, messageId, text);
  };

  if (!ctx.adminDb || ctx.firestoreAvailable === false) {
    await done("資料庫暫時連不上，請稍後再按一次");
    return;
  }

  const pendingRef = ctx.adminDb.collection("pending_trades").doc(pendingId);
  const pendingSnap = await pendingRef.get();
  const original = cq.message?.text || "";
  if (!pendingSnap.exists) {
    await done("這張確認卡已經處理過了");
    return;
  }
  const pending = pendingSnap.data();
  if (pending.chatId !== chatId) {
    await done("無法處理");
    return;
  }
  if (action === "no") {
    await pendingRef.delete();
    await done("已取消", `${original}\n\n❌ 已取消，沒有記錄`);
    return;
  }
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    await pendingRef.delete();
    await done("確認卡已過期", `${original}\n\n⌛ 超過 15 分鐘已失效，請重新傳一次`);
    return;
  }

  const stockRef = ctx.adminDb.collection("users").doc(pending.uid).collection("stocks").doc(pending.docId);
  try {
    const resultText: string = await ctx.adminDb.runTransaction(async (tx: any) => {
      const fresh = await tx.get(stockRef);
      const p = await tx.get(pendingRef);
      if (!p.exists) throw new TradeError("這張確認卡已經處理過了");
      const data = fresh.exists ? fresh.data() : null;
      const trades: Trade[] = Array.isArray(data?.trades) ? data.trades : [];

      if (pending.kind === "undo") {
        const sorted = sortTrades(trades);
        if (sorted[sorted.length - 1]?.id !== pending.expectedLastId) {
          throw new TradeError("交易紀錄在這之後有變動，沒有復原。請重新傳一次「復原」");
        }
        const undone = undoLastTrade(trades);
        if (!undone) throw new TradeError("沒有交易紀錄可以復原");
        tx.set(stockRef, { shares: undone.position.shares, cost: undone.position.cost, trades: undone.trades }, { merge: true });
        tx.delete(pendingRef);
        return `↩️ 已復原，目前 ${money(undone.position.shares)} 股`;
      }

      const trade: ParsedTrade = pending.trade;
      const now = new Date();
      // 以雲端最新股數計算（不用確認卡上的預覽數字）
      const position = { shares: Number(data?.shares) || 0, cost: data?.cost !== undefined && data?.cost !== null ? Number(data.cost) : null };
      const { position: next, trade: record } = applyTrade(trade.symbol, position, {
        side: trade.side, shares: trade.shares, price: trade.price, tradeDate: trade.tradeDate,
        recordedAt: now.toISOString(), recordedDate: today(), id: tradeId(),
      });
      const update: any = { shares: next.shares, cost: next.cost, trades: [...trades, record] };
      if (!fresh.exists) {
        update.symbol = trade.symbol;
        update.name = trade.name;
        update.createdAt = now.toISOString();
      }
      tx.set(stockRef, update, { merge: true });
      tx.delete(pendingRef);
      return `✅ 已記錄，${trade.name} 目前 ${money(next.shares)} 股` +
        (fresh.exists ? "" : "\n（新股票的股息資料會在下次更新時補上）");
    });
    await done("已記錄", `${original}\n\n${resultText}`);
  } catch (err: any) {
    if (err instanceof TradeError) {
      await done("沒有記錄", `${original}\n\n⚠️ ${err.message}`);
    } else {
      logFirestoreError("Telegram trade confirm", err);
      await done("發生錯誤，沒有記錄，請再按一次");
    }
  }
}

export { TRADE_HELP };
