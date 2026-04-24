import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { expandUserPath } from "../utils/local-path";
import { buildConversationFilename, sanitizeFilenamePart } from "../utils/file-naming";
import { logInfo, logDebug, logWarn } from "../utils/logger";
import type { ComposerMeta } from "./composer-db-reader";

const execFileAsync = promisify(execFileCb);

const FRONTMATTER_KEYS = {
  composerId: "chronicleComposerId",
  lastUpdatedAt: "chronicleLastUpdatedAt",
  workspaceUri: "chronicleWorkspaceUri",
  workspacePath: "chronicleWorkspacePath",
  source: "chronicleSource",
} as const;

export type ConversationSource = "local" | "remote";

export interface ChronicleFrontmatter {
  composerId: string;
  lastUpdatedAt: number;
  workspaceUri?: string;
  workspacePath?: string;
  source?: ConversationSource;
}

export interface LocalConversationEntry {
  projectName: string;
  filePath: string;
  displayName: string;
  frontmatter: ChronicleFrontmatter;
}

interface ChronicleIndex {
  conversations: Record<string, { relativePath: string; lastUpdatedAt: number }>;
}

export class LocalStore {
  private syncSubdir = "local";

  constructor(private readonly getRootPath: () => string) {}

  /** Plugin home directory (e.g. ~/.cursor-chronicle). */
  getRoot(): string {
    return expandUserPath(this.getRootPath().trim() || "~/.cursor-chronicle");
  }

  setSyncSubdir(name: string): void {
    this.syncSubdir = sanitizeFilenamePart(name) || "local";
    logDebug(`LocalStore.setSyncSubdir: ${this.syncSubdir}`);
  }

  /** Git-synced subdirectory (e.g. ~/.cursor-chronicle/<repo-name>). */
  getSyncDir(): string {
    return path.join(this.getRoot(), this.syncSubdir);
  }

  conversationsDir(): string {
    return path.join(this.getSyncDir(), "conversations");
  }

