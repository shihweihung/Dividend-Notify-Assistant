import express from "express";
import { firebaseAuth } from "../middleware/auth";
import { parsePortfolioScreenshotWithGemini } from "../services/screenshotParser";

export const router = express.Router();

// API: AI Parse Portfolio Screenshot
router.post("/api/parse-portfolio-screenshot", firebaseAuth, async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: "請上傳或提供截圖圖片內容" });
    }

    const result = await parsePortfolioScreenshotWithGemini(imageBase64, mimeType || "image/png");
    return res.json({
      success: true,
      parsedStocks: result.parsedStocks,
      unresolved: result.unresolved,
      invalid: result.invalid,
      note: result.note
    });
  } catch (err: any) {
    console.error("[Screenshot OCR Endpoint Error]", err);
    return res.status(500).json({
      error: err.message || "截圖解析失敗，請確認圖片清晰度後重試。"
    });
  }
});
