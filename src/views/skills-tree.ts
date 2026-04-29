import * as vscode from "vscode";
import path from "node:path";
import { SkillRecord, RemoteSkillMeta } from "../models";
import { SkillsCollector } from "../services/skills-collector";
import { SyncStateService } from "../services/sync-state";
import { LocalStore } from "../services/local-store";
import { detectRemoteHome } from "../utils/remote-home";

type TreeItem = SkillCategoryNode | SkillNode | RemoteSkillNode | EmptyNode;

function skillRemotePathKey(skill: SkillRecord): string {
  if (skill.source === "project" && skill.projectName) {
    return `skills/${skill.projectName}__${skill.skillName}/SKILL.md`;
  }
  return `skills/${skill.skillName}/SKILL.md`;
}

export class SkillCategoryNode extends vscode.TreeItem {
  constructor(label: string, public readonly childItems: TreeItem[]) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "skillCategory";
    this.description = `${childItems.length}`;
    this.iconPath = new vscode.ThemeIcon("folder-library");
  }
}

export class SkillNode extends vscode.TreeItem {
  constructor(public readonly skill: SkillRecord, synced: boolean) {
    super(skill.skillName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "skill";
    this.description = `${skill.files.length} files`;

    const scopeLabel =
      skill.source === "user" ? "用户级" : `项目级 (${skill.projectName ?? ""})`;
    this.tooltip = `${skill.skillName}\n${scopeLabel}\n${synced ? "✓ Synced" : "○ Not synced"}\nPath: ${skill.absolutePath}`;
    this.iconPath = new vscode.ThemeIcon(
      synced ? "cloud" : "circle-outline",
      synced ? new vscode.ThemeColor("charts.green") : undefined
    );
    // absolutePath is either a raw filesystem path (local skills) or a serialized URI string
    // (project/remote skills collected via vscode.workspace.fs). Use Uri.file() for filesystem
    // paths so that Windows drive-letter paths (C:\...) are handled correctly.
    const skillMd =
      skill.absolutePath.startsWith("vscode-") || skill.absolutePath.startsWith("file:")
        ? vscode.Uri.joinPath(vscode.Uri.parse(skill.absolutePath), "SKILL.md")
        : vscode.Uri.file(path.join(skill.absolutePath, "SKILL.md"));
    this.command = {
      command: "vscode.open",
      title: "Open SKILL.md",
      arguments: [skillMd],
    };
  }
}

export class RemoteSkillNode extends vscode.TreeItem {
  constructor(public readonly remote: RemoteSkillMeta, syncDir: string) {
    super(remote.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "remoteSkill";
    this.description = (remote.description || "").replace(/\s+/g, " ").trim().slice(0, 48);
    this.tooltip = `${remote.name}\n${remote.description || ""}\n右键安装到本地`;
    this.iconPath = new vscode.ThemeIcon("cloud-download");
    const skillMdPath = path.join(syncDir, "skills", remote.name, "SKILL.md");
    this.command = {
      command: "vscode.open",
      title: "Open SKILL.md",
      arguments: [vscode.Uri.file(skillMdPath)],
    };
  }
}

export class SkillsTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly collector: SkillsCollector,
    private readonly syncState: SyncStateService,
    private readonly localStore: LocalStore,
    private readonly listRemoteSkills: () => Promise<RemoteSkillMeta[]>
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (element instanceof SkillCategoryNode) {
      return element.childItems;
    }

    if (element) {
      return [];
    }

    const state = await this.syncState.load();
    const categories: SkillCategoryNode[] = [];

    const remoteHome = await detectRemoteHome();
    const live = await this.collector.collect(remoteHome);
    const userNodes: SkillNode[] = [];
    const projectNodes: SkillNode[] = [];
    for (const skill of live) {
      const synced = Boolean(state.files[skillRemotePathKey(skill)]);
      const node = new SkillNode(skill, synced);
      if (skill.source === "user") userNodes.push(node);
      else projectNodes.push(node);
    }
    if (userNodes.length > 0) {
      categories.push(new SkillCategoryNode("User Skills (全局)", userNodes));
    }
    if (projectNodes.length > 0) {
      categories.push(new SkillCategoryNode("Project Skills (工作区)", projectNodes));
    }

    let remote: RemoteSkillMeta[] = [];
    try {
      remote = await this.listRemoteSkills();
    } catch {
      remote = [];
    }
    if (remote.length > 0) {
      const syncDir = this.localStore.getSyncDir();
      categories.push(
        new SkillCategoryNode("GitHub 仓库 (可安装)", remote.map((r) => new RemoteSkillNode(r, syncDir)))
      );
    }

    if (categories.length === 0) {
      return [new EmptyNode()];
    }

    return categories;
  }
}

class EmptyNode extends vscode.TreeItem {
  constructor() {
    super("No skills found", vscode.TreeItemCollapsibleState.None);
    this.description = "配置 GitHub 或添加 ~/.cursor/skills/";
    this.iconPath = new vscode.ThemeIcon("info");
  }
}
