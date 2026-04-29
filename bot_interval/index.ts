import "dotenv/config";
import { Collection, Db } from "mongodb";
import type { TrailingStopConfig } from "../type.js";
import { API_KEY, SECRET } from "../const.js";
import { publicMethods, privateMethods } from "../indodax.js";

let trailingWorkerRunning = false;

export async function startTrailingStopWorker(db: Db, trailingStopsCollection: Collection<TrailingStopConfig>) {

  if (trailingWorkerRunning) return;
  trailingWorkerRunning = true;

  console.error("[Trailing Worker] Memulai pemantauan Trailing Stop (Native API)...");

  setInterval(async () => {
    try {
      if (!trailingStopsCollection) return; // Menunggu koneksi DB siap

      const stops = await trailingStopsCollection.find({}).toArray();
      if (stops.length === 0) return;

      const uniqueSymbols = [...new Set(stops.map(s => s.symbol))];
      const prices: Record<string, number> = {};

      // Fetch prices using native Public API
      for (const symbol of uniqueSymbols) {
        try {
          const data = await publicMethods.ticker?.({ pair_id: symbol });
          if (data && data.ticker && data.ticker.last) {
            prices[symbol] = parseFloat(data.ticker.last);
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

        // Cek aktivasi
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
            // Update harga tertinggi
            if (stop.highestPrice === undefined || currentPrice > stop.highestPrice) {
              stop.highestPrice = currentPrice;
              changed = true;
            }
            
            // Hitung trigger sell
            const triggerPrice = stop.highestPrice * (1 - (stop.trailingPercentage / 100));
            if (currentPrice <= triggerPrice) {
              console.error(`[Trailing Worker] EXECUTED SELL untuk ID ${stop.id} di ${currentPrice} (Highest: ${stop.highestPrice}, Drop: ${stop.trailingPercentage}%)`);
              try {
                // Indodax native trade: sell market menggunakan btc (jumlah coin)
                const coin = stop.symbol.split('_')[0]?.toLowerCase();
                if (coin) {
                  await privateMethods.trade?.(API_KEY, SECRET, {
                    pair: stop.symbol,
                    type: 'sell',
                    order_type: 'market',
                    [coin]: stop.amount 
                  });
                  console.error(`[Trailing Worker] ORDER BERHASIL: SELL ${stop.amount} ${stop.symbol}`);
                  executed = true;
                  changed = true;
                }
              } catch (e: any) {
                console.error(`[Trailing Worker] ORDER GAGAL SELL:`, e.message);
              }
            }
          } else if (stop.side === 'buy') {
            // Update harga terendah
            if (stop.lowestPrice === undefined || currentPrice < stop.lowestPrice) {
              stop.lowestPrice = currentPrice;
              changed = true;
            }
            
            // Hitung trigger buy
            const triggerPrice = stop.lowestPrice * (1 + (stop.trailingPercentage / 100));
            if (currentPrice >= triggerPrice) {
              console.error(`[Trailing Worker] EXECUTED BUY untuk ID ${stop.id} di ${currentPrice} (Lowest: ${stop.lowestPrice}, Rise: ${stop.trailingPercentage}%)`);
              try {
                // Indodax native trade: buy market biasanya menggunakan idr (rupiah)
                await privateMethods.trade?.(API_KEY, SECRET, {
                  pair: stop.symbol,
                  type: 'buy',
                  order_type: 'market',
                  idr: stop.amount 
                });
                console.error(`[Trailing Worker] ORDER BERHASIL: BUY dengan IDR ${stop.amount} pada ${stop.symbol}`);
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