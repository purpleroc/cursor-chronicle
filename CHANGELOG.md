# Changelog

## [1.0.0]

### Windows 全平台支持

- 统一用户目录解析（`getUserHome()`）：Windows 优先读 `USERPROFILE`，避免 `os.homedir()` 在某些 Cursor 安装环境返回 Program Files 路径导致 EPERM
- Cursor DB 路径兼容：macOS `~/Library/Application Support/Cursor/...`、Linux `~/.config/Cursor/...`、Windows `%APPDATA%/Cursor/...` + `%LOCALAPPDATA%/Cursor/...`
- JSONL transcript 扫描支持 Windows 多候选目录（`%USERPROFILE%\.cursor\projects`、`%APPDATA%\Cursor\projects`、`%LOCALAPPDATA%\Cursor\projects`）
- Git 长路径支持：clone/init 自动设置 `core.longpaths=true`
- Git 换行符处理：设置 `core.autocrlf=false` + `.gitattributes` 强制 LF，修复 Windows 下 frontmatter 因 CRLF 解析失败的问题
- `parseFrontmatter` 增加 `\r\n` → `\n` 规范化，兼容已有 CRLF 文件
- 文件名截断至 120 字符，防止 Windows MAX_PATH 超限
- Git 可用性检测：未安装 Git 时弹出中文提示并引导安装
- `gitPull` 自动处理 untracked 文件冲突（如 `.gitignore`），删除冲突文件后重试
- Skill URI 修复：Windows 路径不再被误解析为 URI scheme（`C:` → `file:///C:/...`）
- 同步锁文件移至 `os.tmpdir()`，避免写入受保护目录

### 内置 SQLite 读取（sql.js）

- 用 sql.js（纯 JS/WASM）替代 sqlite3 CLI，Windows/macOS/Linux 均无需预装任何工具
- WASM 二进制随 VSIX 一起分发，构建时自动复制到 dist/
- `ComposerDbReader` 和 `TitleResolver` 改为异步 API

### Frontmatter v2 规范

- 新增 `chronicleVersion: 2` 字段，标记数据格式版本
- `chronicleSource`（`local` | `remote`）和 `chronicleHostname` 改为必填，解决旧数据字段缺失导致的分类污染
- 向下兼容：v1 旧数据（无 version 字段）中缺失的 source 默认为 `local`、缺失的 hostname 视为未知来源，只归入 Git 仓库分组

### 侧边栏优化

- 对话树按来源语义分组为「本机」「远程开发」「Git 仓库（全量）」三栏，取代原来按 hostname 逐台列出；本机/远程仅展示当前机器的数据，Git 仓库展示完整归档
- 分支选择器：用自定义下拉组件替代原生 `<datalist>`，修复 Electron webview 中下拉定位错位
- GitHub 仓库 Skill 点击行为改为打开 SKILL.md 预览，安装统一通过右键菜单或安装面板
- Welcome 视图添加「配置 GitHub」工具栏入口

## [0.0.9]

- Skip GitHub push when sync directory has no file changes — `gitAddAndCommit` result (`committed`) gates the push and notification, eliminating unnecessary network requests
- Suppress noisy sync notifications: toast only appears when files are actually committed and pushed; silent status bar update otherwise
- Fix multi-IDE plugin conflicts: replace TOCTOU-prone lock with atomic `wx`-flag file creation (`fs.writeFile` with `{ flag: "wx" }`), preventing concurrent sync across multiple IDE windows
- Correct sync order: pull from GitHub first (clone on first run, pull on subsequent), then collect from local machine, then refresh tree views, then commit and push — tree views now reflect both remote and local data
- Add `gitPull` to `LocalStore`: pulls latest remote changes before collection; gracefully skips on new/empty repos or offline
- Tree views refresh immediately after collection, independent of GitHub sync; non-active IDE instances also refresh their tree views even when lock is held by another instance
- Remove `executeGitHubSync` helper (inlined into main sync flow for clarity)

## [0.0.8]

- Change default sync branch from `main` to `master`
- Branch selector now supports both dropdown and free-text input (HTML5 datalist combo box)
- Auto-create remote branch if it doesn't exist: on save, `ensureRemoteBranch` checks remote via `git ls-remote --heads` and pushes to create the branch when missing
- Fix `git push --force` failing with "cannot lock ref" error: add `git fetch origin` before push to ensure remote tracking refs are up-to-date
- Add `git merge --abort` on pull conflict before force push to avoid pushing in a dirty merge state
- Extract `gitFetchSafe` helper for resilient fetch (silent fail when offline or empty repo)

## [0.0.7]

- Fix skills sync producing unnecessary commits: use per-file MD5 hashes in `skills-index.json` to detect actual content changes; `updatedAt` and index file are only updated when file content differs, eliminating empty commits caused by timestamp-only changes

## [0.0.6]

- Branch control: configurable sync branch (default `master`); auto-clone existing remote repo on first sync to avoid branch conflicts across machines
- Import conversations from Markdown files via sidebar toolbar (supports multi-select, auto-generates frontmatter if missing)
- Import Skills from Markdown files — creates `~/.cursor/skills/<name>/SKILL.md`
- Settings page i18n: Chinese / English toggle with one-click language switch
- Rewrite README with bilingual content and updated feature documentation

## [0.0.5]

- Git-based GitHub sync (commit/push) instead of per-file API uploads
- Per-repository sync folders under a configurable root; skills sourced directly (mirror removed)
- Smarter repo creation, write-permission checks, and push conflict handling
- Settings panel: local path, token validation with logging; webview interaction fix

## [0.0.4]

- Fix sync button showing "no changes" when remote repo is empty — always push existing commits even if no new commit is created
- Optimize marketplace discoverability: bilingual description, refined keywords and categories
- Add repository, homepage, galleryBanner and other metadata fields
- Fix README images to render correctly on VS Code Marketplace
- Add CHANGELOG.md for marketplace Changelog tab

## [0.0.3]

- Fix Remote-SSH skill collection and installation
- Improve incremental sync with SHA-256 dedup
- Add sync lock to prevent multi-window conflicts

## [0.0.2]

- Add Skills management panel with card UI
- Support installing skills from GitHub
- Add auto-sync with configurable intervals

## [0.0.1]

- Initial release
- Conversation collection from Cursor SQLite and JSONL
- Markdown export with YAML frontmatter
- GitHub sync via Octokit
- Sidebar tree views for conversations and skills
