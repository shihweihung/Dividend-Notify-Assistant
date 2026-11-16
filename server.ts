import dotenv from "dotenv";
dotenv.config({ override: true });
import http from "http";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { initFirestoreClient, checkFirestoreHealth } from "./server/context";
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
  const httpServer = http.createServer(app);
  const PORT = 3000;

  // 同步建立 Firebase Admin 實例（不阻塞開埠）
  initFirestoreClient();

  app.use("/api/parse-portfolio-screenshot", express.json({ limit: "25mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.use(adminRouter);     // /api/admin/*
  app.use(telegramRouter);  // /api/telegram/*
  app.use(dividendRouter);  // /api/dividend/:symbol
  app.use(portfolioRouter); // /api/parse-portfolio-screenshot
  app.use(cronRouter);      // /api/cron/*

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const hmrDisabled = process.env.DISABLE_HMR === "true";
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmrDisabled ? false : { server: httpServer, overlay: false },
      },
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

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // 連線檢查、舊資料搬遷與 Telegram Polling 在背景啟動，避免延遲開埠
    void (async () => {
      try {
        await checkFirestoreHealth();
        await migrateLegacyJsonDb();
        await startTelegramPolling();
      } catch (bgErr) {
        console.error("[Background Init Error]", bgErr);
      }
    })();
  });
}

if (process.env.NODE_ENV !== "test") {
  startServer().catch((err) => {
    console.error("Fatal error starting server:", err);
  });
}
