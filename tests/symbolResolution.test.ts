import { resolveSymbolFromName, mergeAndValidateStocks } from '../server.js';

function assertEqual(actual: any, expected: any, testName: string) {
  if (actual === expected) {
    console.log(`✅ [PASS] ${testName}`);
  } else {
    console.error(`❌ [FAIL] ${testName}: Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  }
}

function assertCloseTo(actual: number, expected: number, delta: number, testName: string) {
  if (Math.abs(actual - expected) <= delta) {
    console.log(`✅ [PASS] ${testName}`);
  } else {
    console.error(`❌ [FAIL] ${testName}: Expected ${expected} ± ${delta}, got ${actual}`);
    process.exitCode = 1;
  }
}

console.log("=== Running Symbol Resolution Unit Tests ===");

// 1. name='國泰台灣科技龍頭', symbol='00881' -> '00881'
assertEqual(
  resolveSymbolFromName('00881', '國泰台灣科技龍頭'),
  '00881',
  "Test 1: Normal matching symbol"
);

// 2. name='國泰台灣科技龍頭', symbol='00878' -> '00881' (Name map takes precedence)
assertEqual(
  resolveSymbolFromName('00878', '國泰台灣科技龍頭'),
  '00881',
  "Test 2: Name map precedence over incorrect Gemini symbol"
);

// 3. name='台新新光金', symbol='2888' -> '2887'
assertEqual(
  resolveSymbolFromName('2888', '台新新光金'),
  '2887',
  "Test 3: Shin Kong / Taishin merger symbol override to 2887"
);

// 4. name='中信美國公債20年', symbol='00795' -> '00795B'
assertEqual(
  resolveSymbolFromName('00795', '中信美國公債20年'),
  '00795B',
  "Test 4: Bond ETF suffix correction to 00795B"
);

// 5. name='國泰', symbol='' -> null
assertEqual(
  resolveSymbolFromName('', '國泰'),
  null,
  "Test 5: Incomplete name without exact match returns null"
);

// 6. name='某某新上市股', symbol='6666' -> '6666'
assertEqual(
  resolveSymbolFromName('6666', '某某新上市股'),
  '6666',
  "Test 6: Fallback to valid stock code when name not in map"
);

// 7. name='', symbol='' -> null
assertEqual(
  resolveSymbolFromName('', ''),
  null,
  "Test 7: Empty symbol and name returns null"
);

// 8. Deduplication / Merging test for Hon Hai (鴻海)
console.log("\n=== Running Stock Merging Unit Test ===");
const honHaiList = [
  { symbol: '2317', name: '鴻海', shares: 2000, cost: 195.94, totalCost: 391880 },
  { symbol: '2317', name: '鴻海', shares: 1050, cost: 188.25, totalCost: 197662.5 }
];

const merged = mergeAndValidateStocks(honHaiList);
assertEqual(merged.parsedStocks.length, 1, "Test 8a: Single merged entry created");
assertEqual(merged.parsedStocks[0].symbol, '2317', "Test 8b: Symbol is 2317");
assertEqual(merged.parsedStocks[0].shares, 3050, "Test 8c: Shares summed to 3050");
assertCloseTo(merged.parsedStocks[0].cost!, 193.29, 0.01, "Test 8d: Weighted average cost is ~193.29");

if (process.exitCode === 1) {
  console.error("\n❌ Some tests failed.");
  process.exit(1);
} else {
  console.log("\n🎉 All unit tests passed successfully!");
}
