import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const home = process.env.HOME ?? "";
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
  const candidates =
    process.platform === "darwin"
      ? [path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")]
      : [path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb")];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

let sqlite3Ok: boolean | undefined;
function hasSqlite3(): boolean {
  if (sqlite3Ok !== undefined) return sqlite3Ok;
  try {
    execFileSync("sqlite3", ["--version"], { encoding: "utf8", timeout: 2000, stdio: "pipe" });
    sqlite3Ok = true;
  } catch {
    sqlite3Ok = false;
  }
  return sqlite3Ok;
}

function querySingle(db: string, sql: string): string | null {
  try {
    const raw = execFileSync("sqlite3", [db, sql], {
      encoding: "utf8",
      timeout: 15000,
      stdio: "pipe",
      maxBuffer: 50 * 1024 * 1024,
    }).trim();
    return raw || null;
  } catch {
    return null;
  }
}

function queryJsonRows(db: string, sql: string): Record<string, string>[] {
  try {
    const raw = execFileSync("sqlite3", ["-json", db, sql], {
      encoding: "utf8",
      timeout: 30000,
      stdio: "pipe",
      maxBuffer: 100 * 1024 * 1024,
    }).trim();
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export class ComposerDbReader {
  private readonly dbPath: string | null;
  private metaCache: ComposerMeta[] | null = null;

  constructor() {
    this.dbPath = hasSqlite3() ? resolveDbPath() : null;
  }

  get available(): boolean {
    return this.dbPath !== null;
  }

  listAll(): ComposerMeta[] {
    if (this.metaCache) return this.metaCache;
    if (!this.dbPath) return [];

    try {
      const raw = querySingle(
        this.dbPath,
        "SELECT value FROM ItemTable WHERE key='composer.composerHeaders';"
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
          const bubbles = this.readBubbles(h.composerId);
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
    }
  }

  readBubbles(composerId: string): ComposerBubble[] {
    if (!this.dbPath || !UUID_RE.test(composerId)) return [];

    try {
      const raw = querySingle(
        this.dbPath,
        `SELECT value FROM cursorDiskKV WHERE key='composerData:${composerId}';`
      );
      if (!raw) return [];

      const data = JSON.parse(raw);

      if (data._v && data._v >= 9) {
        return this.readV9(composerId, data);
      }
      return this.readLegacy(data);
    } catch {
      return [];
    }
  }

  private readV9(composerId: string, data: any): ComposerBubble[] {
    const headers: any[] = data.fullConversationHeadersOnly ?? [];
    if (headers.length === 0) return [];

    const bubbleIds = headers.map((h: any) => h.bubbleId).filter(Boolean);
    if (bubbleIds.length === 0) return [];

    const inClause = bubbleIds
      .map((id: string) => `'bubbleId:${composerId}:${id}'`)
      .join(",");

    const rows = queryJsonRows(
      this.dbPath!,
      `SELECT key, value FROM cursorDiskKV WHERE key IN (${inClause});`
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

  invalidateCache(): void {
    this.metaCache = null;
  }
}
