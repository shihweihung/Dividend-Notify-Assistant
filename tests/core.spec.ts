// 核心商業邏輯的回歸測試。執行：npm test
// 這些測試鎖住 CLAUDE.md 列出的規則，重構或讓 AI 改 code 之後都要全部通過。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSymbolFromName, normalizeName, normalizeSymbol } from '../server/lib/symbols';
import { mergeAndValidateStocks } from '../server/lib/portfolioMerge';
import {
  normalizeDateStr, dedupeStocksBySymbol, findDividendEventsForDate,
  sharesBeforeExDate, collectDividendCandidates, estimateNetPayment, buildPaymentMessage,
} from '../server/lib/dividendEvents';

describe('resolveSymbolFromName（規則 4：股名對照表優先於 Gemini 代號）', () => {
  test('股名查得到時，以對照表為準，忽略 Gemini 給的代號', () => {
    assert.equal(resolveSymbolFromName('00878', '國泰台灣科技龍頭'), '00881');
    assert.equal(resolveSymbolFromName('2888', '台新新光金'), '2887');
  });

  test('債券 ETF 的 B 後綴不可被吃掉', () => {
    assert.equal(resolveSymbolFromName('00795', '中信美國公債20年'), '00795B');
  });

  test('股名含空白或全形字也能對到', () => {
    assert.equal(resolveSymbolFromName('', '台 積 電'), '2330');
    assert.equal(normalizeName('ａｂ c'), 'ABC');
  });

  test('股名查不到時，退回符合台股格式的代號（去掉 .TW / .TWO）', () => {
    assert.equal(resolveSymbolFromName('2330.TW', '不存在的股名'), '2330');
    assert.equal(resolveSymbolFromName('6488.two', ''), '6488');
    assert.equal(resolveSymbolFromName('00679b', ''), '00679B');
  });

  test('美股代號（1-5 碼英文）可通過', () => {
    assert.equal(resolveSymbolFromName('aapl', ''), 'AAPL');
  });

  test('格式不符時回傳 null，交由上層回報（不可猜）', () => {
    assert.equal(resolveSymbolFromName('12', '某某電子'), null);
    assert.equal(resolveSymbolFromName('', ''), null);
    assert.equal(resolveSymbolFromName('ABCDEF', ''), null);
  });

  test('已知限制：「長榮」對到海運 2603，不是長榮航 2618', () => {
    assert.equal(resolveSymbolFromName('2618', '長榮'), '2603');
  });
});

describe('mergeAndValidateStocks（規則 1、2、5）', () => {
  test('同代號跨券商合併：股數相加、成本加權平均（鴻海 2000@195.94 + 1050@188.25）', () => {
    const r = mergeAndValidateStocks([
      { symbol: null, name: '鴻海', shares: 2000, cost: 195.94, totalCost: 391880 },
      { symbol: '2317', name: '鴻海', shares: 1050, cost: 188.25, totalCost: 197663 },
    ]);
    assert.equal(r.parsedStocks.length, 1);
    const s = r.parsedStocks[0];
    assert.equal(s.symbol, '2317');
    assert.equal(s.shares, 3050);
    assert.equal(s.cost, 193.29);
    assert.equal(s.totalCost, 391880 + 197663);
  });

  test('合併絕不可取最大值（Math.max 是 bug）', () => {
    const r = mergeAndValidateStocks([
      { symbol: '2330', name: '', shares: 100, cost: 500 },
      { symbol: '2330', name: '', shares: 50, cost: 600 },
    ]);
    assert.equal(r.parsedStocks[0].shares, 150);
    assert.equal(r.parsedStocks[0].cost, 533.33);
  });

  test('對不到代號的資料列放進 unresolved，不可靜默丟棄', () => {
    const r = mergeAndValidateStocks([{ symbol: null, name: '某某小型股', shares: 1000, cost: 20, totalCost: null }]);
    assert.equal(r.parsedStocks.length, 0);
    assert.deepEqual(r.unresolved, [{ name: '某某小型股', shares: 1000, cost: 20, totalCost: null }]);
  });

  test('股名空白也要回報，名稱標示為「未知股名」', () => {
    const r = mergeAndValidateStocks([{ symbol: '', name: '', shares: 10 }]);
    assert.equal(r.unresolved[0].name, '未知股名');
  });

  test('checksum：股數×均價 與 投資成本 差異超過 0.1% 進 invalid', () => {
    // 1000 × 38.15 = 38150，畫面成本 38250 → 差 0.26%
    const r = mergeAndValidateStocks([{ symbol: '0056', name: '元大高股息', shares: 1000, cost: 38.15, totalCost: 38250 }]);
    assert.equal(r.parsedStocks.length, 0);
    assert.equal(r.invalid.length, 1);
    assert.equal(r.invalid[0].symbol, '0056');
    assert.equal(r.invalid[0].expectedTotal, 38150);
  });

  test('checksum：差異在 0.1% 以內（均價四捨五入誤差）視為通過', () => {
    // 15000 × 38.15 = 572250，畫面成本 572239 → 差 0.0019%
    const r = mergeAndValidateStocks([{ symbol: null, name: '元大高股息', shares: 15000, cost: 38.15, totalCost: 572239 }]);
    assert.equal(r.invalid.length, 0);
    assert.equal(r.parsedStocks[0].symbol, '0056');
  });

  test('checksum 容差固定為 0.001：0.09% 通過、0.11% 不通過', () => {
    const pass = mergeAndValidateStocks([{ symbol: '2330', name: '', shares: 1000, cost: 100, totalCost: 100090 }]);
    const fail = mergeAndValidateStocks([{ symbol: '2330', name: '', shares: 1000, cost: 100, totalCost: 100110 }]);
    assert.equal(pass.invalid.length, 0);
    assert.equal(fail.invalid.length, 1);
  });

  test('畫面沒有投資成本欄位時不做 checksum', () => {
    const r = mergeAndValidateStocks([{ symbol: '2330', name: '', shares: 1000, cost: 100, totalCost: null }]);
    assert.equal(r.parsedStocks.length, 1);
    assert.equal(r.invalid.length, 0);
  });

  test('每一筆輸入都必須出現在 parsedStocks / unresolved / invalid 之一（股數守恆）', () => {
    const input = [
      { symbol: null, name: '鴻海', shares: 2000, cost: 195.94, totalCost: 391880 },
      { symbol: '2317', name: '鴻海', shares: 1050, cost: 188.25, totalCost: 197663 },
      { symbol: null, name: '查無此股', shares: 300, cost: 10, totalCost: null },
      { symbol: '0056', name: '元大高股息', shares: 1000, cost: 38.15, totalCost: 38250 },
      { symbol: 'AAPL', name: '', shares: 5, cost: 180, totalCost: null },
    ];
    const r = mergeAndValidateStocks(input);
    const sum = (xs: any[]) => xs.reduce((a, x) => a + x.shares, 0);
    assert.equal(sum(r.parsedStocks) + sum(r.unresolved) + sum(r.invalid), sum(input));
  });
});

