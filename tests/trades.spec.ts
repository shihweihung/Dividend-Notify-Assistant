// 買進 / 賣出交易：費用估算、成本、已實現損益、除息日股數
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateFee, estimateTax, taxRateFor, applyTrade, undoLastTrade, totalRealizedPnl,
  adjustSharesWithTrades, sharesAtExDateFromCurrent, TradeError, type Trade,
} from '../shared/trades';
import { resolveSharesAtExDate, computeYearDividends } from '../shared/dividendCalc';

let seq = 0;
const input = (side: 'buy' | 'sell', shares: number, price: number, tradeDate: string, recordedDate = tradeDate) => ({
  side, shares, price, tradeDate, recordedDate,
  recordedAt: `${recordedDate}T10:00:${String(seq++ % 60).padStart(2, '0')}.000Z`, id: `t${seq}`,
});

describe('費用估算', () => {
  test('手續費 0.1425%，整股最低 20 元、零股最低 1 元', () => {
    assert.equal(estimateFee(100, 1000), 142);  // 100000 × 0.1425% = 142.5
    assert.equal(estimateFee(10, 1000), 20);    // 14.25 → 最低 20
    assert.equal(estimateFee(1000, 5), 7);      // 零股 7.125
    assert.equal(estimateFee(10, 10), 1);       // 零股最低 1
  });
  test('證交稅：股票 0.3%、ETF 0.1%、債券 ETF 免徵', () => {
    assert.equal(taxRateFor('2330'), 0.003);
    assert.equal(taxRateFor('0056'), 0.001);
    assert.equal(taxRateFor('00795B'), 0);
    assert.equal(estimateTax('2317', 200, 1000), 600);
    assert.equal(estimateTax('0056', 38.15, 1000), 38);
  });
});

describe('applyTrade', () => {
  test('100 股賣掉 50 股：股數變 50，平均成本不變，算出已實現損益', () => {
    const r = applyTrade('2330', { shares: 100, cost: 500 }, input('sell', 50, 600, '2026-11-10'));
    assert.deepEqual(r.position, { shares: 50, cost: 500 });
    // 賣出金額 30000 − 手續費 42 − 證交稅 90 − 成本 25000 = 4868
    assert.equal(r.trade.fee, 42);
    assert.equal(r.trade.tax, 90);
    assert.equal(r.trade.realizedPnl, 4868);
  });

  test('買進：平均成本含手續費重新加權', () => {
    const r = applyTrade('0056', { shares: 1000, cost: 38 }, input('buy', 1000, 40, '2026-11-10'));
    // (38000 + 40000 + 57) / 2000 = 39.0285 → 39.03
    assert.deepEqual(r.position, { shares: 2000, cost: 39.03 });
    assert.equal(r.trade.realizedPnl, null);
  });

  test('從 0 股開始買進，成本 = (金額 + 手續費) / 股數', () => {
    const r = applyTrade('2317', { shares: 0, cost: null }, input('buy', 1000, 200, '2026-11-10'));
    assert.deepEqual(r.position, { shares: 1000, cost: 200.29 });
  });

  test('成本未知時，賣出的已實現損益為 null（不亂算）', () => {
    const r = applyTrade('2330', { shares: 100, cost: null }, input('sell', 50, 600, '2026-11-10'));
    assert.equal(r.trade.realizedPnl, null);
  });

  test('賣超過持股、股數或價格不合理、成交日在未來 → 擋下來', () => {
    assert.throws(() => applyTrade('2330', { shares: 100, cost: 500 }, input('sell', 101, 600, '2026-11-10')), TradeError);
    assert.throws(() => applyTrade('2330', { shares: 100, cost: 500 }, input('sell', 0, 600, '2026-11-10')), TradeError);
    assert.throws(() => applyTrade('2330', { shares: 100, cost: 500 }, input('buy', 10, -1, '2026-11-10')), TradeError);
    assert.throws(() => applyTrade('2330', { shares: 100, cost: 500 }, input('buy', 10, 1, '2026-11-20', '2026-11-14')), TradeError);
  });

  test('分批賣光：每次的損益都記得到，合計正確', () => {
    let pos = { shares: 100, cost: 500 as number | null };
    const trades: Trade[] = [];
    for (const [q, p] of [[50, 600], [50, 400]] as const) {
      const r = applyTrade('2330', pos, input('sell', q, p, '2026-11-10'));
      pos = r.position; trades.push(r.trade);
    }
    assert.equal(pos.shares, 0);
    assert.equal(totalRealizedPnl(trades), trades[0].realizedPnl! + trades[1].realizedPnl!);
    assert.ok(trades[1].realizedPnl! < 0);
  });

  test('復原最後一筆交易：回到交易前的股數與成本', () => {
    const a = applyTrade('0056', { shares: 1000, cost: 38 }, input('buy', 1000, 40, '2026-11-10'));
    const b = applyTrade('0056', a.position, input('sell', 500, 41, '2026-11-11'));
    const u = undoLastTrade([a.trade, b.trade])!;
    assert.deepEqual(u.position, a.position);
    assert.equal(u.trades.length, 1);
    assert.deepEqual(undoLastTrade([a.trade])!.position, { shares: 1000, cost: 38 });
  });
});

