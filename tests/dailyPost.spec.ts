// 舒洪道貼文：手動要求只處理本人，排程才會掃全部使用者
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ctx } from '../server/context';
import { generateDailyPostCore } from '../server/services/dailyPost';
import { makeDb, type Store } from './helpers/fakeFirestore';

const envBackup = { ...process.env };
beforeEach(() => {
  // 不給 Gemini 金鑰：不會真的呼叫 AI，只驗證「處理了誰」
  delete process.env.GEMINI_API_KEY;
  delete process.env.CUSTOM_GEMINI_API_KEY;
  ctx.firestoreAvailable = true;
  const store: Store = new Map();
  store.set('users/me', { telegramChatId: '111', telegramBotToken: 'T' });
  store.set('users/me/stocks/2330', { symbol: '2330', shares: 1000 });
  store.set('users/mom', { telegramChatId: '222', telegramBotToken: 'T' });
  store.set('users/mom/stocks/0056', { symbol: '0056', shares: 1000 });
  store.set('telegram_chats/333', { chatId: '333', botToken: 'T', stocks: [{ symbol: '2317', shares: 10 }] });
  ctx.adminDb = makeDb(store);
});
afterEach(() => { process.env = { ...envBackup }; });

describe('generateDailyPostCore', () => {
  test('網頁手動要求：只處理登入的本人', async () => {
    const r: any = await generateDailyPostCore({ onlyUserId: 'me' });
    assert.equal(r.targetFound, true);
    assert.equal(r.postsGenerated + r.postsFailed, 1);
  });

  test('Telegram /post：只處理該聊天室（含只用 Telegram 的使用者）', async () => {
    const a: any = await generateDailyPostCore({ onlyChatId: '222' });
    assert.equal(a.postsGenerated + a.postsFailed, 1);
    const b: any = await generateDailyPostCore({ onlyChatId: '333' });
    assert.equal(b.postsGenerated + b.postsFailed, 1);
  });

  test('找不到聊天室時回報 targetFound = false', async () => {
    const r: any = await generateDailyPostCore({ onlyChatId: '999' });
    assert.equal(r.targetFound, false);
  });

  test('手動要求不受試用期限制（排程則已停止）', async () => {
    const manual: any = await generateDailyPostCore({ onlyUserId: 'me' });
    assert.notEqual(manual.skipped, true);
    const scheduled: any = await generateDailyPostCore();
    assert.equal(scheduled.skipped, true);
  });
});