describe('股息通知：資料整理與事件判斷', () => {
  test('normalizeDateStr 統一成 YYYY-MM-DD', () => {
    assert.equal(normalizeDateStr('2026/1/5'), '2026-01-05');
    assert.equal(normalizeDateStr(' 2026-11-12 '), '2026-11-12');
    assert.equal(normalizeDateStr(''), '');
    assert.equal(normalizeDateStr(undefined), '');
    assert.equal(normalizeDateStr(20261112), '');
  });

  test('normalizeSymbol 去掉 .TW / .TWO 並轉大寫', () => {
    assert.equal(normalizeSymbol('2330.tw'), '2330');
    assert.equal(normalizeSymbol(' 00679b '), '00679B');
    assert.equal(normalizeSymbol(null), '');
  });

  test('dedupeStocksBySymbol：2330 與 2330.TW 視為同一檔，股數相加、成本加權', () => {
    const r = dedupeStocksBySymbol([
      { symbol: '2330', name: '台積電', shares: 100, cost: 500 },
      { symbol: '2330.TW', name: '2330', shares: 300, cost: 600 },
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].shares, 400);
    assert.equal(r[0].cost, 575);
    assert.equal(r[0].name, '台積電');
  });

  test('dedupeStocksBySymbol：兩筆都沒有成本時 cost 為 null', () => {
    const r = dedupeStocksBySymbol([
      { symbol: '0056', shares: 100 },
      { symbol: '0056', shares: 200 },
    ]);
    assert.equal(r[0].shares, 300);
    assert.equal(r[0].cost, null);
  });

  test('除息日是今天 → 產生 ex-dividend 事件', () => {
    const info = { history: [{ date: '2026/11/12', amount: 1.2 }] };
    const ev = findDividendEventsForDate(info, {}, '2026-11-12');
    assert.deepEqual(ev, [{ type: 'ex-dividend', amount: 1.2, exDateStr: '2026-11-12' }]);
  });

  test('沒有發放日時，以除息日 +1 個月推估', () => {
    const info = { history: [{ date: '2026-10-12', amount: 0.8 }] };
    const ev = findDividendEventsForDate(info, {}, '2026-11-12');
    assert.deepEqual(ev, [{ type: 'payment', amount: 0.8, exDateStr: '2026-10-12', payDateEstimated: true }]);
  });

  test('發放日是今天 → payment 事件，並帶出對應除息日（用來查除息當天的持股快照）', () => {
    const info = { history: [{ date: '2026-09-18', paymentDate: '2026-11-12', amount: 2 }] };
    const ev = findDividendEventsForDate(info, {}, '2026-11-12');
    assert.deepEqual(ev, [{ type: 'payment', amount: 2, exDateStr: '2026-09-18' }]);
  });

  test('history 有重複同一天的紀錄，只通知一次', () => {
    const info = { history: [{ date: '2026-11-12', amount: 1 }, { date: '2026-11-12', amount: 1 }] };
    assert.equal(findDividendEventsForDate(info, {}, '2026-11-12').length, 1);
  });

  test('沒有 history 時，改看 exDividendDate / paymentDate 欄位', () => {
    const info = { exDividendDate: '2026/11/12', paymentDate: '2026-12-10', amount: 3 };
    assert.deepEqual(findDividendEventsForDate(info, {}, '2026-11-12'), [
      { type: 'ex-dividend', amount: 3, exDateStr: '2026-11-12' },
    ]);
    assert.equal(findDividendEventsForDate(info, {}, '2026-11-13').length, 0);
  });
});

