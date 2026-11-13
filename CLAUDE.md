# 息引力 (Dividend Notify Assistant)

台股股息追蹤 Telegram Bot。Express/TypeScript + Firebase/Firestore + Cloud Run + Gemini。
程式由 AI Studio 產生後直接 commit 到 main,沒有 PR 流程。

## 後端結構
- `server.ts`:只負責啟動(Firestore 初始化、掛 router、Vite/靜態檔、錯誤處理)
- `server/context.ts`:共用狀態(adminDb、firestoreAvailable、in-memory fallback)
- `shared/`:前後端共用的純函式(股息計算),不可引用 Firebase / React / Express
- `server/lib/`:純函式,不碰網路與資料庫,必須有測試
  - `symbols.ts`(NAME_MAP、resolveSymbolFromName)、`portfolioMerge.ts`(mergeAndValidateStocks)、`dividendEvents.ts`(股息事件判斷)
- `server/services/`:商業流程(每日批次、股息通知、Telegram bot、截圖解析)
- `server/routes/`:Express router,只做參數檢查與呼叫 service
- 新增 API 時放進對應的 routes 檔,不要再寫回 server.ts
- `npm test` 必須全部通過;改到 `server/lib/` 的邏輯要同步補 `tests/core.spec.ts`

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
與後端 `server/lib/portfolioMerge.ts` 的 `mergeAndValidateStocks` 不同步而產生 bug。
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

### 7. 領息金額以「除息日前一天」的持股計算
使用者會隨時調整持股,領息通知不可直接用目前股數。
- 股數取除息日前(不含當天)最後一份快照(`sharesBeforeExDate`);除息日當天才買的領不到
- 除息後才賣掉的股票仍要發領息通知(`collectDividendCandidates` 會從快照找回來)
- 找不到除息前快照時才用目前股數,且訊息必須註明「以目前持股估算」
- 金額 = 股數 × 每股股利,元以下捨去,再扣匯費 10 元;不扣二代健保(使用者決定)
- 除息日早於第一份快照時,用最早一份快照估算;完全沒有快照才用目前股數,兩者都要標示是估算
- 規則寫在 `shared/dividendCalc.ts`,網頁(今年已領/未領、月曆、歷年股息)與 Telegram 通知共用同一份,
  不可在 `src/App.tsx` 或 `server/` 另外寫一套算法
- 「已領 / 未領」一律用今天日期即時判斷(發放日 <= 今天就是已領),不可使用後端存下來的
  `receivedAmountCurrentYear`、`monthlyDistribution` 等欄位(那是抓資料當下的結果,過了發放日不會更新)
- 測試在 `tests/dividendCalc.spec.ts`、`tests/core.spec.ts`、`tests/dividendNotify.spec.ts`

### 8. 買進 / 賣出以交易紀錄為準
- 交易存在 `users/{uid}/stocks/{symbol}.trades` 陣列(不另開集合,不多讀文件),規則在 `shared/trades.ts`
- 除息日能領幾股看「成交日」,不是記錄日:除息日前一天(含)以前買進才領得到,除息日當天賣出仍領得到;
  快照只包含「記錄日 <= 快照日」的交易,`adjustSharesWithTrades` 依成交日修正,所以晚幾天補登也算得對
- 手續費與證交稅自動估算(使用者決定,不手動輸入):手續費 0.1425%(整股最低 20、零股最低 1),
  證交稅 股票 0.3% / ETF 0.1% / 債券 ETF 免徵
- 賣出不改變平均成本;買進的平均成本含手續費重新加權
- 只能復原「最後一筆」交易(用交易前存下的 prevShares / prevCost 還原),避免成本算錯
- 舊的清倉資料(sellPrice / soldShares)沒有交易紀錄時才使用;沒填賣出股數就不算已實現損益,不可預設 1000 股

## 使用情境(做取捨時的依據)
- 使用者只有本人與少數家人,不需要為大量使用者設計
- 優先順序:股息股數正確 > 花費最低 > 使用方便 > 效能
- daily-batch 排程在台北時間下午 2 點(收盤後)執行,快照代表當天收盤後的持股

## 已移除的功能
- 舒洪道每日貼文草稿(2026-11 移除,使用者不再使用),不要再加回來

## 其他慣例
- Gemini 一律用 Flash / Flash-Lite,Pro 會產生明顯 API 費用
- Cloud Run `min instances` 維持 0
- 排程一律走 Cloud Scheduler + cron HTTP endpoint,不可用 `setInterval`
- 對照表(NAME_MAP)目前寫死在 server/lib/symbols.ts,新增股票需改 code;
  若看到重複手動新增的跡象,可提醒改為同步證交所 ISIN 對照檔
