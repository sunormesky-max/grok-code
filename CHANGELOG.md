# Changelog

All notable changes to GrokCode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- See [ROADMAP.md](ROADMAP.md)

## [1.3.8] — 2026-07-16

### Templates · checkpoints compare · paste save

- **Rules → Code**: rules modal **Open in Code** saves then opens `.grok/rules.md`
- **Checkpoint A→B**: Diff bar compare two points (before / cp / live) with dedicated ops view
- **Paste images → disk**: images saved under workspace `.grok/paste/` when a project is open
- **Session templates pack**: `session-templates.json` + welcome chips + `/template` + save current prompt as template

## [1.3.7] — 2026-07-16

### Checkpoints · project rules · quiet hours

- **Diff checkpoints**: per-turn content snapshots · Live / cp chips · restore checkpoint to disk
- **Composer drag-drop**: drop files onto composer (same attach path as paste)
- **Project rules**: workspace `.grok/rules.md` merged into agent `--rules` (global + project)
- **Quiet hours**: mute completion chime between configured times (in rules modal)

## [1.3.6] — 2026-07-16

### Signal & context

- **Diff blame hover**: +/- lines show Agent turn / task / prompt; banner + multi-turn history tip
- **Paste attachments**: paste images/text files into composer → chips + context note on send
- **Status bar rules**: click `rules` chip for quick `--rules` edit (+ chime toggle)
- **Background flight done**: toast + soft chime when a non-active / unfocused task finishes

## [1.3.5] — 2026-07-16

### Composer & task polish

- **@file mentions**: type `@` in composer to pick workspace paths (insert as `` `path` ``)
- **Diff side-by-side**: Unified / Side-by-side toggle · shortcut `s` on Diff tab · `/sbs`
- **Task pin + drag reorder**: 📌 pin · drag tabs to reorder · persisted
- **Prompt draft backup**: auto-save unsent text per project+task; restore on switch; clear on send

## [1.3.4] — 2026-07-16

### Review & composer power tools

- **Diff reviewed mark** (`a` / toolbar) + green list badge
- **Diff j/k** next/prev file when Diff tab is active
- **Multi-select Diff**: checkboxes · 忽略/还原/审阅选中 · 全选
- **Slash commands** in composer: `/craft` `/plan` `/ask` `/model` `/share` `/rename` `/diff` `/search` `/skill` `/help`
- **In-task message search**: ⌕ button or Ctrl+F in chat · Enter/↑↓ navigate hits

## [1.3.3] — 2026-07-16

### Flight-deck UX (self-directed)

- **Task rename**: double-click tab (or Ctrl+K) for inline rename
- **Live filters**: 全部 / 写入 / 工具 / 错误 / 信号 chips under mission bar
- **Diff hunk fold**: collapsible hunks + expand/collapse all toolbar
- **Composer model chip**: quick presets (CLI default / grok-build / 4.5 / 4) + custom

## [1.3.2] — 2026-07-16

### Next-batch UX

- **Skill chip preview**: open SKILL.md in a read-only modal even outside the workspace (copy / open folder / open in project editor)
- **Outline sticky highlight**: current symbol tracks scroll & caret; auto-scroll outline into view
- **Plan auto-detect**: plan-like assistant replies show **执行方案** even outside Plan mode (Ask still excluded)
- **Session export share card**: Markdown/JSON copy + save dialog (chat header ⇪ · Ctrl+K)

## [1.3.1] — 2026-07-16

### Craft flight deck

- Stronger Craft rules/prefix (multi-step, short post-flight recap)
- **Mode-aware** composer placeholder + send label (fixed idle label reset)
- **Ctrl+Shift+Enter** one-shot Craft without leaving Plan/Ask UI
- Status **Craft · 飞行中 / Craft 待命**; badge click cycles modes
- **Mission summary** bar after Craft turns (tools · writes · Diff files)
- Welcome deck rebranded for Craft + “落地一改” quick action
- Craft flight: left rail accent, inflight badge pulse, min maxTurns floor when YOLO
- Command palette: cycle work mode

