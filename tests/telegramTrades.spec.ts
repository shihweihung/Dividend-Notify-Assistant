// Telegram 記帳流程：確認卡 → 按確認才寫入；寫入用最新股數；取消不寫；別的聊天室不能按
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ctx } from '../server/context';
import { handleTradeText, handleTradeCallback } from '../server/services/telegramTrades';

// ---- 極簡 Firestore 假物件（只實作這個流程用到的方法） ----
type Store = Map<string, any>;
function fakeDb(store: Store) {
  let auto = 0;
  const docRef = (path: string): any => ({
    id: path.split('/').pop(),
    path,
    get: async () => snap(path),
    set: async (data: any, opts?: any) => { store.set(path, opts?.merge ? { ...(store.get(path) || {}), ...data } : data); },
    delete: async () => { store.delete(path); },
    collection: (name: string) => colRef(`${path}/${name}`),
  });
  const snap = (path: string) => ({ exists: store.has(path), id: path.split('/').pop(), data: () => store.get(path) });
  const colRef = (path: string): any => ({
    doc: (id?: string) => docRef(`${path}/${id ?? `auto${++auto}`}`),
    get: async () => {
      const docs = [...store.keys()].filter(k => k.startsWith(path + '/') && k.split('/').length === path.split('/').length + 1).map(snap);
      return { empty: docs.length === 0, docs };
    },
    where: (field: string, _op: string, value: any) => ({
      limit: () => ({
        get: async () => {
          const docs = [...store.keys()].filter(k => k.startsWith(path + '/') && k.split('/').length === path.split('/').length + 1 && store.get(k)?.[field] === value).map(snap);
          return { empty: docs.length === 0, docs };
        },
      }),
    }),
  });
  return {
    collection: (name: string) => colRef(name),
    runTransaction: async (fn: any) => {
      const writes: (() => void)[] = [];
      const tx = {
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => writes.push(() => store.set(ref.path, opts?.merge ? { ...(store.get(ref.path) || {}), ...data } : data)),
        delete: (ref: any) => writes.push(() => store.delete(ref.path)),
      };
      const result = await fn(tx);
      writes.forEach(w => w());
      return result;
    },
  };
}

// ---- 攔截 Telegram API ----
let sent: { method: string; body: any }[] = [];
(globalThis as any).fetch = async (url: string, init: any) => {
  sent.push({ method: String(url).split('/').pop()!, body: JSON.parse(init.body) });
  return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
};

const UID = 'u1';
const CHAT = '999';
let store: Store;

function lastButtons() {
  const m = [...sent].reverse().find(s => s.body.reply_markup);
  return m!.body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data) as string[];
}
const press = (data: string, chatId = CHAT) =>
  handleTradeCallback('TOKEN', { id: 'cq', data, message: { chat: { id: Number(chatId) }, message_id: 1, text: 'card' } });

beforeEach(() => {
  sent = [];
  store = new Map();
  store.set(`users/${UID}`, { telegramChatId: CHAT });
  store.set(`users/${UID}/stocks/3711`, { symbol: '3711', name: '日月光投控', shares: 1200, cost: 148, trades: [] });
  ctx.adminDb = fakeDb(store);
  ctx.firestoreAvailable = true;
});

