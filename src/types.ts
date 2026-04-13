export type EtfComponent = {
  name: string;
  symbol: string;
  weight: number; // percentage
}

export type DividendInfo = {
  symbol: string;
  name: string;
  exDividendDate: string; // YYYY-MM-DD
  paymentDate: string;    // YYYY-MM-DD
  amount: number; // Next/Latest single payment amount
  receivedAmountCurrentYear?: number; // Sum of dividends already paid in current year
  pendingAmountCurrentYear?: number; // Sum of dividends announced but not yet paid in current year
  monthlyDistribution?: number[]; // Array of 12 numbers representing dividend amount per share for each month
  currentPrice?: number;
  yield?: number;
  updatedAt: string;
  isEtf?: boolean;
  topComponents?: EtfComponent[];
  source?: string;
  sourceUrl?: string;
}

export type StockEntry = {
  symbol: string;
  name: string;
  shares: number;
  dividendInfo?: DividendInfo;
  manualDividendAdjustment?: number | null;
}

export type CalendarEvent = {
  date: Date;
  type: 'ex-dividend' | 'payment';
  stockName: string;
  symbol: string;
  amount?: number;
}
