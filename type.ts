export interface TrailingStopConfig {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  amount: number;
  trailingPercentage: number;
  activationPrice?: number;
  highestPrice?: number;
  lowestPrice?: number;
  apiKey: string;
  secret: string;
  active: boolean;
}