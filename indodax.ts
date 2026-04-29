import crypto from "crypto";
import { URLSearchParams } from "url";

const PUBLIC_BASE = "https://indodax.com";
const PRIVATE_BASE = "https://indodax.com/tapi";

// ─── Public API ───────────────────────────────────────────────────────────────

export async function publicRequest(path: string): Promise<any> {
  const res = await fetch(`${PUBLIC_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

export const publicMethods: Record<string, (params?: any) => Promise<any>> = {
  /** Server time */
  server_time: () => publicRequest("/api/server_time"),
  /** All available pairs */
  pairs: () => publicRequest("/api/pairs"),
  /** Price increments */
  price_increments: () => publicRequest("/api/price_increments"),
  /** Market summaries */
  summaries: () => publicRequest("/api/summaries"),
  /** Ticker for a specific pair, e.g. btcidr */
  ticker: ({ pair_id = "btcidr" } = {}) => publicRequest(`/api/ticker/${pair_id}`),
  /** All tickers */
  ticker_all: () => publicRequest("/api/ticker_all"),
  /** Recent trades for a pair */
  trades: ({ pair_id = "btcidr" } = {}) => publicRequest(`/api/trades/${pair_id}`),
  /** Order book depth for a pair */
  depth: ({ pair_id = "btcidr" } = {}) => publicRequest(`/api/depth/${pair_id}`),
  /** OHLC chart history */
  ohlc_history: ({ symbol = "BTCIDR", tf = "15", from, to }: { symbol?: string; tf?: string; from: number; to: number }) =>
    publicRequest(`/tradingview/history_v2?symbol=${symbol}&tf=${tf}&from=${from}&to=${to}`),
};

// ─── Private API ──────────────────────────────────────────────────────────────

export async function privateRequest(
  apiKey: string,
  secretKey: string,
  method: string,
  params: Record<string, any> = {}
): Promise<any> {
  const body: Record<string, any> = {
    method,
    timestamp: Date.now(),
    recvWindow: 5000,
    ...params,
  };

  const queryString = new URLSearchParams(
    Object.entries(body).map(([k, v]) => [k, String(v)])
  ).toString();

  const sign = crypto
    .createHmac("sha512", secretKey)
    .update(queryString)
    .digest("hex");

  const res = await fetch(PRIVATE_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Key: apiKey,
      Sign: sign,
    },
    body: queryString,
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();
  if (data.success === 0) {
    throw new Error(data.error || "Indodax Private API error");
  }
  return data.return;
}

export const privateMethods: Record<
  string,
  (apiKey: string, secretKey: string, params?: any) => Promise<any>
> = {
  /** Get account info & balances */
  getInfo: (k, s) => privateRequest(k, s, "getInfo"),

  /** Deposit & withdrawal history (max 7-day range) */
  transHistory: (k, s, p) => privateRequest(k, s, "transHistory", p),

  /** Place an order */
  trade: (k, s, p) => privateRequest(k, s, "trade", p),

  /** Trade history (deprecated April 7, 2026 → use /api/v2/myTrades) */
  tradeHistory: (k, s, p) => privateRequest(k, s, "tradeHistory", p),

  /** List open orders (optionally filter by pair) */
  openOrders: (k, s, p) => privateRequest(k, s, "openOrders", p),

  /** Order history for a pair */
  orderHistory: (k, s, p) => privateRequest(k, s, "orderHistory", p),

  /** Get a specific order by ID */
  getOrder: (k, s, p) => privateRequest(k, s, "getOrder", p),

  /** Get order by client_order_id */
  getOrderByClientOrderId: (k, s, p) => privateRequest(k, s, "getOrderByClientOrderId", p),

  /** Cancel an open order */
  cancelOrder: (k, s, p) => privateRequest(k, s, "cancelOrder", p),

  /** Cancel by client_order_id */
  cancelByClientOrderId: (k, s, p) => privateRequest(k, s, "cancelByClientOrderId", p),

  /** Withdraw fee info */
  withdrawFee: (k, s, p) => privateRequest(k, s, "withdrawFee", p),

  /** Withdraw coin */
  withdrawCoin: (k, s, p) => privateRequest(k, s, "withdrawCoin", p),
};
