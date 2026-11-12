import { ctx } from "../context";
import { fetchStockDataFromTwse } from "../../src/services/twseService";

export async function updateAllUserStocks() {
  if (!ctx.adminDb || ctx.firestoreAvailable === false) {
    console.warn("[Stock Update] Firestore not accessible or initialized in this environment. Skipping global stock update.");
    return;
  }

  console.log("[Stock Update] Starting global stock data update...");
  const fetchCache = new Map<string, any>();

  try {
    // 1. Get all users
    const usersSnap = await ctx.adminDb.collection("users").get();
    console.log(`[Stock Update] Found ${usersSnap.size} users to update.`);

    for (const userDoc of usersSnap.docs) {
      const userId = userDoc.id;
      const stocksSnap = await ctx.adminDb.collection("users").doc(userId).collection("stocks").get();
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

            await ctx.adminDb.collection("users").doc(userId).collection("stocks").doc(symbol).set({
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
