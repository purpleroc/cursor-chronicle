import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

import { TranscriptScanner } from "./services/transcript-scanner";
import { TranscriptParser } from "./services/transcript-parser";
import { MarkdownGenerator } from "./services/markdown-generator";
import { SkillsCollector } from "./services/skills-collector";
import { SyncStateService } from "./services/sync-state";
import { GitHubSyncService, parseDescriptionFromSkillMd } from "./services/github-sync";
import { SkillsInstaller } from "./services/skills-installer";
import { ComposerDbReader } from "./services/composer-db-reader";
import { LocalStore } from "./services/local-store";
import { CollectService } from "./services/collect-service";
import { SettingsPanel, SettingsPayload } from "./views/settings-panel";
import { SkillsPickerPanel } from "./views/skills-picker-panel";
import { ConversationsTreeProvider, ConversationNode } from "./views/conversations-tree";
import { SkillsTreeProvider, SkillNode } from "./views/skills-tree";
import { SkillRecord, RemoteSkillMeta } from "./models";
import { acquireSyncLock, releaseSyncLock } from "./services/sync-lock";
import { detectRemoteHome, isRemoteSession, getRemoteHost } from "./utils/remote-home";
import { initLogger, logInfo, logWarn, logError, logDebug } from "./utils/logger";

const TOKEN_KEY = "cursorChronicle.githubToken";

let statusBar: vscode.StatusBarItem;
let autoSyncTimer: NodeJS.Timeout | undefined;
let autoSyncDisposable: vscode.Disposable | undefined;
let repoVerified = false;

function getLocalProjectPath(): string {
  return vscode.workspace
    .getConfiguration("cursorChronicle")
    .get<string>("localProjectPath", "~/.cursor-chronicle");
}

function applySyncSubdir(localStore: LocalStore): void {
  const repo = vscode.workspace
    .getConfiguration("cursorChronicle")
    .get<string>("github.repository", "");
  const repoName = repo ? repo.split("/").pop() || "local" : "local";
  localStore.setSyncSubdir(repoName);
}

function formatSyncError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("Resource not accessible by personal access token")) {
    return `同步失败: Token 权限不足。请使用 Classic Token (需要 repo 权限)，或 Fine-grained Token (需要 Contents: Read and Write 权限)。`;
  }
  return `同步失败: ${msg}`;
}

async function readSkillFile(skill: SkillRecord, relativeFile: string): Promise<string> {
  const baseUri =
    skill.absolutePath.startsWith("vscode-") || skill.absolutePath.startsWith("file:")
      ? vscode.Uri.parse(skill.absolutePath)
      : vscode.Uri.file(skill.absolutePath);
  const fileUri = vscode.Uri.joinPath(baseUri, relativeFile);
  if (baseUri.scheme === "file") {
    return fs.readFile(fileUri.fsPath, "utf8");
  }
  const bytes = await vscode.workspace.fs.readFile(fileUri);
  return decoder.decode(bytes);
}

