# Roadmap

Living plan for the GrokCode open-source ecosystem. Order may change based on community feedback.

## Now (v1.x)

- [x] Core desktop agent + multi-project / multi-task / Live·Code·Diff
- [x] Context L0–L3 · MCP/Skills · OSS packaging · onboarding · reliability
- [x] Plugins · i18n · themes · profiles · telemetry · catalog · pages · icons
- [x] Chat + Live virtualization · a11y basics
- [x] **Command palette** (Ctrl+K) + project/task switcher
- [x] **Dependabot** + packaging dep upgrade path
- [x] **MCP/Skills i18n** for management UI
- [x] **UI polish** layer (glass, chips, composer, scrollbars)
- [x] Settings general form i18n
- [x] Keyboard cheatsheet · density themes · file tree polish
- [x] Global file/content search · Code|Diff split · Electron 43
- [x] Craft/Plan/Ask modes · style packs · personal protect / trash delete
- [x] Ask IPC hard-block · outline · split width persist · skills index inject
- [x] Plan execute chip · per-project split width · multi-lang outline · skill match chips
- [x] Craft flight deck (one-shot Craft, mission bar, mode HUD)
- [x] Skill preview modal · outline sticky · plan auto-detect · session share card
- [x] Task rename · Live filters · Diff hunk fold · Composer model chip
- [x] Diff review/j-k/multi-select · slash cmds · chat message search
- [x] @file mentions · Diff side-by-side · task pin/reorder · prompt drafts
- [x] Diff blame hover · paste attach · rules chip · bg flight notify
- [x] Diff checkpoints · drag-drop attach · .grok/rules.md · quiet hours
- [x] Rules open in Code · A→B checkpoint compare · paste→.grok/paste · templates pack
- [x] Template import/export + local sync · blame heat · whole-turn restore
- [x] Turn scrubber · template tags/search · heat legend · encrypted packs (v1.4.0)
- [x] Scrub persist · [ ] keys · template favorites (v1.4.1)
- [x] Diff play scrub · welcome ★ · `.grok/templates.json` (v1.4.2)
- [x] Scrub speed · open templates in Code · welcome apply&send (v1.4.3)
- [x] Loop scrub · welcome context menu · Diff filmstrip (v1.4.4)
- [x] Filmstrip hover paths · L loop · storyboard export (v1.4.5)
- [x] HTML review pack · tip open-in-Code (v1.4.6)
- [x] Mini diffs · PNG · review folder pack (v1.4.7)
- [x] Storyboard notes · pack A|B compare · budget compress (v1.4.8)
- [x] Pack compare polish · progressive compress modes (v1.4.9)
- [x] HTML pack compare · encrypted storyboard export (v1.4.10)
- [x] Native Windows titleBarOverlay · calmer collapsible chrome (v1.4.13–1.4.14)
- [x] Agent-first layout shell · Agent/Review/Full presets (v1.5.0)
- [x] Pilot chat-center layout · Diff↔Agent review bridge (v1.5.1)
- [x] Auto-Pilot ultra-wide · storyboard filmstrip import (v1.5.2)
- [x] Storyboard disk rehydrate when paths exist (v1.5.3)
- [x] Visual impact flight-deck polish (v1.5.4)
- [x] Chat/Live drama · theme intensity · micro-interactions (v1.5.5)
- [x] FX toggle · boot refresh · Diff filmstrip HUD parity (v1.5.6)
- [x] Welcome/empty · toast/modal glass · haptic CSS (v1.5.7)
- [x] Onboarding · settings sections · a11y motion docs (v1.5.8)
- [x] MCP/Skills/Plugins panes · doctor cards · force reduce motion (v1.5.9)
- [x] Command palette · global search HUD · visual QA checklist (v1.6.0)
- [x] Help overlay · compact audit · themed boot (v1.6.1)
- [x] Outline / split / tree flight-deck pass (v1.6.2)
- [x] Optional cinematic idle ambient (v1.6.3)
- [x] Storyboard mini-diff → before reconstruct (v1.7.0)
- [x] Plugin marketplace TUI filter/action parity (v1.7.1)
- [x] Default shell converge · Work/Review primary (v1.8.0)
- [x] Core task flow + streaming pipeline (v1.9.0)

## Now (core)

