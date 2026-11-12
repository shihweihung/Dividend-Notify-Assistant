import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { initFirestore } from "./server/context";
import { migrateLegacyJsonDb } from "./server/services/chatStore";
import { startTelegramPolling } from "./server/services/telegramPolling";
import { router as adminRouter } from "./server/routes/admin";
import { router as telegramRouter } from "./server/routes/telegram";
import { router as dividendRouter } from "./server/routes/dividend";
import { router as portfolioRouter } from "./server/routes/portfolio";
import { router as cronRouter } from "./server/routes/cron";

// 純函式另外匯出，方便測試與既有 import 相容
export { normalizeName, NAME_MAP, resolveSymbolFromName } from "./server/lib/symbols";
export { mergeAndValidateStocks } from "./server/lib/portfolioMerge";

const __dirname = process.cwd();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Firebase Admin 初始化與連線檢查、舊 JSON DB 搬遷
  await initFirestore();
  await migrateLegacyJsonDb();

  app.use("/api/parse-portfolio-screenshot", express.json({ limit: "25mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // 每日貼文自動推播已暫停，僅保留手動觸發（Web UI / Telegram /post / Cloud Scheduler）
  console.log("[Scheduler] Daily post automatic push is PAUSED per user preference (manual trigger only).");

  app.use(adminRouter);     // /api/admin/*
  app.use(telegramRouter);  // /api/telegram/*

  // Trigger background poller for non-webhook bots
  startTelegramPolling();

  app.use(dividendRouter);  // /api/dividend/:symbol
  app.use(portfolioRouter); // /api/parse-portfolio-screenshot
  app.use(cronRouter);      // /api/cron/*, /api/user/generate-daily-post

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

  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    if (err && err.type === "entity.too.large") {
      console.warn(`[Payload Too Large] ${req.method} ${req.path}`);
      return res.status(413).json({ error: "圖片檔案過大，請改用較小的截圖或重新裁切後再試。" });
    }
    console.error(`[Unhandled Error] ${req.method} ${req.path}:`, err);
    return res.status(500).json({ error: err?.message || "伺服器發生未預期錯誤" });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  startServer().catch((err) => {
    console.error("Fatal error starting server:", err);
  });
}
