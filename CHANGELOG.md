# Changelog

All notable changes to GrokCode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- See [ROADMAP.md](ROADMAP.md)

## [1.7.0] — 2026-07-16

### Storyboard — reconstruct before from mini-diff

- **`DiffUtil.parseUnifiedText` / `reconstructFromUnified`**: reverse mini-diff text into ops; when full disk `after` matches the after-snippet, recover full-file **before**
- **Import hydrate**: offline packs use reconstructed ops for unified/side-by-side (not only raw text)
- **Disk rehydrate**: prefer reverse mini-diff → before when session has no baseline
- Diff stats badges: `recon full` / `recon snippet` / truncated
- Unit tests for round-trip mini-diff reconstruct

## [1.6.3] — 2026-07-16

### Visual impact 10 — cinematic idle ambient

- **Optional cinematic idle** (off by default): Settings → 外观 → 电影级待机氛围; Ctrl+K toggle
- After ~12s without input: soft vignette, dust motes, secondary scan beam, richer nebula/corners
- Respects force reduce motion + OS `prefers-reduced-motion`; starfield meteors slightly more frequent when idle
- `visual-impact-10.css` + `GrokFx` idle API (`get/set/toggleCinematicIdle`)

## [1.6.2] — 2026-07-16

### Visual impact 9 — outline · split · tree

- **Outline panel**: STRUCTURE HUD head, ice rail, kind chips, active glow, theme tints
- **Code|Diff split**: dual-pane edge chrome, gradient divider grip, active Split toggle
- **Explorer tree**: flight-deck panel head/filter/toolbar, active ice rail, ext-tint glow, breadcrumb HUD
- Compact density + high FX + reduced-motion for the new layers
- `visual-impact-9.css` + VISUAL-QA outline/split/tree checks

## [1.6.1] — 2026-07-16

### Visual impact 8 — help · compact · themed boot

- **Shortcuts overlay** (Ctrl+/ / ?): FLIGHT CONTROLS kicker, glass card, hover ice rail, kbd chips
- **Density compact**: tighter layout presets, filmstrip, palette/search/help, restrained high-FX glow
- **Themed boot**: Ice / Mars / Void / Ember tint grid, log, progress, logo glow
- `visual-impact-8.css` + VISUAL-QA density/boot checks

## [1.6.0] — 2026-07-16

### Visual polish milestone — palette · search · QA

- **Command palette**: flight-deck glass, group labels, active ice rail, kbd-style hints
- **Global search** (Ctrl+P / Ctrl+Shift+F): mode capsules + result rows match palette HUD
- **docs/VISUAL-QA.md**: regression checklist for themes, layouts, FX, motion
- Closes the v1.5.x visual-impact arc (`visual-impact` … `visual-impact-7.css`)

## [1.5.9] — 2026-07-16

### Visual impact 6 — mgmt panes · doctor · reduce motion

- **MCP / Skills / Plugins / Catalog**: flight-deck toolbar, list, form, log chrome
- **Doctor cards**: summary + item glow by ok/warn/bad
- **Force reduce motion** in Appearance + Ctrl+K; `body.force-reduced-motion`
- New `visual-impact-6.css`

## [1.5.8] — 2026-07-16

### Visual impact 5 — onboarding · settings · a11y docs

- **Onboarding**: flight-deck briefing layout (kickers, hero cards, step dots glow)
- **Settings**: mono section titles (CLI · Context · Diagnostics · Theme · Telemetry), sharper tabs/fields
- **README**: reduced-motion + FX intensity accessibility notes
- New `visual-impact-5.css`

## [1.5.7] — 2026-07-16

### Visual impact 4 — empty · glass · haptic

- **Welcome / empty states**: cinematic hero cards for chat welcome, Live, Code, Diff, explorer empty
- **Toast + modal glass**: unified ice/mars edge glass for toasts, settings, gc-modals, command palette
- **Haptic CSS**: press-scale on critical controls; `haptic()` helper on send / stop / layout / review bridge
- New `visual-impact-4.css`

## [1.5.6] — 2026-07-16

### Visual impact 3 — FX · boot · filmstrip HUD

- **FX intensity**: Settings → 外观 → 标准 / 高强度；`body.fx-high` 增强光晕（Ctrl+K 可切换）
- **Boot**: BIOS v1.5 deck copy, stronger grid/scan/logo/log/progress rail
- **Diff filmstrip / scrubber**: Agent-grade glass cards, energy strip, active glows (parity with chat HUD)
- New `fx.js` + `visual-impact-3.css`

