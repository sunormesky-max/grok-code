# Changelog

All notable changes to GrokCode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- See [ROADMAP.md](ROADMAP.md)

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
