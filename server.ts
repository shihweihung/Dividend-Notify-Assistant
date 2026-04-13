import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import { GoogleGenAI } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  app.get("/api/debug-env", (req, res) => {
    res.json({
      geminiKeyLength: process.env.GEMINI_API_KEY?.length,
      geminiKeyPrefix: process.env.GEMINI_API_KEY?.substring(0, 4),
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

  // OAuth 2.0 Client
  const oauth2Client = new google.auth.OAuth2(
    "1020628400729-cafsiu9cg8am5gc1btvna0ghgjvmitt3.apps.googleusercontent.com",
    process.env.CLIENT_SECRET,
    `https://ais-dev-twr673v6jih523sgrdooye-315522563695.asia-east1.run.app/auth/callback`
  );

  // API: Get Auth URL
  app.get("/api/auth/url", (req, res) => {
    const scopes = ["https://www.googleapis.com/auth/calendar.events"];
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: scopes,
    });
    res.json({ url });
  });

  // API: Callback
  app.get(["/auth/callback", "/auth/callback/"], async (req, res) => {
    const { code, state: userId } = req.query;
    console.log("Auth callback received:", { code, userId });
    try {
      const { tokens } = await oauth2Client.getToken(code as string);
      console.log("Tokens received");
      
      // Store tokens in memory for this session
      oauth2Client.setCredentials(tokens);
      
      // For this prototype, we'll send a success message to the opener
      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Authentication successful. This window should close automatically.</p>
          </body>
        </html>
      `);
    } catch (error) {
      console.error("Auth callback error:", error);
      res.status(500).send("Authentication failed: " + (error instanceof Error ? error.message : String(error)));
    }
  });

  // API: Add Event
  app.post("/api/calendar/event", async (req, res) => {
    const { summary, start, end } = req.body;
    console.log("Adding event request body:", req.body);
    
    try {
      if (!oauth2Client.credentials.access_token) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const calendar = google.calendar({ version: "v3", auth: oauth2Client });
      
      // For all-day events, Google Calendar API expects 'date' (YYYY-MM-DD) instead of 'dateTime'.
      // Also, the end date must be exclusive (the day after the start date).
      const startDate = new Date(start);
      const endDate = new Date(end || start);
      endDate.setDate(endDate.getDate() + 1); // Make end date exclusive
      
      const startStr = startDate.toISOString().split('T')[0];
      const endStr = endDate.toISOString().split('T')[0];
      
      const event = await calendar.events.insert({
        calendarId: "primary",
        requestBody: {
          summary,
          start: { date: startStr },
          end: { date: endStr },
          reminders: {
            useDefault: false,
            overrides: [
              { method: 'popup', minutes: -480 }, // 8:00 AM on the day of the event (all-day events start at 00:00)
            ],
          },
        },
      });
      res.json(event.data);
    } catch (error) {
      console.error("Failed to add event:", error);
      // Log the full error object to see the Gaxios error details
      console.error("Full error object:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
      
      res.status(500).json({ error: "Failed to add event: " + (error instanceof Error ? error.message : String(error)) });
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
