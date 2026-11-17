// 前端的防呆檢查（直接檢查原始碼）：
// 更新股息資料時不可順便寫回股數，否則「全部更新」執行期間的買賣會被舊股數蓋掉。
// 2026-11-16 實際發生：賣出日月光 200 股後，開 App 時的自動更新把股數寫回 1400。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('更新股息資料（dividendInfo: info）的 setDoc 不可寫入目前持股的股數', () => {
  const src = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf-8');
  const blocks = src.split('await setDoc(').slice(1).map(b => b.slice(0, b.indexOf('});') + 3));
  const refreshWrites = blocks.filter(b => b.includes('dividendInfo: info'));
  assert.ok(refreshWrites.length >= 2, `預期至少 2 個股息更新寫入（單檔、全部），實際 ${refreshWrites.length}`);
  for (const b of refreshWrites) {
    assert.doesNotMatch(b, /shares:\s*(stock|existingStock)/, `股息更新不可寫入股數：\n${b}`);
  }
});

// 手機從背景切回來時畫面上的股數可能還是舊的（Firestore 尚未重連），
// 記錄買賣與復原必須以雲端最新的股數 / 交易紀錄計算，不可直接用畫面上的 stocks。
test('記錄買賣、復原交易以 runTransaction 讀取雲端最新資料', () => {
  const src = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf-8');
  for (const fn of ['const handleRecordTrade', 'const handleUndoLastTrade']) {
    const start = src.indexOf(fn);
    assert.ok(start >= 0, `找不到 ${fn}`);
    const body = src.slice(start, src.indexOf('\n  };\n', start));
    assert.match(body, /runTransaction\(db/, `${fn} 必須用 runTransaction 讀雲端最新資料`);
    assert.doesNotMatch(body, /await setDoc\(/, `${fn} 不可直接用畫面上的資料 setDoc`);
  }
});

test('切回前景時重新向伺服器讀取持股', () => {
  const src = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf-8');
  assert.match(src, /visibilitychange/);
  assert.match(src, /getDocsFromServer\(collection\(db, 'users', user\.uid, 'stocks'\)\)/);
});
