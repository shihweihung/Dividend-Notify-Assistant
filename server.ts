import dotenv from "dotenv";
dotenv.config({ override: true });
import http from "http";
import express from "express";
import compression from "compression";
import path from "path";

// 純函式另外匯出，方便測試與既有 import 相容
export { normalizeName, NAME_MAP, resolveSymbolFromName } from "./server/lib/symbols";
export { mergeAndValidateStocks } from "./server/lib/portfolioMerge";

const __dirname = process.cwd();

async function startServer() {
  const app = express();
  app.use(compression()); // JS 約 1.4MB → 400KB
  const httpServer = http.createServer(app);
  const PORT = 3000;

  let apiRouter: express.Router | null = null;
  let frontendHandler: express.RequestHandler | null = null;
  let initError: unknown = null;

  app.use("/api/parse-portfolio-screenshot", express.json({ limit: "25mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // 背景平行載入路由模組與 Vite，避免延遲開埠導致健康檢查超時
  const initPromise = (async () => {
    try {
      const [
        { initFirestoreClient, checkFirestoreHealth },
        { migrateLegacyJsonDb },
        { startTelegramPolling },
        { router: adminRouter },
        { router: telegramRouter },
        { router: dividendRouter },
        { router: portfolioRouter },
        { router: cronRouter },
      ] = await Promise.all([
        import("./server/context"),
        import("./server/services/chatStore"),
        import("./server/services/telegramPolling"),
        import("./server/routes/admin"),
        import("./server/routes/telegram"),
        import("./server/routes/dividend"),
        import("./server/routes/portfolio"),
        import("./server/routes/cron"),
      ]);

      initFirestoreClient();

      const router = express.Router();
      router.use(adminRouter);     // /api/admin/*
      router.use(telegramRouter);  // /api/telegram/*
      router.use(dividendRouter);  // /api/dividend/:symbol
      router.use(portfolioRouter); // /api/parse-portfolio-screenshot
      router.use(cronRouter);      // /api/cron/*
      apiRouter = router;

      if (process.env.NODE_ENV !== "production") {
        const { createServer: createViteServer } = await import("vite");
        const hmrDisabled = process.env.DISABLE_HMR === "true";
        const vite = await createViteServer({
          server: {
            middlewareMode: true,
            hmr: hmrDisabled ? false : { server: httpServer, overlay: false },
          },
          appType: "spa",
        });
        frontendHandler = vite.middlewares;
      } else {
        const staticRouter = express.Router();
        const distPath = path.join(__dirname, "dist");
        // 檔名帶 hash 的 JS/CSS 內容不會變，讓手機快取一年；index.html 仍每次檢查新版
        staticRouter.use("/assets", express.static(path.join(distPath, "assets"), { immutable: true, maxAge: "365d" }));
        staticRouter.use(express.static(distPath));
        staticRouter.get("*", (req, res) => {
          res.sendFile(path.join(distPath, "index.html"));
        });
        frontendHandler = staticRouter;
      }

      // 連線檢查、舊資料搬遷與 Telegram Polling 在背景執行
      void (async () => {
        try {
          await checkFirestoreHealth();
          await migrateLegacyJsonDb();
          await startTelegramPolling();
        } catch (bgErr) {
          console.error("[Background Init Error]", bgErr);
        }
      })();
    } catch (err) {
      initError = err;
      console.error("Fatal error initializing server modules:", err);
    }
  })();

  app.use(async (req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    if (!apiRouter && !initError) await initPromise;
    if (initError) return next(initError);
    return apiRouter!(req, res, next);
  });

  app.use(async (req, res, next) => {
    if (!frontendHandler && !initError) await initPromise;
    if (initError) return next(initError);
    return frontendHandler!(req, res, next);
  });

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
  });
}

if (process.env.NODE_ENV !== "test") {
  startServer().catch((err) => {
    console.error("Fatal error starting server:", err);
  });
}