describe('領息金額：用除息日前的持股計算（持股變動不影響）', () => {
  const snaps = [
    { date: '2026-09-16', stocks: [{ symbol: '2317', shares: 2000 }] },
    { date: '2026-09-17', stocks: [{ symbol: '2317', shares: 3050 }, { symbol: '0056', shares: 1000 }] },
    { date: '2026-09-18', stocks: [{ symbol: '2317', shares: 5000 }] }, // 除息日當天加碼，不能領
    { date: '2026-10-01', stocks: [] },                                   // 之後全部賣掉
  ];

  test('取除息日「前一天」的快照，不含除息日當天', () => {
    assert.equal(sharesBeforeExDate(snaps, '2317', '2026-09-18'), 3050);
  });

  test('除息日前沒有快照時回傳 null（呼叫端要標示估算）', () => {
    assert.equal(sharesBeforeExDate(snaps, '2317', '2026-09-16'), null);
  });

  test('除息日前的快照裡沒有這檔 → 0 股（當時沒持有，不能領）', () => {
    assert.equal(sharesBeforeExDate(snaps, '2330', '2026-09-18'), 0);
  });

  test('快照日期格式不一、代號帶 .TW 也能對到', () => {
    const s = [{ date: '2026/9/17', stocks: [{ symbol: '2317.TW', shares: 1000 }, { symbol: '2317', shares: 50 }] }];
    assert.equal(sharesBeforeExDate(s, '2317', '2026-09-18'), 1050);
  });

  test('已經賣掉的股票仍會列入檢查（除息後才賣，股息照樣入帳）', () => {
    const current = [{ symbol: '2330', shares: 100, dividendInfo: { amount: 5 } }];
    const c = collectDividendCandidates(current, snaps);
    assert.deepEqual(c.map(x => [x.stock.symbol, x.holdsNow]), [['2330', true], ['2317', false], ['0056', false]]);
  });

  test('同一檔以目前持股的資料為準，已賣出的則取最新快照', () => {
    const c = collectDividendCandidates([{ symbol: '2317', shares: 1, name: '現在' }], [
      { date: '2026-01-01', stocks: [{ symbol: '0056', shares: 1, name: '舊' }] },
      { date: '2026-02-01', stocks: [{ symbol: '0056', shares: 2, name: '新' }, { symbol: '2317', shares: 9, name: '快照' }] },
    ]);
    assert.equal(c.find(x => x.stock.symbol === '2317')!.stock.name, '現在');
    assert.equal(c.find(x => x.stock.symbol === '0056')!.stock.name, '新');
  });

  test('入帳金額：元以下捨去，再扣匯費 10 元，不扣二代健保', () => {
    assert.equal(estimateNetPayment(1.2, 3050), 3650);      // 3660 - 10
    assert.equal(estimateNetPayment(0.35, 333), 106);       // 116.55 → 116 - 10
    assert.equal(estimateNetPayment(5, 10000), 49990);      // 滿 2 萬也不扣二代健保
    assert.equal(estimateNetPayment(0.1, 30), 0);           // 不會變負數
    assert.equal(estimateNetPayment(0.1, 3000), 290);       // 浮點誤差不可少算 1 元
  });

  test('領息訊息顯示股數與單價，方便對帳', () => {
    const msg = buildPaymentMessage({ stockName: '鴻海', symbol: '2317', amountPerShare: 1.2, shares: 3050, sharesSource: 'before-ex-date' });
    assert.equal(msg, '💰 今天是 鴻海(2317) 的領息日！預計入帳 $3,650\n（3,050 股 × 每股 $1.2，已扣匯費 $10）');
  });

  test('用目前持股估算、發放日推估時，訊息要註明', () => {
    const msg = buildPaymentMessage({ stockName: '鴻海', symbol: '2317', amountPerShare: 1, shares: 1000, sharesSource: 'current', payDateEstimated: true });
    assert.match(msg, /以目前持股估算/);
    assert.match(msg, /以除息日後一個月推估/);
  });
});
