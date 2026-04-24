import { Dirent, promises as fs } from "node:fs";
import path from "node:path";
import { TranscriptScanResult } from "../models";
import { resolveProjectName } from "../utils/project-name-resolver";

const CURSOR_PROJECTS_ROOT = path.join(process.env.HOME ?? "", ".cursor", "projects");

export class TranscriptScanner {
  async scan(ignoreProjectNames: string[] = []): Promise<TranscriptScanResult[]> {
    const results: TranscriptScanResult[] = [];
    const ignored = new Set(ignoreProjectNames);

    let projectEntries;
    try {
      projectEntries = await fs.readdir(CURSOR_PROJECTS_ROOT, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of projectEntries) {
      if (!entry.isDirectory() || ignored.has(entry.name)) {
        continue;
      }

      const transcriptRoot = path.join(CURSOR_PROJECTS_ROOT, entry.name, "agent-transcripts");
      const sessionDirs = await this.readDirsSafe(transcriptRoot);
      for (const sessionDir of sessionDirs) {
        const sessionPath = path.join(transcriptRoot, sessionDir.name);
        const mainTranscriptPath = path.join(sessionPath, `${sessionDir.name}.jsonl`);
        if (!(await this.exists(mainTranscriptPath))) {
          continue;
        }

        const subagentDir = path.join(sessionPath, "subagents");
        const subagentPaths = await this.readJsonlFiles(subagentDir);
        results.push({
          projectDirName: entry.name,
          projectName: resolveProjectName(entry.name),
          sessionId: sessionDir.name,
          mainTranscriptPath,
          subagentPaths
        });
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
