import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { fetchStockDataFromTwse } from "./src/services/twseService";
import { fetchDividendData } from "./src/services/geminiService";
import moment from "moment-timezone";
import { GoogleGenAI } from "@google/genai";


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
      const firebaseApp = admin.apps.length > 0 ? admin.apps[0]! : admin.initializeApp({
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

  async function sendTelegramMsg(botToken: string, toChatId: number | string, textToSend: string) {
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

  async function sendSingleTelegramMsg(botToken: string, toChatId: number | string, textToSend: string) {
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

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  const apiKeyAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const apiKey = req.headers['x-api-key'];
    if (process.env.API_SECRET_KEY && apiKey === process.env.API_SECRET_KEY) {
      next();
    } else {
      res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
    }
  };

  const firebaseAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
      return res.status(401).json({ error: 'Unauthorized: Missing ID token' });
    }
    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      (req as any).user = decodedToken;
      next();
    } catch (error) {
      res.status(401).json({ error: 'Unauthorized: Invalid ID token' });
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

  async function runDailyBatchCore() {
    const startTime = Date.now();
    
    if (!adminDb || firestoreAvailable === false) {
      return {
        success: false,
        error: "Firestore is not available or initialized."
      };
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
                  await adminDb.collection("users").doc(userId).collection("stocks").doc(symbol).set({
                    costDropAlerted: true
                  }, { merge: true });
                }
              } else if (dropPct < 0.15 && isAlerted) {
                console.log(`[Cost Drop Alert] Resetting alert status for ${symbol}`);
                await adminDb.collection("users").doc(userId).collection("stocks").doc(symbol).set({
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

      return {
        success: true,
        users: usersSnap.size,
        prices: { updated: pricesUpdated, failed: pricesFailed },
        snapshots: { created: snapshotsCreated, skipped: snapshotsSkipped },
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

  let lastUpdateRunDate = "";

  function startDailyUpdateScheduler() {
    console.log("[Scheduler] Daily stock update scheduler started.");
    
    // Asynchronously run batch on server startup to ensure today's snapshot exists
    setTimeout(() => {
      runDailyBatchCore().catch(err => console.error("[Startup Daily Batch Error]", err));
    }, 3000);

    setInterval(async () => {
      try {
        const taipeiTime = moment().tz("Asia/Taipei");
        const todayStr = taipeiTime.format("YYYY-MM-DD");
        const hourMinute = taipeiTime.format("HH:mm");
        const dayOfWeek = taipeiTime.day(); // 0 is Sunday, 6 is Saturday
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        // Check if it's 2:00 PM (14:00) or later Taipei time and hasn't run today yet
        if (taipeiTime.hour() >= 14 && lastUpdateRunDate !== todayStr) {
          lastUpdateRunDate = todayStr;
          console.log(`[Scheduler] It is ${taipeiTime.format("HH:mm")} Taipei time (${todayStr}). Triggering daily batch snapshot & stock update...`);
          await runDailyBatchCore();
        }
      } catch (err: any) {
        console.error("[Scheduler Error] Error in daily update check:", err.message || err);
      }
    }, 60000); // Check every minute
  }

  // Start the daily update scheduler
  startDailyUpdateScheduler();

  // Core Function: Run Dividend Ex-Date & Payment Date Push Notifications via Telegram
  async function runDividendNotifyCore() {
    console.log("[Dividend Notify] Starting dividend notification push check...");
    if (firestoreAvailable === false || !adminDb) {
      console.warn("[Dividend Notify] Firestore unavailable. Skipping notification push.");
      return { success: false, error: "Firestore unavailable" };
    }

    const taipeiTime = moment().tz("Asia/Taipei");
    const todayStr = taipeiTime.format("YYYY-MM-DD");

    const normalizeDateStr = (d: any) => {
      if (!d || typeof d !== 'string') return '';
      const cleaned = d.trim().replace(/\//g, '-');
      const parts = cleaned.split('-');
      if (parts.length === 3) {
        const y = parts[0];
        const m = parts[1].padStart(2, '0');
        const day = parts[2].padStart(2, '0');
        return `${y}-${m}-${day}`;
      }
      return cleaned;
    };

    let notificationsSent = 0;
    let logsCreated = 0;
    const processedChatIds = new Set<string>();
    const sentKeysInMemory = new Set<string>();

    try {
      // 1. Process authenticated users collection
      const usersSnapshot = await adminDb.collection("users").get();
      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const userData = userDoc.data() || {};
        const chatId = userData.telegramChatId ? String(userData.telegramChatId).trim() : null;
        const botToken = (userData.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "").trim();

        if (!chatId || !botToken) continue;
        processedChatIds.add(chatId);

        const stocksSnapshot = await adminDb.collection("users").doc(userId).collection("stocks").get();
        const rawStocks = stocksSnapshot.docs.map((d: any) => d.data());
        
        // Deduplicate stocks array by symbol to avoid processing duplicate stock entries
        const stockMap = new Map<string, any>();
        for (const s of rawStocks) {
          if (s && s.symbol) stockMap.set(String(s.symbol).trim(), s);
        }
        const userStocks = Array.from(stockMap.values());

        for (const stock of userStocks) {
          if (!stock) continue;
          const symbol = String(stock.symbol).trim();
          const stockName = stock.name || symbol;
          const shares = Number(stock.shares) || 0;
          const info = stock.dividendInfo || stock;

          const eventsToNotify: { type: 'ex-dividend' | 'payment'; amount: number }[] = [];

          if (info.history && Array.isArray(info.history) && info.history.length > 0) {
            const seenEx = new Set<string>();
            const seenPay = new Set<string>();

            for (const div of info.history) {
              const exDateStr = normalizeDateStr(div.date);
              let payDateStr = normalizeDateStr(div.paymentDate || div.payDate);

              if (!payDateStr && exDateStr) {
                const mEx = moment(exDateStr);
                if (mEx.isValid()) {
                  payDateStr = mEx.add(1, 'month').format('YYYY-MM-DD');
                }
              }

              if (exDateStr === todayStr && !seenEx.has(exDateStr)) {
                seenEx.add(exDateStr);
                eventsToNotify.push({
                  type: 'ex-dividend',
                  amount: Number(div.amount || info.amount || 0)
                });
              }

              if (payDateStr === todayStr && !seenPay.has(payDateStr)) {
                seenPay.add(payDateStr);
                eventsToNotify.push({
                  type: 'payment',
                  amount: Number(div.amount || info.amount || 0)
                });
              }
            }
          } else {
            const exDateStr = normalizeDateStr(info.exDividendDate || stock.exDividendDate);
            const payDateStr = normalizeDateStr(info.paymentDate || stock.paymentDate);

            if (exDateStr === todayStr) {
              eventsToNotify.push({
                type: 'ex-dividend',
                amount: Number(info.amount || 0)
              });
            }
            if (payDateStr === todayStr) {
              eventsToNotify.push({
                type: 'payment',
                amount: Number(info.amount || 0)
              });
            }
          }

          for (const evt of eventsToNotify) {
            const dedupDocId = `notify_${chatId}_${symbol}_${evt.type}_${todayStr}`;
            if (sentKeysInMemory.has(dedupDocId)) {
              console.log(`[Dividend Notify Dedup In-Memory] ${dedupDocId} already processed. Skipping.`);
              continue;
            }
            sentKeysInMemory.add(dedupDocId);

            const logRef = adminDb.collection("dividend_notify_log").doc(dedupDocId);
            const logSnap = await logRef.get();

            if (logSnap.exists) {
              console.log(`[Dividend Notify Dedup DB] ${dedupDocId} already notified. Skipping.`);
              continue;
            }

            let msgText = "";
            if (evt.type === 'ex-dividend') {
              msgText = `📅 今天是 ${stockName}(${symbol}) 的除息日！每股 $${evt.amount}`;
            } else {
              const totalEst = Math.round(evt.amount * shares);
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
      const chatsSnapshot = await adminDb.collection("telegram_chats").get();
      for (const chatDoc of chatsSnapshot.docs) {
        const chatData = chatDoc.data() || {};
        const chatId = String(chatData.chatId || chatDoc.id).trim();
        if (processedChatIds.has(chatId)) continue;
        const botToken = (chatData.botToken || process.env.TELEGRAM_BOT_TOKEN || "").trim();
        const rawStocks = chatData.stocks || [];
        if (!chatId || !botToken || !Array.isArray(rawStocks) || rawStocks.length === 0) continue;

        const stockMap = new Map<string, any>();
        for (const s of rawStocks) {
          if (s && s.symbol) stockMap.set(String(s.symbol).trim(), s);
        }
        const userStocks = Array.from(stockMap.values());

        for (const stock of userStocks) {
          if (!stock) continue;
          const symbol = String(stock.symbol).trim();
          const stockName = stock.name || symbol;
          const shares = Number(stock.shares) || 0;
          const info = stock.dividendInfo || stock;

          const eventsToNotify: { type: 'ex-dividend' | 'payment'; amount: number }[] = [];

          if (info.history && Array.isArray(info.history) && info.history.length > 0) {
            const seenEx = new Set<string>();
            const seenPay = new Set<string>();

            for (const div of info.history) {
              const exDateStr = normalizeDateStr(div.date);
              let payDateStr = normalizeDateStr(div.paymentDate || div.payDate);

              if (!payDateStr && exDateStr) {
                const mEx = moment(exDateStr);
                if (mEx.isValid()) {
                  payDateStr = mEx.add(1, 'month').format('YYYY-MM-DD');
                }
              }

              if (exDateStr === todayStr && !seenEx.has(exDateStr)) {
                seenEx.add(exDateStr);
                eventsToNotify.push({
                  type: 'ex-dividend',
                  amount: Number(div.amount || info.amount || 0)
                });
              }

              if (payDateStr === todayStr && !seenPay.has(payDateStr)) {
                seenPay.add(payDateStr);
                eventsToNotify.push({
                  type: 'payment',
                  amount: Number(div.amount || info.amount || 0)
                });
              }
            }
          } else {
            const exDateStr = normalizeDateStr(info.exDividendDate || stock.exDividendDate);
            const payDateStr = normalizeDateStr(info.paymentDate || stock.paymentDate);

            if (exDateStr === todayStr) {
              eventsToNotify.push({
                type: 'ex-dividend',
                amount: Number(info.amount || 0)
              });
            }
            if (payDateStr === todayStr) {
              eventsToNotify.push({
                type: 'payment',
                amount: Number(info.amount || 0)
              });
            }
          }

          for (const evt of eventsToNotify) {
            const dedupDocId = `notify_${chatId}_${symbol}_${evt.type}_${todayStr}`;
            if (sentKeysInMemory.has(dedupDocId)) {
              console.log(`[Dividend Notify Dedup In-Memory] ${dedupDocId} already processed. Skipping.`);
              continue;
            }
            sentKeysInMemory.add(dedupDocId);

            const logRef = adminDb.collection("dividend_notify_log").doc(dedupDocId);
            const logSnap = await logRef.get();

            if (logSnap.exists) {
              console.log(`[Dividend Notify Dedup DB] ${dedupDocId} already notified. Skipping.`);
              continue;
            }

            let msgText = "";
            if (evt.type === 'ex-dividend') {
              msgText = `📅 今天是 ${stockName}(${symbol}) 的除息日！每股 $${evt.amount}`;
            } else {
              const totalEst = Math.round(evt.amount * shares);
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

  let lastNotifyRunDate = "";

  function startDividendNotifyScheduler() {
    console.log("[Scheduler] Dividend notification push scheduler started.");
    
    // Check on startup after 5 seconds if hour is >= 8
    setTimeout(() => {
      const taipeiTime = moment().tz("Asia/Taipei");
      if (taipeiTime.hour() >= 8 && lastNotifyRunDate !== taipeiTime.format("YYYY-MM-DD")) {
        lastNotifyRunDate = taipeiTime.format("YYYY-MM-DD");
        runDividendNotifyCore().catch(err => console.error("[Startup Dividend Notify Error]", err));
      }
    }, 5000);

    setInterval(async () => {
      try {
        const taipeiTime = moment().tz("Asia/Taipei");
        const todayStr = taipeiTime.format("YYYY-MM-DD");

        // Trigger if it's 8:00 AM or later Taipei time and hasn't run today yet
        if (taipeiTime.hour() >= 8 && lastNotifyRunDate !== todayStr) {
          lastNotifyRunDate = todayStr;
          console.log(`[Scheduler] It is ${taipeiTime.format("HH:mm")} Taipei time (${todayStr}). Triggering dividend notifications...`);
          await runDividendNotifyCore();
        }
      } catch (err: any) {
        console.error("[Scheduler Error] Error in dividend notification check:", err.message || err);
      }
    }, 60000); // Check every minute
  }

  // Start the dividend notification scheduler
  startDividendNotifyScheduler();

  // Core Function: Generate Daily "舒洪道" Style Post Draft via Gemini & Telegram Push
  const DAILY_POST_TRIAL_END = "2026-08-11";

  async function generateDailyPostCore() {
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

    if (firestoreAvailable === false || !adminDb) {
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
          try {
            const response = await ai.models.generateContent({
              model: modelName,
              contents: systemPromptTemplate,
            });

            generatedText = response.text ? response.text.trim() : "";
            if (generatedText) {
              console.log(`[Daily Post] Successfully generated post using model: ${modelName}`);
              break;
            }
          } catch (modelErr: any) {
            console.warn(`[Daily Post] Model ${modelName} failed, retrying next Flash candidate:`, modelErr.message || modelErr);
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
      const usersSnapshot = await adminDb.collection("users").get();
      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const userData = userDoc.data() || {};
        const chatId = userData.telegramChatId ? String(userData.telegramChatId) : null;
        const botToken = userData.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "";

        if (!chatId || !botToken) continue;
        processedChatIds.add(chatId);

        const stocksSnapshot = await adminDb.collection("users").doc(userId).collection("stocks").get();
        const userStocks = stocksSnapshot.docs.map((d: any) => d.data());

        if (!userStocks || userStocks.length === 0) continue;

        await processAndSendDraftForUser(userStocks, chatId, botToken);
        postsGenerated++;
      }

      // 2. Process telegram_chats collection (for standalone Telegram Bot chats)
      const chatsSnapshot = await adminDb.collection("telegram_chats").get();
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

  let lastDailyPostRunDate = "";

  function startDailyPostScheduler() {
    console.log("[Scheduler] Daily post automatic push is PAUSED per user preference (manual trigger only).");
    // Automatic timer disabled as requested. Users can trigger posts manually from Web UI or Telegram.
  }

  // Start the daily post draft scheduler
  startDailyPostScheduler();

  // API: Manually trigger update of all user stock prices & dividends
  app.get("/api/admin/trigger-stock-update", apiKeyAuth, async (req, res) => {
    console.log("[API] Manual stock update triggered via API.");
    updateAllUserStocks().catch(err => {
      console.error("[API Stock Update Error]", err);
    });
    return res.json({ success: true, message: "Stock update process triggered in background." });
  });

  // API: Save / Sync Telegram Chat Data
  app.post("/api/telegram/save-chat-data", firebaseAuth, async (req, res) => {
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
  app.post("/api/telegram/send", firebaseAuth, async (req, res) => {
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
        `✍️ *輸入 「/post」 或 「舒洪道」 即可手動要求生成舒洪道風格貼文！*\n` +
        `🎯 *「如何做好我的動態資產平衡？」*\n\n` +
        `直接在下方輸入區輸入您的問題，隨時看子彈到位、聽策略叮嚀！👇`;
      await sendTelegramMsg(botToken, chatId, welcomeText);
      return;
    }

    // Manual Trigger Command for "舒洪道" Daily Post Draft
    if (text.startsWith("/post") || text.includes("舒洪道") || text.includes("生成貼文") || text === "發文") {
      await sendTelegramMsg(botToken, chatId, "✍️ 收到指示！正在為您生成「舒洪道」風格貼文草稿，請稍候...");
      generateDailyPostCore().catch(err => console.error("[Manual Telegram Post Error]", err));
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

      let totalStockValue = 0;
      let totalStockCost = 0;
      let hasAnyCost = false;

      const stocksSummary = stocksList.length > 0
        ? stocksList.slice(0, 20).map((s: any) => {
            const name = s.name || s.symbol;
            const shares = Number(s.shares) || 0;
            const cost = s.cost !== undefined && s.cost !== null && Number(s.cost) > 0 ? Number(s.cost) : null;
            const currentPrice = Number(s.dividendInfo?.currentPrice || s.currentPrice || 0);
            const yieldRate = Number(s.dividendInfo?.yield || 0);

            const currentValue = currentPrice * shares;
            totalStockValue += currentValue;

            let costText = "成本單價: 未設定";
            let profitText = "";

            if (cost !== null) {
              hasAnyCost = true;
              const totalCost = cost * shares;
              totalStockCost += totalCost;
              costText = `成本單價: $${cost}元 (總成本: $${Math.round(totalCost).toLocaleString()}元)`;

              if (currentPrice > 0 && shares > 0) {
                const profit = currentValue - totalCost;
                const profitRate = totalCost > 0 ? ((profit / totalCost) * 100).toFixed(2) : '0.00';
                profitText = `, 未實現損益: ${profit >= 0 ? '+' : ''}$${Math.round(profit).toLocaleString()}元 (${profitRate}%)`;
              }
            }

            let extra = "";
            if (currentPrice > 0) {
              extra += `, 現價: $${currentPrice}元, 現值市值: $${Math.round(currentValue).toLocaleString()}元`;
            }
            if (yieldRate > 0) {
              extra += `, 殖利率: ${yieldRate.toFixed(2)}%`;
            }

            let divInfoText = "";
            const info = s.dividendInfo;
            if (info) {
              if (info.exDividendDate) divInfoText += `, 最新/下次除息日: ${info.exDividendDate}`;
              if (info.amount) divInfoText += `, 最新單次配息: $${info.amount}元`;
              if (info.paymentDate) divInfoText += `, 預計發放日: ${info.paymentDate}`;
              if (info.history && Array.isArray(info.history) && info.history.length > 0) {
                const historyList = info.history.slice(0, 6).map((h: any) => 
                  `${h.date || h.year}(配息:$${h.amount}元${h.paymentDate ? ',付息:' + h.paymentDate : ''})`
                ).join("; ");
                divInfoText += `, 配息紀錄: [${historyList}]`;
              }
            }

            return `- ${name} (${s.symbol}): ${shares.toLocaleString()} 股, ${costText}${extra}${divInfoText}${profitText}`;
          }).join("\n") + (isTruncated ? "\n... (省略其餘持股)" : "")
        : "目前持股列表中尚無持股數據（若您剛加入，可返回網頁重新加載以觸發最新的同步）。";

      // 針對使用者提問抽取的即時個股數據 (例如使用者問「00881今年配息多少」)
      const stockCodeMatches = text.match(/\b(00\d{2,4}|\d{4})\b/g);
      let queriedStockInfo = "";
      if (stockCodeMatches && stockCodeMatches.length > 0) {
        const uniqueCodes = (Array.from(new Set(stockCodeMatches)) as string[]).slice(0, 3);
        const fetchedList: string[] = [];
        for (const code of uniqueCodes) {
          try {
            console.log(`[Telegram Query] Fetching live TWSE stock info for queried symbol: ${code}`);
            const data = await fetchStockDataFromTwse(code);
            if (data) {
              let historyStr = "";
              if (data.history && Array.isArray(data.history) && data.history.length > 0) {
                historyStr = data.history.slice(0, 8).map((h: any) => 
                  `  • ${h.year}年度/期別 (${h.date}): 配息 $${h.amount} 元${h.paymentDate ? ', 發放日: ' + h.paymentDate : ''}`
                ).join("\n");
              }
              fetchedList.push(
                `📌 提問個股【${data.name} (${data.symbol})】即時權威配息數據：\n` +
                `- 當前股價: $${data.price} 元\n` +
                `- 最新單次配息金額: $${data.amount} 元\n` +
                `- 最新/下次除息日: ${data.exDate || '未定/已除息'}\n` +
                `- 最新股息發放日: ${data.paymentDate || '未定'}\n` +
                `- 預估殖利率: ${data.yield}%\n` +
                (historyStr ? `- 歷年配息詳細紀錄：\n${historyStr}\n` : "")
              );
            }
          } catch (e: any) {
            console.warn(`[Telegram Query] Failed to fetch live data for ${code}:`, e.message || e);
          }
        }
        if (fetchedList.length > 0) {
          queriedStockInfo = `## 針對使用者提問抽取的即時公開數據（權威資料來源）\n` + fetchedList.join("\n") + "\n\n";
        }
      }

      const totalUnrealizedProfit = totalStockValue - totalStockCost;
      const totalProfitRate = totalStockCost > 0 ? ((totalUnrealizedProfit / totalStockCost) * 100).toFixed(2) : '0.00';
      const totalAssets = totalStockValue + cash;

      const profitSummaryText = hasAnyCost
        ? `💰 總股票成本：$${Math.round(totalStockCost).toLocaleString()} 元 | 未實現總損益：${totalUnrealizedProfit >= 0 ? '+' : ''}$${Math.round(totalUnrealizedProfit).toLocaleString()} 元 (${totalProfitRate}%)\n`
        : `💰 總股票成本：目前尚未設定成本單價 (若使用者詢問損益，請提示可在「息引力」網頁補填各股票的「成本單價」以獲得自動計算)\n`;

      const backgroundSection = `## 當前個人資產背景\n` +
        `📊 帳戶：${finalUsername} | 現金：$${cash.toLocaleString()} 元 | 股票總市值：$${Math.round(totalStockValue).toLocaleString()} 元 | 總資產：$${Math.round(totalAssets).toLocaleString()} 元\n` +
        profitSummaryText +
        queriedStockInfo +
        `持股明細與股息紀錄：\n` +
        `${stocksSummary}\n\n`;

      const currentDateStr = moment().tz("Asia/Taipei").format("YYYY-MM-DD");
      const currentYearStr = moment().tz("Asia/Taipei").format("YYYY");

      const systemInstruction =
        `# Role: 息引力資產守護助理\n\n` +
        `【重要時間與時空脈絡基準】\n` +
        `今天是台北時間 ${currentDateStr}（當前年度為 ${currentYearStr} 年）。\n` +
        `當使用者詢問「今年」、「最新」配息、歷史除息或股價數據時，請務必使用背景資料中提供的 ${currentYearStr} 年最新即時數據解答，嚴禁回答 2024 或 2025 年之前的舊歷史數據！\n\n` +
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
        `3. 近 30 天內的除息事件或關鍵行事曆(若有)\n\n` +
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
        `### 模式 D:獲利與損益查詢(關鍵字:獲利、損益、賺多少、賠多少、報酬率、利潤、賺或賠)\n` +
        `限制 3 段落內,約 150-250 字。內容:\n` +
        `1. 總獲利快照:回報總投資成本、股票總市值與未實現總損益（包含金額與報酬率 %）。\n` +
        `2. 個股表現分析:列出獲利最高與需注意（虧損或獲利較低）的持股部位與金額/報酬率。\n` +
        `3. 若有部分或全部股票未設定成本單價，提醒使用者可返回「息引力」網頁的各股票欄位中填寫「成本單價」，系統便能自動為您精算完整即時獲利損益。\n\n` +
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
      // Strictly Flash / Flash-Lite models only (never Pro models to avoid billing/quota issues)
      const modelsToTry = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash"];
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
                tools: [{ googleSearch: {} }],
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
  app.post("/api/telegram/register-webhook", firebaseAuth, async (req, res) => {
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
    if (firestoreAvailable === false) {
      return [defaultBotToken].filter((t) => Boolean(t) && !invalidBotTokens.has(t!)) as string[];
    }

    const tokens = new Set<string>();
    
    let defaultIsWebhook = false;

    try {
      const snapshot = await adminDb.collection("telegram_chats").get();
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
      if (isProduction || firestoreAvailable === true) {
        console.error("Error retrieving dynamic bot tokens:", e);
      } else {
        if (!firestoreErrorLogged) {
          console.warn("[Firestore] Cannot retrieve dynamic bot tokens (this is expected in dev environments without Firestore access):", e.message || e);
          firestoreErrorLogged = true;
        }
      }
    }

    if (defaultBotToken && !defaultIsWebhook && !invalidBotTokens.has(defaultBotToken)) {
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

  // Trigger background poller for non-webhook bots
  startTelegramPolling();

  // API: Fetch Dividend Data via Gemini
  app.get("/api/dividend/:symbol", firebaseAuth, async (req, res) => {
    const symbol = (req.params.symbol || "").trim().toUpperCase();
    const apiKey = process.env.CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      console.error("SERVER ERROR: API Key is missing.");
      return res.status(500).json({ error: "伺服器尚未設定 AI 金鑰，請聯繫管理員。" });
    }

    try {
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

  // API: Daily Batch for price updates and portfolio snapshots (Triggered daily at 14:00 Taipei time by Cloud Scheduler or internal timer)
  app.post("/api/cron/daily-batch", apiKeyAuth, async (req, res) => {
    const result = await runDailyBatchCore();
    if (!result.success) {
      return res.status(500).json(result);
    }
    return res.json(result);
  });

  // API: Daily Dividend Notification Push (Triggered daily at 08:00 Taipei time by Cloud Scheduler or internal timer)
  app.post("/api/cron/dividend-notify", apiKeyAuth, async (req, res) => {
    const result = await runDividendNotifyCore();
    if (!result.success) {
      return res.status(500).json(result);
    }
    return res.json(result);
  });

  // API: Daily "舒洪道" Style Post Draft Generation (Triggered daily at 14:30 Taipei time by Cloud Scheduler or internal timer)
  app.post("/api/cron/daily-post", apiKeyAuth, async (req, res) => {
    const result = await generateDailyPostCore();
    if (result && !result.success) {
      return res.status(500).json(result);
    }
    return res.json(result || { success: true });
  });

  // API: User Manual Trigger for "舒洪道" Daily Post Draft Generation
  app.post("/api/user/generate-daily-post", async (req, res) => {
    console.log("[API] User requested manual generation of 舒洪道 post draft.");
    const result = await generateDailyPostCore();
    if (result && !result.success) {
      return res.status(500).json(result);
    }
    return res.json(result || { success: true });
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

startServer().catch((err) => {
  console.error("Fatal error starting server:", err);
});
