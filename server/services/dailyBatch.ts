import admin from "firebase-admin";
import moment from "moment-timezone";
import { ctx } from "../context";
import { sendTelegramMsg } from "./telegramApi";

export async function runDailyBatchCore() {
  const startTime = Date.now();
  
  if (!ctx.adminDb || ctx.firestoreAvailable === false) {
    return {
      success: false,
      error: "Firestore is not available or initialized."
    };
  }

  try {
    // Step 1: Get all users and collect unique stock symbols
    const usersSnap = await ctx.adminDb.collection("users").get();
    const allStocksToUpdate: { userId: string, symbol: string, docId: string }[] = [];
    const uniqueSymbolsSet = new Set<string>();

    for (const userDoc of usersSnap.docs) {
      const userId = userDoc.id;
      const stocksSnap = await ctx.adminDb.collection("users").doc(userId).collection("stocks").get();
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
    const priceStartStr = moment().tz("Asia/Taipei").subtract(7, 'days').format("YYYY-MM-DD");
    const priceMap = new Map<string, number>();
    let pricesUpdated = 0;
    let pricesFailed = 0;

    await Promise.all(uniqueSymbols.map(async (symbol) => {
      const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${symbol}&start_date=${priceStartStr}`;
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
          console.log(`[Price Refresh] No data from FinMind for ${symbol} (date>=${priceStartStr}, status=${json?.status}, msg=${json?.msg})`);
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
    let currentPriceBatch = ctx.adminDb.batch();
    let priceBatchOpCount = 0;
    priceBatches.push(currentPriceBatch);

    const nowIso = new Date().toISOString();

    for (const stockInfo of allStocksToUpdate) {
      const { userId, symbol } = stockInfo;
      const newPrice = priceMap.get(symbol);
      if (newPrice !== undefined) {
        const stockDocRef = ctx.adminDb.collection("users").doc(userId).collection("stocks").doc(symbol);
        
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
          currentPriceBatch = ctx.adminDb.batch();
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
    let currentSnapshotBatch = ctx.adminDb.batch();
    let snapshotBatchOpCount = 0;
    snapshotBatches.push(currentSnapshotBatch);

    for (const userDoc of usersSnap.docs) {
      const userId = userDoc.id;
      try {
        const snapshotRef = ctx.adminDb.collection("users").doc(userId).collection("snapshots").doc(todayStr);
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
        const userStocksSnap = await ctx.adminDb.collection("users").doc(userId).collection("stocks").get();
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

          // Cost Drop Alert (跌破成本 15% 警示與重設)
          const cost = stockData.cost !== undefined && stockData.cost !== null ? Number(stockData.cost) : 0;
          const effectivePrice = priceMap.get(symbol) !== undefined ? priceMap.get(symbol)! : price;

          if (cost > 0 && effectivePrice > 0) {
            const dropPct = (cost - effectivePrice) / cost;
            const isAlerted = Boolean(stockData.costDropAlerted);
            const chatId = userData?.telegramChatId ? String(userData.telegramChatId) : null;
            const botToken = userData?.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "";

            if (dropPct >= 0.15) {
              if (!isAlerted) {
                if (chatId && botToken) {
                  const stockName = stockData.name || symbol;
                  const dropPctInt = Math.floor(dropPct * 100);
                  const alertMsg = `⚠️ 成本警示：${stockName}(${symbol}) 現價 $${effectivePrice},較您的成本 $${cost} 已下跌 ${dropPctInt}%,請留意。`;
                  console.log(`[Cost Drop Alert] Triggering alert for ${symbol} to ChatID ${chatId} (drop: ${dropPctInt}%)`);
                  await sendTelegramMsg(botToken, chatId, alertMsg);
                }
                await ctx.adminDb.collection("users").doc(userId).collection("stocks").doc(symbol).set({
                  costDropAlerted: true
                }, { merge: true });
              }
            } else if (dropPct < 0.15 && isAlerted) {
              console.log(`[Cost Drop Alert] Resetting alert status for ${symbol}`);
              await ctx.adminDb.collection("users").doc(userId).collection("stocks").doc(symbol).set({
                costDropAlerted: false
              }, { merge: true });
            }
          }
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
          currentSnapshotBatch = ctx.adminDb.batch();
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

    // Step 4b: Take snapshots of portfolio values for standalone telegram_chats
    let telegramSnapshotsCreated = 0;
    let telegramSnapshotsSkipped = 0;

    const tgSnapshotBatches: any[] = [];
    let currentTgSnapshotBatch = ctx.adminDb.batch();
    let tgSnapshotBatchOpCount = 0;
    tgSnapshotBatches.push(currentTgSnapshotBatch);

    try {
      const chatsSnapshot = await ctx.adminDb.collection("telegram_chats").get();
      for (const chatDoc of chatsSnapshot.docs) {
        const chatData = chatDoc.data() || {};
        const stocks = chatData.stocks;
        if (!Array.isArray(stocks) || stocks.length === 0) {
          continue;
        }

        try {
          const snapshotRef = ctx.adminDb.collection("telegram_chats").doc(chatDoc.id).collection("snapshots").doc(todayStr);
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
                console.log(`[Telegram Chat Snapshot] Skipped for chat ${chatDoc.id} (recent snapshot exists)`);
                telegramSnapshotsSkipped++;
                continue;
              }
            }
          }

          const cash = chatData.cash !== undefined ? Number(chatData.cash) : 0;
          currentTgSnapshotBatch.set(snapshotRef, {
            date: todayStr,
            stocks: stocks,
            cash: cash,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });

          console.log(`[Telegram Chat Snapshot] Created for chat ${chatDoc.id} (stocks=${stocks.length})`);
          telegramSnapshotsCreated++;

          tgSnapshotBatchOpCount++;
          if (tgSnapshotBatchOpCount >= 400) {
            currentTgSnapshotBatch = ctx.adminDb.batch();
            tgSnapshotBatches.push(currentTgSnapshotBatch);
            tgSnapshotBatchOpCount = 0;
          }
        } catch (chatErr: any) {
          console.error(`[Telegram Chat Snapshot Error] Failed to generate snapshot for chat ${chatDoc.id}:`, chatErr.message || chatErr);
        }
      }

      for (const b of tgSnapshotBatches) {
        await b.commit();
      }
    } catch (tgErr: any) {
      console.error(`[Telegram Chat Snapshot Error] Failed to process telegram_chats collection:`, tgErr.message || tgErr);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Daily Batch] Complete: prices_updated=${pricesUpdated}, prices_failed=${pricesFailed}, snapshots_created=${snapshotsCreated}, telegram_snapshots_created=${telegramSnapshotsCreated}, elapsed=${elapsed} ms`);

    return {
      success: true,
      users: usersSnap.size,
      prices: { updated: pricesUpdated, failed: pricesFailed },
      snapshots: { created: snapshotsCreated, skipped: snapshotsSkipped },
      telegramChatSnapshots: { created: telegramSnapshotsCreated, skipped: telegramSnapshotsSkipped },
      elapsedMs: elapsed
    };

  } catch (err: any) {
    console.error("[Daily Batch Fatal Error]:", err.message || err);
    return {
      success: false,
      error: err.message || err
    };
  }
}

// 排程已改由 Cloud Scheduler 透過 POST /api/cron/daily-batch 觸發
