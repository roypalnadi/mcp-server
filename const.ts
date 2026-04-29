import "dotenv/config";

export const MONGO_URI = process.env.MONGO_URI || "";
export const DB_NAME = "mcp_trailing_stop_db";
export const API_KEY = process.env.API_KEY || "";
export const SECRET = process.env.SECRET || "";