async function mergeSkillsForIndex(
  collector: SkillsCollector,
  github: GitHubSyncService
): Promise<SkillRecord[]> {
  const map = new Map<string, SkillRecord>();
  const remoteHome = await detectRemoteHome();
  for (const s of await collector.collect(remoteHome)) {
    map.set(github.skillRemoteDir(s), s);
  }
  return [...map.values()];
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(initLogger());
  logInfo("Cursor Chronicle activating...");

  const scanner = new TranscriptScanner();
  const parser = new TranscriptParser();
  const mdGen = new MarkdownGenerator();
  const skillsCollector = new SkillsCollector();
  const syncState = new SyncStateService();
  const dbReader = new ComposerDbReader();
  const localStore = new LocalStore(() => getLocalProjectPath());
  const collectService = new CollectService(
    dbReader,
    parser,
    mdGen,
    localStore,
    scanner,
    skillsCollector
  );

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "cursorChronicle.viewSyncStatus";
  updateStatusBar("idle");
  statusBar.show();
  context.subscriptions.push(statusBar);

  const listRemoteSkills = async (): Promise<RemoteSkillMeta[]> => {
    const token = await context.secrets.get(TOKEN_KEY);
    const repository = vscode.workspace
      .getConfiguration("cursorChronicle")
      .get<string>("github.repository", "");
    if (!token || !repository) return [];
    const github = new GitHubSyncService(token);
    return github.listRemoteSkills(github.parseRepo(repository));
  };

  const convTree = new ConversationsTreeProvider(localStore, syncState);
  const skillsTree = new SkillsTreeProvider(skillsCollector, syncState, listRemoteSkills);

  context.subscriptions.push(
    vscode.window.createTreeView("cursorChronicle.conversations", { treeDataProvider: convTree }),
    vscode.window.createTreeView("cursorChronicle.skills", { treeDataProvider: skillsTree }),
    vscode.window.registerTreeDataProvider("cursorChronicle.welcome", {
      getTreeItem: (e: never) => e,
      getChildren: () => [],
    })
  );

  await refreshConfiguredContext(context);
  applySyncSubdir(localStore);

  const settingsPanel = new SettingsPanel(
    context,
    async (payload, token) => {
      await saveSettings(payload, token, context);
      await refreshConfiguredContext(context);
      applySyncSubdir(localStore);
      if (payload.branch) {
        try {
          await localStore.gitSwitchBranch(payload.branch);
        } catch (e) {
          logWarn(`Settings save: branch switch to ${payload.branch} failed: ${e instanceof Error ? e.message : e}`);
        }
      }
      restartAutoSync(runCollectAndSync);
      convTree.refresh();
      skillsTree.refresh();
    }
  );

  const runCollectAndSync = async (): Promise<void> => {
    logInfo("runCollectAndSync: acquiring lock...");
    const locked = await acquireSyncLock();
    if (!locked) {
      logWarn("runCollectAndSync: lock already held, skipping");
      return;
    }
    updateStatusBar("syncing");
    syncState.invalidateCache();
    dbReader.invalidateCache();
    let ok = false;
    try {
      const r = await collectService.collectAll();
      logInfo(`runCollectAndSync: collected ${r.conversationsWritten} conversations, ${r.skillsMirrored} skills`);
      const token = await context.secrets.get(TOKEN_KEY);
      const repository = vscode.workspace
        .getConfiguration("cursorChronicle")
        .get<string>("github.repository", "");
      if (token && repository) {
        await executeGitHubSync(context, localStore, skillsCollector, syncState, convTree, skillsTree);
        logInfo("runCollectAndSync: GitHub sync completed");
        void vscode.window.showInformationMessage(
          `Chronicle: 已收集 ${r.conversationsWritten} 个对话、${r.skillsMirrored} 个技能，并已同步 GitHub。`
        );
      } else {
        logInfo("runCollectAndSync: no GitHub config, skip remote sync");
        void vscode.window.showInformationMessage(
          `Chronicle: 已收集 ${r.conversationsWritten} 个对话、${r.skillsMirrored} 个技能。配置 GitHub 后可同步到仓库。`
        );
      }
      ok = true;
    } catch (e) {
      logError("runCollectAndSync failed", e);
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      updateStatusBar("error");
    } finally {
      await releaseSyncLock();
      if (ok) updateStatusBar("synced");
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorChronicle.syncNow", runCollectAndSync),
    vscode.commands.registerCommand("cursorChronicle.collectToLocal", async () => {
      logInfo("collectToLocal: starting local collection");
      try {
        updateStatusBar("syncing");
        const r = await collectService.collectAll();
        convTree.refresh();
        skillsTree.refresh();
        logInfo(`collectToLocal: done — ${r.conversationsWritten} conversations, ${r.skillsMirrored} skills`);
        void vscode.window.showInformationMessage(
          `已收集到本地: ${r.conversationsWritten} 对话, ${r.skillsMirrored} 技能`
        );
      } catch (e) {
        logError("collectToLocal failed", e);
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      } finally {
        updateStatusBar("idle");
      }
    }),
    vscode.commands.registerCommand("cursorChronicle.openSettings", async () => {
      logDebug("openSettings: opening settings panel");
      const lang = vscode.workspace.getConfiguration("cursorChronicle").get<"zh-CN" | "en">("language", "zh-CN");
      settingsPanel.show(readSettings(), await getTokenMask(context), lang);
    }),
    vscode.commands.registerCommand("cursorChronicle.viewSyncStatus", async () => {
      const state = await syncState.load();
      void vscode.window.showInformationMessage(
        `本地目录: ${localStore.getRoot()} | 上次同步: ${state.lastSyncTime ?? "从未"} | 已追踪对话: ${Object.keys(state.conversations).length}`
      );
    }),
    vscode.commands.registerCommand("cursorChronicle.refreshConversations", () => convTree.refresh()),
    vscode.commands.registerCommand("cursorChronicle.refreshSkills", () => skillsTree.refresh()),

    vscode.commands.registerCommand("cursorChronicle.syncOneConversation", async (node: ConversationNode) => {
      await syncSingleConversationFromFile(context, localStore, node, syncState, convTree);
    }),
    vscode.commands.registerCommand("cursorChronicle.exportOneConversation", async (node: ConversationNode) => {
      const dest = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.basename(node.entry.filePath)),
        filters: { Markdown: ["md"] },
      });
      if (!dest) return;
      const text = await localStore.readFileText(node.entry.filePath);
      await vscode.workspace.fs.writeFile(dest, encoder.encode(text));
      void vscode.window.showInformationMessage(`已导出: ${dest.fsPath}`);
    }),

    vscode.commands.registerCommand("cursorChronicle.syncOneSkill", async (node: SkillNode) => {
      await syncSingleSkill(context, node.skill, localStore, syncState, skillsTree);
    }),
    vscode.commands.registerCommand("cursorChronicle.chooseInstallRemoteSkill", async (remote: RemoteSkillMeta) => {
      const token = await context.secrets.get(TOKEN_KEY);
      const repository = vscode.workspace
        .getConfiguration("cursorChronicle")
        .get<string>("github.repository", "");
      if (!token || !repository) {
        void vscode.window.showErrorMessage("请先配置 GitHub。");
        return;
      }
      const items: Array<{ label: string; target: "user" | "project" | "remote-user" }> = [
        { label: "安装到本地用户级 (~/.cursor/skills/)", target: "user" },
      ];
      if (isRemoteSession()) {
        items.push({ label: "安装到远端用户级 (~/.cursor/skills/)", target: "remote-user" });
        items.push({ label: "安装到远端项目级 (.cursor/skills/)", target: "project" });
      } else {
        items.push({ label: "安装到当前工作区 (.cursor/skills/)", target: "project" });
      }
      const pick = await vscode.window.showQuickPick(items, { title: `安装技能: ${remote.name}` });
      if (!pick) return;
      try {
        const remoteHome = await detectRemoteHome();
        const github = new GitHubSyncService(token);
        const installer = new SkillsInstaller(github, remoteHome);
        await installer.installFromRepo(repository, remote.name, pick.target);
        void vscode.window.showInformationMessage(`已安装: ${remote.name}`);
        skillsTree.refresh();
        await collectService.collectAll();
        convTree.refresh();
      } catch (e) {
        void vscode.window.showErrorMessage(`安装失败: ${e instanceof Error ? e.message : e}`);
      }
    }),

    vscode.commands.registerCommand("cursorChronicle.manageSkills", async () => {
      logDebug("manageSkills: opening skills management panel");
      const token = await context.secrets.get(TOKEN_KEY);
      const repository = vscode.workspace
        .getConfiguration("cursorChronicle")
        .get<string>("github.repository", "");
      if (!token || !repository) {
        logWarn("manageSkills: GitHub not configured");
        void vscode.window.showErrorMessage("请先配置 GitHub (侧边栏 → Configure GitHub)。");
        return;
      }
      try {
        const remoteHome = await detectRemoteHome();
        const github = new GitHubSyncService(token);
        const installer = new SkillsInstaller(github, remoteHome);
        const repoRef = github.parseRepo(repository);
        const skills = await github.listRemoteSkills(repoRef);
        const installedLocalUser = await installer.listInstalled("user");
        const installedRemoteUser = await installer.listInstalled("remote-user");
        const installedProject = await installer.listInstalled("project");
        const refreshPanelCtx = async () => {
          const [lu, ru, proj] = await Promise.all([
            installer.listInstalled("user"),
            installer.listInstalled("remote-user"),
            installer.listInstalled("project"),
          ]);
          panel.updateCtx({
            skills,
            installed: { localUser: [...lu], remoteUser: [...ru], project: [...proj] },
            isRemote: isRemoteSession(),
            remoteHost: getRemoteHost(),
          });
        };

        const panel = new SkillsPickerPanel(
          async ({ skill, target }) => {
            try {
              await installer.installFromRepo(repository, skill, target);
              void vscode.window.showInformationMessage(`已安装: ${skill}`);
              skillsTree.refresh();
            } catch (e) {
              void vscode.window.showErrorMessage(`安装失败: ${e instanceof Error ? e.message : e}`);
            }
            await refreshPanelCtx();
          },
          async ({ skill, target }) => {
            try {
              await installer.uninstall(skill, target);
              void vscode.window.showInformationMessage(`已卸载: ${skill}`);
              skillsTree.refresh();
            } catch (e) {
              void vscode.window.showErrorMessage(`卸载失败: ${e instanceof Error ? e.message : e}`);
            }
            await refreshPanelCtx();
          }
        );
        panel.show({
          skills,
          installed: {
            localUser: [...installedLocalUser],
            remoteUser: [...installedRemoteUser],
            project: [...installedProject],
          },
          isRemote: isRemoteSession(),
          remoteHost: getRemoteHost(),
        });
      } catch (e) {
        logError("manageSkills: failed to load skills", e);
        void vscode.window.showErrorMessage(`加载 Skills 失败: ${e instanceof Error ? e.message : e}`);
      }
    }),

    vscode.commands.registerCommand("cursorChronicle.importSkill", async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { Markdown: ["md"] },
        title: "Import Skill from Markdown",
      });
      if (!uris || uris.length === 0) return;

      const uri = uris[0];
      const defaultName = path.basename(uri.fsPath, ".md").toLowerCase().replace(/\s+/g, "-");
      const skillName = await vscode.window.showInputBox({
        prompt: "Skill name (will create directory under ~/.cursor/skills/)",
        value: defaultName,
        placeHolder: defaultName,
      });
      if (!skillName) return;

      try {
        const remoteHome = await detectRemoteHome();
        const cursorHome = remoteHome?.fsPath ?? (process.env.HOME ?? process.env.USERPROFILE ?? "");
        const skillDir = path.join(cursorHome, ".cursor", "skills", skillName);
        await fs.mkdir(skillDir, { recursive: true });

        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = new TextDecoder().decode(bytes);
        await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");

        skillsTree.refresh();
        void vscode.window.showInformationMessage(`已导入 Skill: ${skillName} → ~/.cursor/skills/${skillName}/`);
      } catch (e) {
        logError(`importSkill: failed`, e);
        void vscode.window.showErrorMessage(`导入 Skill 失败: ${e instanceof Error ? e.message : e}`);
      }
    }),

    vscode.commands.registerCommand("cursorChronicle.importConversation", async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: { Markdown: ["md"] },
        title: "Import Conversations from Markdown",
      });
      if (!uris || uris.length === 0) return;

      const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? "imported";
      const projectName = await vscode.window.showInputBox({
        prompt: "Project name for imported conversations",
        value: workspaceName,
        placeHolder: workspaceName,
      });
      if (!projectName) return;

      let imported = 0;
      for (const uri of uris) {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const content = new TextDecoder().decode(bytes);
          const fileName = path.basename(uri.fsPath);
          await localStore.importConversationFile(projectName, fileName, content);
          imported++;
        } catch (e) {
          logError(`importConversation: failed to import ${uri.fsPath}`, e);
        }
      }
      convTree.refresh();
      void vscode.window.showInformationMessage(`已导入 ${imported} 个对话到 "${projectName}"`);
    }),

    vscode.commands.registerCommand("cursorChronicle.exportConversations", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showErrorMessage("请先打开一个项目工作区。");
        return;
      }
      const config = vscode.workspace.getConfiguration("cursorChronicle");
      const relPath = config.get<string>("export.localPath", ".cursor-chronicle/exports");
      const outputUri = vscode.Uri.joinPath(folder.uri, relPath);
      await vscode.workspace.fs.createDirectory(outputUri);
      let n = 0;
      for (const entry of await localStore.listConversations()) {
        const text = await localStore.readFileText(entry.filePath);
        const sub = vscode.Uri.joinPath(outputUri, entry.projectName);
        await vscode.workspace.fs.createDirectory(sub);
        const dest = vscode.Uri.joinPath(sub, path.basename(entry.filePath));
        await vscode.workspace.fs.writeFile(dest, encoder.encode(text));
        n += 1;
      }
      void vscode.window.showInformationMessage(`已导出 ${n} 个文件到 ${relPath}`);
    })
  );

  const token = await context.secrets.get(TOKEN_KEY);
  const repo = vscode.workspace.getConfiguration("cursorChronicle").get<string>("github.repository", "");
  if (!token || !repo) {
    const action = await vscode.window.showInformationMessage(
      "Cursor Chronicle: 首次使用，请配置 GitHub 仓库和 Token。",
      "立即配置"
    );
    if (action === "立即配置") {
      const lang = vscode.workspace.getConfiguration("cursorChronicle").get<"zh-CN" | "en">("language", "zh-CN");
      settingsPanel.show(readSettings(), await getTokenMask(context), lang);
    }
  }

  void collectService
    .collectAll()
    .then(() => {
      convTree.refresh();
      skillsTree.refresh();
      logInfo("Initial collection completed");
    })
    .catch((e) => {
      logError("Initial collection failed (non-fatal)", e);
    });

  restartAutoSync(runCollectAndSync);
  logInfo("Cursor Chronicle activated");
}

