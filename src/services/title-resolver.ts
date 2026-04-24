import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const home = process.env.HOME ?? "";

function resolveDbPath(): string | null {
  const candidates =
    process.platform === "darwin"
      ? [path.join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb")]
      : [
          path.join(home, ".config/Cursor/User/globalStorage/state.vscdb"),
          path.join(home, ".cursor-server/data/User/globalStorage/state.vscdb"),
        ];

  for (const p of candidates) {
    if (existsSync(p)) { return p; }
  }
  return null;
}

let dbPath: string | null | undefined;
let sqlite3Available: boolean | undefined;

function checkSqlite3(): boolean {
  if (sqlite3Available !== undefined) { return sqlite3Available; }
  try {
    execFileSync("sqlite3", ["--version"], { encoding: "utf8", timeout: 2000, stdio: "pipe" });
    sqlite3Available = true;
  } catch {
    sqlite3Available = false;
  }
  return sqlite3Available;
}

function getDbPath(): string | null {
  if (dbPath !== undefined) { return dbPath; }
  dbPath = resolveDbPath();
  return dbPath;
}

const titleCache = new Map<string, string | null>();

/**
 * Reads the AI-generated conversation title from Cursor's internal SQLite DB.
 * Returns null when:
 *   - Running in Remote-SSH where the DB doesn't exist
 *   - sqlite3 is not installed
 *   - Session has no title (old conversations)
 */
export function getCursorTitle(sessionId: string): string | null {
  const cached = titleCache.get(sessionId);
  if (cached !== undefined) { return cached; }

  const db = getDbPath();
  if (!db || !checkSqlite3()) {
    titleCache.set(sessionId, null);
    return null;
  }

  try {
    const raw = execFileSync("sqlite3", [
      db,
      `SELECT value FROM cursorDiskKV WHERE key='composerData:${sessionId}';`
    ], { encoding: "utf8", timeout: 3000, stdio: "pipe" });

    if (!raw.trim()) {
      titleCache.set(sessionId, null);
      return null;
    }

    const obj = JSON.parse(raw.trim());
    const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : null;
    titleCache.set(sessionId, name);
    return name;
  } catch {
    titleCache.set(sessionId, null);
    return null;
  }
}
