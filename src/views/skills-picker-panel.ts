import * as vscode from "vscode";
import { RemoteSkillMeta } from "../models";
import { SkillInstallTarget } from "../services/skills-installer";

interface InstallRequest {
  skill: string;
  target: SkillInstallTarget;
}

interface UninstallRequest {
  skill: string;
  target: SkillInstallTarget;
}

export interface SkillsPickerContext {
  skills: RemoteSkillMeta[];
  installed: {
    localUser: string[];
    remoteUser: string[];
    project: string[];
  };
  isRemote: boolean;
  remoteHost: string;
}

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}

export class SkillsPickerPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly onInstall: (request: InstallRequest) => Promise<void>,
    private readonly onUninstall: (request: UninstallRequest) => Promise<void>
  ) {}

  updateCtx(ctx: SkillsPickerContext): void {
    this.panel?.webview.postMessage({ type: "setCtx", ctx });
  }

  show(ctx: SkillsPickerContext): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.panel.webview.postMessage({ type: "setCtx", ctx });
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "cursorChronicleSkills",
      "Cursor Chronicle Skills",
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "install") {
        await this.onInstall(message as InstallRequest);
      } else if (message.type === "uninstall") {
        await this.onUninstall(message as UninstallRequest);
      }
    });

    this.panel.webview.html = this.render(ctx);
  }

  private render(ctx: SkillsPickerContext): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';`;

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
    .page { width: 100%; max-width: 680px; padding: 32px 24px 48px; }

    .header { margin-bottom: 24px; }
    .header h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.3px; margin-bottom: 6px; }
    .header p { color: var(--fg-dim); font-size: 13px; line-height: 1.5; }
    .header .env-badge {
      display: inline-block; margin-top: 8px; padding: 3px 10px;
      font-size: 11px; border-radius: 10px;
      background: rgba(78,201,176,0.15); color: var(--ok);
    }

    .search-bar {
      width: 100%; padding: 8px 12px; font-size: 13px; border-radius: 6px;
      background: var(--input-bg); color: var(--input-fg);
      border: 1px solid var(--input-border); outline: none;
      margin-bottom: 16px; transition: border-color 0.15s;
    }
    .search-bar:focus { border-color: var(--focus-border); }

    .card {
      background: var(--card-bg); border: 1px solid var(--card-border);
      border-radius: 8px; margin-bottom: 12px; overflow: hidden;
      transition: border-color 0.15s;
    }
    .card:hover { border-color: var(--focus-border); }

    .card-body { padding: 16px 18px; }

    .card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .card-info { flex: 1; min-width: 0; }
    .card-name {
      font-size: 14px; font-weight: 600; margin-bottom: 4px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .card-desc {
      font-size: 12px; color: var(--fg-dim); line-height: 1.4;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }

    .badges { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 8px; }
    .badge {
      font-size: 10px; font-weight: 500; padding: 2px 8px; border-radius: 10px;
    }
    .badge.local { background: rgba(78,201,176,0.15); color: var(--ok); }
    .badge.remote { background: rgba(100,149,237,0.18); color: #6495ed; }
    .badge.project { background: rgba(204,167,0,0.15); color: var(--warn); }

    .card-actions {
      display: flex; align-items: center; gap: 8px; margin-top: 12px;
      padding-top: 12px; border-top: 1px solid var(--divider);
    }

    select {
      padding: 5px 8px; font-size: 12px; border-radius: 4px;
      background: var(--input-bg); color: var(--input-fg);
      border: 1px solid var(--input-border); outline: none;
      cursor: pointer; flex-shrink: 0;
    }
    select:focus { border-color: var(--focus-border); }

    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 5px 14px; font-size: 12px; font-weight: 500;
      border-radius: 4px; cursor: pointer; border: none;
      transition: background 0.15s, opacity 0.15s;
    }
    .btn:active { opacity: 0.85; }
    .btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
    .btn-primary:hover { background: var(--btn-hover); }
    .btn-secondary { background: var(--btn-sec-bg); color: var(--btn-sec-fg); }
    .btn-secondary:hover { background: var(--btn-sec-hover); }
    .btn-danger { background: rgba(244,135,113,0.15); color: var(--err); }
    .btn-danger:hover { background: rgba(244,135,113,0.25); }

    .spacer { flex: 1; }

    .empty {
      text-align: center; padding: 48px 16px; color: var(--fg-dim);
    }
    .empty h3 { margin-bottom: 8px; font-size: 15px; color: var(--fg); }

    .toast {
      padding: 10px 14px; border-radius: 6px; font-size: 12px;
      margin-bottom: 12px; display: none; line-height: 1.4;
    }
    .toast.success { display: block; background: rgba(78,201,176,0.12); color: var(--ok); border: 1px solid rgba(78,201,176,0.3); }
    .toast.error { display: block; background: rgba(244,135,113,0.12); color: var(--err); border: 1px solid rgba(244,135,113,0.3); }
    .toast.info { display: block; background: rgba(204,167,0,0.1); color: var(--warn); border: 1px solid rgba(204,167,0,0.25); }

    .count { color: var(--fg-dim); font-size: 12px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <h1>Skills 管理</h1>
      <p>从 GitHub 仓库获取全量 Skills，选择安装目标后同步到本地或远程。</p>
      <span id="envBadge" class="env-badge" style="display:none;"></span>
    </div>
    <div id="msg" class="toast"></div>
    <input class="search-bar" id="search" type="text" placeholder="搜索 Skill..." />
    <div id="count" class="count"></div>
    <div id="list"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let ctx = ${safeJsonForScript(ctx)};

    const $ = (id) => document.getElementById(id);
    const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    function render() {
      const q = $('search').value.toLowerCase();
      const filtered = ctx.skills.filter(s =>
        s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)
      );
      $('count').textContent = filtered.length + ' / ' + ctx.skills.length + ' skills';

      if (ctx.isRemote) {
        $('envBadge').style.display = 'inline-block';
        $('envBadge').textContent = 'Remote-SSH: ' + esc(ctx.remoteHost);
      }

      if (filtered.length === 0) {
        $('list').innerHTML = '<div class="empty"><h3>没有找到匹配的 Skill</h3><p>' +
          (ctx.skills.length === 0 ? '仓库中暂无 Skill，请先同步 Skills 到 GitHub。' : '尝试不同的搜索关键词。') + '</p></div>';
        return;
      }

      $('list').innerHTML = filtered.map(skill => {
        const n = esc(skill.name);
        const desc = esc(skill.description || '无描述');

        const badgeHtml = [];
        if (ctx.installed.localUser.includes(skill.name))
          badgeHtml.push('<span class="badge local">本地-用户级</span>');
        if (ctx.installed.remoteUser.includes(skill.name))
          badgeHtml.push('<span class="badge remote">远端-用户级</span>');
        if (ctx.installed.project.includes(skill.name))
          badgeHtml.push('<span class="badge project">项目级</span>');

        const isAnyInstalled = ctx.installed.localUser.includes(skill.name) ||
          ctx.installed.remoteUser.includes(skill.name) ||
          ctx.installed.project.includes(skill.name);

        let options = '';
        if (ctx.isRemote) {
          options = '<option value="user">本地 - 用户级</option>' +
                    '<option value="remote-user">远端 - 用户级</option>' +
                    '<option value="project">远端 - 项目级</option>';
        } else {
          options = '<option value="user">用户级</option>' +
                    '<option value="project">项目级</option>';
        }

        return '<div class="card"><div class="card-body">' +
          '<div class="card-top"><div class="card-info">' +
            '<div class="card-name">' + n + '</div>' +
            '<div class="card-desc">' + desc + '</div>' +
          '</div></div>' +
          (badgeHtml.length ? '<div class="badges">' + badgeHtml.join('') + '</div>' : '') +
          '<div class="card-actions">' +
            '<select data-skill="' + n + '">' + options + '</select>' +
            '<button class="btn btn-primary" data-install="' + n + '">' + (isAnyInstalled ? '更新' : '安装') + '</button>' +
            (isAnyInstalled ? '<button class="btn btn-danger" data-uninstall="' + n + '">卸载</button>' : '') +
            '<span class="spacer"></span>' +
            '<span style="font-size:11px;color:var(--fg-dim);">' + (skill.files ? skill.files.length + ' files' : '') + '</span>' +
          '</div></div></div>';
      }).join('');

      bindActions();
    }

    function bindActions() {
      document.querySelectorAll('button[data-install]').forEach(btn => {
        btn.addEventListener('click', () => {
          const skill = btn.getAttribute('data-install');
          const sel = document.querySelector('select[data-skill="' + skill + '"]');
          const target = sel ? sel.value : 'user';
          btn.textContent = '安装中...';
          btn.disabled = true;
          vscode.postMessage({ type: 'install', skill, target });
        });
      });
      document.querySelectorAll('button[data-uninstall]').forEach(btn => {
        btn.addEventListener('click', () => {
          const skill = btn.getAttribute('data-uninstall');
          const sel = document.querySelector('select[data-skill="' + skill + '"]');
          const target = sel ? sel.value : 'user';
          btn.textContent = '卸载中...';
          btn.disabled = true;
          vscode.postMessage({ type: 'uninstall', skill, target });
        });
      });
    }

    $('search').addEventListener('input', render);

    window.addEventListener('message', (event) => {
      const m = event.data;
      if (m.type === 'setCtx') {
        ctx = m.ctx;
        render();
      }
    });

    render();
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