  private indexPath(): string {
    return path.join(this.getSyncDir(), "chronicle-index.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.conversationsDir(), { recursive: true });

    const gitignore = path.join(this.getSyncDir(), ".gitignore");
    const requiredEntries = [".DS_Store", "chronicle-index.json"];
    try {
      const existing = await fs.readFile(gitignore, "utf8");
      const lines = existing.split("\n").map((l) => l.trim());
      const missing = requiredEntries.filter((e) => !lines.includes(e));
      if (missing.length > 0) {
        await fs.writeFile(gitignore, existing.trimEnd() + "\n" + missing.join("\n") + "\n", "utf8");
      }
    } catch {
      await fs.writeFile(gitignore, requiredEntries.join("\n") + "\n", "utf8");
    }

    try {
      await fs.readFile(this.indexPath(), "utf8");
    } catch {
      const empty: ChronicleIndex = { conversations: {} };
      await fs.writeFile(this.indexPath(), JSON.stringify(empty, null, 2), "utf8");
    }
  }

  private async loadIndex(): Promise<ChronicleIndex> {
    try {
      const raw = await fs.readFile(this.indexPath(), "utf8");
      const p = JSON.parse(raw) as ChronicleIndex;
      return { conversations: p.conversations ?? {} };
    } catch {
      return { conversations: {} };
    }
  }

  private async saveIndex(idx: ChronicleIndex): Promise<void> {
    await fs.mkdir(this.getSyncDir(), { recursive: true });
    await fs.writeFile(this.indexPath(), JSON.stringify(idx, null, 2), "utf8");
  }

  async shouldSkipConversation(meta: ComposerMeta): Promise<boolean> {
    const idx = await this.loadIndex();
    const entry = idx.conversations[meta.composerId];
    if (!entry) return false;
    return entry.lastUpdatedAt >= meta.lastUpdatedAt;
  }

  async writeConversation(
    projectName: string,
    createdAt: Date,
    title: string,
    meta: ComposerMeta,
    bodyMarkdown: string,
    source?: ConversationSource
  ): Promise<string> {
    await this.init();
    const safeProject = sanitizeFilenamePart(projectName);
    const dir = path.join(this.conversationsDir(), safeProject);
    await fs.mkdir(dir, { recursive: true });

    const baseName = buildConversationFilename(createdAt, title);
    let filePath = path.join(dir, baseName);
    try {
      await fs.access(filePath);
      const stem = baseName.replace(/\.md$/i, "");
      filePath = path.join(dir, `${stem}-${meta.composerId.slice(0, 8)}.md`);
    } catch {
      /* use baseName */
    }

    const fm = [
      "---",
      `${FRONTMATTER_KEYS.composerId}: ${meta.composerId}`,
      `${FRONTMATTER_KEYS.lastUpdatedAt}: ${meta.lastUpdatedAt}`,
      meta.workspaceUri
        ? `${FRONTMATTER_KEYS.workspaceUri}: ${JSON.stringify(meta.workspaceUri)}`
        : "",
      meta.workspacePath
        ? `${FRONTMATTER_KEYS.workspacePath}: ${JSON.stringify(meta.workspacePath)}`
        : "",
      source ? `${FRONTMATTER_KEYS.source}: ${source}` : "",
      "---",
      "",
    ]
      .filter(Boolean)
      .join("\n");

    const full = fm + bodyMarkdown;
    await fs.writeFile(filePath, full, "utf8");

    const idx = await this.loadIndex();
    const rel = path.relative(this.getSyncDir(), filePath);
    idx.conversations[meta.composerId] = {
      relativePath: rel.split(path.sep).join("/"),
      lastUpdatedAt: meta.lastUpdatedAt,
    };
    await this.saveIndex(idx);
    return filePath;
  }

  async writeConversationFromJsonl(
    projectName: string,
    createdAt: Date,
    title: string,
    sessionId: string,
    lastUpdatedAt: number,
    workspaceUri: string | undefined,
    workspacePath: string | undefined,
    bodyMarkdown: string,
    source?: ConversationSource
  ): Promise<string> {
    const meta: ComposerMeta = {
      composerId: sessionId,
      name: title,
      createdAt: createdAt.getTime(),
      lastUpdatedAt,
      mode: "agent",
      workspaceUri,
      workspacePath,
    };
    return this.writeConversation(projectName, createdAt, title, meta, bodyMarkdown, source);
  }

  async shouldSkipJsonl(sessionId: string, lastUpdatedAt: number): Promise<boolean> {
    const idx = await this.loadIndex();
    const entry = idx.conversations[sessionId];
    if (!entry) return false;
    return entry.lastUpdatedAt >= lastUpdatedAt;
  }

  async readFileText(absPath: string): Promise<string> {
    return fs.readFile(absPath, "utf8");
  }

  async listConversations(): Promise<LocalConversationEntry[]> {
    await this.init();
    const root = this.conversationsDir();
    const out: LocalConversationEntry[] = [];

    let projectDirs: string[] = [];
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }

    for (const proj of projectDirs) {
      const pdir = path.join(root, proj);
      let files: string[] = [];
      try {
        files = (await fs.readdir(pdir)).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }
      for (const f of files) {
        const filePath = path.join(pdir, f);
        try {
          const raw = await fs.readFile(filePath, "utf8");
          const fm = parseFrontmatter(raw);
          if (!fm) continue;
          out.push({
            projectName: proj,
            filePath,
            displayName: f.replace(/\.md$/i, ""),
            frontmatter: fm,
          });
        } catch {
          continue;
        }
      }
    }

    out.sort((a, b) => b.frontmatter.lastUpdatedAt - a.frontmatter.lastUpdatedAt);
    return out;
  }

