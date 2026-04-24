# Changelog

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
