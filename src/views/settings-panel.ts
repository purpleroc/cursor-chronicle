import * as vscode from "vscode";
import { logDebug, logError, logInfo, logWarn } from "../utils/logger";

export interface SettingsPayload {
  localProjectPath: string;
  repository: string;
  branch: string;
  createRepoIfMissing: boolean;
  visibility: "private" | "public";
  autoSync: boolean;
  intervalMinutes: number;
  syncConversations: boolean;
  syncSkills: boolean;
}

type TokenType = "classic" | "fine-grained" | "unknown";
type Lang = "zh-CN" | "en";

const i18n: Record<Lang, Record<string, string>> = {
  "zh-CN": {
    headerTitle: "Cursor Chronicle",
    headerDesc: "将对话记录和 Skills 自动备份到 GitHub 仓库",
    localStorageStep: "本地存储",
    localPathLabel: "Chronicle 本地目录",
    localPathHint: '对话记录和 Skills 镜像的本地存储路径。支持 <b>~</b> 展开为用户目录。修改后需重新收集。',
    githubStep: "GitHub 连接",
    connected: "已连接",
    notConnected: "未连接",
    tokenLabel: "Personal Access Token",
    testBtn: "验证",
    tokenHint: '验证时会自动识别 Token 类型。Classic Token: 适合自动创建仓库（需 <b>repo</b>）。Fine-grained Token: 适合最小权限（需 <b>Contents: Read and Write</b>，并授予目标仓库权限）。<br/>创建入口: https://github.com/settings/tokens (Classic) / https://github.com/settings/personal-access-tokens/new (Fine-grained)',
    repoLabel: "目标仓库 (owner/repo)",
    branchLabel: "同步分支",
    branchHint: "验证 Token 后自动加载远程分支列表。保存时自动切换到所选分支。",
    createRepoLabel: "自动创建仓库",
    visibilityLabel: "仓库可见性",
    syncStep: "同步配置",
    autoSyncLabel: "自动同步",
    autoSyncDesc: "按设定间隔自动将数据同步到 GitHub",
    intervalLabel: "同步间隔",
    scopeLabel: "同步范围",
    scopeConvLabel: "对话记录",
    scopeConvDesc: "AI Conversations",
    scopeSkillLabel: "Skills",
    scopeSkillDesc: "Custom Agent Skills",
    saveBtn: "保存设置",
    savedMsg: "设置已保存！",
    testing: "验证中...",
    tokenMissing: "请先输入新 Token",
    repoFormatError: "目标仓库格式必须是 owner/repo",
    min5: "5 分钟",
    min10: "10 分钟",
    min30: "30 分钟",
    min60: "60 分钟",
  },
  en: {
    headerTitle: "Cursor Chronicle",
    headerDesc: "Auto-backup conversations and Skills to GitHub",
    localStorageStep: "Local Storage",
    localPathLabel: "Chronicle Local Directory",
    localPathHint: 'Local storage path for conversations and Skills mirror. Supports <b>~</b> expansion. Re-collect after changing.',
    githubStep: "GitHub Connection",
    connected: "Connected",
    notConnected: "Not Connected",
    tokenLabel: "Personal Access Token",
    testBtn: "Verify",
    tokenHint: 'Token type is auto-detected. Classic Token: suitable for auto-creating repos (needs <b>repo</b> scope). Fine-grained Token: least privilege (needs <b>Contents: Read and Write</b>).<br/>Create: https://github.com/settings/tokens (Classic) / https://github.com/settings/personal-access-tokens/new (Fine-grained)',
    repoLabel: "Target Repository (owner/repo)",
    branchLabel: "Sync Branch",
    branchHint: "Remote branches load after token verification. Saving will auto-switch to the selected branch.",
    createRepoLabel: "Auto-create repository",
    visibilityLabel: "Repository Visibility",
    syncStep: "Sync Settings",
    autoSyncLabel: "Auto Sync",
    autoSyncDesc: "Automatically sync data to GitHub at set intervals",
    intervalLabel: "Sync Interval",
    scopeLabel: "Sync Scope",
    scopeConvLabel: "Conversations",
    scopeConvDesc: "AI Conversations",
    scopeSkillLabel: "Skills",
    scopeSkillDesc: "Custom Agent Skills",
    saveBtn: "Save Settings",
    savedMsg: "Settings saved!",
    testing: "Verifying...",
    tokenMissing: "Please enter a new Token first",
    repoFormatError: "Repository format must be owner/repo",
    min5: "5 min",
    min10: "10 min",
    min30: "30 min",
    min60: "60 min",
  },
};

