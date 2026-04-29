import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import ccxt from "ccxt";
import crypto from "crypto";
import { MongoClient, Db, Collection } from "mongodb";
import type { TrailingStopConfig } from "./type.js";
import { startTrailingStopWorker } from "./bot_interval/index.js";
import { API_KEY, DB_NAME, MONGO_URI, SECRET } from "./const.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

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

const app = express();

let currentMcp: { server: McpServer, transport: StreamableHTTPServerTransport } | null = null;
let isInitialized = false;

async function setupMcp() {
  if (currentMcp) {
    try {
      await currentMcp.transport.close();
      await currentMcp.server.close();
    } catch (e) {
      // Ignore errors during cleanup
    }
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID()
  });

  await server.connect(transport as any);
  
  currentMcp = { server, transport };
  isInitialized = true;
  
  console.error("[MCP] Instance created and connected.");
  return currentMcp;
}

app.use(express.json());

// Route all MCP requests (GET for SSE, POST for messages) to the transport
app.use('/mcp', async (req: Request, res: Response) => {
  try {
    // Detect initialize request to reset the singleton if needed
    const isInitialize = req.method === 'POST' && (
      Array.isArray(req.body) 
      ? req.body.some((m: any) => m.method === 'initialize')
      : req.body?.method === 'initialize'
    );

    if (isInitialize && isInitialized) {
      console.error("[MCP] Re-initializing for new connection...");
      await setupMcp();
    } else if (!currentMcp) {
      await setupMcp();
    }

    if (currentMcp) {
      await currentMcp.transport.handleRequest(req, res, req.body);
    }
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

app.get('/', async (req, res) => {
  res.json({status: 'ok'});
});

async function main() {
  try {
    await connectMongo();
    startTrailingStopWorker(db, trailingStopsCollection);
    
    // Initial setup will happen on first request or here
    await setupMcp();
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.error(`[MCP] Server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

main();