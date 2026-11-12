import express from "express";
import { optionalFirebaseAuth } from "../middleware/auth";
import { fetchDividendData } from "../../src/services/geminiService";

export const router = express.Router();

// 伺服器端股息記憶體快取（Map，key 為 symbol，TTL 1 小時）
const dividendServerCache = new Map<string, { data: any; timestamp: number }>();
const DIVIDEND_CACHE_TTL = 60 * 60 * 1000;

// 未登入 IP 限流紀錄（每 IP 每分鐘最多 10 次）
const unauthIpRequestTimestamps = new Map<string, number[]>();

// API: Fetch Dividend Data (Pure API + TWSE/MoneyDJ/Yahoo official data)
router.get("/api/dividend/:symbol", optionalFirebaseAuth, async (req, res) => {
  const symbol = (req.params.symbol || "").trim().toUpperCase();

  // 對未登入（沒有 req.user）的請求加上 IP 限流：每 IP 每分鐘最多 10 次，超過回 429
  if (!(req as any).user) {
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const windowMs = 60 * 1000;
    const history = (unauthIpRequestTimestamps.get(clientIp) || []).filter(t => now - t < windowMs);

    if (history.length >= 10) {
      return res.status(429).json({ error: "請求過於頻繁，未登入訪客每分鐘最多查詢 10 次，請稍候再試。" });
    }

    history.push(now);
    unauthIpRequestTimestamps.set(clientIp, history);
  }

  // 命中快取直接回傳
  const cached = dividendServerCache.get(symbol);
  if (cached && (Date.now() - cached.timestamp < DIVIDEND_CACHE_TTL)) {
    return res.json(cached.data);
  }

  try {
    const data = await fetchDividendData(symbol);
    if (!data) {
      return res.status(404).json({ error: "找不到該股票的資料" });
    }
    dividendServerCache.set(symbol, { data, timestamp: Date.now() });
    res.json(data);
  } catch (error) {
    console.error("Server-side dividend error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "查詢股利資訊失敗" });
  }
});
