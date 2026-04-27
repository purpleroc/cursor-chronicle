# Changelog

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
