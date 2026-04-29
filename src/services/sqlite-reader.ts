import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { logDebug, logWarn } from "../utils/logger";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Minimal interface for sql.js Database (we don't rely on @types/sql.js). */
interface SqlJsDatabase {
  prepare(sql: string): SqlJsStatement;
  close(): void;
}

interface SqlJsStatement {
  bind(params?: any[]): boolean;
  step(): boolean;
  get(): any[];
  getAsObject(): Record<string, unknown>;
  free(): void;
}

let sqlJsPromise: Promise<any> | null = null;

/**
 * Lazy singleton that initialises sql.js once per process.
 * The WASM binary is expected at dist/sql-wasm.wasm (copied by esbuild.config.cjs).
 */
async function getSqlJs(): Promise<any> {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      const initSqlJs = require("sql.js");
      const wasmPath = path.join(__dirname, "sql-wasm.wasm");
      const wasmBinary = await fs.readFile(wasmPath);
      logDebug(`SqliteReader: initialising sql.js from ${wasmPath}`);
      return initSqlJs({ wasmBinary });
    })();
  }
  return sqlJsPromise;
}

/**
 * Opens a SQLite database file and runs queries against it.
 * The database is loaded fully into memory, then kept open until close() is called.
 */
export class SqliteReader {
  private db: SqlJsDatabase | null = null;
  private loadPromise: Promise<SqlJsDatabase | null> | null = null;

  constructor(private readonly dbPath: string) {}

  private load(): Promise<SqlJsDatabase | null> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        const SQL = await getSqlJs();
        const buffer = await fs.readFile(this.dbPath);
        const db = new SQL.Database(buffer) as SqlJsDatabase;
        logDebug(`SqliteReader: opened ${path.basename(this.dbPath)} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
        this.db = db;
        return db;
      } catch (e) {
        logWarn(`SqliteReader: failed to open ${this.dbPath}: ${e instanceof Error ? e.message : e}`);
        return null;
      }
    })();
    return this.loadPromise;
  }

  /** Returns the first column of the first row, or null if no rows / error. */
  async querySingle(sql: string, params?: (string | number | null)[]): Promise<string | null> {
    const db = await this.load();
    if (!db) return null;
    try {
      const stmt = db.prepare(sql);
      if (params) stmt.bind(params);
      if (!stmt.step()) { stmt.free(); return null; }
      const row = stmt.get();
      stmt.free();
      const val = row[0];
      return val != null ? String(val) : null;
    } catch (e) {
      logWarn(`SqliteReader.querySingle failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Returns all rows as key→value string objects. */
  async queryRows(sql: string, params?: (string | number | null)[]): Promise<Record<string, string>[]> {
    const db = await this.load();
    if (!db) return [];
    try {
      const stmt = db.prepare(sql);
      if (params) stmt.bind(params);
      const rows: Record<string, string>[] = [];
      while (stmt.step()) {
        const obj = stmt.getAsObject();
        const row: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj)) {
          row[k] = v != null ? String(v) : "";
        }
        rows.push(row);
      }
      stmt.free();
      return rows;
    } catch (e) {
      logWarn(`SqliteReader.queryRows failed: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** Releases the in-memory database. */
  close(): void {
    this.db?.close();
    this.db = null;
    this.loadPromise = null;
  }
}

/** Returns true if sql.js WASM binary is present in the dist directory. */
export function isSqlJsAvailable(): boolean {
  try {
    return existsSync(path.join(__dirname, "sql-wasm.wasm"));
  } catch {
    return false;
  }
}
