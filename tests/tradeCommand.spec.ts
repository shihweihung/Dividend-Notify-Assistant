// Telegram 記帳指令解析
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseTradeCommand, parseDateToken } from '../server/lib/tradeCommand';

const TODAY = '2026-11-23';
const HELD = [
  { symbol: '2330', name: '台積電', shares: 1200 },
  { symbol: '3711', name: '日月光投控', shares: 1200 },
  { symbol: '00878', name: '國泰永續高股息', shares: 20000 },
  { symbol: '0056', name: '元大高股息', shares: 15000 },
  { symbol: '00713', name: '元大台灣高息低波', shares: 8000 },
];

describe('parseTradeCommand', () => {
  test('一般聊天不是記帳指令', () => {
    assert.equal(parseTradeCommand('我目前的資產配置如何', TODAY, HELD), null);
    assert.equal(parseTradeCommand('', TODAY, HELD), null);
  });

  test('代號 + 股數 + 價格，日期預設今天', () => {
    assert.deepEqual(parseTradeCommand('買 2330 1000 1050', TODAY, HELD), {
      kind: 'trade', side: 'buy', symbol: '2330', name: '台積電', shares: 1000, price: 1050, tradeDate: TODAY, isNewStock: false,
    });
  });

  test('股名部分比對、賣出', () => {
    const r = parseTradeCommand('賣 日月光 200 178', TODAY, HELD) as any;
    assert.equal(r.kind, 'trade');
    assert.equal(r.side, 'sell');
    assert.equal(r.symbol, '3711');
    assert.equal(r.shares, 200);
    assert.equal(r.price, 178);
  });

  test('張 = 1000 股，@ 與 元 標示價格，順序可調換', () => {
    const a = parseTradeCommand('買進 0056 2張 36.5', TODAY, HELD) as any;
    assert.equal(a.shares, 2000);
    assert.equal(a.price, 36.5);
    const b = parseTradeCommand('賣出 00878 @21.6 500股', TODAY, HELD) as any;
    assert.equal(b.shares, 500);
    assert.equal(b.price, 21.6);
  });

  test('沒有空格的寫法', () => {
    const r = parseTradeCommand('賣日月光200股178元', TODAY, HELD) as any;
    assert.equal(r.kind, 'trade');
    assert.equal(r.symbol, '3711');
    assert.equal(r.shares, 200);
    assert.equal(r.price, 178);
  });

  test('日期：月/日、昨天；月/日晚於今天視為去年', () => {
    assert.equal((parseTradeCommand('買 2330 1000 1050 11/20', TODAY, HELD) as any).tradeDate, '2026-11-20');
    assert.equal((parseTradeCommand('買 2330 1000 1050 昨天', TODAY, HELD) as any).tradeDate, '2026-11-22');
    assert.equal(parseDateToken('12/30', TODAY), '2025-12-30');
  });

  test('成交日不能晚於今天、不存在的日期要擋', () => {
    assert.equal((parseTradeCommand('買 2330 1000 1050 2026-12-01', TODAY, HELD) as any).kind, 'error');
    assert.equal((parseTradeCommand('買 2330 1000 1050 2026-02-30', TODAY, HELD) as any).kind, 'error');
  });

  test('對到多檔時不猜，要求改打代號', () => {
    const r = parseTradeCommand('賣 元大 100 30', TODAY, HELD) as any;
    assert.equal(r.kind, 'error');
    assert.match(r.message, /好幾檔/);
  });

  test('沒有持有的股票不能賣；可以買新股票（代號）', () => {
    assert.equal((parseTradeCommand('賣 2317 100 200', TODAY, HELD) as any).kind, 'error');
    const r = parseTradeCommand('買 2317 1000 200', TODAY, HELD) as any;
    assert.equal(r.kind, 'trade');
    assert.equal(r.isNewStock, true);
  });

  test('缺股數或價格要回格式說明', () => {
    const r = parseTradeCommand('買 2330 1000', TODAY, HELD) as any;
    assert.equal(r.kind, 'error');
    assert.match(r.message, /股數和價格/);
  });

  test('零股、小數股數擋掉', () => {
    assert.equal((parseTradeCommand('買 2330 10 1050', TODAY, HELD) as any).shares, 10);
    assert.equal((parseTradeCommand('買 2330 10.5 1050', TODAY, HELD) as any).kind, 'error');
  });

  test('復原指令', () => {
    assert.deepEqual(parseTradeCommand('復原 日月光', TODAY, HELD), { kind: 'undo', symbol: '3711', name: '日月光投控' });
    assert.equal((parseTradeCommand('復原', TODAY, HELD) as any).kind, 'error');
  });
});
