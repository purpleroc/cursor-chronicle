import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SyncState } from "../models";
import { getUserHome } from "../utils/local-path";

const STATE_DIR = path.join(getUserHome(), ".cursor", "cursor-chronicle");
const STATE_PATH = path.join(STATE_DIR, "sync-state.json");

export class SyncStateService {
  private cached: SyncState | null = null;

  async load(): Promise<SyncState> {
    if (this.cached) { return this.cached; }
    try {
      const content = await fs.readFile(STATE_PATH, "utf8");
      const parsed = JSON.parse(content) as SyncState;
      this.cached = {
        lastSyncTime: parsed.lastSyncTime,
        files: parsed.files ?? {},
        conversations: parsed.conversations ?? {}
      };
      return this.cached;
    } catch {
      this.cached = { files: {}, conversations: {} };
      return this.cached;
    }
  }

  async save(state: SyncState): Promise<void> {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
    this.cached = state;
  }

  invalidateCache(): void {
    this.cached = null;
  }

  hashContent(content: string): string {
    return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
  }

  isConversationSynced(sessionId: string): boolean {
    return Boolean(this.cached?.conversations?.[sessionId]);
  }

  isSkillSynced(skillKey: string): boolean {
    return Boolean(this.cached?.files?.[`skills/${skillKey}/SKILL.md`]);
  }
}