## [1.3.0] — 2026-07-16

### Craft mode polish

- Explicit **Craft** prompt prefix (act-now flight mode)
- **Ctrl+1 / 2 / 3** switch Craft / Plan / Ask (with toast)
- Send button label follows mode: `Grok it` / `规划` / `提问`
- Status bar **mode badge** + composer focus color by mode
- Craft chip subtle pulse

## [1.2.9] — 2026-07-16

### Added

- **Plan → Execute**: after a Plan reply, one-click **执行方案** (switches to Craft and runs)
- **Per-project split width** map in localStorage
- **Outline** multi-language (TS interfaces, Rust, Java/Kotlin, Ruby, CSS, HTML ids, JSON keys, nested depth)
- **Skill match chips** after a turn when user text scores against skill descriptions

## [1.2.8] — 2026-07-16

### Added / hardened

- **Ask hard-block**: UI `fs:write` / `fs:delete` / `terminal:run` rejected in Ask mode
- Personal-protect heuristics on dangerous terminal patterns
- **Split divider width** persisted (`localStorage`)
- **Code Outline** panel (functions/classes/headings → jump)
- **Skills progressive index** injected into agent (name+description only; toggle in Appearance)

## [1.2.7] — 2026-07-16

### Added (WorkBuddy-inspired, GrokCode-native)

- **Work modes**: Craft / Plan / Ask (composer chips + rules injection)
  - Plan: plan first; user says「执行」to act
  - Ask: no auto-approve tools + read-only rules
- **Style packs**: default / pragmatic / teaching / warm / blunt
- **Personal protect** settings + **delete → Recycle Bin** on Windows (UI fs:delete)
- Skill pack **template** under `examples/skills/skill-pack-template/` (progressive disclosure layout)

## [1.2.6] — 2026-07-16

### Added

- **Global search**: files (`Ctrl+P`) + content (`Ctrl+Shift+F`) with path fuzzy match & line jump
- **Code | Diff split** layout toggle (`⧉ Split` / command palette); resizable divider
- IPC `fs:search` / `fs:searchPaths`

### Changed

- **Electron → 43.x** major upgrade (security line); electron-builder 26 remains

## [1.2.5] — 2026-07-16

### Added

- **Keyboard shortcuts cheatsheet** (`?` or `Ctrl+/`, also via Ctrl+K)
- **UI density** comfortable / compact (Appearance + command palette)
- **File tree polish**: extension tint, active file highlight, expand/collapse all, richer icons
- Path **breadcrumb** in Code chrome

## [1.2.4] — 2026-07-16

### Added / UI

- **UI polish layer** (`ui-polish.css`): glass edges, tab chips, composer glow, message cards, scrollbars, settings modal
- **Command palette** navigates open **projects & tasks** (grouped “Navigate / Actions”)
- Settings general form **full i18n** (labels, options, doctor/update actions)

## [1.2.3] — 2026-07-16

### Added

- **Command palette** (`Ctrl+K` / `Cmd+K`) for navigation, settings, theme, doctor, docs
- **Dependabot** weekly updates for npm + GitHub Actions
- MCP / Skills management **i18n** (toasts, empty states, actions)
- `npm run audit:official` and [docs/SECURITY_DEPS.md](docs/SECURITY_DEPS.md)

### Security / deps

- Upgrade **electron-builder** to v26 (clears packaging `tar` advisories)
- Upgrade **Electron** toward current 39.x line (remaining Electron CVEs need major 40+; documented)

## [1.2.2] — 2026-07-16

### Added

- **GitHub Pages** workflow for community catalog (`docs/catalog/` → Actions Pages)
- **App icon** generator (`npm run icons` → `build/icon.png`) wired into electron-builder + BrowserWindow
- **Chat virtualization** for long threads (render tail, “load earlier” bar)
- Release pipeline runs catalog + icons before packaging

## [1.2.1] — 2026-07-15

### Fixed

- Linux `.deb` build: require author email / maintainer metadata (v1.2.0 ubuntu job failure)

### Added

