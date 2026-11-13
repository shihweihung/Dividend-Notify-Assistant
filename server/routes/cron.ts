import express from "express";
import { apiKeyAuth } from "../middleware/auth";
import { runDailyBatchCore } from "../services/dailyBatch";
import { runDividendNotifyCore } from "../services/dividendNotify";

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
