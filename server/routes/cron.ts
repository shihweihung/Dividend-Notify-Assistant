import express from "express";
import { apiKeyAuth, firebaseAuth } from "../middleware/auth";
import { runDailyBatchCore } from "../services/dailyBatch";
import { runDividendNotifyCore } from "../services/dividendNotify";
import { generateDailyPostCore } from "../services/dailyPost";

export const router = express.Router();

// API: Daily Batch for price updates and portfolio snapshots (Triggered daily at 14:00 Taipei time by Cloud Scheduler or internal timer)
router.post("/api/cron/daily-batch", apiKeyAuth, async (req, res) => {
  const result = await runDailyBatchCore();
  if (!result.success) {
    return res.status(500).json(result);
  }
  return res.json(result);
});

// API: Daily Dividend Notification Push (Triggered daily at 08:00 Taipei time by Cloud Scheduler or internal timer)
router.post("/api/cron/dividend-notify", apiKeyAuth, async (req, res) => {
  const result = await runDividendNotifyCore();
  if (!result.success) {
    return res.status(500).json(result);
  }
  return res.json(result);
});

// API: Daily "舒洪道" Style Post Draft Generation (Triggered daily at 14:30 Taipei time by Cloud Scheduler or internal timer)
router.post("/api/cron/daily-post", apiKeyAuth, async (req, res) => {
  const result = await generateDailyPostCore();
  if (result && !result.success) {
    return res.status(500).json(result);
  }
  return res.json(result || { success: true });
});

// API: User Manual Trigger for "舒洪道" Daily Post Draft Generation
router.post("/api/user/generate-daily-post", firebaseAuth, async (req, res) => {
  console.log("[API] User requested manual generation of 舒洪道 post draft.");
  const result = await generateDailyPostCore();
  if (result && !result.success) {
    return res.status(500).json(result);
  }
  return res.json(result || { success: true });
});