- Richer **i18n** for dynamic toasts / Live / chat recovery strings (`{n}` / `{name}` interpolate)
- **Theme pack import** UI (drag-drop or file picker for `vars` JSON)
- **Plugin search** filter in Settings → Plugins
- **A11y**: skip link, `:focus-visible`, aria labels on chrome controls
- Static **catalog site** under `docs/catalog/`
- Docs: [SIGNING.md](docs/SIGNING.md), [CONTRIBUTING_WORKFLOW.md](docs/CONTRIBUTING_WORKFLOW.md)

## [1.2.0] — 2026-07-15

### Added

- **Plugin marketplace bridge** — Settings → Plugins (`grok plugin` list/install/enable + marketplaces)
- **i18n** — Chinese / English shell UI (`renderer/i18n.js`, Settings → Appearance)
- **Theme packs** — grok / void / mars / ice / ember + `examples/themes/`
- **Virtualized Live timeline** for long agent sessions
- **Project profiles** — export / import rules & flight-deck config
- **Telemetry opt-in** — local `~/.grok-code/crashes` only unless endpoint set
- **Community catalog** — Settings → Catalog from `examples/` (`npm run catalog`)
- Release matrix: **Windows + Linux + macOS** unsigned community artifacts

### Changed

- Version **1.2.0**; ROADMAP Now items completed for promised v1.x surface

## [1.1.0] — 2026-07-15

### Added

- **First-run onboarding** wizard with environment doctor (CLI / auth / sessions / editors)
- **One-click diagnostics** export under `~/.grok-code/diagnostics/` (no secrets)
- **Session reliability**: auto retry without `--resume` on session errors; UI retry / fresh-session bar
- **Optional LLM L1/L2** context mode (xAI Chat Completions; fallback to heuristics)
- **Open in external editor** (Cursor / VS Code / system) from Diff and Code panes
- **Auto-update** via `electron-updater` + GitHub Releases (packaged builds only)
- Renderer modules: `utils.js`, `onboarding.js`, `settings-extra.js`, `external-editor-ui.js`
- Unit tests: `npm test` (`scripts/test-unit.js`)

### Changed

- Settings: context mode, preferred editor, auto-update toggles
- `npm run check` now runs syntax checks + unit tests

## [1.0.0] — 2026-07-15

### Added

- Desktop shell (Electron) driving **local Grok Build CLI** headless (`streaming-json`)
- **Multi-project** workspaces with parallel agents
- **Multi-task** per project (independent CLI sessions)
- **Live / Code / Diff** mission control, unified diffs, restore / restore-all
- **Context inheritance** (`~/.grok-code/sessions`) + **L0–L3** compression
- Settings: general, **MCP** (list/add/remove/doctor/timeout), **Skills** (list/toggle/create/edit)
- Sci-fi UI, boot sequence, frameless title bar
- Open-source kit: MIT, CONTRIBUTING, CoC, SECURITY, examples, issue/PR templates
- CI workflow + electron-builder packaging (Windows NSIS + portable)

### Notes

- Requires installed Grok CLI + auth (`grok login` or `XAI_API_KEY`)
- YOLO / always-approve is full workspace trust

[Unreleased]: https://github.com/sunormesky-max/grok-code/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/sunormesky-max/grok-code/compare/v1.2.9...v1.3.0
[1.2.9]: https://github.com/sunormesky-max/grok-code/compare/v1.2.8...v1.2.9
[1.2.8]: https://github.com/sunormesky-max/grok-code/compare/v1.2.7...v1.2.8
[1.2.7]: https://github.com/sunormesky-max/grok-code/compare/v1.2.6...v1.2.7
[1.2.6]: https://github.com/sunormesky-max/grok-code/compare/v1.2.5...v1.2.6
[1.2.5]: https://github.com/sunormesky-max/grok-code/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/sunormesky-max/grok-code/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/sunormesky-max/grok-code/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/sunormesky-max/grok-code/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/sunormesky-max/grok-code/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/sunormesky-max/grok-code/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/sunormesky-max/grok-code/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/sunormesky-max/grok-code/releases/tag/v1.0.0
