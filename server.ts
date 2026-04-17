import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  app.get("/api/debug-env", (req, res) => {
    res.json({
      customKeyLength: process.env.CUSTOM_GEMINI_API_KEY?.length,
      customKeyPrefix: process.env.CUSTOM_GEMINI_API_KEY?.substring(0, 4),
      systemKeyLength: process.env.GEMINI_API_KEY?.length,
      systemKeyPrefix: process.env.GEMINI_API_KEY?.substring(0, 4),
    });
  });

  // API: Fetch Dividend Data via Gemini
  app.get("/api/dividend/:symbol", async (req, res) => {
    const { symbol } = req.params;
    // 優先順序：1. 自訂金鑰 -> 2. 系統金鑰 -> 3. 硬編碼備用金鑰
    const apiKey = process.env.CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "AIzaSyAS5DTm2hGz9VKd8BPWQKkRQy_Oo_Zvnqk";
    
    if (!apiKey) {
      console.error("SERVER ERROR: API Key is missing.");
      return res.status(500).json({ error: "伺服器尚未設定 AI 金鑰，請聯繫管理員。" });
    }

    try {
      const servicePath = path.join(__dirname, "src", "services", "geminiService.ts");
      const { fetchDividendData } = await import(servicePath);
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

startServer();
