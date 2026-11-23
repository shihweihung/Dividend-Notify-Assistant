// Firestore 健康檢查：冷啟動慢不可把資料庫標成不能用
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctx, checkFirestoreHealth } from '../server/context';

const fakeDb = (get: () => Promise<any>) => ({ collection: () => ({ limit: () => ({ get }) }) });

test('查詢比逾時慢：先回 false，但 firestoreAvailable 不設成 false，查完變 true', async () => {
  let finish!: () => void;
  ctx.firestoreAvailable = null;
  ctx.adminDb = fakeDb(() => new Promise(r => { finish = () => r({}); }));
  assert.equal(await checkFirestoreHealth(10), false);
  assert.equal(ctx.firestoreAvailable, null);
  finish();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(ctx.firestoreAvailable, true);
});

test('真的出錯才標成不能用', async () => {
  ctx.firestoreAvailable = null;
  ctx.adminDb = fakeDb(() => Promise.reject(new Error('PERMISSION_DENIED')));
  assert.equal(await checkFirestoreHealth(1000), false);
  assert.equal(ctx.firestoreAvailable, false);
});
