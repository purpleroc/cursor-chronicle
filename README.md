# Cursor Chronicle

> 将 Cursor AI 对话与自定义 Skills 备份到 GitHub，支持本地/远程多环境。

Cursor Chronicle 是一个 VS Code / Cursor 扩展，自动收集你与 AI 的所有对话记录和自定义 Skills，导出为 Markdown 文件，并同步到 GitHub 仓库进行版本管理。

## 核心功能

### 📝 对话收集与导出

- **自动收集** — 从 Cursor 本地 SQLite 数据库与 JSONL 日志中提取对话
- **Markdown 导出** — 每条对话导出为独立 `.md` 文件，包含 YAML frontmatter 元数据
- **按项目分目录** — 对话按所属工作区 / 项目名自动归类
- **增量更新** — 通过 `chronicle-index.json` 跟踪已处理的对话，仅处理新增或变更内容
- **单条导出** — 右键菜单支持单条对话导出到任意位置
- **批量导出** — 一键将所有对话导出到工作区指定目录

![chronicle](https://raw.githubusercontent.com/purpleroc/cursor-chronicle/main/pic/cursor-chronicle-1.png)

### 🛠️ Skills 管理

- **本地镜像** — 自动将 `~/.cursor/skills/` 和工作区 `.cursor/skills/` 镜像到 Chronicle 目录
- **同步到 GitHub** — 将 Skills 上传到 GitHub 仓库，含 `skills-index.json` 索引
- **从 GitHub 安装** — 侧边栏浏览 GitHub 仓库中的 Skills，一键安装
- **Skills 管理面板** — 卡片式 UI，支持搜索、安装 / 卸载、徽章显示安装状态
- **多安装目标** — 支持安装到用户级（`~/.cursor/skills/`）或项目级（`.cursor/skills/`）

![skills](https://raw.githubusercontent.com/purpleroc/cursor-chronicle/main/pic/cursor-chronicle-2.png)

### ☁️ GitHub 同步

- **自动同步** — 可配置定时自动同步（5 / 10 / 30 / 60 分钟间隔）
- **手动同步** — 侧边栏一键触发收集 + 同步
- **SHA-256 去重** — 文件内容哈希比对，避免重复上传
- **自动建仓** — 首次使用可自动创建 GitHub 仓库（Private / Public）
- **同步锁** — 多窗口同时打开时通过 `sync.lock` 防止冲突

![git](https://raw.githubusercontent.com/purpleroc/cursor-chronicle/main/pic/cursor-chronicle-1.png)


### 🖥️ Remote-SSH 支持

- **远端对话收集** — 通过 `vscode.workspace.fs` 读取远端 `agent-transcripts`
- **远端 Skills 收集** — 自动探测远端 home 目录，收集远端用户级 Skills
- **三目标安装** — Remote-SSH 模式下支持安装到：本地用户级、远端用户级、远端项目级

### 🎛️ 侧边栏 UI

- **对话树** — 按当前工作区与其他项目分组展示，点击直接打开 Markdown 文件
- **Skills 树** — 分类展示：Chronicle 本地镜像、User Skills、Project Skills、GitHub 仓库（可安装）
- **同步状态** — 状态栏实时显示同步进度（idle / syncing / synced / error）

## 快速开始

### 1. 安装

```bash
npm install
npm run release
```

`release` 会依次执行 类型检查 → 清理 → 生产构建（minify、无 sourcemap）→ 打包 VSIX。完成后在项目根目录生成 `cursor-chronicle-x.x.x.vsix`。

在 Cursor / VS Code 中通过 **Extensions → Install from VSIX** 安装。

### 2. 配置 GitHub

1. 点击侧边栏中的 **Cursor Chronicle** 图标
2. 点击 **Configure GitHub** 打开设置页面
3. 输入 GitHub Personal Access Token
   - Classic Token 需要 `repo` scope
   - Fine-grained Token 需要 `Contents: Read and Write` 权限
4. 填写目标仓库（`owner/repo` 格式）
5. 保存设置

### 3. 开始使用

| 命令 | 说明 |
|------|------|
| `Chronicle: Collect + Sync GitHub` | 收集对话 + Skills 并同步到 GitHub |
| `Chronicle: Collect to Local Folder` | 仅收集到本地 Chronicle 目录 |
| `Chronicle: Install Skills from GitHub` | 打开 Skills 管理面板 |
| `Chronicle: Export All Conversations` | 批量导出所有对话到工作区 |
| `Chronicle: View Sync Status` | 查看同步状态信息 |

## 配置项

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `cursorChronicle.github.repository` | `""` | GitHub 仓库（`owner/repo`） |
| `cursorChronicle.github.createRepoIfMissing` | `false` | 仓库不存在时自动创建 |
| `cursorChronicle.github.defaultVisibility` | `"private"` | 自动创建仓库的可见性 |
| `cursorChronicle.autoSync.enabled` | `false` | 启用定时自动同步 |
| `cursorChronicle.autoSync.intervalMinutes` | `10` | 自动同步间隔（分钟） |
| `cursorChronicle.sync.conversations` | `true` | 同步对话到 GitHub |
| `cursorChronicle.sync.skills` | `true` | 同步 Skills 到 GitHub |
| `cursorChronicle.export.localPath` | `".cursor-chronicle/exports"` | 批量导出路径（工作区相对） |
| `cursorChronicle.ignore.projects` | `[]` | 收集时跳过的项目名列表 |
| `cursorChronicle.localProjectPath` | `"~/.cursor-chronicle"` | 本地 Chronicle 目录 |

## 本地目录结构

```
~/.cursor-chronicle/
├── conversations/
│   └── <project-name>/
│       └── <conversation>.md       # 对话 Markdown（含 YAML frontmatter）
├── skills/
│   └── mirror/
│       ├── user/<skill>/           # 用户级 Skills 镜像
│       └── project/<project>__<skill>/  # 项目级 Skills 镜像
├── chronicle-index.json            # 增量同步索引
└── .git/                           # 本地 Git 仓库（自动初始化）
```

## 开发

```bash
npm install          # 安装依赖
npm run build        # 开发构建（含 sourcemap）
npm run watch        # 监听模式，文件变更自动重编译
npm run typecheck    # 仅 TypeScript 类型检查
npm run release      # 一键打包：typecheck → clean → 生产构建 → VSIX
```

| 脚本 | 说明 |
|------|------|
| `build` | esbuild 开发构建，输出到 `dist/extension.js`（含 sourcemap） |
| `build:prod` | esbuild 生产构建（minify、无 sourcemap） |
| `watch` | 监听模式，实时编译 |
| `typecheck` | `tsc --noEmit` 类型检查 |
| `clean` | 清理 `dist/` 目录 |
| `release` | 完整打包流程，生成 `.vsix` 文件 |

## 排查问题

打开输出面板（`View → Output`），在下拉列表中选择 **Cursor Chronicle**，可查看详细运行日志。

## 安全

- Token 使用 VS Code `SecretStorage` 加密存储
- Webview 严格遵循 CSP（Content Security Policy）
- 所有 HTML 输出使用转义处理
- SQLite 查询参数经过 UUID 格式校验

## License

MIT