describe('除息日股數：交易的「成交日」決定能不能領息', () => {
  const sell = (shares: number, tradeDate: string, recordedDate: string) =>
    applyTrade('2330', { shares: 1000, cost: 500 }, input('sell', shares, 600, tradeDate, recordedDate)).trade;
  const buy = (shares: number, tradeDate: string, recordedDate: string) =>
    applyTrade('2330', { shares: 1000, cost: 500 }, input('buy', shares, 600, tradeDate, recordedDate)).trade;

  test('11/10 賣出、11/15 才補登，除息日 11/12 → 用賣出後的股數', () => {
    // 11/11 的快照還是 100 股（那時還沒記錄賣出）
    assert.equal(adjustSharesWithTrades(100, '2026-11-11', '2026-11-12', [sell(50, '2026-11-10', '2026-11-15')]), 50);
  });

  test('除息日當天賣出：仍領得到', () => {
    assert.equal(adjustSharesWithTrades(50, '2026-11-12', '2026-11-12', [sell(50, '2026-11-12', '2026-11-12')]), 100);
  });

  test('除息日前一天買進並當天記錄：領得到；除息日當天買進：領不到', () => {
    assert.equal(adjustSharesWithTrades(150, '2026-11-11', '2026-11-12', [buy(50, '2026-11-11', '2026-11-11')]), 150);
    assert.equal(adjustSharesWithTrades(150, '2026-11-12', '2026-11-12', [buy(50, '2026-11-12', '2026-11-12')]), 100);
  });

  test('沒有快照時用目前股數倒推', () => {
    assert.equal(sharesAtExDateFromCurrent(50, '2026-11-12', [sell(50, '2026-11-13', '2026-11-13')]), 100);
    assert.equal(sharesAtExDateFromCurrent(50, '2026-11-12', [sell(50, '2026-11-10', '2026-11-10')]), 50);
  });

  test('整合到 resolveSharesAtExDate 與今年股息計算', () => {
    const late = sell(500, '2026-10-20', '2026-10-25'); // 10/20 賣、10/25 才記
    const snaps = [{ date: '2026-10-21', stocks: [{ symbol: '2330', shares: 1000 }] }];
    assert.deepEqual(resolveSharesAtExDate(snaps, '2330', '2026-10-22', 500, [late]), { shares: 500, source: 'before-ex-date' });
    const y = computeYearDividends({
      stocks: [{ symbol: '2330', shares: 500, trades: [late], dividendInfo: { history: [{ date: '2026-10-22', paymentDate: '2026-11-11', amount: 5 }] } }],
      snapshots: snaps, year: 2026, todayStr: '2026-11-14',
    });
    assert.equal(y.received, 500 * 5 - 10);
  });
});
