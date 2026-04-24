import * as vscode from "vscode";
import os from "node:os";
import { LocalStore, LocalConversationEntry } from "../services/local-store";
import { SyncStateService } from "../services/sync-state";

function getRepoLabel(): string {
  const repo = vscode.workspace.getConfiguration("cursorChronicle").get<string>("github.repository", "");
  return repo || "GitHub";
}

type TreeItem = LocationNode | ProjectNode | ConversationNode | EmptyConversationNode;

export class LocationNode extends vscode.TreeItem {
  constructor(
    label: string,
    icon: string,
    public readonly items: (ProjectNode | ConversationNode)[],
    collapsed: boolean
  ) {
    super(
      label,
      collapsed
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded
    );
    this.contextValue = "location";
    this.iconPath = new vscode.ThemeIcon(icon);
    const count = items.reduce((n, item) => {
      if (item instanceof ProjectNode) return n + item.conversations.length;
      return n + 1;
    }, 0);
    this.description = `${count}`;
  }
}

export class ProjectNode extends vscode.TreeItem {
  constructor(
    public readonly projectName: string,
    public readonly conversations: ConversationNode[],
    isCurrent?: boolean
  ) {
    super(
      projectName,
      isCurrent
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.contextValue = "project";
    this.description = isCurrent ? `${conversations.length} · 当前工作区` : `${conversations.length}`;
    this.iconPath = new vscode.ThemeIcon(isCurrent ? "folder-active" : "folder");
  }
}

export class ConversationNode extends vscode.TreeItem {
  constructor(public readonly entry: LocalConversationEntry, synced: boolean) {
    super(entry.displayName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "conversation";
    const hostLabel = entry.frontmatter.hostname ? `Host: ${entry.frontmatter.hostname}` : "";
    this.tooltip = `${entry.filePath}\n${hostLabel}\n${synced ? "✓ Synced" : "○ Not synced"}`.trim();
    this.iconPath = new vscode.ThemeIcon(
      synced ? "cloud" : "circle-outline",
      synced ? new vscode.ThemeColor("charts.green") : undefined
    );
    this.resourceUri = vscode.Uri.file(entry.filePath);
    this.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [vscode.Uri.file(entry.filePath)],
    };
  }
}

class EmptyConversationNode extends vscode.TreeItem {
  constructor() {
    super("暂无本地对话文件", vscode.TreeItemCollapsibleState.None);
    this.description = "运行「收集到本地」或同步";
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

function isCurrentWorkspaceEntry(
  entry: LocalConversationEntry,
  folders: readonly vscode.WorkspaceFolder[]
): boolean {
  for (const folder of folders) {
    const folderStr = folder.uri.toString().replace(/\/+$/, "");
    if (entry.frontmatter.workspaceUri) {
      if (entry.frontmatter.workspaceUri.replace(/\/+$/, "") === folderStr) return true;
    }
    if (entry.frontmatter.workspacePath && folder.uri.scheme === "file") {
      if (folder.uri.fsPath === entry.frontmatter.workspacePath) return true;
    }
  }
  return false;
}

function buildProjectNodes(
  grouped: Map<string, ConversationNode[]>,
  folders: readonly vscode.WorkspaceFolder[]
): ProjectNode[] {
  const nodes: ProjectNode[] = [];
  for (const [name, convs] of grouped) {
    convs.sort((a, b) => b.entry.frontmatter.lastUpdatedAt - a.entry.frontmatter.lastUpdatedAt);
    const isCurrent = folders.length > 0
      && convs.some((c) => isCurrentWorkspaceEntry(c.entry, folders));
    nodes.push(new ProjectNode(name, convs, isCurrent));
  }
  nodes.sort((a, b) => a.projectName.localeCompare(b.projectName));
  return nodes;
}

export class ConversationsTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly localStore: LocalStore,
    private readonly syncState: SyncStateService
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (element instanceof LocationNode) return element.items;
    if (element instanceof ProjectNode) return element.conversations;
    if (element) return [];

    const state = await this.syncState.load();
    const folders = vscode.workspace.workspaceFolders ?? [];
    const entries = await this.localStore.listConversations();

    if (entries.length === 0) {
      return [new EmptyConversationNode()];
    }

    const currentHostname = os.hostname();
    const hostGroups = new Map<string, Map<string, ConversationNode[]>>();

    for (const entry of entries) {
      const synced = Boolean(state.conversations?.[entry.frontmatter.composerId]);
      const node = new ConversationNode(entry, synced);
      const host = entry.frontmatter.hostname || "__repo__";
      if (!hostGroups.has(host)) hostGroups.set(host, new Map());
      const projectMap = hostGroups.get(host)!;
      const arr = projectMap.get(entry.projectName) ?? [];
      arr.push(node);
      projectMap.set(entry.projectName, arr);
    }

    const root: TreeItem[] = [];

    // Current host first (expanded), other hosts after (collapsed)
    const sortedHosts = [...hostGroups.keys()].sort((a, b) => {
      if (a === currentHostname) return -1;
      if (b === currentHostname) return 1;
      return a.localeCompare(b);
    });

    for (const host of sortedHosts) {
      const projectMap = hostGroups.get(host)!;
      const projects = buildProjectNodes(projectMap, folders);
      const isCurrentHost = host === currentHostname;
      let icon: string;
      let label: string;
      if (isCurrentHost) {
        icon = "vm";
        label = `${host} (本机)`;
      } else if (host === "__repo__") {
        icon = "repo";
        label = getRepoLabel();
      } else {
        icon = "remote-explorer";
        label = host;
      }
      root.push(new LocationNode(label, icon, projects, !isCurrentHost));
    }

    if (root.length === 0) {
      return [new EmptyConversationNode()];
    }
    return root;
  }
}