## [1.5.5] — 2026-07-16

### Visual impact 2 — stream · themes · micro

- **Chat stream**: stronger user/assistant/tool/thought cards, live stream edge + caret pulse
- **Live timeline**: entrance motion, energy rail, kind-colored glows, hover lift
- **Themes**: Void / Ice / Mars / Ember intensity layered on flight-deck (settings → 主题)
- **Micro**: Send button pulse, task select flash, Diff scrub/film card press feedback
- Fix orphan CSS around task-tab running dot

## [1.5.4] — 2026-07-16

### Visual impact — flight deck

- New `visual-impact.css`: stronger ice/mars edge glows, Agent hero panel, cinematic topbar energy line
- Composer focus bloom · primary Send gradient punch · mode chips / layout presets premium capsule
- Live badge pulse · explorer rail glow · status bar telemetry strip
- Cloud services explicitly deferred in ROADMAP (UI-first)

## [1.5.3] — 2026-07-16

### Storyboard disk rehydrate

- After importing a storyboard pack, **auto-rehydrate** files that still exist under the open project (read disk → after/ops)
- Banner actions: **从磁盘恢复** / **退出回灌**; shows `disk ok/miss` counts
- Prefer full line diffs when disk content is available; fall back to offline mini-diff text otherwise
- Ctrl+K: 「Storyboard 从磁盘 rehydrate」

## [1.5.2] — 2026-07-16

### Auto-Pilot · storyboard filmstrip import

- **Auto-Pilot**: titlebar **Auto** chip — when enabled, window ≥1600px switches to Pilot (hysteresis &lt;1500 → Agent); skips Review/Full
- **Import storyboard** into Diff filmstrip (**⬆** on scrubber / Ctrl+K): JSON · HTML · AES encrypted packs
- Offline mini-diffs displayed when full file snapshots are missing
- **Exit** overlay banner to leave imported review mode

## [1.5.1] — 2026-07-16

### Pilot layout · Diff ↔ Agent review bridge

- **Pilot** layout preset: Agent chat **centered** (ultra-wide command deck via flex order)
- **Review bridge** chip on Agent head when there are changes → jumps to Review + Diff
- **Diff tab badge** with change count
- Diff toolbar **@ 讨论**: inject `@path` into composer and focus Agent
- Ctrl+K: layout Pilot · open review bridge

## [1.5.0] — 2026-07-16

### Agent-first layout (Codex / ZCode inspired · Grok sci-fi)

- **Layout presets** in titlebar: **Agent** (default) · **Review** · **Full**
- **Agent mode**: chat is the primary stage (wider, elevated HUD glass); Explorer + Terminal tucked; Live detail collapsed
- **Review mode**: open file tree + Live detail for code review
- **Full mode**: classic multi-pane IDE density
- Compact workspace strip, quieter cosmos atmosphere, denser task/composer chrome
- New stylesheet `layout-agent.css`

## [1.4.14] — 2026-07-16

### Calmer UI · collapsible middle chrome

- **Windows title bar**: transparent overlay (`#00000000`) so min/max/close blend with the glass topbar
- **Live detail side**: focus / changes / context collapsed by default; toggle **详情** (or Ctrl+K)
- **Terminal**: collapsed by default; click bar or ↕ to expand
- Slimmer Live empty state (less visual noise)

## [1.4.13] — 2026-07-16

### Window controls + titlebar cleanup

- **Windows**: use native `titleBarOverlay` for min/max/close (system-drawn, always works)
- Hide custom ─□✕ on Windows; keep them for Linux
- Restore clean titlebar layout (no fixed floating button layer / no broken padding)

## [1.4.12] — 2026-07-16

### Fix window controls (Windows)

- Stop putting `-webkit-app-region: drag` on the whole titlebar (Electron swallows child clicks)
- Window min/max/close live in a **fixed overlay outside `#app`**, never under a drag ancestor
- Drag only on brand + middle spacer; IPC + pointer handlers hardened

## [1.4.11] — 2026-07-16

### Fixes

- **Enter to send**: composer **Enter** sends (Shift+Enter newline); Ctrl+Enter still works; Ctrl+Shift+Enter = one-shot Craft
- **Window controls**: frameless min/max/close clicks restored (force `-webkit-app-region: no-drag` + capture handlers; IPC window resolve fallback)

