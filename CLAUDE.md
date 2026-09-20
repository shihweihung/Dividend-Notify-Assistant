# 息引力 (Dividend Notify Assistant)

台股股息追蹤 Telegram Bot。Express/TypeScript + Firebase/Firestore + Cloud Run + Gemini。
程式由 AI Studio 產生後直接 commit 到 main,沒有 PR 流程。

## 審查時優先看的事

### 1. 不可靜默丟資料
解析、合併、匯入流程中,任何無法處理的資料列都必須回報給使用者,
不可用 `continue` / `filter` 悄悄跳過。
`mergeAndValidateStocks` 的 `unresolved` / `invalid` 分類就是為此存在。

### 2. 同代號合併必須股數相加 + 成本加權平均
使用者同一檔股票會分散在多個券商帳號(例如鴻海 2000 股 @195.94 與 1050 股 @188.25,
合併後應為 3050 股 @193.29)。
出現 `Math.max(existing.shares, item.shares)` 這類寫法一律視為 bug。

### 3. 前端不得重複實作後端邏輯
`src/components/AIScreenshotModal.tsx` 曾經自己做過一份代號過濾與去重,
與 `server.ts` 的 `mergeAndValidateStocks` 不同步而產生 bug。
前端只負責呈現與讓使用者編輯,解析/合併/驗算一律在後端。
例外:`handleConfirmApply` 裡的代號格式檢查是擋使用者手動輸入錯字,應保留。

### 4. 股票代號解析的優先順序不可隨意翻轉
`resolveSymbolFromName` 目前是「股名對照表優先於 Gemini 回傳的代號」。
原因:多數券商截圖只顯示股名沒有股號,Gemini 靠記憶反查會出錯
(例如台新新光金給成已下市的 2888、00795B 的 B 後綴被吃掉)。
已知會撞的短股名(如「長榮」對應 2603 而非長榮航 2618)是已知限制,
要改成「螢幕代號優先」必須連同 Gemini prompt 一起評估,不可單邊修改。

### 5. checksum 容差固定 0.1%
`股數 × 均價 ≈ 投資成本`,容差 0.001。
容差來自券商畫面的均價已四捨五入到小數第二位;實測七檔最大誤差 0.0121%。
不要為了讓某筆資料通過而放寬這個值。

### 6. 持股截圖含帳號與姓名
原圖不可寫入 Cloud Storage、不可進 log、不可存進 Firestore,只保留解析後的結果。

## 其他慣例
- Gemini 一律用 Flash / Flash-Lite,Pro 會產生明顯 API 費用
- Cloud Run `min instances` 維持 0
- 排程一律走 Cloud Scheduler + cron HTTP endpoint,不可用 `setInterval`
- 對照表(NAME_MAP)目前寫死在 server.ts,新增股票需改 code;
  若看到重複手動新增的跡象,可提醒改為同步證交所 ISIN 對照檔
