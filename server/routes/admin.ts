import express from "express";
import { apiKeyAuth } from "../middleware/auth";
import { updateAllUserStocks } from "../services/stockUpdate";

export const router = express.Router();

// API: Manually trigger update of all user stock prices & dividends
router.get("/api/admin/trigger-stock-update", apiKeyAuth, async (req, res) => {
  console.log("[API] Manual stock update triggered via API.");
  updateAllUserStocks().catch(err => {
    console.error("[API Stock Update Error]", err);
  });
  return res.json({ success: true, message: "Stock update process triggered in background." });
});