export function deactivate(): void {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = undefined;
  }
}

function updateStatusBar(state: "idle" | "syncing" | "synced" | "error"): void {
  const map = {
    idle: { text: "$(sync) Chronicle", tooltip: "Click to view sync status" },
    syncing: { text: "$(sync~spin) Collecting…", tooltip: "Collect + sync" },
    synced: { text: "$(check) Synced", tooltip: "Last sync completed" },
    error: { text: "$(error) Sync failed", tooltip: "Last sync failed" },
  };
  statusBar.text = map[state].text;
  statusBar.tooltip = map[state].tooltip;
}

async function getTokenMask(context: vscode.ExtensionContext): Promise<string> {
  const token = await context.secrets.get(TOKEN_KEY);
  if (!token) return "";
  if (token.length <= 8) return "●".repeat(token.length);
  return token.slice(0, 4) + "●".repeat(Math.min(token.length - 8, 20)) + token.slice(-4);
}

async function refreshConfiguredContext(context: vscode.ExtensionContext): Promise<void> {
  const token = await context.secrets.get(TOKEN_KEY);
  const repo = vscode.workspace.getConfiguration("cursorChronicle").get<string>("github.repository", "");
  await vscode.commands.executeCommand("setContext", "cursorChronicle.configured", Boolean(token && repo));
}

