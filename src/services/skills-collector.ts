import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { SkillRecord } from "../models";

export class SkillsCollector {
  async collect(remoteHomeUri?: vscode.Uri): Promise<SkillRecord[]> {
    const records: SkillRecord[] = [];
    const home = process.env.HOME ?? "";
    const userSkillsDir = path.join(home, ".cursor", "skills");

    records.push(...(await this.collectLocal(userSkillsDir, "user")));

    if (remoteHomeUri) {
      const remoteSkillsUri = vscode.Uri.joinPath(remoteHomeUri, ".cursor", "skills");
      records.push(...(await this.collectFromUri(remoteSkillsUri, "user")));
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const skillsUri = vscode.Uri.joinPath(folder.uri, ".cursor", "skills");
      const projectName = folder.name;
      records.push(...(await this.collectFromUri(skillsUri, "project", projectName)));
    }

    return records;
  }

  private async collectLocal(baseDir: string, source: "user", projectName?: string): Promise<SkillRecord[]> {
    let entries;
    try {
      entries = await fs.readdir(baseDir, { withFileTypes: true });
    } catch { return []; }

    const records: SkillRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      const skillPath = path.join(baseDir, entry.name);
      const files = await this.listLocalFiles(skillPath, skillPath);
      if (!files.includes("SKILL.md")) { continue; }
      records.push({ source, projectName, skillName: entry.name, absolutePath: skillPath, files });
    }
    return records;
  }

  private async collectFromUri(baseUri: vscode.Uri, source: "user" | "project", projectName?: string): Promise<SkillRecord[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(baseUri);
    } catch { return []; }

    const records: SkillRecord[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) { continue; }
      const skillUri = vscode.Uri.joinPath(baseUri, name);
      const files = await this.listUriFiles(skillUri, skillUri);
      if (!files.includes("SKILL.md")) { continue; }
      records.push({ source, projectName, skillName: name, absolutePath: skillUri.toString(), files });
    }
    return records;
  }

  private async listLocalFiles(baseDir: string, currentDir: string): Promise<string[]> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const abs = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.listLocalFiles(baseDir, abs)));
      } else if (entry.isFile()) {
        files.push(path.relative(baseDir, abs));
      }
    }
    return files.sort();
  }

  private async listUriFiles(baseUri: vscode.Uri, currentUri: vscode.Uri): Promise<string[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(currentUri);
    } catch { return []; }

    const files: string[] = [];
    for (const [name, type] of entries) {
      const childUri = vscode.Uri.joinPath(currentUri, name);
      if (type === vscode.FileType.Directory) {
        files.push(...(await this.listUriFiles(baseUri, childUri)));
      } else if (type === vscode.FileType.File) {
        const rel = childUri.path.slice(baseUri.path.length + 1);
        files.push(rel);
      }
    }
    return files.sort();
  }
}
