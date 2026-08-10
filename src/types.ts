export type EtfComponent = {
  name: string;
  symbol?: string;
  code?: string;
  weight: number | string; // percentage
}

export type DividendInfo = {
  symbol: string;
  name: string;
  exDividendDate: string; // YYYY-MM-DD
  paymentDate: string;    // YYYY-MM-DD
  amount: number; // Next/Latest single payment amount
  receivedAmountCurrentYear?: number; // Sum of dividends already paid in current year
  pendingAmountCurrentYear?: number; // Sum of dividends announced but not yet paid in current year
  monthlyDistribution?: number[]; // Array of 12 numbers representing received dividend amount per share for each month
  pendingMonthlyDistribution?: number[]; // Array of 12 numbers representing pending dividend amount per share for each month
  currentPrice?: number;
  yield?: number;
  updatedAt: string;
  isEtf?: boolean;
  topComponents?: EtfComponent[];
  etfComponents?: EtfComponent[];
  etfComponentsUpdatedAt?: string;
  source?: string;
  sourceUrl?: string;
  isPaymentDateEstimated?: boolean;
  status?: string;
  history?: any[];
}

export type StockEntry = {
  symbol: string;
  name: string;
  shares: number;
  cost?: number; // Average purchase price per share
  sellPrice?: number; // Selling price per share for realized profit calculation
  soldShares?: number; // Shares sold when cleared
  dividendInfo?: DividendInfo;
}

export type CalendarEvent = {
  date: Date;
  type: 'ex-dividend' | 'payment';
  stockName: string;
  symbol: string;
  amount?: number;
}
