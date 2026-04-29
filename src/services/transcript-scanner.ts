import { Dirent, promises as fs } from "node:fs";
import path from "node:path";
import { TranscriptScanResult } from "../models";
import { resolveProjectName } from "../utils/project-name-resolver";
import { getUserHome } from "../utils/local-path";

/**
 * Returns candidate root directories for Cursor's per-project data.
 * macOS/Linux: ~/.cursor/projects
 * Windows: multiple candidates (Cursor may use different base dirs depending on install type)
 *   - %USERPROFILE%\.cursor\projects   (most common, mirrors macOS/Linux)
 *   - %APPDATA%\Cursor\projects        (VS Code-style roaming AppData)
 *   - %LOCALAPPDATA%\cursor\projects   (some installs use lowercase / local AppData)
 */
function getCursorProjectsRoots(): string[] {
  const home = getUserHome();
  const roots: string[] = [path.join(home, ".cursor", "projects")];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const candidates = [
      path.join(appData, "Cursor", "projects"),
      path.join(localAppData, "cursor", "projects"),
      path.join(localAppData, "Cursor", "projects"),
    ];
    for (const c of candidates) {
      if (!roots.includes(c)) roots.push(c);
    }
  }
  return roots;
}

export class TranscriptScanner {
  async scan(ignoreProjectNames: string[] = []): Promise<TranscriptScanResult[]> {
    const results: TranscriptScanResult[] = [];
    const ignored = new Set(ignoreProjectNames);
    const seenSessions = new Set<string>();

    for (const cursorProjectsRoot of getCursorProjectsRoots()) {
      let projectEntries;
      try {
        projectEntries = await fs.readdir(cursorProjectsRoot, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of projectEntries) {
        if (!entry.isDirectory() || ignored.has(entry.name)) {
          continue;
        }

        const transcriptRoot = path.join(cursorProjectsRoot, entry.name, "agent-transcripts");
        const sessionDirs = await this.readDirsSafe(transcriptRoot);
        for (const sessionDir of sessionDirs) {
          if (seenSessions.has(sessionDir.name)) continue;
          const sessionPath = path.join(transcriptRoot, sessionDir.name);
          const mainTranscriptPath = path.join(sessionPath, `${sessionDir.name}.jsonl`);
          if (!(await this.exists(mainTranscriptPath))) {
            continue;
          }

          const subagentDir = path.join(sessionPath, "subagents");
          const subagentPaths = await this.readJsonlFiles(subagentDir);
          seenSessions.add(sessionDir.name);
          results.push({
            projectDirName: entry.name,
            projectName: resolveProjectName(entry.name),
            sessionId: sessionDir.name,
            mainTranscriptPath,
            subagentPaths,
          });
        }
      }
    }

    return results;
  }

  private async readDirsSafe(target: string): Promise<Dirent[]> {
    try {
      const entries = await fs.readdir(target, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory());
    } catch {
      return [];
    }
  }

  private async readJsonlFiles(target: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(target, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => path.join(target, entry.name));
    } catch {
      return [];
    }
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }
}
