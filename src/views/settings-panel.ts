import * as vscode from "vscode";
import { logDebug, logError, logInfo, logWarn } from "../utils/logger";

export interface SettingsPayload {
  localProjectPath: string;
  repository: string;
  createRepoIfMissing: boolean;
  visibility: "private" | "public";
  autoSync: boolean;
  intervalMinutes: number;
  syncConversations: boolean;
  syncSkills: boolean;
}

type TokenType = "classic" | "fine-grained" | "unknown";

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
    private readonly onSave: (payload: SettingsPayload, token?: string) => Promise<void>
  ) {}

  show(initial: SettingsPayload, tokenMask: string): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.panel.webview.postMessage({ type: "setData", data: initial, tokenMask });
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
          this.panel?.webview.postMessage({ type: "testResult", ok: false, msg: "请先输入新 Token" });
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
            : "未知类型";
        let warning: string | undefined;
        let messageText = `验证成功！用户: ${user.data.login}｜Token 类型: ${tokenTypeLabel}`;

        if (repository) {
          const [owner, repo] = repository.split("/");
          if (!owner || !repo) {
            logWarn(`SettingsPanel.testToken: invalid repository format "${repository}"`);
            this.panel?.webview.postMessage({ type: "testResult", ok: false, msg: "目标仓库格式必须是 owner/repo" });
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
                ? [
                  perms.admin ? "admin" : "",
                  perms.maintain ? "maintain" : "",
                  perms.push ? "push" : "",
                  perms.triage ? "triage" : "",
                  perms.pull ? "pull" : "",
                ].filter(Boolean).join(", ")
                : "unknown";
              logWarn(`SettingsPanel.testToken: no write permission for ${owner}/${repo} perms=${permText}`);
              this.panel?.webview.postMessage({
                type: "testResult",
                ok: false,
                msg: `验证失败: 对目标仓库 ${owner}/${repo} 没有写权限（当前权限: ${permText}）`
              });
              return;
            }
            logInfo(`SettingsPanel.testToken: repo write permission OK for ${owner}/${repo}`);
            messageText += `｜仓库写入: OK (${owner}/${repo})`;
          } catch (repoErr: unknown) {
            const status = (repoErr as { status?: number }).status;
            if (status === 404) {
              logWarn(`SettingsPanel.testToken: repo not found or inaccessible ${owner}/${repo}`);
              if (!createRepoIfMissing) {
                this.panel?.webview.postMessage({
                  type: "testResult",
                  ok: false,
                  msg: `验证失败: 目标仓库不存在或当前 Token 无访问权限 (${owner}/${repo})`
                });
                return;
              }
              if (owner !== user.data.login) {
                this.panel?.webview.postMessage({
                  type: "testResult",
                  ok: false,
                  msg: `验证失败: 仅支持自动创建当前登录用户 (${user.data.login}) 名下仓库，当前为 ${owner}/${repo}`
                });
                return;
              }
              logInfo(`SettingsPanel.testToken: creating repository ${owner}/${repo} (${visibility})`);
              try {
                await withTimeout(
                  octokit.repos.createForAuthenticatedUser({
                    name: repo,
                    private: visibility === "private",
                    auto_init: false,
                  }),
                  15_000,
                  "创建仓库超时（15s）"
                );
                const createdRepo = await withTimeout(
                  octokit.repos.get({ owner, repo }),
                  15_000,
                  "新建仓库权限检查超时（15s）"
                );
                const createdPerms = createdRepo.data.permissions;
                const createdCanPush = Boolean(createdPerms?.push || createdPerms?.admin || createdPerms?.maintain);
                if (!createdCanPush) {
                  const createdPermText = createdPerms
                    ? [
                      createdPerms.admin ? "admin" : "",
                      createdPerms.maintain ? "maintain" : "",
                      createdPerms.push ? "push" : "",
                      createdPerms.triage ? "triage" : "",
                      createdPerms.pull ? "pull" : "",
                    ].filter(Boolean).join(", ")
                    : "unknown";
                  this.panel?.webview.postMessage({
                    type: "testResult",
                    ok: false,
                    msg: `验证失败: 仓库已创建但无写权限 (${owner}/${repo}, 当前权限: ${createdPermText})`
                  });
                  return;
                }
                logInfo(`SettingsPanel.testToken: repo created and write permission OK for ${owner}/${repo}`);
                messageText += `｜仓库已创建且可写: ${owner}/${repo}`;
              } catch (createErr: unknown) {
                const createMsg = createErr instanceof Error ? createErr.message : String(createErr);
                if (!createMsg.includes("name already exists")) {
                  logError("SettingsPanel.testToken: create repository failed", createErr);
                  this.panel?.webview.postMessage({
                    type: "testResult",
                    ok: false,
                    msg: `验证失败: 自动创建仓库失败 (${owner}/${repo}) - ${createMsg}`
                  });
                  return;
                }
                logWarn(`SettingsPanel.testToken: repo already exists, fallback permission check ${owner}/${repo}`);
                try {
                  const existingRepo = await withTimeout(
                    octokit.repos.get({ owner, repo }),
                    15_000,
                    "已存在仓库权限检查超时（15s）"
                  );
                  const existingPerms = existingRepo.data.permissions;
                  const existingCanPush = Boolean(existingPerms?.push || existingPerms?.admin || existingPerms?.maintain);
                  if (!existingCanPush) {
                    const existingPermText = existingPerms
                      ? [
                        existingPerms.admin ? "admin" : "",
                        existingPerms.maintain ? "maintain" : "",
                        existingPerms.push ? "push" : "",
                        existingPerms.triage ? "triage" : "",
                        existingPerms.pull ? "pull" : "",
                      ].filter(Boolean).join(", ")
                      : "unknown";
                    this.panel?.webview.postMessage({
                      type: "testResult",
                      ok: false,
                      msg: `验证失败: 仓库已存在但无写权限 (${owner}/${repo}, 当前权限: ${existingPermText})`
                    });
                    return;
                  }
                  messageText += `｜仓库已存在且可写: ${owner}/${repo}`;
                } catch (existingErr: unknown) {
                  const existingMsg = existingErr instanceof Error ? existingErr.message : String(existingErr);
                  logError("SettingsPanel.testToken: existing repo permission fallback failed", existingErr);
                  this.panel?.webview.postMessage({
                    type: "testResult",
                    ok: false,
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

        logInfo(`SettingsPanel.testToken: success (${Date.now() - start}ms)`);
        this.panel?.webview.postMessage({
          type: "testResult",
          ok: true,
          msg: messageText,
          warning,
        });
      } catch (e) {
        logError("SettingsPanel.testToken: failed", e);
        this.panel?.webview.postMessage({ type: "testResult", ok: false, msg: `验证失败: ${e instanceof Error ? e.message : e}` });
      }
    });

    this.panel.webview.html = this.render(initial, tokenMask);
  }

  private render(initial: SettingsPayload, tokenMask: string): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';`;
    const localPathValue = escapeHtml(initial.localProjectPath);
    const repoValue = escapeHtml(initial.repository);
    const tokenPlaceholder = tokenMask
      ? escapeHtml(tokenMask) + " (clear to change)"
      : "ghp_xxxxxxxxxxxxxxxxxxxx";
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

    /* Header */
    .header { margin-bottom: 28px; }
    .header h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.3px; margin-bottom: 6px; }
    .header p { color: var(--fg-dim); font-size: 13px; line-height: 1.5; }

    /* Cards */
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

    /* Form groups */
    .fg { margin-bottom: 16px; }
    .fg:last-child { margin-bottom: 0; }
    .fg > label {
      display: block; font-size: 12px; font-weight: 500;
      color: var(--fg-dim); margin-bottom: 5px; letter-spacing: 0.2px;
    }
    .fg .hint {
      font-size: 11px; color: var(--fg-dim); margin-top: 4px; line-height: 1.4;
      opacity: 0.8;
    }

    /* Inputs */
    input[type="text"], input[type="password"], select {
      width: 100%; padding: 7px 10px; font-size: 13px; border-radius: 4px;
      background: var(--input-bg); color: var(--input-fg);
      border: 1px solid var(--input-border); outline: none;
      transition: border-color 0.15s;
    }
    input:focus, select:focus { border-color: var(--focus-border); }

    /* Input group (token row) */
    .input-row { display: flex; gap: 6px; }
    .input-row input { flex: 1; }
    .input-row button { flex-shrink: 0; }

    /* Buttons */
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 7px 16px; font-size: 12px; font-weight: 500;
      border-radius: 4px; cursor: pointer; border: none;
      transition: background 0.15s, opacity 0.15s;
    }
    .btn:active { opacity: 0.85; }
    .btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
    .btn-primary:hover { background: var(--btn-hover); }
    .btn-secondary { background: var(--btn-sec-bg); color: var(--btn-sec-fg); }
    .btn-secondary:hover { background: var(--btn-sec-hover); }
    .btn-save {
      width: 100%; padding: 10px; font-size: 13px; font-weight: 600;
      border-radius: 6px; margin-top: 8px;
    }

    /* Toggle switch */
    .toggle-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 0;
    }
    .toggle-row .label { font-size: 13px; font-weight: 500; }
    .toggle-row .desc { font-size: 11px; color: var(--fg-dim); margin-top: 2px; }
    .switch {
      position: relative; width: 40px; height: 22px; flex-shrink: 0;
    }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute; inset: 0; cursor: pointer;
      background: var(--input-border); border-radius: 11px;
      transition: background 0.2s;
    }
    .slider::before {
      content: ""; position: absolute; left: 3px; top: 3px;
      width: 16px; height: 16px; border-radius: 50%;
      background: var(--fg); transition: transform 0.2s;
    }
    .switch input:checked + .slider { background: var(--btn-bg); }
    .switch input:checked + .slider::before { transform: translateX(18px); }

    /* Inline row */
    .inline { display: flex; gap: 12px; align-items: flex-start; }
    .inline > * { flex: 1; }

    /* Checkbox */
    .ck {
      display: flex; align-items: center; gap: 8px;
      font-size: 13px; cursor: pointer; padding: 6px 0; user-select: none;
    }
    .ck input[type="checkbox"] {
      width: 16px; height: 16px; accent-color: var(--btn-bg);
      cursor: pointer; flex-shrink: 0;
    }

    /* Interval pills */
    .pills { display: flex; gap: 6px; flex-wrap: wrap; }
    .pill {
      padding: 5px 14px; font-size: 12px; border-radius: 14px;
      background: var(--input-bg); color: var(--fg-dim);
      border: 1px solid var(--input-border); cursor: pointer;
      transition: all 0.15s; user-select: none;
    }
    .pill.active {
      background: var(--btn-bg); color: var(--btn-fg);
      border-color: var(--btn-bg);
    }
    .pill:hover:not(.active) { border-color: var(--focus-border); color: var(--fg); }

    /* Divider */
    .sep { border: none; border-top: 1px solid var(--divider); margin: 16px 0; }

    /* Scope grid */
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

    /* Toast */
    .toast {
      padding: 10px 14px; border-radius: 6px; font-size: 12px;
      margin-top: 12px; display: none; line-height: 1.4;
    }
    .toast.success { display: block; background: rgba(78,201,176,0.12); color: var(--ok); border: 1px solid rgba(78,201,176,0.3); }
    .toast.error { display: block; background: rgba(244,135,113,0.12); color: var(--err); border: 1px solid rgba(244,135,113,0.3); }
    .toast.info { display: block; background: rgba(204,167,0,0.1); color: var(--warn); border: 1px solid rgba(204,167,0,0.25); }

    /* Interval sub-section */
    .sub-section { padding-left: 4px; margin-top: 12px; }
    .sub-section.hidden { display: none; }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <h1>Cursor Chronicle</h1>
      <p>将对话记录和 Skills 自动备份到 GitHub 仓库</p>
    </div>

    <!-- Card 1: Local Storage -->
    <div class="card">
      <div class="card-head">
        <span class="step">1</span>
        <span>本地存储</span>
      </div>
      <div class="card-body">
        <div class="fg">
          <label>Chronicle 本地目录</label>
          <input id="localPath" type="text" value="${localPathValue}" placeholder="~/.cursor-chronicle" />
          <p class="hint">对话记录和 Skills 镜像的本地存储路径。支持 <b>~</b> 展开为用户目录。修改后需重新收集。</p>
        </div>
      </div>
    </div>

    <!-- Card 2: GitHub Connection -->
    <div class="card">
      <div class="card-head">
        <span class="step">2</span>
        <span>GitHub 连接</span>
        <span id="connBadge" class="badge ${tokenMask ? "ok" : "none"}">${tokenMask ? "已连接" : "未连接"}</span>
      </div>
      <div class="card-body">
        <div class="fg">
          <label>Personal Access Token</label>
          <div class="input-row">
            <input id="token" type="password" placeholder="${tokenPlaceholder}" />
            <button class="btn btn-secondary" id="testBtn">验证</button>
          </div>
          <p class="hint">验证时会自动识别 Token 类型。Classic Token: 适合自动创建仓库（需 <b>repo</b>）。Fine-grained Token: 适合最小权限（需 <b>Contents: Read and Write</b>，并授予目标仓库权限）。<br/>创建入口: https://github.com/settings/tokens (Classic) / https://github.com/settings/personal-access-tokens/new (Fine-grained)</p>
          <div id="testResult" class="toast"></div>
        </div>
        <div class="fg">
          <label>目标仓库 (owner/repo)</label>
          <input id="repo" type="text" value="${repoValue}" placeholder="your-username/cursor-chronicle-data" />
        </div>
        <div class="inline">
          <div class="fg">
            <label class="ck"><input id="createRepo" type="checkbox" ${initial.createRepoIfMissing ? "checked" : ""}/> 自动创建仓库</label>
          </div>
          <div class="fg">
            <label>仓库可见性</label>
            <select id="visibility">
              <option value="private" ${initial.visibility === "private" ? "selected" : ""}>Private</option>
              <option value="public" ${initial.visibility === "public" ? "selected" : ""}>Public</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- Card 3: Sync Settings -->
    <div class="card">
      <div class="card-head">
        <span class="step">3</span>
        <span>同步配置</span>
      </div>
      <div class="card-body">
        <div class="toggle-row">
          <div>
            <div class="label">自动同步</div>
            <div class="desc">按设定间隔自动将数据同步到 GitHub</div>
          </div>
          <label class="switch">
            <input id="autoSync" type="checkbox" ${initial.autoSync ? "checked" : ""}/>
            <span class="slider"></span>
          </label>
        </div>

        <div id="intervalSection" class="sub-section${initial.autoSync ? "" : " hidden"}">
          <label style="font-size:12px;color:var(--fg-dim);margin-bottom:8px;display:block;">同步间隔</label>
          <div class="pills">
            <span class="pill${initial.intervalMinutes === 5 ? " active" : ""}" data-val="5">5 分钟</span>
            <span class="pill${initial.intervalMinutes === 10 ? " active" : ""}" data-val="10">10 分钟</span>
            <span class="pill${initial.intervalMinutes === 30 ? " active" : ""}" data-val="30">30 分钟</span>
            <span class="pill${initial.intervalMinutes === 60 ? " active" : ""}" data-val="60">60 分钟</span>
          </div>
        </div>

        <hr class="sep" />

        <label style="font-size:12px;color:var(--fg-dim);margin-bottom:10px;display:block;">同步范围</label>
        <div class="scope-grid">
          <label class="scope-card${initial.syncConversations ? " on" : ""}" id="scopeConv">
            <input id="syncConv" type="checkbox" ${initial.syncConversations ? "checked" : ""}/>
            <span class="scope-icon">&#128172;</span>
            <div>
              <div class="scope-label">对话记录</div>
              <div class="scope-desc">AI Conversations</div>
            </div>
          </label>
          <label class="scope-card${initial.syncSkills ? " on" : ""}" id="scopeSkill">
            <input id="syncSkills" type="checkbox" ${initial.syncSkills ? "checked" : ""}/>
            <span class="scope-icon">&#128736;</span>
            <div>
              <div class="scope-label">Skills</div>
              <div class="scope-desc">Custom Agent Skills</div>
            </div>
          </label>
        </div>
      </div>
    </div>

    <button class="btn btn-primary btn-save" id="saveBtn">保存设置</button>
    <div id="saveResult" class="toast"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const uiLog = (msg) => vscode.postMessage({ type: 'uiLog', msg });
    const uiError = (msg) => vscode.postMessage({ type: 'uiError', msg });
    const on = (id, event, handler) => {
      const el = $(id);
      if (!el) {
        uiError('missing element: ' + id);
        return;
      }
      el.addEventListener(event, handler);
    };
    let hasExistingToken = ${tokenMask ? "true" : "false"};
    let selectedInterval = ${initial.intervalMinutes};
    uiLog('script initialized');
    window.addEventListener('error', (ev) => {
      uiError('window error: ' + (ev.message || 'unknown'));
    });

    /* Token focus: fill masked placeholder for editing */
    on('token', 'focus', () => {
      if (hasExistingToken && !$('token').value) {
        $('token').value = '__MASKED__';
        $('token').select();
      }
    });

    /* Test token */
    on('testBtn', 'click', () => {
      const token = $('token').value;
      $('testResult').className = 'toast info';
      $('testResult').textContent = '验证中...';
      $('testResult').style.display = 'block';
      vscode.postMessage({
        type: 'testToken',
        token,
        payload: {
          createRepoIfMissing: $('createRepo').checked,
          repository: $('repo').value,
          visibility: $('visibility').value
        }
      });
    });

    /* Auto-sync toggle → show/hide interval */
    on('autoSync', 'change', () => {
      $('intervalSection').classList.toggle('hidden', !$('autoSync').checked);
    });

    /* Interval pills */
    document.querySelectorAll('.pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        selectedInterval = Number(pill.dataset.val);
      });
    });

    /* Scope cards */
    on('syncConv', 'change', () => { $('scopeConv').classList.toggle('on', $('syncConv').checked); });
    on('syncSkills', 'change', () => { $('scopeSkill').classList.toggle('on', $('syncSkills').checked); });

    /* Save */
    on('saveBtn', 'click', () => {
      const tokenVal = $('token').value;
      vscode.postMessage({
        type: 'save',
        token: tokenVal || (hasExistingToken ? '__MASKED__' : undefined),
        payload: {
          localProjectPath: $('localPath').value,
          repository: $('repo').value,
          createRepoIfMissing: $('createRepo').checked,
          visibility: $('visibility').value,
          autoSync: $('autoSync').checked,
          intervalMinutes: selectedInterval,
          syncConversations: $('syncConv').checked,
          syncSkills: $('syncSkills').checked
        }
      });
    });

    /* Messages from extension */
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'testResult') {
        const text = msg.warning ? (msg.msg + '\\n' + msg.warning) : msg.msg;
        $('testResult').className = msg.ok ? (msg.warning ? 'toast info' : 'toast success') : 'toast error';
        $('testResult').textContent = text;
        if (msg.ok) {
          $('connBadge').className = 'badge ok';
          $('connBadge').textContent = '已连接';
        }
      } else if (msg.type === 'saved') {
        $('saveResult').className = 'toast success';
        $('saveResult').textContent = '设置已保存！';
        setTimeout(() => { $('saveResult').style.display = 'none'; }, 3000);
      } else if (msg.type === 'setData') {
        $('localPath').value = msg.data.localProjectPath || '~/.cursor-chronicle';
        $('repo').value = msg.data.repository || '';
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
          $('connBadge').textContent = '已连接';
        }
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
