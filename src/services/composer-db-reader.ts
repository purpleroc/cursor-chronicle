import { existsSync } from "node:fs";
import path from "node:path";
import { getUserHome } from "../utils/local-path";
import { SqliteReader, isSqlJsAvailable } from "./sqlite-reader";
import { logDebug } from "../utils/logger";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_FROM_USER_MAX = 40;

export interface ComposerMeta {
  composerId: string;
  name: string;
  createdAt: number;
  lastUpdatedAt: number;
  mode: string;
  workspacePath?: string;
  workspaceUri?: string;
  workspaceScheme?: string;
}

export interface ComposerBubble {
  type: number; // 1 = user, 2 = assistant
  text: string;
  thinking?: string;
}

function resolveDbPath(): string | null {
  const home = getUserHome();
  let candidates: string[];
  if (process.platform === "darwin") {
    candidates = [
      path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    ];
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
    ];
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export class ComposerDbReader {
  private metaCache: ComposerMeta[] | null = null;

  get available(): boolean {
    return isSqlJsAvailable() && resolveDbPath() !== null;
  }

  /** Call before the next sync cycle to force a fresh DB read. */
  invalidateCache(): void {
    this.metaCache = null;
  }

  async listAll(): Promise<ComposerMeta[]> {
    if (this.metaCache) return this.metaCache;

    const dbPath = resolveDbPath();
    if (!dbPath) {
      logDebug("ComposerDbReader.listAll: state.vscdb not found");
      return [];
    }

    const reader = new SqliteReader(dbPath);
    try {
      const raw = await reader.querySingle(
        "SELECT value FROM ItemTable WHERE key=?",
        ["composer.composerHeaders"]
      );
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      const all: any[] = parsed.allComposers ?? (Array.isArray(parsed) ? parsed : []);

      const results: ComposerMeta[] = [];
      for (const h of all) {
        if (!h.composerId || h.subagentInfo || h.isDraft) continue;

        const ws = h.workspaceIdentifier?.uri;
        let name = typeof h.name === "string" && h.name.trim() ? h.name.trim() : "";
        if (!name || name.toLowerCase() === "untitled") {
          const bubbles = await this.readBubblesViaReader(reader, h.composerId);
          const firstUser = bubbles.find((b) => b.type === 1 && b.text?.trim());
          if (!firstUser) continue;
          name = firstUser.text.replace(/\s+/g, " ").trim().slice(0, TITLE_FROM_USER_MAX);
          if (!name) continue;
        }

        results.push({
          composerId: h.composerId,
          name,
          createdAt: h.createdAt ?? 0,
          lastUpdatedAt: h.lastUpdatedAt ?? 0,
          mode: h.unifiedMode ?? h.forceMode ?? "unknown",
          workspacePath: ws?.fsPath,
          workspaceUri: ws?.external,
          workspaceScheme: ws?.scheme,
        });
      }

      this.metaCache = results;
      return results;
    } catch {
      return [];
    } finally {
      reader.close();
    }
  }

  async readBubbles(composerId: string): Promise<ComposerBubble[]> {
    if (!UUID_RE.test(composerId)) return [];
    const dbPath = resolveDbPath();
    if (!dbPath) return [];

    const reader = new SqliteReader(dbPath);
    try {
      return await this.readBubblesViaReader(reader, composerId);
    } finally {
      reader.close();
    }
  }

  /**
   * Reads bubbles using an already-open reader (avoids reopening the DB
   * when called from listAll which already holds a reader).
   */
  private async readBubblesViaReader(reader: SqliteReader, composerId: string): Promise<ComposerBubble[]> {
    if (!UUID_RE.test(composerId)) return [];

    try {
      const raw = await reader.querySingle(
        "SELECT value FROM cursorDiskKV WHERE key=?",
        [`composerData:${composerId}`]
      );
      if (!raw) return [];

      const data = JSON.parse(raw);

      if (data._v && data._v >= 9) {
        return this.readV9ViaReader(reader, composerId, data);
      }
      return this.readLegacy(data);
    } catch {
      return [];
    }
  }

  private async readV9ViaReader(reader: SqliteReader, composerId: string, data: any): Promise<ComposerBubble[]> {
    const headers: any[] = data.fullConversationHeadersOnly ?? [];
    if (headers.length === 0) return [];

    const bubbleIds = headers.map((h: any) => h.bubbleId).filter(Boolean);
    if (bubbleIds.length === 0) return [];

    // bubbleIds and composerId are UUID-validated, so string interpolation is safe here.
    const inClause = bubbleIds
      .map((id: string) => `'bubbleId:${composerId}:${id}'`)
      .join(",");

    const rows = await reader.queryRows(
      `SELECT key, value FROM cursorDiskKV WHERE key IN (${inClause})`
    );

    const byId = new Map<string, any>();
    for (const row of rows) {
      const bid = row.key.split(":").pop();
      try {
        byId.set(bid!, JSON.parse(row.value));
      } catch {
        /* skip corrupt entries */
      }
    }

    const result: ComposerBubble[] = [];
    for (const h of headers) {
      const b = byId.get(h.bubbleId);
      if (!b) continue;
      result.push({
        type: b.type ?? 0,
        text: b.text ?? "",
        thinking: typeof b.thinking === "object" ? b.thinking?.text : undefined,
      });
    }
    return result;
  }

  private readLegacy(data: any): ComposerBubble[] {
    const conv: any[] = data.conversation ?? [];
    return conv
      .filter((msg: any) => msg.type === 1 || msg.type === 2 || msg.role)
      .map((msg: any) => ({
        type: msg.type ?? (msg.role === "user" ? 1 : 2),
        text: msg.text ?? "",
      }));
  }
}