## [1.4.10] — 2026-07-16

### HTML pack compare · encrypted storyboard

- **Compare HTML packs**: A|B import accepts JSON, offline HTML (parses `const TURNS`), and AES-encrypted packs
- **Encrypted export**: toolbar **🔒** / Ctrl+K → AES-GCM storyboard JSON (`grokcode-storyboard-aes-v1`, passphrase, same KDF as template packs)

## [1.4.9] — 2026-07-16

### Pack compare polish · progressive compress

- **Compare detail**: click a turn → side-by-side prompts/notes, file both/only-A/only-B lists, mini-diff stats + text pair
- **Compare filters**: All / Diff / Only A / Only B / Same + summary pills; **Copy summary** markdown
- **Budget modes**: Full / Balanced / Compact chips on Diff toolbar (persisted); progressive strip (trim text → omit cold diffs → all diffs → trim prompts) with export toast stats

## [1.4.8] — 2026-07-16

### Storyboard notes · pack compare · budget compress

- **Reviewer notes**: per-turn local notes under the filmstrip (project-scoped, exported into MD/HTML/JSON)
- **Pack compare**: pick two storyboard JSON files (toolbar **A|B** or Ctrl+K) → side-by-side turn table
- **Budget compress**: large packs strip cold-turn mini diffs first (soft ~900k char budget)

## [1.4.7] — 2026-07-16

### Review handoff pack

- **Mini diffs** embedded in HTML/Markdown storyboard (per-file, size-capped from checkpoints)
- **PNG overview**: canvas raster of the turn filmstrip
- **Review folder**: pick directory → `storyboard.html` + `.md` + `.json` + `.png` and open folder

## [1.4.6] — 2026-07-16

### Storyboard HTML pack · open from tip

- **Click path in filmstrip tip** → open file in Code
- **HTML review pack**: self-contained offline storyboard (timeline + prompt + files)
- Export toolbar: **⬇** Markdown · **HTML** pack; save dialog supports both

## [1.4.5] — 2026-07-16

### Filmstrip polish

- **Hover paths**: filmstrip cards show floating full file path list + prompt snippet
- **Loop shortcut**: Diff tab **L** toggles loop (same as ↻)
- **Export storyboard**: ⬇ exports Markdown (+ JSON) of all turns / files

## [1.4.4] — 2026-07-16

### Loop · context menu · filmstrip

- **Scrub loop**: ↻ toggle — playback wraps to first turn instead of stopping on Live
- **Welcome right-click**: pin / apply / send / edit prompt / open pack
- **Diff filmstrip**: per-turn cards with heat bar, file count, sample names

## [1.4.3] — 2026-07-16

### Playback speed · project templates in Code · apply & send

- **Scrub speed**: 0.5x / 1x / 1.5x / 2x chips on Diff timeline (persisted)
- **Open project templates**: menu + Ctrl+K → open/create `.grok/templates.json` in Code
- **Welcome ↵**: one-click apply template and send (Craft)

## [1.4.2] — 2026-07-16

### Play scrub · project templates

- **Diff play**: ▶ / Space auto-scrubs through agent turns (ends on Live)
- **Welcome favorites**: ★ section first on empty task
- **Project templates**: load/merge `.grok/templates.json`; save current prompt into project pack

## [1.4.1] — 2026-07-16

### Scrub persistence · favorites

- **Diff scrub persisted** per project path (restored on project switch / Diff open)
- **Keyboard `[` `]`** (and ‹ › buttons) for previous / next agent turn
- **Template favorites**: ★ pin · filter favorites only · favorites sort first

## [1.4.0] — 2026-07-16

### Review cockpit

- **Turn timeline scrubber**: scrub across all Diff files by agent turn; dim untouched files; range + ticks
- **Template tags + search**: tags on starters; search box + #tag chips in template menu
- **Heat legend toggle**: Diff toolbar show/hide heat 0–4 legend
- **Encrypted template pack**: AES-GCM + PBKDF2 passphrase export/import (portable “remote-ready” sealed pack)

## [1.3.9] — 2026-07-16

### Templates marketplace-lite · heat · whole-turn

- **Template pack**: export / import JSON; opt-in **local sync folder** (OneDrive/Dropbox/local) push & pull
- **Diff blame heat**: +/- lines tint by turn age (heat 0–4, hotter = more recent)
- **Whole-turn restore**: restore all Diff files that share the selected checkpoint turnId

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