  async writePublishSkill(skillDirName: string, relativeFile: string, content: string): Promise<void> {
    const outPath = path.join(this.getSyncDir(), "skills", skillDirName, relativeFile);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, content, "utf8");
  }

  async writePublishSkillsIndex(jsonContent: string): Promise<void> {
    const outPath = path.join(this.getSyncDir(), "skills", "skills-index.json");
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, jsonContent, "utf8");
  }

  async gitConfigureRemote(token: string, owner: string, repo: string): Promise<void> {
    const cwd = this.getSyncDir();
    await fs.mkdir(cwd, { recursive: true });

    try {
      await fs.access(path.join(cwd, ".git"));
    } catch {
      await execFileAsync("git", ["init"], { cwd, timeout: 10_000 });
    }

    try {
      await execFileAsync("git", ["config", "user.email"], { cwd, timeout: 5_000 });
    } catch {
      await execFileAsync("git", ["config", "user.email", "cursor-chronicle@local"], { cwd, timeout: 5_000 });
      await execFileAsync("git", ["config", "user.name", "Cursor Chronicle"], { cwd, timeout: 5_000 });
    }

    const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    try {
      await execFileAsync("git", ["remote", "set-url", "origin", url], { cwd, timeout: 10_000 });
    } catch {
      await execFileAsync("git", ["remote", "add", "origin", url], { cwd, timeout: 10_000 });
    }
    logDebug(`LocalStore.gitConfigureRemote: configured for ${owner}/${repo}`);
  }

  async gitAddAndCommit(message: string): Promise<{ committed: boolean; filesChanged: number }> {
    const cwd = this.getSyncDir();
    await execFileAsync("git", ["add", "-A"], { cwd, timeout: 30_000 });

    try {
      await execFileAsync("git", ["diff", "--cached", "--quiet"], { cwd, timeout: 10_000 });
      return { committed: false, filesChanged: 0 };
    } catch {
      // has staged changes — continue
    }

    const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-only"], {
      cwd, timeout: 10_000, encoding: "utf8",
    });
    const filesChanged = (stdout as string).trim().split("\n").filter(Boolean).length;

    await execFileAsync("git", ["commit", "-m", message], { cwd, timeout: 30_000 });
    logInfo(`LocalStore.gitAddAndCommit: committed ${filesChanged} files`);
    return { committed: true, filesChanged };
  }

  async gitPush(): Promise<void> {
    const cwd = this.getSyncDir();
    try {
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, timeout: 5_000 });
    } catch {
      logDebug("LocalStore.gitPush: no commits yet, skipping push");
      return;
    }
    const branch = await this.gitCurrentBranch();
    try {
      await execFileAsync("git", ["push", "-u", "origin", branch], { cwd, timeout: 120_000 });
      logInfo("LocalStore.gitPush: pushed successfully");
      return;
    } catch {
      logWarn("LocalStore.gitPush: push rejected, attempting pull --allow-unrelated-histories");
    }
    try {
      await execFileAsync("git", ["pull", "--no-edit", "--allow-unrelated-histories", "origin", branch], {
        cwd, timeout: 60_000,
      });
      await execFileAsync("git", ["push", "-u", "origin", branch], { cwd, timeout: 120_000 });
      logInfo("LocalStore.gitPush: pushed after merge");
      return;
    } catch {
      logWarn("LocalStore.gitPush: merge conflict, force pushing (local is source of truth)");
    }
    await execFileAsync("git", ["push", "--force", "-u", "origin", branch], { cwd, timeout: 120_000 });
    logInfo("LocalStore.gitPush: force pushed successfully");
  }

  private async gitCurrentBranch(): Promise<string> {
    const cwd = this.getSyncDir();
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd, timeout: 5_000, encoding: "utf8",
    });
    return (stdout as string).trim();
  }

}

export function parseFrontmatter(raw: string): ChronicleFrontmatter | null {
  if (!raw.startsWith("---\n")) return null;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const block = raw.slice(4, end);
  const lines = block.split("\n");
  const map: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.+)$/);
    if (!m) continue;
    map[m[1]] = m[2].trim();
  }
  const id = map[FRONTMATTER_KEYS.composerId];
  const lu = map[FRONTMATTER_KEYS.lastUpdatedAt];
  if (!id || !lu) return null;
  const lastUpdatedAt = Number(lu);
  if (Number.isNaN(lastUpdatedAt)) return null;

  let workspaceUri: string | undefined;
  let workspacePath: string | undefined;
  const uRaw = map[FRONTMATTER_KEYS.workspaceUri];
  const pRaw = map[FRONTMATTER_KEYS.workspacePath];
  if (uRaw) {
    try {
      workspaceUri = JSON.parse(uRaw) as string;
    } catch {
      workspaceUri = uRaw.replace(/^"|"$/g, "");
    }
  }
  if (pRaw) {
    try {
      workspacePath = JSON.parse(pRaw) as string;
    } catch {
      workspacePath = pRaw.replace(/^"|"$/g, "");
    }
  }

  const sourceRaw = map[FRONTMATTER_KEYS.source];
  const source = sourceRaw === "local" || sourceRaw === "remote" ? sourceRaw : undefined;

  return { composerId: id, lastUpdatedAt, workspaceUri, workspacePath, source };
}