function t(lang: Lang, key: string): string {
  return i18n[lang]?.[key] ?? i18n["en"][key] ?? key;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function detectTokenType(token: string): TokenType {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_")) return "classic";
  return "unknown";
}

async function withTimeout<T>(p: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await Promise.race<T>([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ]);
}

export class SettingsPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onSave: (payload: SettingsPayload, token?: string) => Promise<void>,
    private readonly onLanguageChange?: (lang: Lang) => void
  ) {}

  show(initial: SettingsPayload, tokenMask: string, lang: Lang = "zh-CN"): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.panel.webview.postMessage({ type: "setData", data: initial, tokenMask, lang });
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "cursorChronicleSettings",
      "Cursor Chronicle — Settings",
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message) => {
      try {
        if (message.type === "uiLog") {
          logDebug(`SettingsPanel.webview: ${String(message.msg ?? "")}`);
          return;
        }
        if (message.type === "uiError") {
          logError(`SettingsPanel.webview: ${String(message.msg ?? "unknown error")}`);
          return;
        }
        if (message.type === "langChange") {
          const newLang = message.lang === "en" ? "en" : "zh-CN";
          await vscode.workspace.getConfiguration("cursorChronicle").update("language", newLang, vscode.ConfigurationTarget.Global);
          this.onLanguageChange?.(newLang);
          return;
        }
        if (message.type === "save") {
          const rawToken = message.token as string | undefined;
          const isPlaceholder = rawToken === "__MASKED__";
          await this.onSave(message.payload as SettingsPayload, isPlaceholder ? undefined : rawToken);
          this.panel?.webview.postMessage({ type: "saved" });
          return;
        }
        if (message.type !== "testToken") return;
        const start = Date.now();

        const rawToken = message.token as string;
        const payload = (message.payload as Partial<SettingsPayload> | undefined) ?? {};
        const createRepoIfMissing = Boolean(payload.createRepoIfMissing);
        const repository = String(payload.repository ?? "").trim();
        const visibility = payload.visibility === "public" ? "public" : "private";
        logInfo(`SettingsPanel.testToken: start repository="${repository}" createRepo=${createRepoIfMissing}`);

        if (!rawToken || rawToken === "__MASKED__") {
          logWarn("SettingsPanel.testToken: missing new token");
          this.panel?.webview.postMessage({ type: "testResult", ok: false, msg: t(message.lang ?? "zh-CN", "tokenMissing") });
          return;
        }

        const { Octokit } = await import("@octokit/rest");
        const octokit = new Octokit({ auth: rawToken });
        logDebug("SettingsPanel.testToken: Octokit initialized");
        const user = await withTimeout(
          octokit.users.getAuthenticated(),
          15_000,
          "验证超时（15s），请检查网络后重试"
        );
        logInfo(`SettingsPanel.testToken: authenticated user=${user.data.login}`);

        const tokenType = detectTokenType(rawToken);
        const tokenTypeLabel = tokenType === "classic"
          ? "Classic Token"
          : tokenType === "fine-grained"
            ? "Fine-grained Token"
            : "Unknown";
        let warning: string | undefined;
        let messageText = `✓ ${user.data.login} | ${tokenTypeLabel}`;
        let branches: string[] = [];

        if (repository) {
          const [owner, repo] = repository.split("/");
          if (!owner || !repo) {
            logWarn(`SettingsPanel.testToken: invalid repository format "${repository}"`);
            this.panel?.webview.postMessage({ type: "testResult", ok: false, msg: t(message.lang ?? "zh-CN", "repoFormatError") });
            return;
          }
          try {
            logDebug(`SettingsPanel.testToken: checking repo permission ${owner}/${repo}`);
            const repoInfo = await withTimeout(
              octokit.repos.get({ owner, repo }),
              15_000,
              "仓库权限检查超时（15s）"
            );
            const perms = repoInfo.data.permissions;
            const canPush = Boolean(perms?.push || perms?.admin || perms?.maintain);
            if (!canPush) {
              const permText = perms
                ? [perms.admin ? "admin" : "", perms.maintain ? "maintain" : "", perms.push ? "push" : "", perms.triage ? "triage" : "", perms.pull ? "pull" : ""].filter(Boolean).join(", ")
                : "unknown";
              logWarn(`SettingsPanel.testToken: no write permission for ${owner}/${repo} perms=${permText}`);
              this.panel?.webview.postMessage({
                type: "testResult", ok: false,
                msg: `验证失败: 对目标仓库 ${owner}/${repo} 没有写权限（当前权限: ${permText}）`
              });
              return;
            }
            logInfo(`SettingsPanel.testToken: repo write permission OK for ${owner}/${repo}`);
            messageText += ` | Repo OK (${owner}/${repo})`;

            try {
              const branchList = await withTimeout(
                octokit.repos.listBranches({ owner, repo, per_page: 100 }),
                15_000,
                "获取分支列表超时（15s）"
              );
              branches = branchList.data.map((b) => b.name);
              logDebug(`SettingsPanel.testToken: listBranches returned ${branches.length} branches: ${branches.join(", ")}`);
            } catch (branchErr) {
              logWarn(`SettingsPanel.testToken: listBranches failed, trying git refs fallback: ${branchErr instanceof Error ? branchErr.message : branchErr}`);
              try {
                const refs = await withTimeout(
                  octokit.git.listMatchingRefs({ owner, repo, ref: "heads/" }),
                  15_000,
                  "获取分支引用超时（15s）"
                );
                branches = refs.data.map((r) => r.ref.replace("refs/heads/", ""));
                logDebug(`SettingsPanel.testToken: git refs fallback returned ${branches.length} branches: ${branches.join(", ")}`);
              } catch (refErr) {
                logWarn(`SettingsPanel.testToken: git refs fallback also failed: ${refErr instanceof Error ? refErr.message : refErr}`);
                warning = (warning ? warning + "\n" : "") + "⚠ 无法获取分支列表，请检查 Token 权限。";
              }
            }
          } catch (repoErr: unknown) {
            const status = (repoErr as { status?: number }).status;
            if (status === 404) {
              logWarn(`SettingsPanel.testToken: repo not found or inaccessible ${owner}/${repo}`);
              if (!createRepoIfMissing) {
                this.panel?.webview.postMessage({
                  type: "testResult", ok: false,
                  msg: `验证失败: 目标仓库不存在或当前 Token 无访问权限 (${owner}/${repo})`
                });
                return;
              }
              if (owner !== user.data.login) {
                this.panel?.webview.postMessage({
                  type: "testResult", ok: false,
                  msg: `验证失败: 仅支持自动创建当前登录用户 (${user.data.login}) 名下仓库，当前为 ${owner}/${repo}`
                });
                return;
              }
              logInfo(`SettingsPanel.testToken: creating repository ${owner}/${repo} (${visibility})`);
              try {
                await withTimeout(
                  octokit.repos.createForAuthenticatedUser({ name: repo, private: visibility === "private", auto_init: false }),
                  15_000, "创建仓库超时（15s）"
                );
                const createdRepo = await withTimeout(octokit.repos.get({ owner, repo }), 15_000, "新建仓库权限检查超时（15s）");
                const createdPerms = createdRepo.data.permissions;
                const createdCanPush = Boolean(createdPerms?.push || createdPerms?.admin || createdPerms?.maintain);
                if (!createdCanPush) {
                  const createdPermText = createdPerms
                    ? [createdPerms.admin ? "admin" : "", createdPerms.maintain ? "maintain" : "", createdPerms.push ? "push" : "", createdPerms.triage ? "triage" : "", createdPerms.pull ? "pull" : ""].filter(Boolean).join(", ")
                    : "unknown";
                  this.panel?.webview.postMessage({
                    type: "testResult", ok: false,
                    msg: `验证失败: 仓库已创建但无写权限 (${owner}/${repo}, 当前权限: ${createdPermText})`
                  });
                  return;
                }
                logInfo(`SettingsPanel.testToken: repo created and write permission OK for ${owner}/${repo}`);
                messageText += ` | Repo created: ${owner}/${repo}`;
              } catch (createErr: unknown) {
                const createMsg = createErr instanceof Error ? createErr.message : String(createErr);
                if (!createMsg.includes("name already exists")) {
                  logError("SettingsPanel.testToken: create repository failed", createErr);
                  this.panel?.webview.postMessage({
                    type: "testResult", ok: false,
                    msg: `验证失败: 自动创建仓库失败 (${owner}/${repo}) - ${createMsg}`
                  });
                  return;
                }
                logWarn(`SettingsPanel.testToken: repo already exists, fallback permission check ${owner}/${repo}`);
                try {
                  const existingRepo = await withTimeout(octokit.repos.get({ owner, repo }), 15_000, "已存在仓库权限检查超时（15s）");
                  const existingPerms = existingRepo.data.permissions;
                  const existingCanPush = Boolean(existingPerms?.push || existingPerms?.admin || existingPerms?.maintain);
                  if (!existingCanPush) {
                    const existingPermText = existingPerms
                      ? [existingPerms.admin ? "admin" : "", existingPerms.maintain ? "maintain" : "", existingPerms.push ? "push" : "", existingPerms.triage ? "triage" : "", existingPerms.pull ? "pull" : ""].filter(Boolean).join(", ")
                      : "unknown";
                    this.panel?.webview.postMessage({
                      type: "testResult", ok: false,
                      msg: `验证失败: 仓库已存在但无写权限 (${owner}/${repo}, 当前权限: ${existingPermText})`
                    });
                    return;
                  }
                  messageText += ` | Repo OK (existing): ${owner}/${repo}`;
                } catch (existingErr: unknown) {
                  const existingMsg = existingErr instanceof Error ? existingErr.message : String(existingErr);
                  logError("SettingsPanel.testToken: existing repo permission fallback failed", existingErr);
                  this.panel?.webview.postMessage({
                    type: "testResult", ok: false,
                    msg: `验证失败: 仓库已存在，但无法验证写权限 (${owner}/${repo}) - ${existingMsg}`
                  });
                  return;
                }
              }
            } else {
              logError("SettingsPanel.testToken: repo permission check failed", repoErr);
              throw repoErr;
            }
          }
        }

        if (branches.length > 0) {
          messageText += ` | Branches: ${branches.join(", ")}`;
        }
        logInfo(`SettingsPanel.testToken: success (${Date.now() - start}ms), branches=${branches.length}`);
        this.panel?.webview.postMessage({
          type: "testResult", ok: true, msg: messageText, warning, branches,
        });
      } catch (e) {
        logError("SettingsPanel.testToken: failed", e);
        this.panel?.webview.postMessage({ type: "testResult", ok: false, msg: `验证失败: ${e instanceof Error ? e.message : e}` });
      }
    });

    this.panel.webview.html = this.render(initial, tokenMask, lang);
  }

  private render(initial: SettingsPayload, tokenMask: string, lang: Lang): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';`;
    const localPathValue = escapeHtml(initial.localProjectPath);
    const repoValue = escapeHtml(initial.repository);
    const branchValue = escapeHtml(initial.branch || "master");
    const tokenPlaceholder = tokenMask
      ? escapeHtml(tokenMask) + " (clear to change)"
      : "ghp_xxxxxxxxxxxxxxxxxxxx";

    const I18N_JSON = JSON.stringify(i18n);

    return `<!doctype html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --fg-dim: var(--vscode-descriptionForeground, #888);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-border: var(--vscode-input-border, #555);
      --input-fg: var(--vscode-input-foreground, #ccc);
      --focus-border: var(--vscode-focusBorder, #0078d4);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #fff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --btn-sec-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --btn-sec-fg: var(--vscode-button-secondaryForeground, #ccc);
      --btn-sec-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
      --card-bg: var(--vscode-editorWidget-background, #252526);
      --card-border: var(--vscode-editorWidget-border, #454545);
      --divider: var(--vscode-panel-border, #3e3e3e);
      --ok: #4ec9b0;
      --err: #f48771;
      --warn: #cca700;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: 13px; color: var(--fg); background: var(--bg);
      padding: 0; display: flex; justify-content: center;
    }
    .page { width: 100%; max-width: 580px; padding: 32px 24px 48px; }
    .header { margin-bottom: 28px; display: flex; align-items: flex-start; justify-content: space-between; }
    .header-left {}
    .header-left h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.3px; margin-bottom: 6px; }
    .header-left p { color: var(--fg-dim); font-size: 13px; line-height: 1.5; }
    .lang-switch {
      display: inline-flex; border: 1px solid var(--input-border); border-radius: 4px; overflow: hidden; flex-shrink: 0; margin-top: 4px;
    }
    .lang-btn {
      padding: 4px 10px; font-size: 11px; cursor: pointer; border: none;
      background: var(--input-bg); color: var(--fg-dim); transition: all 0.15s;
    }
    .lang-btn:first-child { border-right: 1px solid var(--input-border); }
    .lang-btn.active { background: var(--btn-bg); color: var(--btn-fg); }
    .lang-btn:hover:not(.active) { color: var(--fg); }
    .card {
      background: var(--card-bg); border: 1px solid var(--card-border);
      border-radius: 8px; margin-bottom: 16px; overflow: hidden;
    }
    .card-head {
      display: flex; align-items: center; gap: 8px;
      padding: 14px 18px; border-bottom: 1px solid var(--divider);
      font-size: 13px; font-weight: 600;
    }
    .card-head .step {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; border-radius: 50%;
      background: var(--btn-bg); color: var(--btn-fg);
      font-size: 11px; font-weight: 700; flex-shrink: 0;
    }
    .card-head .badge {
      margin-left: auto; font-size: 11px; font-weight: 500;
      padding: 2px 8px; border-radius: 10px;
    }
    .badge.ok { background: rgba(78,201,176,0.15); color: var(--ok); }
    .badge.none { background: rgba(244,135,113,0.12); color: var(--err); }
    .card-body { padding: 18px; }
    .fg { margin-bottom: 16px; }
    .fg:last-child { margin-bottom: 0; }
    .fg > label { display: block; font-size: 12px; font-weight: 500; color: var(--fg-dim); margin-bottom: 5px; letter-spacing: 0.2px; }
    .fg .hint { font-size: 11px; color: var(--fg-dim); margin-top: 4px; line-height: 1.4; opacity: 0.8; }
    input[type="text"], input[type="password"], select {
      width: 100%; padding: 7px 10px; font-size: 13px; border-radius: 4px;
      background: var(--input-bg); color: var(--input-fg);
      border: 1px solid var(--input-border); outline: none; transition: border-color 0.15s;
    }
    input:focus, select:focus { border-color: var(--focus-border); }
    .input-row { display: flex; gap: 6px; }
    .input-row input { flex: 1; }
    .input-row button { flex-shrink: 0; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 7px 16px; font-size: 12px; font-weight: 500;
      border-radius: 4px; cursor: pointer; border: none; transition: background 0.15s, opacity 0.15s;
    }
    .btn:active { opacity: 0.85; }
    .btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
    .btn-primary:hover { background: var(--btn-hover); }
    .btn-secondary { background: var(--btn-sec-bg); color: var(--btn-sec-fg); }
    .btn-secondary:hover { background: var(--btn-sec-hover); }
    .btn-save { width: 100%; padding: 10px; font-size: 13px; font-weight: 600; border-radius: 6px; margin-top: 8px; }
    .toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; }
    .toggle-row .label { font-size: 13px; font-weight: 500; }
    .toggle-row .desc { font-size: 11px; color: var(--fg-dim); margin-top: 2px; }
    .switch { position: relative; width: 40px; height: 22px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute; inset: 0; cursor: pointer;
      background: var(--input-border); border-radius: 11px; transition: background 0.2s;
    }
    .slider::before {
      content: ""; position: absolute; left: 3px; top: 3px;
      width: 16px; height: 16px; border-radius: 50%;
      background: var(--fg); transition: transform 0.2s;
    }
    .switch input:checked + .slider { background: var(--btn-bg); }
    .switch input:checked + .slider::before { transform: translateX(18px); }
    .inline { display: flex; gap: 12px; align-items: flex-start; }
    .inline > * { flex: 1; }
    .ck { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; padding: 6px 0; user-select: none; }
    .ck input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--btn-bg); cursor: pointer; flex-shrink: 0; }
    .pills { display: flex; gap: 6px; flex-wrap: wrap; }
    .pill {
      padding: 5px 14px; font-size: 12px; border-radius: 14px;
      background: var(--input-bg); color: var(--fg-dim);
      border: 1px solid var(--input-border); cursor: pointer; transition: all 0.15s; user-select: none;
    }
    .pill.active { background: var(--btn-bg); color: var(--btn-fg); border-color: var(--btn-bg); }
    .pill:hover:not(.active) { border-color: var(--focus-border); color: var(--fg); }
    .sep { border: none; border-top: 1px solid var(--divider); margin: 16px 0; }
    .scope-grid { display: flex; gap: 12px; }
    .scope-card {
      flex: 1; display: flex; align-items: center; gap: 10px;
      padding: 12px 14px; border-radius: 6px;
      background: var(--input-bg); border: 1px solid var(--input-border);
      cursor: pointer; transition: border-color 0.15s; user-select: none;
    }
    .scope-card:hover { border-color: var(--focus-border); }
    .scope-card.on { border-color: var(--btn-bg); }
    .scope-card input { display: none; }
    .scope-icon { font-size: 20px; flex-shrink: 0; }
    .scope-label { font-size: 13px; font-weight: 500; }
    .scope-desc { font-size: 11px; color: var(--fg-dim); margin-top: 1px; }
    .toast {
      padding: 10px 14px; border-radius: 6px; font-size: 12px;
      margin-top: 12px; display: none; line-height: 1.4;
    }
    .toast.success { display: block; background: rgba(78,201,176,0.12); color: var(--ok); border: 1px solid rgba(78,201,176,0.3); }
    .toast.error { display: block; background: rgba(244,135,113,0.12); color: var(--err); border: 1px solid rgba(244,135,113,0.3); }
    .toast.info { display: block; background: rgba(204,167,0,0.1); color: var(--warn); border: 1px solid rgba(204,167,0,0.25); }
    .sub-section { padding-left: 4px; margin-top: 12px; }
    .sub-section.hidden { display: none; }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div class="header-left">
        <h1 data-i18n="headerTitle">${t(lang, "headerTitle")}</h1>
        <p data-i18n="headerDesc">${t(lang, "headerDesc")}</p>
      </div>
      <div class="lang-switch">
        <button class="lang-btn${lang === "zh-CN" ? " active" : ""}" data-lang="zh-CN">中文</button>
        <button class="lang-btn${lang === "en" ? " active" : ""}" data-lang="en">EN</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="step">1</span>
        <span data-i18n="localStorageStep">${t(lang, "localStorageStep")}</span>
      </div>
      <div class="card-body">
        <div class="fg">
          <label data-i18n="localPathLabel">${t(lang, "localPathLabel")}</label>
          <input id="localPath" type="text" value="${localPathValue}" placeholder="~/.cursor-chronicle" />
          <p class="hint" data-i18n-html="localPathHint">${t(lang, "localPathHint")}</p>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="step">2</span>
        <span data-i18n="githubStep">${t(lang, "githubStep")}</span>
        <span id="connBadge" class="badge ${tokenMask ? "ok" : "none"}" data-i18n="${tokenMask ? "connected" : "notConnected"}">${tokenMask ? t(lang, "connected") : t(lang, "notConnected")}</span>
      </div>
      <div class="card-body">
        <div class="fg">
          <label data-i18n="tokenLabel">${t(lang, "tokenLabel")}</label>
          <div class="input-row">
            <input id="token" type="password" placeholder="${tokenPlaceholder}" />
            <button class="btn btn-secondary" id="testBtn" data-i18n="testBtn">${t(lang, "testBtn")}</button>
          </div>
          <p class="hint" data-i18n-html="tokenHint">${t(lang, "tokenHint")}</p>
          <div id="testResult" class="toast"></div>
        </div>
        <div class="fg">
          <label data-i18n="repoLabel">${t(lang, "repoLabel")}</label>
          <input id="repo" type="text" value="${repoValue}" placeholder="your-username/cursor-chronicle-data" />
        </div>
        <div class="fg">
          <label data-i18n="branchLabel">${t(lang, "branchLabel")}</label>
          <select id="branch">
            <option value="${branchValue}" selected>${branchValue}</option>
          </select>
          <p class="hint" data-i18n-html="branchHint">${t(lang, "branchHint")}</p>
        </div>
        <div class="inline">
          <div class="fg">
            <label class="ck"><input id="createRepo" type="checkbox" ${initial.createRepoIfMissing ? "checked" : ""}/> <span data-i18n="createRepoLabel">${t(lang, "createRepoLabel")}</span></label>
          </div>
          <div class="fg">
            <label data-i18n="visibilityLabel">${t(lang, "visibilityLabel")}</label>
            <select id="visibility">
              <option value="private" ${initial.visibility === "private" ? "selected" : ""}>Private</option>
              <option value="public" ${initial.visibility === "public" ? "selected" : ""}>Public</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="step">3</span>
        <span data-i18n="syncStep">${t(lang, "syncStep")}</span>
      </div>
      <div class="card-body">
        <div class="toggle-row">
          <div>
            <div class="label" data-i18n="autoSyncLabel">${t(lang, "autoSyncLabel")}</div>
            <div class="desc" data-i18n="autoSyncDesc">${t(lang, "autoSyncDesc")}</div>
          </div>
          <label class="switch">
            <input id="autoSync" type="checkbox" ${initial.autoSync ? "checked" : ""}/>
            <span class="slider"></span>
          </label>
        </div>

        <div id="intervalSection" class="sub-section${initial.autoSync ? "" : " hidden"}">
          <label style="font-size:12px;color:var(--fg-dim);margin-bottom:8px;display:block;" data-i18n="intervalLabel">${t(lang, "intervalLabel")}</label>
          <div class="pills">
            <span class="pill${initial.intervalMinutes === 5 ? " active" : ""}" data-val="5" data-i18n="min5">${t(lang, "min5")}</span>
            <span class="pill${initial.intervalMinutes === 10 ? " active" : ""}" data-val="10" data-i18n="min10">${t(lang, "min10")}</span>
            <span class="pill${initial.intervalMinutes === 30 ? " active" : ""}" data-val="30" data-i18n="min30">${t(lang, "min30")}</span>
            <span class="pill${initial.intervalMinutes === 60 ? " active" : ""}" data-val="60" data-i18n="min60">${t(lang, "min60")}</span>
          </div>
        </div>

        <hr class="sep" />

        <label style="font-size:12px;color:var(--fg-dim);margin-bottom:10px;display:block;" data-i18n="scopeLabel">${t(lang, "scopeLabel")}</label>
        <div class="scope-grid">
          <label class="scope-card${initial.syncConversations ? " on" : ""}" id="scopeConv">
            <input id="syncConv" type="checkbox" ${initial.syncConversations ? "checked" : ""}/>
            <span class="scope-icon">&#128172;</span>
            <div>
              <div class="scope-label" data-i18n="scopeConvLabel">${t(lang, "scopeConvLabel")}</div>
              <div class="scope-desc" data-i18n="scopeConvDesc">${t(lang, "scopeConvDesc")}</div>
            </div>
          </label>
          <label class="scope-card${initial.syncSkills ? " on" : ""}" id="scopeSkill">
            <input id="syncSkills" type="checkbox" ${initial.syncSkills ? "checked" : ""}/>
            <span class="scope-icon">&#128736;</span>
            <div>
              <div class="scope-label" data-i18n="scopeSkillLabel">${t(lang, "scopeSkillLabel")}</div>
              <div class="scope-desc" data-i18n="scopeSkillDesc">${t(lang, "scopeSkillDesc")}</div>
            </div>
          </label>
        </div>
      </div>
    </div>

    <button class="btn btn-primary btn-save" id="saveBtn" data-i18n="saveBtn">${t(lang, "saveBtn")}</button>
    <div id="saveResult" class="toast"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const uiLog = (msg) => vscode.postMessage({ type: 'uiLog', msg });
    const uiError = (msg) => vscode.postMessage({ type: 'uiError', msg });
    const on = (id, event, handler) => {
      const el = $(id);
      if (!el) { uiError('missing element: ' + id); return; }
      el.addEventListener(event, handler);
    };

    const I18N = ${I18N_JSON};
    let currentLang = '${lang}';
    let hasExistingToken = ${tokenMask ? "true" : "false"};
    let selectedInterval = ${initial.intervalMinutes};
    uiLog('script initialized, lang=' + currentLang);

    window.addEventListener('error', (ev) => { uiError('window error: ' + (ev.message || 'unknown')); });

    function applyLang(lang) {
      currentLang = lang;
      const strings = I18N[lang] || I18N['en'];
      document.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.getAttribute('data-i18n');
        if (strings[key]) el.textContent = strings[key];
      });
      document.querySelectorAll('[data-i18n-html]').forEach((el) => {
        const key = el.getAttribute('data-i18n-html');
        if (strings[key]) el.innerHTML = strings[key];
      });
      document.querySelectorAll('.lang-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.lang === lang);
      });
      vscode.postMessage({ type: 'langChange', lang });
    }

    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.addEventListener('click', () => applyLang(btn.dataset.lang));
    });

    on('token', 'focus', () => {
      if (hasExistingToken && !$('token').value) {
        $('token').value = '__MASKED__';
        $('token').select();
      }
    });

    on('testBtn', 'click', () => {
      const token = $('token').value;
      $('testResult').className = 'toast info';
      $('testResult').textContent = I18N[currentLang]?.testing || 'Verifying...';
      $('testResult').style.display = 'block';
      vscode.postMessage({
        type: 'testToken', token, lang: currentLang,
        payload: {
          createRepoIfMissing: $('createRepo').checked,
          repository: $('repo').value,
          visibility: $('visibility').value
        }
      });
    });

    on('autoSync', 'change', () => {
      $('intervalSection').classList.toggle('hidden', !$('autoSync').checked);
    });

    document.querySelectorAll('.pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        selectedInterval = Number(pill.dataset.val);
      });
    });

    on('syncConv', 'change', () => { $('scopeConv').classList.toggle('on', $('syncConv').checked); });
    on('syncSkills', 'change', () => { $('scopeSkill').classList.toggle('on', $('syncSkills').checked); });

    on('saveBtn', 'click', () => {
      const tokenVal = $('token').value;
      vscode.postMessage({
        type: 'save',
        token: tokenVal || (hasExistingToken ? '__MASKED__' : undefined),
        payload: {
          localProjectPath: $('localPath').value,
          repository: $('repo').value,
          branch: $('branch').value || 'master',
          createRepoIfMissing: $('createRepo').checked,
          visibility: $('visibility').value,
          autoSync: $('autoSync').checked,
          intervalMinutes: selectedInterval,
          syncConversations: $('syncConv').checked,
          syncSkills: $('syncSkills').checked
        }
      });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'testResult') {
        const text = msg.warning ? (msg.msg + '\\n' + msg.warning) : msg.msg;
        $('testResult').className = msg.ok ? (msg.warning ? 'toast info' : 'toast success') : 'toast error';
        $('testResult').textContent = text;
        if (msg.ok) {
          $('connBadge').className = 'badge ok';
          $('connBadge').textContent = I18N[currentLang]?.connected || 'Connected';
        }
        if (msg.branches && msg.branches.length > 0) {
          const sel = $('branch');
          const curVal = sel.value;
          sel.innerHTML = '';
          msg.branches.forEach((b) => {
            const opt = document.createElement('option');
            opt.value = b;
            opt.textContent = b;
            if (b === curVal) opt.selected = true;
            sel.appendChild(opt);
          });
          if (!msg.branches.includes(curVal) && msg.branches.length > 0) {
            sel.value = msg.branches[0];
          }
          uiLog('branches loaded: ' + msg.branches.join(', '));
        } else if (msg.ok) {
          uiLog('no branches returned from remote');
        }
      } else if (msg.type === 'saved') {
        $('saveResult').className = 'toast success';
        $('saveResult').textContent = I18N[currentLang]?.savedMsg || 'Settings saved!';
        setTimeout(() => { $('saveResult').style.display = 'none'; }, 3000);
      } else if (msg.type === 'setData') {
        $('localPath').value = msg.data.localProjectPath || '~/.cursor-chronicle';
        $('repo').value = msg.data.repository || '';
        const branchSel = $('branch');
        const branchVal = msg.data.branch || 'master';
        if (!Array.from(branchSel.options).some((o) => o.value === branchVal)) {
          branchSel.innerHTML = '';
          const opt = document.createElement('option');
          opt.value = branchVal;
          opt.textContent = branchVal;
          branchSel.appendChild(opt);
        }
        branchSel.value = branchVal;
        $('createRepo').checked = msg.data.createRepoIfMissing;
        $('visibility').value = msg.data.visibility;
        $('autoSync').checked = msg.data.autoSync;
        $('intervalSection').classList.toggle('hidden', !msg.data.autoSync);
        selectedInterval = msg.data.intervalMinutes;
        document.querySelectorAll('.pill').forEach((p) => {
          p.classList.toggle('active', Number(p.dataset.val) === selectedInterval);
        });
        $('syncConv').checked = msg.data.syncConversations;
        $('syncSkills').checked = msg.data.syncSkills;
        $('scopeConv').classList.toggle('on', msg.data.syncConversations);
        $('scopeSkill').classList.toggle('on', msg.data.syncSkills);
        if (msg.tokenMask) {
          hasExistingToken = true;
          $('connBadge').className = 'badge ok';
          $('connBadge').textContent = I18N[currentLang]?.connected || 'Connected';
        }
        if (msg.lang) applyLang(msg.lang);
      }
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