function readSettings(): SettingsPayload {
  const c = vscode.workspace.getConfiguration("cursorChronicle");
  return {
    localProjectPath: c.get<string>("localProjectPath", "~/.cursor-chronicle"),
    repository: c.get<string>("github.repository", ""),
    branch: c.get<string>("github.branch", "master"),
    createRepoIfMissing: c.get<boolean>("github.createRepoIfMissing", false),
    visibility: c.get<"private" | "public">("github.defaultVisibility", "private"),
    autoSync: c.get<boolean>("autoSync.enabled", false),
    intervalMinutes: c.get<number>("autoSync.intervalMinutes", 10),
    syncConversations: c.get<boolean>("sync.conversations", true),
    syncSkills: c.get<boolean>("sync.skills", true),
  };
}

async function saveSettings(
  payload: SettingsPayload,
  token: string | undefined,
  context: vscode.ExtensionContext
): Promise<void> {
  const c = vscode.workspace.getConfiguration("cursorChronicle");
  const g = vscode.ConfigurationTarget.Global;
  await c.update("localProjectPath", payload.localProjectPath, g);
  await c.update("github.repository", payload.repository, g);
  await c.update("github.branch", payload.branch || "master", g);
  await c.update("github.createRepoIfMissing", payload.createRepoIfMissing, g);
  await c.update("github.defaultVisibility", payload.visibility, g);
  await c.update("autoSync.enabled", payload.autoSync, g);
  await c.update("autoSync.intervalMinutes", payload.intervalMinutes, g);
  await c.update("sync.conversations", payload.syncConversations, g);
  await c.update("sync.skills", payload.syncSkills, g);
  if (token?.trim()) await context.secrets.store(TOKEN_KEY, token.trim());
}