describe('Telegram 記帳', () => {
  test('一般聊天不攔截', async () => {
    assert.equal(await handleTradeText('TOKEN', CHAT, '我的資產配置如何'), false);
  });

  test('送出指令只產生確認卡，不寫入股數', async () => {
    assert.equal(await handleTradeText('TOKEN', CHAT, '賣 日月光 200 178'), true);
    assert.equal(store.get(`users/${UID}/stocks/3711`).shares, 1200);
    const card = sent.find(s => s.body.reply_markup)!.body.text as string;
    assert.match(card, /賣出 日月光投控（3711）/);
    assert.match(card, /1,200 → 1,000/);
  });

  test('按確認後寫入，費用與股數用 shared/trades 計算', async () => {
    await handleTradeText('TOKEN', CHAT, '賣 日月光 200 178');
    await press(lastButtons()[0]);
    const doc = store.get(`users/${UID}/stocks/3711`);
    assert.equal(doc.shares, 1000);
    assert.equal(doc.cost, 148);
    assert.equal(doc.trades.length, 1);
    assert.equal(doc.trades[0].tax, Math.floor(200 * 178 * 0.003));
    assert.equal([...store.keys()].some(k => k.startsWith('pending_trades/')), false);
  });

  test('確認時以雲端最新股數計算（期間在網頁上又賣了 1000 股）', async () => {
    await handleTradeText('TOKEN', CHAT, '賣 日月光 200 178');
    store.set(`users/${UID}/stocks/3711`, { ...store.get(`users/${UID}/stocks/3711`), shares: 100 });
    await press(lastButtons()[0]);
    assert.equal(store.get(`users/${UID}/stocks/3711`).shares, 100); // 超賣被擋，不寫入
    assert.match(sent.at(-1)!.body.text, /超過目前持股/);
  });

  test('按取消不寫入；同一張卡不能按兩次', async () => {
    await handleTradeText('TOKEN', CHAT, '買 日月光 1000 170');
    const [ok, no] = lastButtons();
    await press(no);
    assert.equal(store.get(`users/${UID}/stocks/3711`).shares, 1200);
    await press(ok);
    assert.equal(store.get(`users/${UID}/stocks/3711`).shares, 1200);
  });

  test('別的聊天室不能按這張卡', async () => {
    await handleTradeText('TOKEN', CHAT, '買 日月光 1000 170');
    await press(lastButtons()[0], '123');
    assert.equal(store.get(`users/${UID}/stocks/3711`).shares, 1200);
  });

  test('買進新股票會建立持股', async () => {
    await handleTradeText('TOKEN', CHAT, '買 2317 1000 200');
    await press(lastButtons()[0]);
    const doc = store.get(`users/${UID}/stocks/2317`);
    assert.equal(doc.shares, 1000);
    assert.equal(doc.symbol, '2317');
  });

  test('復原最後一筆', async () => {
    await handleTradeText('TOKEN', CHAT, '賣 日月光 200 178');
    await press(lastButtons()[0]);
    await handleTradeText('TOKEN', CHAT, '復原 日月光');
    await press(lastButtons()[0]);
    const doc = store.get(`users/${UID}/stocks/3711`);
    assert.equal(doc.shares, 1200);
    assert.equal(doc.trades.length, 0);
  });

  test('沒連結帳號的聊天室不寫入', async () => {
    assert.equal(await handleTradeText('TOKEN', '555', '買 2330 1000 1050'), true);
    assert.match(sent.at(-1)!.body.text, /還沒有連結/);
  });
});

describe('Telegram 記帳：找帳號', () => {
  test('同一個 Chat ID 有兩個帳號時，以網頁最近同步的 uid 為準', async () => {
    store.set('users/u2', { telegramChatId: CHAT });
    store.set('users/u2/stocks/3711', { symbol: '3711', name: '日月光投控', shares: 5000, cost: 150, trades: [] });
    store.set(`telegram_chats/${CHAT}`, { uid: UID });
    await handleTradeText('TOKEN', CHAT, '賣 日月光 200 178');
    await press(lastButtons()[0]);
    assert.equal(store.get(`users/${UID}/stocks/3711`).shares, 1000);
    assert.equal(store.get('users/u2/stocks/3711').shares, 5000);
  });

  test('兩個帳號又沒有同步紀錄時不猜、不寫入', async () => {
    store.set('users/u2', { telegramChatId: CHAT });
    await handleTradeText('TOKEN', CHAT, '賣 日月光 200 178');
    assert.match(sent.at(-1)!.body.text, /不只一個/);
    assert.equal([...store.keys()].some(k => k.startsWith('pending_trades/')), false);
  });
});
