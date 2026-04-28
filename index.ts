import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import z from "zod";
import ccxt from "ccxt";
import crypto from "crypto";
import { MongoClient, Db, Collection } from "mongodb";

// Redirect all console logs to stderr so they don't break the MCP stdio protocol
console.log = console.error;
console.info = console.error;
console.warn = console.error;

// --- TRAILING STOP STATE MANAGEMENT (MONGODB) ---
const MONGO_URI = process.env.MONGO_URI || "";
const DB_NAME = "mcp_trailing_stop_db";
const API_KEY = process.env.API_KEY || "";
const SECRET = process.env.SECRET || "";

let db: Db;
let trailingStopsCollection: Collection<TrailingStopConfig>;

interface TrailingStopConfig {
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
  }
}
// --------------------------------------

const server = new McpServer(
  {
    title: "Local MCP Server",
    name: "local-mcp-server",
    version: "1.0.0",
    description: "A simple Local MCP Server"
  },
  { capabilities: { tools: {} } }
);

server.registerTool('indodax-ccxt', {
  title: 'Indodax CCXT Services',
  description: 'Mengakses semua layanan Indodax menggunakan CCXT (Public & Private API). Contoh method: fetchTicker, fetchOrderBook, fetchBalance, dll.',
  inputSchema: {
    method: z.string().describe("Nama method CCXT yang ingin dipanggil (contoh: 'fetchTicker', 'fetchBalance', 'fetchOpenOrders')"),
    args: z.array(z.any()).optional().describe("Daftar argumen sesuai urutan method CCXT. Contoh untuk fetchTicker: ['BTC/IDR']"),
  },
}, async ({ method, args }) => {
  try {
    const exchange = new ccxt.indodax({
      apiKey: API_KEY,
      secret: SECRET,
      enableRateLimit: true,
      sandbox: false
    });

    if (typeof (exchange as any)[method] !== 'function') {
      return {
        content: [{ type: "text", text: `Method '${method}' tidak ditemukan atau bukan sebuah fungsi pada CCXT Indodax.` }],
        isError: true,
      };
    }

    const data = await (exchange as any)[method](...(args || []));

    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Indodax CCXT Error: ${error.message}` }],
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
        apiKey: API_KEY,
        secret: SECRET,
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



async function main() {
  await connectMongo();
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();