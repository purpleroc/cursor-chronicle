import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { LocalStore } from "./local-store";
import { logInfo } from "../utils/logger";
import { getUserHome } from "../utils/local-path";

export type SkillInstallTarget = "user" | "project" | "remote-user";

/** Repo dir may be `projectName__skillName`; installed folder is always skillName. */
export function skillInstallName(remoteSkillDir: string): string {
  return (remoteSkillDir.split("__").pop() ?? remoteSkillDir).trim();
}

export class SkillsInstaller {
  constructor(
    private readonly localStore: LocalStore,
    private readonly remoteHomeUri?: vscode.Uri
  ) {}

  async install(remoteSkillDir: string, target: SkillInstallTarget): Promise<string> {
    const skillName = skillInstallName(remoteSkillDir);
    logInfo(`SkillsInstaller.install: "${remoteSkillDir}" → ${target} as "${skillName}"`);
    if (!skillName) {
      throw new Error("未指定 skill 名称。");
    }
    if (!(await this.localStore.syncedSkillExists(remoteSkillDir))) {
      throw new Error(`未找到 skill 文件：${remoteSkillDir}。请先同步 GitHub。`);
    }

    if (target === "user") {
      return this.installLocal(remoteSkillDir, skillName);
    }
    const files = await this.localStore.readSyncedSkillFiles(remoteSkillDir);
    if (files.length === 0) {
      throw new Error(`未找到 skill 文件：${remoteSkillDir}。请先同步 GitHub。`);
    }
    if (target === "remote-user") {
      return this.installToRemoteUser(skillName, files);
    }
    return this.installToWorkspace(skillName, files);
  }

  async uninstall(skillName: string, target: SkillInstallTarget): Promise<void> {
    const destName = skillInstallName(skillName);
    logInfo(`SkillsInstaller.uninstall: "${destName}" from ${target}`);
    if (target === "user") {
      const dir = path.join(getUserHome(), ".cursor", "skills", destName);
      await fs.rm(dir, { recursive: true, force: true });
    } else if (target === "remote-user") {
      const uri = this.remoteUserSkillUri(destName);
      try { await vscode.workspace.fs.delete(uri, { recursive: true }); } catch { /* already gone */ }
    } else {
      const uri = this.projectSkillUri(destName);
      try { await vscode.workspace.fs.delete(uri, { recursive: true }); } catch { /* already gone */ }
    }
  }

  async listInstalled(target: SkillInstallTarget): Promise<Set<string>> {
    if (target === "user") {
      const root = path.join(getUserHome(), ".cursor", "skills");
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

  private async installLocal(remoteSkillDir: string, skillName: string): Promise<string> {
    const srcDir = this.localStore.syncedSkillDir(remoteSkillDir);
    const skillDir = path.join(getUserHome(), ".cursor", "skills", skillName);
    await fs.mkdir(path.dirname(skillDir), { recursive: true });
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.cp(srcDir, skillDir, { recursive: true });
    return skillDir;
  }

  private async installToRemoteUser(
    skillName: string,
    files: Array<{ relativePath: string; content: Uint8Array }>
  ): Promise<string> {
    const baseUri = this.remoteUserSkillUri(skillName);
    try { await vscode.workspace.fs.delete(baseUri, { recursive: true }); } catch { /* first install */ }
    for (const file of files) {
      const fileUri = vscode.Uri.joinPath(baseUri, file.relativePath);
      await vscode.workspace.fs.writeFile(fileUri, file.content);
    }
    return baseUri.toString();
  }

  private async installToWorkspace(
    skillName: string,
    files: Array<{ relativePath: string; content: Uint8Array }>
  ): Promise<string> {
    const baseUri = this.projectSkillUri(skillName);
    try { await vscode.workspace.fs.delete(baseUri, { recursive: true }); } catch { /* first install */ }
    for (const file of files) {
      const fileUri = vscode.Uri.joinPath(baseUri, file.relativePath);
      await vscode.workspace.fs.writeFile(fileUri, file.content);
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
}
