import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import crypto from "crypto";
import { MongoClient, Db, Collection } from "mongodb";
import type { TrailingStopConfig } from "./type.js";
import { startTrailingStopWorker } from "./bot_interval/index.js";
import { API_KEY, DB_NAME, MONGO_URI, SECRET } from "./const.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { publicMethods, privateMethods } from "./indodax.js";

// Redirect all console logs to stderr so they don't break the MCP stdio protocol
console.log = console.error;
console.info = console.error;
console.warn = console.error;

let db: Db;
let trailingStopsCollection: Collection<TrailingStopConfig>;



async function connectMongo() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    trailingStopsCollection = db.collection<TrailingStopConfig>("trailing_stops");
    
    // Pastikan index unique pada 'id'
    await trailingStopsCollection.createIndex({ id: 1 }, { unique: true });
    console.error("[MongoDB] Terhubung ke database dengan sukses.");
  } catch (err) {
    console.error("[MongoDB] Gagal terhubung:", err);
    throw err;
  }
}
// --------------------------------------

function registerTools(server: McpServer) {
  server.registerTool('indodax', {
    title: 'Indodax Open API',
    description: [
      'Mengakses Indodax melalui Open API resmi (tanpa CCXT).',
      '',
      'Public methods (tidak perlu API key):',
      '  server_time, pairs, price_increments, summaries,',
      '  ticker, ticker_all, trades, depth, ohlc_history',
      '',
      'Private methods (perlu API key):',
      '  getInfo, transHistory, trade, tradeHistory,',
      '  openOrders, orderHistory, getOrder, getOrderByClientOrderId,',
      '  cancelOrder, cancelByClientOrderId, withdrawFee, withdrawCoin',
      '',
      'Contoh params untuk ticker: { "pair_id": "btcidr" }',
      'Contoh params untuk trade: { "pair": "btc_idr", "type": "buy", "price": 1500000000, "idr": 50000, "order_type": "limit" }',
    ].join('\n'),
    inputSchema: {
      method: z.string().describe("Nama method yang ingin dipanggil, contoh: 'ticker', 'getInfo', 'trade'"),
      params: z.record(z.string(), z.any()).optional().describe("Parameter tambahan sebagai object, contoh: { \"pair_id\": \"btcidr\" }"),
    },
  }, async ({ method, params }) => {
    try {
      let data: any;

      if (method in publicMethods) {
        data = await publicMethods[method]?.(params);
      } else if (method in privateMethods) {
        data = await privateMethods[method]?.(API_KEY, SECRET, params);
      } else {
        return {
          content: [{ type: "text", text: `Method '${method}' tidak ditemukan.\n\nPublic: ${Object.keys(publicMethods).join(', ')}\nPrivate: ${Object.keys(privateMethods).join(', ')}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Indodax API Error: ${error.message}` }],
        isError: true,
      };
    }
  });

  server.registerTool('manage_trailing_stop', {
    title: 'Manage Trailing Stop',
    description: 'Membuat, melihat, atau menghapus order trailing stop otomatis yang berjalan di background.',
    inputSchema: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('create'),
        payload: z.object({
          symbol: z.string().describe("Pair koin (contoh: 'BTC/IDR')"),
          side: z.enum(['buy', 'sell']).describe("Aksi: 'buy' atau 'sell'"),
          amount: z.number().describe("Jumlah aset yang akan dibeli/dijual"),
          trailingPercentage: z.number().describe("Jarak persentase trailing (contoh: 2 untuk 2%)"),
          activationPrice: z.number().optional().describe("Harga aktivasi untuk memulai trailing (opsional, jika kosong langsung aktif)"),
        })
      }),
      z.object({
        action: z.literal('list'),
        payload: z.object({}).optional() // Empty payload required by schema
      }),
      z.object({
        action: z.literal('delete'),
        payload: z.object({
          id: z.string().describe("ID dari trailing stop yang ingin dihapus")
        })
      })
    ])
  }, async ({ action, payload }) => {
    try {
      if (!trailingStopsCollection) {
         return { content: [{ type: "text", text: "Database belum siap." }], isError: true };
      }

      if (action === 'create') {
        const id = crypto.randomUUID();
        const newStop: TrailingStopConfig = {
          id,
          symbol: payload.symbol,
          side: payload.side,
          amount: payload.amount,
          trailingPercentage: payload.trailingPercentage,
          ...(payload.activationPrice !== undefined ? { activationPrice: payload.activationPrice } : {}),
          active: payload.activationPrice === undefined,
        };
        
        await trailingStopsCollection.insertOne(newStop as any);
        
        return {
          content: [{ type: "text", text: `Trailing Stop berhasil dibuat dengan ID: ${id}\n\nDetail:\n${JSON.stringify({ ...newStop }, null, 2)}` }]
        };
      }

      if (action === 'list') {
        const stops = await trailingStopsCollection.find({}).toArray();
        const safeStops = stops.map(s => {
          const { _id, ...rest } = s as any;
          return { ...rest };
        });
        return {
          content: [{ type: "text", text: safeStops.length > 0 ? JSON.stringify(safeStops, null, 2) : "Tidak ada trailing stop aktif." }]
        };
      }

      if (action === 'delete') {
        const result = await trailingStopsCollection.deleteOne({ id: payload.id });
        if (result.deletedCount === 0) {
          return { content: [{ type: "text", text: `Error: Trailing stop dengan ID ${payload.id} tidak ditemukan.` }], isError: true };
        }
        return {
          content: [{ type: "text", text: `Trailing stop dengan ID ${payload.id} berhasil dihapus dari database.` }]
        };
      }

      return { content: [{ type: "text", text: "Invalid action" }], isError: true };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  });
}

function createMcpServer() {
  const server = new McpServer(
    {
      title: "Local MCP Server",
      name: "local-mcp-server",
      version: "1.0.0",
      description: "A simple Local MCP Server"
    },
    { capabilities: { tools: {} } }
  );

  registerTools(server);

  return server;
}

async function main() {
  try {
    await connectMongo();

    if (process.env.RUN_INTERVAL === 'true') startTrailingStopWorker(db, trailingStopsCollection);
    
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    
    await server.connect(transport);
    console.error("[MCP] Server running on stdio");
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

main();