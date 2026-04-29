import { existsSync } from "node:fs";
import path from "node:path";
import { getUserHome } from "../utils/local-path";
import { SqliteReader, isSqlJsAvailable } from "./sqlite-reader";

function resolveDbPath(): string | null {
  const home = getUserHome();
  let candidates: string[];
  if (process.platform === "darwin") {
    candidates = [path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")];
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    candidates = [
      path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb"),
      path.join(localAppData, "cursor", "User", "globalStorage", "state.vscdb"),
      path.join(localAppData, "Cursor", "User", "globalStorage", "state.vscdb"),
    ];
  } else {
    candidates = [
      path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
      path.join(home, ".cursor-server", "data", "User", "globalStorage", "state.vscdb"),
    ];
  }
  for (const p of candidates) {
    if (existsSync(p)) { return p; }
  }
  return null;
}

const titleCache = new Map<string, string | null>();

/**
 * Reads the AI-generated conversation title from Cursor's internal SQLite DB.
 * Returns null when:
 *   - Running in Remote-SSH where the DB doesn't exist
 *   - sql.js WASM is not available
 *   - Session has no title (old conversations)
 */
export async function getCursorTitle(sessionId: string): Promise<string | null> {
  const cached = titleCache.get(sessionId);
  if (cached !== undefined) { return cached; }

  if (!isSqlJsAvailable()) {
    titleCache.set(sessionId, null);
    return null;
  }

  const db = resolveDbPath();
  if (!db) {
    titleCache.set(sessionId, null);
    return null;
  }

  const reader = new SqliteReader(db);
  try {
    const raw = await reader.querySingle(
      "SELECT value FROM cursorDiskKV WHERE key=?",
      [`composerData:${sessionId}`]
    );
    if (!raw) {
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
  } finally {
    reader.close();
  }
}