function restartAutoSync(runCollectAndSync: () => Promise<void>): void {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = undefined;
  }
  if (autoSyncDisposable) {
    autoSyncDisposable.dispose();
    autoSyncDisposable = undefined;
  }
  const c = vscode.workspace.getConfiguration("cursorChronicle");
  if (!c.get<boolean>("autoSync.enabled", false)) return;
  const ms = c.get<number>("autoSync.intervalMinutes", 10) * 60_000;
  autoSyncTimer = setInterval(() => void runCollectAndSync(), ms);
  autoSyncDisposable = {
    dispose: () => {
      if (autoSyncTimer) {
        clearInterval(autoSyncTimer);
        autoSyncTimer = undefined;
      }
    },
  };
}

async function executeGitHubSync(
  context: vscode.ExtensionContext,
  localStore: LocalStore,
  skillsCollector: SkillsCollector,
  syncState: SyncStateService,
  convTree: ConversationsTreeProvider,
  skillsTree: SkillsTreeProvider
): Promise<void> {
  logInfo("executeGitHubSync: starting");
  const settings = readSettings();
  const token = await context.secrets.get(TOKEN_KEY);
  if (!token) {
    void vscode.window.showErrorMessage("请先配置 GitHub Token。");
    return;
  }
  if (!settings.repository) {
    void vscode.window.showErrorMessage("请先配置 GitHub 仓库。");
    return;
  }

  const github = new GitHubSyncService(token);
  const repoRef = github.parseRepo(settings.repository);

  if (!repoVerified) {
    await github.ensureRepository(repoRef, settings.createRepoIfMissing, settings.visibility);
    repoVerified = true;
  }
  await github.assertRepositoryWritable(repoRef);

  if (settings.syncSkills) {
    await prepareSkillsForPublish(localStore, skillsCollector, github);
  }

  await localStore.gitConfigureRemote(token, repoRef.owner, repoRef.repo, settings.branch);
  const { committed, filesChanged } = await localStore.gitAddAndCommit("chore: sync conversations and skills");

  if (committed) {
    logInfo(`executeGitHubSync: committed ${filesChanged} files`);
  }
  await localStore.gitPush(settings.branch);

  await markAllAsSynced(localStore, skillsCollector, syncState, github);
  convTree.refresh();
  skillsTree.refresh();
  logInfo("executeGitHubSync: completed");
}

