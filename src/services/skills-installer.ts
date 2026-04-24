import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { GitHubSyncService } from "./github-sync";
import { logInfo, logError } from "../utils/logger";

export type SkillInstallTarget = "user" | "project" | "remote-user";

const encoder = new TextEncoder();

export class SkillsInstaller {
  constructor(
    private readonly github: GitHubSyncService,
    private readonly remoteHomeUri?: vscode.Uri
  ) {}

  async installFromRepo(
    repository: string,
    remoteSkillDir: string,
    target: SkillInstallTarget
  ): Promise<string> {
    logInfo(`SkillsInstaller.install: "${remoteSkillDir}" → ${target}`);
    const repoRef = this.github.parseRepo(repository);
    const files = await this.github.downloadSkillFiles(repoRef, remoteSkillDir);
    if (files.length === 0) {
      throw new Error("未找到 skill 文件。");
    }

    const skillName = this.normalizeSkillName(remoteSkillDir);

    if (target === "user") {
      return this.installLocal(skillName, files);
    }
    if (target === "remote-user") {
      return this.installToRemoteUser(skillName, files);
    }
    return this.installToWorkspace(skillName, files);
  }

  async uninstall(skillName: string, target: SkillInstallTarget): Promise<void> {
    logInfo(`SkillsInstaller.uninstall: "${skillName}" from ${target}`);
    if (target === "user") {
      const dir = path.join(process.env.HOME ?? "", ".cursor", "skills", skillName);
      await fs.rm(dir, { recursive: true, force: true });
    } else if (target === "remote-user") {
      const uri = this.remoteUserSkillUri(skillName);
      try { await vscode.workspace.fs.delete(uri, { recursive: true }); } catch { /* already gone */ }
    } else {
      const uri = this.projectSkillUri(skillName);
      try { await vscode.workspace.fs.delete(uri, { recursive: true }); } catch { /* already gone */ }
    }
  }

  async listInstalled(target: SkillInstallTarget): Promise<Set<string>> {
    if (target === "user") {
      const root = path.join(process.env.HOME ?? "", ".cursor", "skills");
      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        return new Set(entries.filter(e => e.isDirectory()).map(e => e.name));
      } catch { return new Set(); }
    }

    if (target === "remote-user") {
      if (!this.remoteHomeUri) return new Set();
      const uri = vscode.Uri.joinPath(this.remoteHomeUri, ".cursor", "skills");
      try {
        const entries = await vscode.workspace.fs.readDirectory(uri);
        return new Set(entries.filter(([, t]) => t === vscode.FileType.Directory).map(([n]) => n));
      } catch { return new Set(); }
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return new Set(); }
    const uri = vscode.Uri.joinPath(folder.uri, ".cursor", "skills");
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      return new Set(entries.filter(([, t]) => t === vscode.FileType.Directory).map(([n]) => n));
    } catch { return new Set(); }
  }

  private async installLocal(skillName: string, files: Array<{ relativePath: string; content: string }>): Promise<string> {
    const skillDir = path.join(process.env.HOME ?? "", ".cursor", "skills", skillName);
    await fs.mkdir(skillDir, { recursive: true });
    for (const file of files) {
      const abs = path.join(skillDir, file.relativePath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, file.content, "utf8");
    }
    return skillDir;
  }

  private async installToRemoteUser(skillName: string, files: Array<{ relativePath: string; content: string }>): Promise<string> {
    const baseUri = this.remoteUserSkillUri(skillName);
    for (const file of files) {
      const fileUri = vscode.Uri.joinPath(baseUri, file.relativePath);
      await vscode.workspace.fs.writeFile(fileUri, encoder.encode(file.content));
    }
    return baseUri.toString();
  }

  private async installToWorkspace(skillName: string, files: Array<{ relativePath: string; content: string }>): Promise<string> {
    const baseUri = this.projectSkillUri(skillName);
    for (const file of files) {
      const fileUri = vscode.Uri.joinPath(baseUri, file.relativePath);
      await vscode.workspace.fs.writeFile(fileUri, encoder.encode(file.content));
    }
    return baseUri.toString();
  }

  private remoteUserSkillUri(skillName: string): vscode.Uri {
    if (!this.remoteHomeUri) {
      throw new Error("无法检测远程主机的 home 目录，无法操作远端用户级 Skill。");
    }
    return vscode.Uri.joinPath(this.remoteHomeUri, ".cursor", "skills", skillName);
  }

  private projectSkillUri(skillName: string): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { throw new Error("当前没有打开项目，无法操作项目级 Skill。"); }
    return vscode.Uri.joinPath(folder.uri, ".cursor", "skills", skillName);
  }

  private normalizeSkillName(remoteSkillDir: string): string {
    return (remoteSkillDir.split("__").pop() ?? remoteSkillDir).trim();
  }
}
