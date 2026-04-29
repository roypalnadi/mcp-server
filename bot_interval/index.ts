import "dotenv/config";
import ccxt from "ccxt";
import { Collection, Db, MongoClient } from "mongodb";
import type { TrailingStopConfig } from "../type.js";
import { API_KEY, SECRET } from "../const.js";

let trailingWorkerRunning = false;
export async function startTrailingStopWorker(db: Db, trailingStopsCollection: Collection<TrailingStopConfig>) {

  if (trailingWorkerRunning) return;
  trailingWorkerRunning = true;

  const publicExchange = new ccxt.indodax({ enableRateLimit: true });
  console.error("[Trailing Worker] Memulai pemantauan Trailing Stop...");

  setInterval(async () => {
    try {
      if (!trailingStopsCollection) return; // Menunggu koneksi DB siap

      const stops = await trailingStopsCollection.find({}).toArray();
      if (stops.length === 0) return;

      const symbolsToFetch = [...new Set(stops.map(s => s.symbol))];
      const prices: Record<string, number> = {};

      for (const symbol of symbolsToFetch) {
        try {
          const ticker = await publicExchange.fetchTicker(symbol);
          if (ticker && ticker.last) {
            prices[symbol] = ticker.last;
          }
        } catch (e: any) {
          console.error(`[Trailing Worker] Gagal fetch ticker ${symbol}:`, e.message);
        }
      }

      for (const stop of stops) {
        const currentPrice = prices[stop.symbol];
        if (!currentPrice) continue;

        let executed = false;
        let changed = false;

        if (!stop.active && stop.activationPrice) {
          if ((stop.side === 'sell' && currentPrice >= stop.activationPrice) ||
              (stop.side === 'buy' && currentPrice <= stop.activationPrice)) {
            stop.active = true;
            console.error(`[Trailing Worker] ID ${stop.id} AKTIF pada harga ${currentPrice}`);
            changed = true;
          }
        }

        if (stop.active) {
          if (stop.side === 'sell') {
            if (stop.highestPrice === undefined || currentPrice > stop.highestPrice) {
              stop.highestPrice = currentPrice;
              changed = true;
            }
            const triggerPrice = stop.highestPrice * (1 - (stop.trailingPercentage / 100));
            if (currentPrice <= triggerPrice) {
              console.error(`[Trailing Worker] EXECUTED SELL untuk ID ${stop.id} di ${currentPrice} (Highest: ${stop.highestPrice}, Drop: ${stop.trailingPercentage}%)`);
              try {
                const privateExchange = new ccxt.indodax({ apiKey: API_KEY, secret: SECRET, enableRateLimit: true });
                await privateExchange.createOrder(stop.symbol, 'market', 'sell', stop.amount);
                console.error(`[Trailing Worker] ORDER BERHASIL: SELL ${stop.amount} ${stop.symbol}`);
                executed = true;
                changed = true;
              } catch (e: any) {
                console.error(`[Trailing Worker] ORDER GAGAL SELL:`, e.message);
              }
            }
          } else if (stop.side === 'buy') {
            if (stop.lowestPrice === undefined || currentPrice < stop.lowestPrice) {
              stop.lowestPrice = currentPrice;
              changed = true;
            }
            const triggerPrice = stop.lowestPrice * (1 + (stop.trailingPercentage / 100));
            if (currentPrice >= triggerPrice) {
              console.error(`[Trailing Worker] EXECUTED BUY untuk ID ${stop.id} di ${currentPrice} (Lowest: ${stop.lowestPrice}, Rise: ${stop.trailingPercentage}%)`);
              try {
                const privateExchange = new ccxt.indodax({ apiKey: API_KEY, secret: SECRET, enableRateLimit: true });
                await privateExchange.createOrder(stop.symbol, 'market', 'buy', stop.amount);
                console.error(`[Trailing Worker] ORDER BERHASIL: BUY ${stop.amount} ${stop.symbol}`);
                executed = true;
                changed = true;
              } catch (e: any) {
                console.error(`[Trailing Worker] ORDER GAGAL BUY:`, e.message);
              }
            }
          }
        }

        // Update database per stop order
        if (executed) {
          await trailingStopsCollection.deleteOne({ id: stop.id });
        } else if (changed) {
          const { _id, ...updateData } = stop as any;
          await trailingStopsCollection.updateOne({ id: stop.id }, { $set: updateData });
        }
      }

    } catch (err) {
      console.error("[Trailing Worker] Error in interval:", err);
    }
  }, 10000); // 10 detik interval pengecekan
}