function md5(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

async function prepareSkillsForPublish(
  localStore: LocalStore,
  skillsCollector: SkillsCollector,
  github: GitHubSyncService
): Promise<void> {
  const merged = await mergeSkillsForIndex(skillsCollector, github);

  const prevIndex = await loadPreviousSkillsIndex(localStore);
  const metas: RemoteSkillMeta[] = [];
  let hasAnyChange = false;

  for (const skill of merged) {
    const dirName = github.skillRemoteDir(skill);
    const prevMeta = prevIndex.get(dirName);
    const prevHashes = prevMeta?.fileHashes ?? {};
    const curHashes: Record<string, string> = {};
    let skillChanged = false;

    for (const relativeFile of skill.files) {
      try {
        const content = await readSkillFile(skill, relativeFile);
        const hash = md5(content);
        curHashes[relativeFile] = hash;

        if (prevHashes[relativeFile] !== hash) {
          skillChanged = true;
          await localStore.writePublishSkill(dirName, relativeFile, content);
        }
      } catch {
        continue;
      }
    }

    const description = await extractLocalSkillDescription(skill);
    if (description !== (prevMeta?.description ?? "")) {
      skillChanged = true;
    }

    if (skillChanged) {
      hasAnyChange = true;
    }

    metas.push({
      name: dirName,
      description,
      updatedAt: skillChanged ? new Date().toISOString() : (prevMeta?.updatedAt ?? new Date().toISOString()),
      files: skill.files,
      fileHashes: curHashes,
    });
  }

  if (hasAnyChange || metas.length !== prevIndex.size) {
    const indexContent = JSON.stringify({ skills: metas }, null, 2);
    await localStore.writePublishSkillsIndex(indexContent);
  }
}

async function loadPreviousSkillsIndex(localStore: LocalStore): Promise<Map<string, RemoteSkillMeta>> {
  const map = new Map<string, RemoteSkillMeta>();
  const raw = await localStore.readPublishSkillsIndex();
  if (!raw) return map;
  try {
    const parsed = JSON.parse(raw) as { skills?: RemoteSkillMeta[] };
    if (Array.isArray(parsed.skills)) {
      for (const s of parsed.skills) map.set(s.name, s);
    }
  } catch { /* corrupted index, treat as empty */ }
  return map;
}

async function extractLocalSkillDescription(skill: SkillRecord): Promise<string> {
  try {
    const content = await readSkillFile(skill, "SKILL.md");
    return parseDescriptionFromSkillMd(content);
  } catch {
    return "";
  }
}

async function markAllAsSynced(
  localStore: LocalStore,
  skillsCollector: SkillsCollector,
  syncState: SyncStateService,
  github: GitHubSyncService
): Promise<void> {
  const state = await syncState.load();
  state.lastSyncTime = new Date().toISOString();

  for (const entry of await localStore.listConversations()) {
    state.conversations[entry.frontmatter.composerId] = "pushed";
  }
  const remoteHome = await detectRemoteHome();
  for (const skill of await skillsCollector.collect(remoteHome)) {
    state.files[`skills/${github.skillRemoteDir(skill)}/SKILL.md`] = "pushed";
  }

  await syncState.save(state);
}

async function gitCommitAndPush(
  context: vscode.ExtensionContext,
  localStore: LocalStore,
  message: string
): Promise<{ committed: boolean; filesChanged: number }> {
  const token = await context.secrets.get(TOKEN_KEY);
  const c = vscode.workspace.getConfiguration("cursorChronicle");
  const repository = c.get<string>("github.repository", "");
  const branch = c.get<string>("github.branch", "master");
  if (!token || !repository) {
    throw new Error("请先配置 GitHub。");
  }
  const github = new GitHubSyncService(token);
  const repoRef = github.parseRepo(repository);
  await github.assertRepositoryWritable(repoRef);
  await localStore.gitConfigureRemote(token, repoRef.owner, repoRef.repo, branch);
  const result = await localStore.gitAddAndCommit(message);
  await localStore.gitPush(branch);
  return result;
}

async function syncSingleConversationFromFile(
  context: vscode.ExtensionContext,
  localStore: LocalStore,
  node: ConversationNode,
  syncState: SyncStateService,
  convTree: ConversationsTreeProvider
): Promise<void> {
  try {
    await gitCommitAndPush(
      context, localStore,
      `docs: sync ${node.entry.frontmatter.composerId}`
    );
    const state = await syncState.load();
    state.conversations[node.entry.frontmatter.composerId] = "pushed";
    await syncState.save(state);
    convTree.refresh();
    void vscode.window.showInformationMessage(`已同步: ${path.basename(node.entry.filePath)}`);
  } catch (e) {
    void vscode.window.showErrorMessage(formatSyncError(e));
  }
}

async function syncSingleSkill(
  context: vscode.ExtensionContext,
  skill: SkillRecord,
  localStore: LocalStore,
  syncState: SyncStateService,
  skillsTree: SkillsTreeProvider
): Promise<void> {
  try {
    const github = new GitHubSyncService((await context.secrets.get(TOKEN_KEY))!);
    const dirName = github.skillRemoteDir(skill);
    for (const relativeFile of skill.files) {
      try {
        const content = await readSkillFile(skill, relativeFile);
        await localStore.writePublishSkill(dirName, relativeFile, content);
      } catch {
        continue;
      }
    }

    await gitCommitAndPush(
      context, localStore,
      `chore: sync skill ${skill.skillName}`
    );
    const state = await syncState.load();
    state.files[`skills/${dirName}/SKILL.md`] = "pushed";
    await syncState.save(state);
    skillsTree.refresh();
    void vscode.window.showInformationMessage(`已同步 Skill: ${skill.skillName}`);
  } catch (e) {
    void vscode.window.showErrorMessage(formatSyncError(e));
  }
}