- [x] Stream contract modules + fixture tests (agent-stream / ipc-channels / stream-scheduler)
- [x] Task phase machine + stream paint (v1.9.0)
- [x] Turn markers + interrupt/resume continue bar (v1.9.1)
- [x] Multi-task stream fairness under heavy tool load (v1.9.2)
- [x] Context L0–L3 inheritance quality for long tasks (v1.9.3)
- [x] Plan → Craft execute chain (v1.9.4)
- [x] Real-time stream (no black box) (v1.9.6)
- [x] **Goal mode** + LiveBatcher perf + arch doc (v1.10.0)
- [x] openExternal whitelist · orphan grok reap · Ask YOLO hard-off (v1.10.2)
- [x] Full ACP host surface: permission picker, ToolStorm, plan/mode/commands, x.ai ext (v1.11.0)
- [x] ACP residual: storm late-wave, tool-delta progress, multimodal text, reverse-req crumbs (v1.11.1)
- [x] ACP Desktop clientType + live totalTokens meter (v1.11.2)
- [x] CLI-native modes only — no host Craft/Plan/Ask/Goal inject (v1.12.0)
- [x] Restore all projects from `~/.grok-code/sessions` on startup (v1.12.1)
- [x] ACP Build 403 → headless fallback like `grok -p` (v1.11.5+)
- [x] agentTransport setting + doctor Build-gate / auth.json (v1.13.0)
- [x] Interactive `x.ai/exit_plan_mode` plan approval UI (v1.14.0)
- [x] Interactive `x.ai/ask_user_question` questionnaire UI (v1.15.0)
- [x] ACP `session/set_mode` (default/plan/ask) from host chip + slash (v1.16.0)
- [x] Doctor optional timed `grok -p` probe (v1.16.0)
- [x] Prefer tool mid-flight partial text when upstream emits InProgress (v1.16.0 host side)
- [x] ACP `session/set_model` from host model chip (v1.17.0)
- [x] Reasoning effort picker via set_model meta + /effort (v1.18.0)
- [x] Live model list from `grok models` + ACP modelState (v1.19.0)
- [x] Per-model effort options from model meta (v1.20.0)
- [x] Document InProgress CLI patch in doctor / settings / ARCHITECTURE (v1.21.0)
- [x] Detect/mark patched InProgress CLI (env · settings · marker file) (v1.22.0)
- [x] README CLI-native truth + invalidate ACP warm pool on settings change (v1.23.0)
- [x] Deeper a11y: interactive announces, menu ARIA, A11Y checklist (v1.24.0)
- [x] Menu arrow-key nav + warm-recycle save toast (v1.25.0)
- [x] Keyboard cheatsheet CLI-native (no Craft/Plan inject) (v1.26.0)
- [x] CLI-native surface copy + mission bar for cli turns (v1.27.0)
- [x] Stream gate + tool humanize from OpenWorker patterns (v1.28.0)
- [x] Global Inbox for plan / ask across tasks (v1.29.0)

## Next (host UX — OpenWorker-inspired)

- [ ] Plan-card execute permission tier (ask-per-step vs YOLO via settings)
- [ ] Session standing grants (within CLI option IDs only)
- [ ] Durable park resume across app restart

## Next (host ↔ open-source grok-build)

- [ ] Upstream still needs normal-tool InProgress emit for long tools (stock CLI; patch optional — see patches/)

## Now (UI / experience)

- [x] Outline panel / split layout visual pass
- [x] Tree polish vs flight-deck chrome consistency
- [x] Optional “cinematic idle” ambient (off by default)
- [x] Layout simplify — hide advanced presets by default
- [x] Mode strip converge + goal track (v1.10.0)

## Deferred (services — not now)

- [ ] Optional true cloud template vault (accounted service)
- [ ] Share encrypted packs via optional link service
- [ ] Shared cloud team profiles

## Later

- [x] Storyboard: reconstruct before from mini-diff when possible
- [x] Accessibility pass: focus trap, live regions, landmarks (v1.9.5)
- [x] Deeper screen-reader checklist + interactive SR (v1.24.0; full NVDA/VO still welcome via issues)
- [x] Plugin marketplace filters parity with every TUI flag

## How to influence

1. [Feature request](https://github.com/sunormesky-max/grok-code/issues/new?template=feature_request.md)
2. [Discussions](https://github.com/sunormesky-max/grok-code/discussions)
3. PR — [CONTRIBUTING.md](CONTRIBUTING.md)
