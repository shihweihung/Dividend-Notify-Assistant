// runDividendNotifyCore 的流程測試：用假的 Firestore 與攔截 fetch，確認實際會發出哪些 Telegram 訊息
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import moment from 'moment-timezone';
import { ctx } from '../server/context';
import { runDividendNotifyCore } from '../server/services/dividendNotify';

import { makeDb, type Store } from './helpers/fakeFirestore';

const day = (offset: number) => moment().tz('Asia/Taipei').add(offset, 'days').format('YYYY-MM-DD');

let sent: { chatId: string; text: string }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    sent.push({ chatId: String(body.chat_id), text: body.text });
    return new Response('{"ok":true}', { status: 200 });
  }) as any;
  ctx.firestoreAvailable = true;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('runDividendNotifyCore', () => {
  test('今天領息：用除息日前一天的股數、含已賣出的股票、只扣匯費', async () => {
    const exDate = day(-30);
    const store: Store = new Map();
    store.set('users/u1', { telegramChatId: '111', telegramBotToken: 'T' });
    // 目前持股：鴻海除息後加碼到 5000 股；0056 已經賣光
    store.set('users/u1/stocks/2317', {
      symbol: '2317', name: '鴻海', shares: 5000,
      dividendInfo: { history: [{ date: exDate, paymentDate: day(0), amount: 1.2 }] },
    });
    store.set(`users/u1/snapshots/${day(-31)}`, {
      date: day(-31),
      stocks: [
        { symbol: '2317', name: '鴻海', shares: 3050 },
        { symbol: '0056', name: '元大高股息', shares: 1000, dividendInfo: { history: [{ date: exDate, paymentDate: day(0), amount: 0.8 }] } },
      ],
    });
    store.set(`users/u1/snapshots/${exDate}`, { date: exDate, stocks: [{ symbol: '2317', shares: 5000 }] });
    ctx.adminDb = makeDb(store);

    const r = await runDividendNotifyCore();
    assert.equal(r.success, true);
    const texts = sent.map(s => s.text).sort();
    assert.equal(sent.length, 2);
    assert.match(texts[0], /元大高股息\(0056\).*預計入帳 \$790/);   // 1000 × 0.8 − 10
    assert.match(texts[1], /鴻海\(2317\).*預計入帳 \$3,650/);       // 3050 × 1.2 − 10，不是 5000 股
    assert.ok(texts.every(t => !t.includes('估算')));
  });

  test('除息日當天或之後才買的股票，不發領息通知', async () => {
    const exDate = day(-30);
    const store: Store = new Map();
    store.set('users/u1', { telegramChatId: '111', telegramBotToken: 'T' });
    store.set('users/u1/stocks/2330', {
      symbol: '2330', shares: 1000,
      dividendInfo: { history: [{ date: exDate, paymentDate: day(0), amount: 5 }] },
    });
    store.set(`users/u1/snapshots/${day(-31)}`, { date: day(-31), stocks: [] });
    ctx.adminDb = makeDb(store);

    await runDividendNotifyCore();
    assert.equal(sent.length, 0);
  });

  test('沒有除息日前的快照：用目前持股，並在訊息註明是估算', async () => {
    const store: Store = new Map();
    store.set('users/u1', { telegramChatId: '111', telegramBotToken: 'T' });
    store.set('users/u1/stocks/2330', {
      symbol: '2330', name: '台積電', shares: 1000,
      dividendInfo: { history: [{ date: day(-30), paymentDate: day(0), amount: 5 }] },
    });
    ctx.adminDb = makeDb(store);

    await runDividendNotifyCore();
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /預計入帳 \$4,990/);
    assert.match(sent[0].text, /以目前持股估算/);
  });

  test('除息提醒只發給目前還持有的股票；同一天不重複發送', async () => {
    const store: Store = new Map();
    store.set('users/u1', { telegramChatId: '111', telegramBotToken: 'T' });
    store.set('users/u1/stocks/2330', { symbol: '2330', name: '台積電', shares: 1000, dividendInfo: { history: [{ date: day(0), amount: 5 }] } });
    store.set(`users/u1/snapshots/${day(-1)}`, {
      date: day(-1),
      stocks: [{ symbol: '0056', shares: 1000, dividendInfo: { history: [{ date: day(0), amount: 1 }] } }],
    });
    ctx.adminDb = makeDb(store);

    await runDividendNotifyCore();
    await runDividendNotifyCore();
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /台積電\(2330\) 的除息日/);
  });

  test('只用 Telegram 的使用者（telegram_chats）也套用同樣規則', async () => {
    const exDate = day(-20);
    const store: Store = new Map();
    store.set('telegram_chats/222', {
      chatId: '222', botToken: 'T',
      stocks: [{ symbol: '2317', name: '鴻海', shares: 9999, dividendInfo: { history: [{ date: exDate, paymentDate: day(0), amount: 1 }] } }],
    });
    store.set(`telegram_chats/222/snapshots/${day(-21)}`, { date: day(-21), stocks: [{ symbol: '2317', shares: 2000 }] });
    ctx.adminDb = makeDb(store);

    await runDividendNotifyCore();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, '222');
    assert.match(sent[0].text, /預計入帳 \$1,990/);
  });
});
