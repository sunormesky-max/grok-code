# Changelog

All notable changes to GrokCode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- See [ROADMAP.md](ROADMAP.md)

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

[Unreleased]: https://github.com/sunormesky-max/grok-code/compare/v1.2.4...HEAD
[1.2.4]: https://github.com/sunormesky-max/grok-code/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/sunormesky-max/grok-code/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/sunormesky-max/grok-code/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/sunormesky-max/grok-code/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/sunormesky-max/grok-code/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/sunormesky-max/grok-code/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/sunormesky-max/grok-code/releases/tag/v1.0.0
