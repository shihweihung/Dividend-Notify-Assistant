import moment from "moment-timezone";
import { ctx, logFirestoreError } from "../context";
import { fetchStockDataFromTwse } from "../../src/services/twseService";
import { sendTelegramMsg } from "./telegramApi";
import { getChatFromFirestore } from "./chatStore";
import { generateDailyPostCore } from "./dailyPost";
import { parsePortfolioScreenshotWithGemini } from "./screenshotParser";

// Helper: Process Telegram Message (shared by Webhook and Polling)
export async function processTelegramMessage(botToken: string, msg: any) {
  if (!msg || !msg.chat || !msg.chat.id) return;
  const chatId = msg.chat.id;
  const msgId = msg.message_id;

  // 1. Deduplication & Rate Limiting with Fallbacks
  const now = Date.now();
  const dedupKey = `${chatId}_${msgId}`;
  let isDuplicate = false;

  if (ctx.firestoreAvailable !== false) {
    try {
      const dedupDocRef = ctx.adminDb.collection("processed_messages").doc(dedupKey);
      const dedupDoc = await dedupDocRef.get();
      if (dedupDoc.exists && now - dedupDoc.data()!.timestamp < 600000) {
        isDuplicate = true;
      } else {
        await dedupDocRef.set({ timestamp: now });
      }
    } catch (e: any) {
      logFirestoreError("Deduplication check", e);
      if (ctx.inMemoryProcessedMessages.has(dedupKey)) {
        isDuplicate = true;
      } else {
        ctx.inMemoryProcessedMessages.add(dedupKey);
      }
    }
  } else {
    if (ctx.inMemoryProcessedMessages.has(dedupKey)) {
      isDuplicate = true;
    } else {
      ctx.inMemoryProcessedMessages.add(dedupKey);
    }
  }

  if (isDuplicate) {
    console.log(`[Telegram Bot Dedup] Already processed message ${msgId} for ChatID ${chatId}. Discarding duplicate.`);
    return;
  }

  let timestamps: number[] = [];
  if (ctx.firestoreAvailable !== false) {
    try {
      const rateLimitRef = ctx.adminDb.collection("rate_limits").doc(String(chatId));
      const rateLimitDoc = await rateLimitRef.get();
      timestamps = rateLimitDoc.exists ? (rateLimitDoc.data()!.timestamps || []) : [];
      timestamps = timestamps.filter((ts: number) => now - ts < 60000);
      if (timestamps.length >= 3) {
        await sendTelegramMsg(botToken, chatId, "請稍後再試");
        return;
      }
      timestamps.push(now);
      await rateLimitRef.set({ timestamps });
    } catch (e: any) {
      logFirestoreError("Rate limit check", e);
      timestamps = ctx.inMemoryRateLimits.get(String(chatId)) || [];
      timestamps = timestamps.filter((ts: number) => now - ts < 60000);
      if (timestamps.length >= 3) {
        await sendTelegramMsg(botToken, chatId, "請稍後再試");
        return;
      }
      timestamps.push(now);
      ctx.inMemoryRateLimits.set(String(chatId), timestamps);
    }
  } else {
    timestamps = ctx.inMemoryRateLimits.get(String(chatId)) || [];
    timestamps = timestamps.filter((ts: number) => now - ts < 60000);
    if (timestamps.length >= 3) {
      await sendTelegramMsg(botToken, chatId, "請稍後再試");
      return;
    }
    timestamps.push(now);
    ctx.inMemoryRateLimits.set(String(chatId), timestamps);
  }

  const text = (msg.text || "").trim();
  const username = msg.from?.first_name || msg.from?.username || msg.from?.last_name || "投資大師";

  console.log(`[Telegram Bot] Processing message from ChatID ${chatId}: "${text}"`);

  let stocks: any[] = [];
  let cash = 0;
  let foundInFirestore = false;
  let finalUsername = username;

  // 1. Lookup: Firestore
  const chatInfo = await getChatFromFirestore(String(chatId));
  if (chatInfo && (chatInfo.stocks?.length > 0 || chatInfo.cash > 0 || (chatInfo.username && chatInfo.username !== "投資大師"))) {
    stocks = chatInfo.stocks || [];
    cash = Number(chatInfo.cash || 0);
    finalUsername = chatInfo.username || username;
    foundInFirestore = true;
    console.log(`[Telegram Bot DB Lookup] Loaded ${stocks.length} stocks and $${cash} cash from Firestore.`);
  }

  // 2. Secondary Fallback: Cloud Firestore DB
  if (!foundInFirestore && ctx.firestoreAvailable !== false && ctx.adminDb) {
    try {
      console.log(`[Telegram Bot DB Lookup] Querying Firestore fallback for telegramChatId = "${chatId}"`);
      const usersRef = ctx.adminDb.collection("users");
      const querySnapshot = await usersRef.where("telegramChatId", "==", String(chatId)).get();
      
      if (!querySnapshot.empty) {
        const userDoc = querySnapshot.docs[0];
        const userData = userDoc.data();
        cash = userData.cash !== undefined ? Number(userData.cash) : 0;
        finalUsername = userData.username || userData.displayName || msg.from?.first_name || msg.from?.username || msg.from?.last_name || "投資大師";
        
        console.log(`[Telegram Bot DB Lookup] Found user document: ${userDoc.id}. Fetching live stocks...`);
        const stocksSnapshot = await usersRef.doc(userDoc.id).collection("stocks").get();
        stocks = stocksSnapshot.docs.map((doc: any) => doc.data());
        foundInFirestore = true;
        console.log(`[Telegram Bot DB Lookup] Loaded ${stocks.length} stocks and $${cash} cash dynamically from Firestore.`);
      } else {
        console.log(`[Telegram Bot DB Lookup] No user document matches telegramChatId: "${chatId}" in Firestore.`);
      }
    } catch (err: any) {
      logFirestoreError("Secondary User Lookup", err);
    }
  }


  // Send welcome message if user not found
  if (!foundInFirestore) {
    // User is not connected yet
    const helpMessage = `👋 哈囉 ${username}！\n\n` +
      `目前您的 Telegram 帳號尚未與「息引力」投資管理網站進行連結狀態同步。\n\n` +
      `您的 Telegram Chat ID 是：\n` +
      `\`${chatId}\` (👈 點擊即可複製)\n\n` +
      `請依照以下步驟完成連結：\n` +
      `1️⃣ 複製上方的 Chat ID。\n` +
      `2️⃣ 前往「息引力」網頁，點擊右上角「通知偏好」或「通知與推播設定」按鈕。\n` +
      `3️⃣ 在「Telegram Chat ID」輸入框中貼上，點擊「儲存設定」，即可立即喚醒您的雙向智慧對話大門！🚀`;
    
    await sendTelegramMsg(botToken, chatId, helpMessage);
    return;
  }

  // Check if user uploaded a photo/screenshot via Telegram
  if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) {
    try {
      await sendTelegramMsg(botToken, chatId, "📷 收到您的券商持股截圖！「息引力」 Gemini AI 正在為您分析圖片中的持股與張數...");
      const largestPhoto = msg.photo[msg.photo.length - 1];
      const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${largestPhoto.file_id}`);
      const fileData = await fileRes.json();

      if (fileData.ok && fileData.result?.file_path) {
        const imgUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
        const imgFetch = await fetch(imgUrl);
        const arrayBuffer = await imgFetch.arrayBuffer();
        const base64Img = Buffer.from(arrayBuffer).toString('base64');
        const ext = fileData.result.file_path.split('.').pop() || 'png';
        const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';

        const parsed = await parsePortfolioScreenshotWithGemini(base64Img, mimeType);
        
        const hasResolved = parsed.parsedStocks && parsed.parsedStocks.length > 0;
        const hasUnresolved = parsed.unresolved && parsed.unresolved.length > 0;
        const hasInvalid = parsed.invalid && parsed.invalid.length > 0;

        if (hasResolved || hasUnresolved || hasInvalid) {
          let summaryText = `🎉 *「息引力」AI 截圖解析完成！*\n\n`;

          if (hasResolved) {
            summaryText += `✅ *成功解析 ${parsed.parsedStocks.length} 檔持股*：\n`;
            for (const item of parsed.parsedStocks) {
              const sharesStr = Number(item.shares || 0).toLocaleString();
              const costStr = item.cost !== null && item.cost !== undefined ? `$${item.cost}` : '未顯示';
              summaryText += `• *${item.symbol} ${item.name || ''}*: ${sharesStr} 股 (均價: ${costStr})\n`;
            }
          }

          if (hasUnresolved) {
            summaryText += `\n❓ *以下 ${parsed.unresolved.length} 檔未能自動對照股票代號*：\n`;
            for (const item of parsed.unresolved) {
              const sharesStr = Number(item.shares || 0).toLocaleString();
              const costStr = item.cost !== null && item.cost !== undefined ? `$${item.cost}` : '未顯示';
              summaryText += `• *${item.name}*: ${sharesStr} 股 (均價: ${costStr})\n`;
            }
            summaryText += `👉 請回覆此訊息提供正確的股票代號（例如：「${parsed.unresolved[0].name} 代號是 0056」）\n`;
          }

          if (hasInvalid) {
            summaryText += `\n⚠️ *以下 ${parsed.invalid.length} 檔數字檢核不符*：\n`;
            for (const item of parsed.invalid) {
              const totalCostStr = item.totalCost !== null && item.totalCost !== undefined ? `$${item.totalCost.toLocaleString()}` : '未顯示';
              const expStr = `$${item.expectedTotal.toLocaleString()}`;
              summaryText += `• *${item.name} (${item.symbol || '無代號'})*: 畫面投資成本 ${totalCostStr}，但以 股數(${item.shares}) × 均價(${item.cost}) 計算應為 ${expStr}\n`;
            }
          }

          summaryText += `\n💡 提示：請至「息引力」網頁介面使用「📷 AI 截圖匯入」，或直接將持股寫入資料庫！🚀`;
          await sendTelegramMsg(botToken, chatId, summaryText);
          return;
        } else {
          await sendTelegramMsg(botToken, chatId, "😅 截圖解析完成，但未能明確辨識出股票資料，請確認截圖是否清晰或包含完整的股票庫存資訊。");
          return;
        }
      } else {
        await sendTelegramMsg(botToken, chatId, "⚠️ 圖片下載失敗，請確認圖片大小或稍後再試。");
        return;
      }
    } catch (photoErr: any) {
      console.error("[Telegram Photo OCR Error]", photoErr);
      await sendTelegramMsg(botToken, chatId, `⚠️ 截圖解析發生錯誤：${photoErr.message || '無法讀取圖片'}`);
      return;
    }
  }

  // Welcome/start command
  if (text.startsWith("/start")) {
    const welcomeText = `🎉 恭喜連線成功，${finalUsername}！\n\n` +
      `我是您的專屬「息引力」資產守護助理 🤖。我已成功連結您的息引力專屬帳戶與持股資料！\n\n` +
      `您可以隨時在 Telegram 上對我發言或詢問任何資產與配置問題，例如：\n` +
      `📊 *「我目前的資產現況與配置建議」*\n` +
      `💰 *「我現在有多少閒置現金？」*\n` +
      `📈 *「分析我的持股持倉」*\n` +
      `✍️ *輸入 「/post」 或 「舒洪道」 即可手動要求生成舒洪道風格貼文！*\n` +
      `🎯 *「如何做好我的動態資產平衡？」*\n\n` +
      `直接在下方輸入區輸入您的問題，隨時看子彈到位、聽策略叮嚀！👇`;
    await sendTelegramMsg(botToken, chatId, welcomeText);
    return;
  }

  // Manual Trigger Command for "舒洪道" Daily Post Draft
  if (text.startsWith("/post") || text.includes("舒洪道") || text.includes("生成貼文") || text === "發文") {
    await sendTelegramMsg(botToken, chatId, "✍️ 收到指示！正在為您生成「舒洪道」風格貼文草稿，請稍候...");
    // 只產生並發送給提出要求的這個聊天室
    generateDailyPostCore({ onlyChatId: String(chatId).trim() })
      .then(async (result: any) => {
        if (result?.postsGenerated > 0) return;
        const reason = !result?.success
          ? "系統暫時無法讀取資料"
          : !result?.targetFound
            ? "找不到您的持股設定"
            : "目前沒有持股資料，或 AI 暫時無法產生";
        await sendTelegramMsg(botToken, chatId, `⚠️ 這次沒有產生貼文草稿（${reason}），請稍後再試。`);
      })
      .catch(err => console.error("[Manual Telegram Post Error]", err));
    return;
  }

  try {
    // Query Gemini AI
    const { GoogleGenAI } = await import("@google/genai");
    const apiKey = process.env.CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("系統或個人自訂 AI 金鑰（CUSTOM_GEMINI_API_KEY 或 GEMINI_API_KEY）未設定，請在 Settings 內設定。");
    }
    const ai = new GoogleGenAI({ 
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });

    const stocksList = stocks || [];
    const isTruncated = stocksList.length > 20;

    let totalStockValue = 0;
    let totalStockCost = 0;
    let hasAnyCost = false;

    const stocksSummary = stocksList.length > 0
      ? stocksList.slice(0, 20).map((s: any) => {
          const name = s.name || s.symbol;
          const shares = Number(s.shares) || 0;
          const cost = s.cost !== undefined && s.cost !== null && Number(s.cost) > 0 ? Number(s.cost) : null;
          const currentPrice = Number(s.dividendInfo?.currentPrice || s.currentPrice || 0);
          const yieldRate = Number(s.dividendInfo?.yield || 0);

          const currentValue = currentPrice * shares;
          totalStockValue += currentValue;

          let costText = "成本單價: 未設定";
          let profitText = "";

          if (cost !== null) {
            hasAnyCost = true;
            const totalCost = cost * shares;
            totalStockCost += totalCost;
            costText = `成本單價: $${cost}元 (總成本: $${Math.round(totalCost).toLocaleString()}元)`;

            if (currentPrice > 0 && shares > 0) {
              const profit = currentValue - totalCost;
              const profitRate = totalCost > 0 ? ((profit / totalCost) * 100).toFixed(2) : '0.00';
              profitText = `, 未實現損益: ${profit >= 0 ? '+' : ''}$${Math.round(profit).toLocaleString()}元 (${profitRate}%)`;
            }
          }

          let extra = "";
          if (currentPrice > 0) {
            extra += `, 現價: $${currentPrice}元, 現值市值: $${Math.round(currentValue).toLocaleString()}元`;
          }
          if (yieldRate > 0) {
            extra += `, 殖利率: ${yieldRate.toFixed(2)}%`;
          }

          let divInfoText = "";
          const info = s.dividendInfo;
          if (info) {
            if (info.exDividendDate) divInfoText += `, 最新/下次除息日: ${info.exDividendDate}`;
            if (info.amount) divInfoText += `, 最新單次配息: $${info.amount}元`;
            if (info.paymentDate) divInfoText += `, 預計發放日: ${info.paymentDate}`;
            if (info.history && Array.isArray(info.history) && info.history.length > 0) {
              const historyList = info.history.slice(0, 6).map((h: any) => 
                `${h.date || h.year}(配息:$${h.amount}元${h.paymentDate ? ',付息:' + h.paymentDate : ''})`
              ).join("; ");
              divInfoText += `, 配息紀錄: [${historyList}]`;
            }
          }

          return `- ${name} (${s.symbol}): ${shares.toLocaleString()} 股, ${costText}${extra}${divInfoText}${profitText}`;
        }).join("\n") + (isTruncated ? "\n... (省略其餘持股)" : "")
      : "目前持股列表中尚無持股數據（若您剛加入，可返回網頁重新加載以觸發最新的同步）。";

    // 針對使用者提問抽取的即時個股數據 (例如使用者問「00881今年配息多少」)
    const stockCodeMatches = text.match(/\b(00\d{2,4}|\d{4})\b/g);
    let queriedStockInfo = "";
    if (stockCodeMatches && stockCodeMatches.length > 0) {
      const uniqueCodes = (Array.from(new Set(stockCodeMatches)) as string[]).slice(0, 3);
      const fetchedList: string[] = [];
      for (const code of uniqueCodes) {
        try {
          console.log(`[Telegram Query] Fetching live TWSE stock info for queried symbol: ${code}`);
          const data = await fetchStockDataFromTwse(code);
          if (data) {
            let historyStr = "";
            if (data.history && Array.isArray(data.history) && data.history.length > 0) {
              historyStr = data.history.slice(0, 8).map((h: any) => 
                `  • ${h.year}年度/期別 (${h.date}): 配息 $${h.amount} 元${h.paymentDate ? ', 發放日: ' + h.paymentDate : ''}`
              ).join("\n");
            }
            fetchedList.push(
              `📌 提問個股【${data.name} (${data.symbol})】即時權威配息數據：\n` +
              `- 當前股價: $${data.price} 元\n` +
              `- 最新單次配息金額: $${data.amount} 元\n` +
              `- 最新/下次除息日: ${data.exDate || '未定/已除息'}\n` +
              `- 最新股息發放日: ${data.paymentDate || '未定'}\n` +
              `- 預估殖利率: ${data.yield}%\n` +
              (historyStr ? `- 歷年配息詳細紀錄：\n${historyStr}\n` : "")
            );
          }
        } catch (e: any) {
          console.warn(`[Telegram Query] Failed to fetch live data for ${code}:`, e.message || e);
        }
      }
      if (fetchedList.length > 0) {
        queriedStockInfo = `## 針對使用者提問抽取的即時公開數據（權威資料來源）\n` + fetchedList.join("\n") + "\n\n";
      }
    }

    const totalUnrealizedProfit = totalStockValue - totalStockCost;
    const totalProfitRate = totalStockCost > 0 ? ((totalUnrealizedProfit / totalStockCost) * 100).toFixed(2) : '0.00';
    const totalAssets = totalStockValue + cash;

    const profitSummaryText = hasAnyCost
      ? `💰 總股票成本：$${Math.round(totalStockCost).toLocaleString()} 元 | 未實現總損益：${totalUnrealizedProfit >= 0 ? '+' : ''}$${Math.round(totalUnrealizedProfit).toLocaleString()} 元 (${totalProfitRate}%)\n`
      : `💰 總股票成本：目前尚未設定成本單價 (若使用者詢問損益，請提示可在「息引力」網頁補填各股票的「成本單價」以獲得自動計算)\n`;

    const backgroundSection = `## 當前個人資產背景\n` +
      `📊 帳戶：${finalUsername} | 現金：$${cash.toLocaleString()} 元 | 股票總市值：$${Math.round(totalStockValue).toLocaleString()} 元 | 總資產：$${Math.round(totalAssets).toLocaleString()} 元\n` +
      profitSummaryText +
      queriedStockInfo +
      `持股明細與股息紀錄：\n` +
      `${stocksSummary}\n\n`;

    const currentDateStr = moment().tz("Asia/Taipei").format("YYYY-MM-DD");
    const currentYearStr = moment().tz("Asia/Taipei").format("YYYY");

    const systemInstruction =
      `# Role: 息引力資產守護助理\n\n` +
      `【重要時間與時空脈絡基準】\n` +
      `今天是台北時間 ${currentDateStr}（當前年度為 ${currentYearStr} 年）。\n` +
      `當使用者詢問「今年」、「最新」配息、歷史除息或股價數據時，請務必使用背景資料中提供的 ${currentYearStr} 年最新即時數據解答，嚴禁回答 2024 或 2025 年之前的舊歷史數據！\n\n` +
      `你是一位專業的股息投資組合分析師,服務對象是有 20+ 檔持股、關注股息現金流與台美股 AI 供應鏈的成熟投資人。\n\n` +
      `## 核心行為準則\n` +
      `- 使用純文字回覆,絕對禁止使用 * # _ 等 Markdown 符號,避免 Telegram 解析失敗\n` +
      `- 直切核心,不客套、不重複、不下總結廢話\n` +
      `- 用「數字 + 事實」說話,少用形容詞\n` +
      `- 段落之間用兩個換行分隔,一段講一個重點\n\n` +
      backgroundSection +
      `## 回覆模式判斷\n\n` +
      `### 模式 A:資產概況查詢(關鍵字:資產、現況、我的股票、現金、閒錢、目前)\n` +
      `限制 3 段落內,約 150-200 字。內容:\n` +
      `1. 總資產快照:市值 + 現金 + 現金比重百分比\n` +
      `2. 前三大部位是哪些股票、佔比多少,是否有集中風險\n` +
      `3. 近 30 天內的除息事件或關鍵行事曆(若有)\n\n` +
      `### 模式 B:組合層級的策略提問(關鍵字:配置、平衡、加碼、減碼、部位、輪動、風險)\n` +
      `300-500 字,分段回答:\n` +
      `1. 現況診斷:目前組合的產業曝險、股息集中度、現金水位是否合理\n` +
      `2. 具體建議:該加碼/減碼哪類部位,說明理由(產業循環位置、估值、殖利率)\n` +
      `3. 執行細節:操作時點的觸發條件(例如「等 XXX 除息後」「季報公布後」)\n` +
      `4. 風險提示:這個建議背後的假設,以及打臉的訊號\n\n` +
      `### 模式 C:個股/ETF 深度分析(關鍵字:分析、看法、值不值得買、XXXX 股號)\n` +
      `300-500 字,三軸分析:\n\n` +
      `【產業鏈位置】\n` +
      `- 這家公司在產業鏈的哪一段?上下游是誰?\n` +
      `- 主要競品是哪幾家?差異化在哪?\n` +
      `- 若為 AI infra 相關,說明與 CPO/光模組/HBM/ASIC 等主軸的連動關係\n\n` +
      `【基本面數據】\n` +
      `- 最近一季/一年 EPS、營收成長率、毛利率(給實際數字)\n` +
      `- 估值:目前 PE、殖利率、與同業比較\n` +
      `- 股息紀錄:近 3-5 年配息連續性、成長率\n\n` +
      `【近期催化劑】\n` +
      `- 已知的法說會、財報公布時點\n` +
      `- 除息日期、預估配息金額\n` +
      `- 產業層級的關鍵事件(新品發表、大廠 capex、政策)\n\n` +
      `結論用 1 句話:結合本人現有部位,建議該加碼/續抱/減碼/觀望,理由一句話。\n\n` +
      `### 模式 D:獲利與損益查詢(關鍵字:獲利、損益、賺多少、賠多少、報酬率、利潤、賺或賠)\n` +
      `限制 3 段落內,約 150-250 字。內容:\n` +
      `1. 總獲利快照:回報總投資成本、股票總市值與未實現總損益（包含金額與報酬率 %）。\n` +
      `2. 個股表現分析:列出獲利最高與需注意（虧損或獲利較低）的持股部位與金額/報酬率。\n` +
      `3. 若有部分或全部股票未設定成本單價，提醒使用者可返回「息引力」網頁的各股票欄位中填寫「成本單價」，系統便能自動為您精算完整即時獲利損益。\n\n` +
      `## 資料來源與誠實原則\n` +
      `- 若不確定的財務數字,直接說「這個數字我沒把握,建議查證」,絕對不編造\n` +
      `- 產業鏈與競品關係可用你的知識回答,但明確年份可以說「以近期公開資訊」\n` +
      `- 不預測股價漲跌幅百分比,只講「方向」與「觸發條件」\n\n` +
      `## 禁止事項\n` +
      `- 不要說「投資有風險、請自行判斷」這類套話,使用者是專業投資人\n` +
      `- 不要用 emoji 過度裝飾,重點處用一個即可\n` +
      `- 不要在回覆開頭問候使用者名字,直接進入分析`;

    console.log(`[Process] About to call Gemini for ChatID ${chatId}`);
    let response;
    // Strictly Flash / Flash-Lite models only (never Pro models to avoid billing/quota issues)
    const modelsToTry = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash"];
    let lastErr: any = null;

    for (const modelName of modelsToTry) {
      let retries = 2;
      while (retries > 0) {
        try {
          let timeoutId: NodeJS.Timeout | undefined = undefined;
          const apiCallPromise = ai.models.generateContent({
            model: modelName,
            contents: text,
            config: {
              systemInstruction: systemInstruction,
              temperature: 0.7,
              maxOutputTokens: 2500,
              tools: [{ googleSearch: {} }],
            },
          });

          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error("Gemini API call timed out after 20 seconds"));
            }, 20000);
          });

          response = await Promise.race([apiCallPromise, timeoutPromise]);
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          console.log(`[Gemini Finish Reason] model: ${modelName}, finishReason: ${response.candidates?.[0]?.finishReason || 'unknown'}`);
          break;
        } catch (err: any) {
          retries--;
          lastErr = err;
          console.warn(`[Gemini Backoff] Busy status for model ${modelName} (retries left: ${retries}):`, err.message || err);
          if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }
      if (response) {
        console.log(`Successfully generated content using model: ${modelName}`);
        break;
      }
    }

    if (!response) {
      throw lastErr || new Error("All Gemini model candidates failed.");
    }

    const replyText = response.text || "抱歉，我的思考核心目前忙碌中，請稍候再試。";
    console.log(`[Process] Gemini done, reply length: ${replyText.length}, about to send`);
    await sendTelegramMsg(botToken, chatId, replyText);
    console.log(`[Process] sendTelegramMsg returned for ChatID ${chatId}`);

  } catch (err: any) {
    console.error("Gemini Telegram answering error:", err.message || err);
    try {
      const errMsg = `⚠️ *機器人服務暫時出現小狀況* ⚠️\n\n` +
        `我們在處理您的提問時遇到異常，可能原因為：\n` +
        `1. 系統或自訂 AI 金鑰設定有誤\n` +
        `2. AI 思考連線逾時\n\n` +
        `*錯誤明細：*\n\`${err.message || err}\`\n\n` +
        `💡 請您返回「息引力」頁面，檢查您的自訂 AI 金鑰設定、或是稍微等候再嘗試向我提問。謝謝您的體諒！`;
      await sendTelegramMsg(botToken, chatId, errMsg);
    } catch (sendErr) {
      console.error("Failed to forward Telegram error message back to user:", sendErr);
    }
  }
}
