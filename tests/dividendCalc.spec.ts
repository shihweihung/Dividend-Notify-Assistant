// shared/dividendCalc.ts：網頁與 Telegram 通知共用的股息計算
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import moment from 'moment-timezone';
import {
  addOneMonth, getDividendRecords, resolveSharesAtExDate, computeYearDividends, yearsWithDividends,
} from '../shared/dividendCalc';

describe('addOneMonth（發放日推估）', () => {
  test('一般日期加一個月', () => {
    assert.equal(addOneMonth('2026-10-22'), '2026-11-22');
    assert.equal(addOneMonth('2026/12/5'), '2027-01-05');
  });
  test('月底自動調整，與 moment 相同', () => {
    for (const d of ['2026-01-31', '2028-01-30', '2026-03-31', '2026-08-31', '2026-12-31']) {
      assert.equal(addOneMonth(d), moment(d).add(1, 'month').format('YYYY-MM-DD'), d);
    }
  });
  test('格式不對回傳空字串', () => {
    assert.equal(addOneMonth(''), '');
    assert.equal(addOneMonth('2026-13'), '');
  });
});

describe('getDividendRecords', () => {
  test('依除息日排序、重複的除息日只留一筆、缺發放日要推估', () => {
    const r = getDividendRecords({ history: [
      { date: '2026-10-22', paymentDate: '2026-11-11', amount: 1.72 },
      { date: '2026/7/21', amount: 0.86 },
      { date: '2026-10-22', paymentDate: '2026-11-11', amount: 1.72 },
    ] });
    assert.deepEqual(r, [
      { exDate: '2026-07-21', payDate: '2026-08-21', payDateEstimated: true, amount: 0.86 },
      { exDate: '2026-10-22', payDate: '2026-11-11', payDateEstimated: false, amount: 1.72 },
    ]);
  });
  test('沒有 history 時用最新一次除息資料', () => {
    const r = getDividendRecords({ exDividendDate: '2026-11-17', paymentDate: '', amount: 0.315 });
    assert.deepEqual(r, [{ exDate: '2026-11-17', payDate: '2026-12-17', payDateEstimated: true, amount: 0.315 }]);
  });
});

describe('resolveSharesAtExDate', () => {
  const snaps = [
    { date: '2026-06-01', stocks: [{ symbol: '0056', shares: 10000 }] },
    { date: '2026-10-21', stocks: [{ symbol: '0056', shares: 15000 }] },
  ];
  test('有除息前一天的快照：準確', () => {
    assert.deepEqual(resolveSharesAtExDate(snaps, '0056', '2026-10-22', 99), { shares: 15000, source: 'before-ex-date' });
  });
  test('除息日早於第一份快照：用最早的快照估算', () => {
    assert.deepEqual(resolveSharesAtExDate(snaps, '0056', '2026-01-20', 99), { shares: 10000, source: 'earliest-snapshot' });
  });
  test('完全沒有快照：用目前持股估算', () => {
    assert.deepEqual(resolveSharesAtExDate([], '0056', '2026-01-20', 99), { shares: 99, source: 'current' });
  });
});

describe('computeYearDividends（網頁的今年已領／未領）', () => {
  const stocks = [
    { symbol: '0056', name: '元大高股息', shares: 15000, dividendInfo: { history: [
      { date: '2026-07-21', paymentDate: '2026-08-13', amount: 0.86 },
      { date: '2026-10-22', paymentDate: '2026-11-11', amount: 1.72 },
      { date: '2025-10-21', paymentDate: '2025-11-12', amount: 0.8 },
    ] } },
    // 已清倉，但除息前有持有
    { symbol: '2330', name: '台積電', shares: 0, dividendInfo: { history: [
      { date: '2026-09-16', paymentDate: '2026-10-09', amount: 5 },
    ] } },
    // 除息後才買
    { symbol: '00881', name: '國泰台灣科技龍頭', shares: 1000, dividendInfo: { history: [
      { date: '2026-08-18', paymentDate: '2026-12-08', amount: 4.6 },
    ] } },
  ];
  const snaps = [
    { date: '2026-07-20', stocks: [{ symbol: '0056', shares: 10000 }] },
    { date: '2026-09-15', stocks: [{ symbol: '0056', shares: 15000 }, { symbol: '2330', shares: 236 }] },
    { date: '2026-10-21', stocks: [{ symbol: '0056', shares: 15000 }, { symbol: '00881', shares: 1000 }] },
  ];

  test('發放日一過就算已領（11/11 的元大高股息在 11/13 是已領）', () => {
    const y = computeYearDividends({ stocks, snapshots: snaps, year: 2026, todayStr: '2026-11-13' });
    assert.equal(y.pending, 0);
    // 0056: 10000×0.86−10 = 8590；15000×1.72−10 = 25790；2330: 236×5−10 = 1170
    assert.equal(y.received, 8590 + 25790 + 1170);
    const before = computeYearDividends({ stocks, snapshots: snaps, year: 2026, todayStr: '2026-11-10' });
    assert.equal(before.pending, 25790);
  });

  test('每筆用除息日前一天的股數；除息後才買的不算', () => {
    const y = computeYearDividends({ stocks, snapshots: snaps, year: 2026, todayStr: '2026-11-13' });
    assert.equal(y.byStock.find(s => s.symbol === '00881'), undefined);
    const s0056 = y.byStock.find(s => s.symbol === '0056')!;
    assert.equal(s0056.payments, 2);
    assert.equal(s0056.perShareTotal, 2.58);
  });

  test('金額一律是整數', () => {
    const y = computeYearDividends({
      stocks: [{ symbol: '3711', shares: 1400, dividendInfo: { history: [{ date: '2026-07-01', paymentDate: '2026-07-30', amount: 6.5832 }] } }],
      snapshots: [], year: 2026, todayStr: '2026-11-13',
    });
    assert.ok(Number.isInteger(y.total));
    assert.equal(y.total, 9206); // 1400 × 6.5832 = 9216.48 → 9216 − 10
  });

  test('依發放月份分到 12 個月', () => {
    const y = computeYearDividends({ stocks, snapshots: snaps, year: 2026, todayStr: '2026-11-13' });
    assert.equal(y.monthly[7].received, 8590);  // 8 月
    assert.equal(y.monthly[9].received, 1170);  // 10 月
    assert.equal(y.monthly[10].received, 25790); // 11 月
  });

  test('只列出有股息的年份', () => {
    assert.deepEqual(yearsWithDividends(stocks), [2025, 2026]);
  });
});
