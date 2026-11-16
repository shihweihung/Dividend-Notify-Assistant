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
  assert.ok(refreshWrites.length >= 3, `預期至少 3 個股息更新寫入，實際 ${refreshWrites.length}`);
  for (const b of refreshWrites) {
    assert.doesNotMatch(b, /shares:\s*(stock|existingStock)/, `股息更新不可寫入股數：\n${b}`);
  }
});
