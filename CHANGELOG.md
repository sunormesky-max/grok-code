# Changelog

All notable changes to GrokCode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- See [ROADMAP.md](ROADMAP.md)

## [1.18.0] — 2026-07-23

### Host ↔ open-source Grok Build — reasoning effort (`/effort`)

CLI sets reasoning effort via `/effort` and `session/set_model` meta
(`reasoning_effort`). GrokCode now mirrors that path.

- **Config** `reasoningEffort` (`low` | `medium` | `high` | `xhigh` | empty)
- **Spawn** already passed `--reasoning-effort`; now driven from settings
- **Live** model chip + effort chip re-call `session/set_model` with effort meta
- **UI** composer `effort · …` chip, settings field, slash `/effort` cycle
- **Normalize** aliases (`x-high`/`max` → `xhigh`, `med` → `medium`)
- Unit tests for effort normalize

## [1.17.0] — 2026-07-23

### Host ↔ open-source Grok Build — `session/set_model`

Composer model chip previously only wrote settings for the *next* spawn.
Now, when an ACP session is warm/running, the host calls the same
`session/set_model` the CLI pager uses.

- **ACP** `setModel(sessionId, modelId, { reasoningEffort? })`
- **IPC** `agent:set_model` / `setSessionModel`; event `agent:model`
- **UI** model preset/custom applies config + live switch when possible
- **Mirror** `x.ai/session_notification` `ModelChanged` → chip + Live
- Empty model id stays “CLI default” (config only, no set_model)
- Unit tests for set_model wire shape + deferred without warm session

## [1.16.0] — 2026-07-23

### Host ↔ open-source Grok Build — `session/set_mode` + doctor probe

CLI owns session modes (`default` | `plan` | `ask`). GrokCode now calls the same
ACP method the pager uses on Shift+Tab / `/plan`, instead of inventing host modes.

- **`session/set_mode`**: IPC `agent:set_mode` / `setSessionMode`; warm-pool aware
- **UI**: status chip cycles default → plan → ask; slash `/plan` `/agent` `/ask` `/cli`
- **Doctor**: optional timed `grok -p` probe (checkbox or `GROKCODE_DOCTOR_PROBE=1`)
- **Tools**: mid-flight `in_progress` updates surface partial result text when present
- Unit tests for mode normalize + set_mode wire shape + doctor skip path

## [1.15.0] — 2026-07-23

### Host ↔ open-source Grok Build — `x.ai/ask_user_question`

When the agent calls `ask_user_question`, the CLI reverse-requests
`x.ai/ask_user_question` (AskUserQuestionExtRequest/Response). Hosts that
auto-`cancelled` blocked interviews; GrokCode now parks and shows a questionnaire.

- **Park reverse-request** until the desktop UI answers (default)
- **Question bar**: multi/single select + freeform Other + notes
- **Outcomes** (wire-tagged): `accepted` · `cancelled` · plan-mode
  `chat_about_this` / `skip_interview` with `partial_answers`
- Replacing a pending questionnaire cancels the previous (pager parity)
- IPC: `agent:user_question` + `agent:user_question_reply` / `replyUserQuestion`
- Opt-out: `GROKCODE_AUTO_CANCEL_ASK_USER=1` (legacy non-hang cancel)
- Unit tests for normalize / park / replace / ExtResponse shapes

## [1.14.0] — 2026-07-23

### Host ↔ open-source Grok Build — plan approval (`x.ai/exit_plan_mode`)

When the CLI agent finishes plan mode it reverse-requests `x.ai/exit_plan_mode`
(ExitPlanModeExtResponse: `approved` | `abandoned` | `cancelled` + optional
`feedback`). Earlier hosts answered with `{}` or auto-cancelled, so plan exit
could hang or skip user review.

- **Park reverse-request** until the desktop UI answers (default even under YOLO)
- **Plan approval bar**: Approve · Request changes (cancelled + feedback) · Quit
  (abandoned) — mirrors CLI `plan_approval_view` outcomes
- IPC: `agent:plan_approval` event + `agent:plan_reply` / `replyPlanApproval`
- Optional auto-approve: `GROKCODE_AUTO_APPROVE_PLAN=1` (or `planInteractive: false`)
- Unit tests for park / resolve / gateway unwrap (`_x.ai/exit_plan_mode`)

## [1.13.0] — 2026-07-18

### Host ↔ open-source Grok Build CLI

Continues the “thin host” line: GrokCode does not invent agent modes; it docks to
[xai-org/grok-build](https://github.com/xai-org/grok-build).

- **agentTransport** setting: `auto` (ACP → headless on 403) | `acp` | `headless`
- **Doctor**: `~/.grok/auth.json` presence; recent stream log Build 403 / cli-chat-proxy gate
- **CLI mode chip**: mirrors `agent:mode` (`current_mode_update` from ACP)
- **Architecture / ROADMAP / ACP audit** updated for CLI-native host model

## [1.12.1] — 2026-07-18

### Fixed

- **Project persistence restore**: startup only reopened `recentProjects` (often empty in
  electron-store) and only scanned `~/.grok-code/sessions` when *no* project was open —
  one seeded project blocked the rest. Now seed recent from session index + always merge
  all snapshots into the project bar and rehydrate tasks/messages.
  **Your data was not deleted** — still under `%USERPROFILE%\.grok-code\sessions\`.

## [1.12.0] — 2026-07-18

### Breaking — CLI-native modes only (no host Craft/Plan/Ask/Goal)

GrokCode is a host for the local Grok CLI. Inventing Craft/Plan/Ask/Goal via
prompt prefixes and permission overrides caused drift from CLI behavior
(`/plan`, Shift+Tab Normal↔Plan↔Always-approve, enter_plan_mode tools).

- **Default `CLI_NATIVE`**: no mode/style rules injected into `--rules`; no
  mode prompt prefixes; Ask no longer forces YOLO off; Plan no longer caps turns
- Mode bar shows single **CLI** chip; palette modes collapsed to CLI
- Permission = settings `alwaysApprove` only (maps to CLI `--always-approve`)
- Opt out (legacy host modes): `GROKCODE_CLI_NATIVE=0` (not recommended)

## [1.11.5] — 2026-07-18

### Fix — ACP 403 Build gate → headless fallback (matches working `grok -p`)

Root cause (local probe): `grok -p --output-format streaming-json` works (thought+text,
model `grok-4.5-build`), but `grok agent stdio` + `session/prompt` hits
`cli-chat-proxy.grok.com/v1/responses` with **403** *Grok Build is coming soon*
even after successful `authenticate` (SuperGrok Heavy). GrokCode only used ACP,
so desktop failed while terminal `-p` worked.

- Call ACP `authenticate` after `initialize` (`cached_token`)
- Surface JSON-RPC `error.data.message` (403 body) instead of bare "Internal error"
- On Build-gate 403 / cold ACP failure with no tools yet → **auto headless**
  (`streaming-json`, same family as `grok -p`); tools progress limited until
  agent stdio is entitled
- Env: `GROKCODE_ACP_NO_FALLBACK=1` to disable; `GROKCODE_AGENT_TRANSPORT=headless` force

## [1.11.4] — 2026-07-18

### Fix — humanize Grok API 403 / auth errors

- Root cause of `Error: Internal error` on Craft: upstream API **403**  
  `Grok Build is coming soon. You don't have access now` (not a GrokCode crash).
- Map 403 / AuthorizationRequired / Internal-error wrappers to clear Chinese copy + next steps (`grok login` / API key).
- Log stderr ERROR lines with force; phase shows access error immediately.

### Earlier

- Auto-update `latest.yml` race (publish never in Release workflow).

## [1.11.3] — 2026-07-18

### Fix — craft black box: tool_delta follow-ups + stuck "Grok · stream"

Diagnosis (`%TEMP%\grokcode-stream.log`, craft run): after first thought/text, host saw **only** `x.ai` `tool_call_delta_chunk` for minutes (0 standard `tool_call`), with 7–30s gaps. Subsequent delta frames omit `tool_call_id`/`name` and only send `tool_index` + `arguments_delta` — we treated them as `id= name=tool` and dropped arg progress. Chat role stayed **Grok · stream** because role only updated on text paint.

- Resolve ToolCallDelta via `tool_index` map + accumulate `arguments_delta` → live tool args/path
- Handle `pending_interaction` / `interaction_resolved` (approve → execute phase)
- `paintLiveAssistantRole`: phase changes update chrome to `Grok · tool · write…` etc.
- Unit test for first/later delta frames (matches grok-build notification.rs contract)

## [1.11.2] — 2026-07-18

### ACP identity + live token meter

- **`clientType: Desktop`**: `initialize` meta dual-writes `clientType: "grok_desktop"`, `clientIdentifier` / `clientSource: "grok-desktop"`, `clientVersion` (upstream `mvp_agent` only reads **meta**, not `clientInfo.name` — name stays `GrokCode` for product branding).
- **Live `totalTokens`**: each `session/update` / `x.ai/session_notification` `_meta.totalTokens` throttled → `agent:usage` mid-turn; activity clock shows `~N tok`.
- Tracks `turnStartMs` when present for future turn-relative UI.

## [1.11.1] — 2026-07-18

### ACP host residual polish (post 1.11.0 audit)

- **ToolStorm late-wave merge**: tools arriving after the 90ms coalesce window still join an open storm card (ACP often emits parallel tools in waves).
- **ToolCallDelta progress**: mid-flight `x.ai` deltas refine existing tool/storm args (`progress: true`) instead of only opening first-seen tools.
- **Multimodal `pickChunkText`**: joins text blocks; skips image/audio/resource.
- **Reverse requests**: plan/exit_plan also emit `agent:permission`; unknown agent→client methods breadcrumb as `agent:ext` `reverse_request` (still reply `{}` so agent never hangs).
- **Usage flags**: normalize `usageIsIncomplete` / `costIsPartial` for Live brief.
- Audit doc sections reconciled with shipped host surface.

## [1.11.0] — 2026-07-18

### Full ACP host surface (post source audit)

- **Permission**: `acp-permission.js` picks real `optionId` from agent options (AllowOnce first, never invent IDs); plan/exit reverse-requests no longer hang on empty `{}`.
- **Tool storm**: `ToolStorm` coalesces ≥3 parallel tools into one batch card with live timers (fixes ACP same-ms tool dumps flooding chat).
- **Plan / mode / commands**: `agent:plan` `agent:mode` `agent:commands` IPC + Live mirrors.
- **Usage**: show cache / incomplete / cost-partial flags.
- **x.ai ext**: permission + unhandled `agent:ext` Live breadcrumbs.
- Audit: `docs/ACP-SOURCE-AUDIT.md`
## [1.10.12] — 2026-07-18

### Audit — wire `x.ai/session_notification` + full ACP source map

- Full audit vs grok-build: `docs/ACP-SOURCE-AUDIT.md`
- Subscribe to `x.ai/session_notification` (was dropped): tool deltas, retry, auto-compact, goal, subagent, task complete → phase / tool liveness
- Standard `session/update` path unchanged; inter-stage activity clock from 1.10.11 kept
## [1.10.11] — 2026-07-18

### Fix — anti-black-box clock for whole prompt (not just first token)

Root cause of “still black box on 1.10.10”: `bufferingSettings` only refines **within** a text/thought span. Long runs stay silent for minutes **between** tool batches with zero `session/update` — and we **stopped** the wait timer after first token, so UI looked frozen.

- Activity clock runs until prompt completes: 首包 / 工具执行中×N / 等待模型继续…
- Thought panel stays **expanded** while streaming
- Tight `bufferingSettings` 1/1/1 + dual `_meta`/`meta` for wire compatibility
## [1.10.10] — 2026-07-18

### ACP stream tuning + upstream patch kit

- Pass `initialize._meta.bufferingSettings` (maxItems=1) for low-latency chunk flush (grok-build ReplayBuffer contract).
- Handle ACP `tool_call_update` status `in_progress` / `pending` (keep tool card running).
- Add `patches/grok-build/`: experimental `InProgress` emit patch + `FEEDBACK.md` for `/feedback` (upstream Issues disabled).
## [1.10.9] — 2026-07-18

### UX — work with upstream ACP batch cadence (not fake token stream)

Upstream grok Build 0.2.x ACP flushes thought/text/tool in **stage batches** with multi-second silent gaps (not token-SSE). GrokCode cannot invent tokens; we improve wait UX:

- **Warm ACP pool**: keep `grok agent stdio` + session after a turn; next prompt skips `initialize`/`session/new` (~1s+ cold path). Log: `acp REUSE` / `session_reuse` / `reused=1`.
- **Wait-clock during CLI silence**: after prompt send, phase ticks `等待模型（CLI 批量段）… Ns` until first thought/text/tool.
- **Tool running timer**: tool cards show `running… Ns` (CLI has no `in_progress`); end shows elapsed seconds.

## [1.10.8] — 2026-07-18

### Fix — packaging integrity (prevent missing-module crashes)

- **1.10.6 crash** was missing `agent-stream.js` in asar; **installed Program Files is still 1.10.6** until reinstall
- Commit remaining pack modules: `ipc-channels.js`, `stream-scheduler.js` + renderer wiring
- `scripts/check-pack-requires.js` fails CI if any electron `require('./…')` or index.html script is untracked

## [1.10.7] — 2026-07-17

### Fix — missing `agent-stream` module crashed installed app

- **Symptom**: main process uncaught `Cannot find module './agent-stream'` under `Program Files\GrokCode\resources\app.asar`
- **Cause**: `electron/agent.js` required `./agent-stream`, but `electron/agent-stream.js` was never committed — CI packaged an asar without the file
- **Fix**: ship `electron/agent-stream.js` (pure NDJSON/ACP reducers used by headless path + unit fixtures)

## [1.10.6] — 2026-07-17

### Fix — kill pre-stream silence (compress + ACP handshake)

Diagnosis (full pipeline review):
1. `compressWithMode` awaited LLM enrich **before** spawn (up to ~25s, no progress events).
2. ACP `initialize → session/new|load → prompt` was a black-box boot with no phased status.
3. Streaming path itself was OK after first token; silence felt like "not streaming".

Changes:
- **Compress**: heuristic always first; LLM enrich budgeted to **3.5s** then fall back to heuristic (prompt never waits full API timeout).
- **Prep phases**: emit `agent:phase` from the moment of Send (准备上下文 → 压缩 → 启动 Agent).
- **ACP handshake phases**: initialize / session/load|new / 等待首包, with `FIRST_TOKEN` + timing lines in `grokcode-stream.log`.

## [1.10.5] — 2026-07-17

### Fix — ACP session/load history replay made UI look blank

- **Root cause**: `session/load` replays old `tool_call` / message updates before the new prompt. GrokCode treated them as live → 60+ tools in 1ms, chat/Live flooded or stuck, looked like “running with no output”.
- **Gate**: only forward `session/update` while `session/prompt` is in flight.
- **IPC**: `safeIpc` + slim tool args so Electron structured-clone never drops payloads.
- **UI**: force paint on first thought/text token and on `agent:done`; tool rows deduped + force-scroll.

## [1.10.4] — 2026-07-17

### Fix — wire real agent transport (ACP), not headless-only stream

**Root cause:** Grok headless `--output-format streaming-json` officially emits only `text` / `thought` / `end` (plus error). **Tool calls and execution progress are never on that stream.** GrokCode was spawning headless and expecting `tool_*` events that the CLI never sends — so the UI looked black-box / dumped a final reply after silent tool work.

**Fix:**
- Primary transport is now **ACP**: `grok agent --always-approve --no-leader stdio`
- Maps `session/update` → UI: `agent_message_chunk` → stream, `agent_thought_chunk` → thought, `tool_call` / `tool_call_update` → tool start/end
- Auto-answers `session/request_permission` when YOLO/always-approve
- Headless `streaming-json` kept as emergency fallback (`GROKCODE_AGENT_TRANSPORT=headless`)

## [1.10.3] — 2026-07-17

### Fix — real-time stream paint (no sudden full dump)

- **IPC coalesce (~60fps)**: text/thought no longer emit full `finalText` on every CLI token (flooded Electron → renderer painted one huge chunk). Latest snapshot flushed every ~16ms; tool/end/stop flush immediately.
- **Async stream debug**: `%TEMP%\grokcode-stream.log` batched/async + sampled (set `GROKCODE_STREAM_DEBUG=full` for every line; `=0` to disable). Sync disk I/O removed from hot path.
- **UI**: stream body prefers DOM append; Live phase label throttled; first token still flushes immediately.

## [1.10.2] — 2026-07-17

### Fix / harden — security & process hygiene (audit follow-up)

- **`shell:openExternal` whitelist**: only `http` / `https` / `mailto` (blocks `file://`, `javascript:`, custom schemes, CRLF injection). Shared helper `electron/shell-safe.js` + unit tests.
- **Orphan Grok CLI cleanup**: track spawned PIDs; stop/close/quit runs `taskkill /T /F` (Windows) with a second-pass reap so zombie `grok.exe` trees do not linger after stop or app exit.
- **Ask mode**: UI mutation hard-block uses `normalizeWorkMode`; agent path still forces `alwaysApprove=false` (no YOLO in Ask even when Settings YOLO is on).

## [1.10.1] — 2026-07-16

### Fix — stop/kill no longer surfaces fake `4294967295`

- **Root cause**: Windows `taskkill` / forced process end reports exit `-1` (`4294967295`). Old agent treated it as a hard CLI failure.
- **intentionalStops**: user stop, replace-run, and cleanup mark the task so close resolves as **stopped** (keeps partial text), not as Error.
- Unexpected kill still maps to a readable Chinese message and **auto-retries once without resume**.
- `scripts/start-dev.ps1` — launch **repo** build so fixes apply (installed `Program Files\GrokCode` lags git).

## [1.10.0] — 2026-07-16

### Goal mode + architecture / perf / UI converge

#### Goal 目标模式
- Fourth work mode **Goal**: anchor an outcome, milestone through it, report `【目标进度】`
- Task-level `goal` state (title / progress% / status / next) — persisted & re-injected each turn
- UI **goal track** bar under mode chips; clear button; Ctrl+4 · `/goal` · command palette
- Full tool throttle (like Craft) with extra max-turns headroom for multi-milestone flights

#### Performance
- **LiveBatcher**: coalesce timeline rebuilds (~56ms) under tool storms
- Fast-path **append** into Live virtual timeline when filter is `all`
- Flush Live batch on run complete; architecture doc spells out stream path

#### UI converge
- Mode strip: Craft · Plan · **Goal** · Ask — denser chips, shorter hints
- Composer hints trimmed to ↵ / / / @ / count
- Status bar shortcut line: Ctrl+1–4 modes
- Work shell keeps Live primary; less chrome noise

#### Architecture
- `docs/ARCHITECTURE.md`: modes table, stream/perf path, preload allowlist note
- Shared `normalizeWorkMode` / `WORK_MODE_IDS` in `modes.js`

## [1.9.6] — 2026-07-16

### Core — real-time streaming (no black box)

- **Preload allowlist**: pass through `agent:phase` + `agent:usage` (were silently dropped — phase machine / Live path dead)
- **StreamFair**: active task paints every frame (`ACTIVE_MS: 0`); first token flushes immediately
- **Live stream mirrors**: sticky think/stream cards in center Live timeline update as tokens arrive
- **Path breadcrumbs**: boot / thinking / tool path / usage visible mid-run; tools flush pending chat stream first
- Chat + Live both stream; no more “silent until done then dump”

## [1.9.5] — 2026-07-16

### A11y — keyboard & screen reader pass

- **`a11y.js` / `a11y.css`**: focus trap for Settings + Command palette; restore focus on close
- **Live regions**: polite/assertive announcers; toast `role=status|alert`; agent status announced
- **Landmarks**: main / Explorer / Agent / Workspace / conversation log; tablists for Live·Code·Diff & tasks
- **Skip link** → `#prompt` composer; stronger `:focus-visible` rings
- Mode chips already use `aria-pressed`; editor tabs sync `aria-selected`
- docs/VISUAL-QA a11y checklist expanded

## [1.9.4] — 2026-07-16

### Core — Plan → Craft execute chain

- **Shared helpers** in `modes.js`: `isPlanExecutePhrase`, `looksLikePlan`, `buildPlanExecutePrompt`
- Typing **执行 / implement the plan** in Plan mode auto-promotes turn to Craft (+ sticky mode switch)
- Execute bar embeds **plan excerpt** into Craft prompt (not a vague one-liner)
- Actions: **执行方案** · **调整方案** · 稍后；preview of first step
- Mission bar labels **PLAN→CRAFT** after execute flights; higher max-turns for plan execute
- Unit tests for phrase / plan detect / execute prompt

## [1.9.3] — 2026-07-16

### Core — context inheritance quality (L0–L3)

- **L0**: prefer complete user→assistant pairs; mark interrupted replies
- **L1**: denser prior merge + bullet extraction from older assistant turns
- **L2**: open/TODO items, Diff changed files, turn trajectory (mode/停/完), stop hints
- **L3**: weighted hot files from Diff; stronger constraint mining
- **Prompt**: continue-from-stop guidance + changed-file list
- Wire `turns` / `changedFiles` / `isContinue` from renderer → compress pipeline
- Unit tests for stop-aware compression

## [1.9.2] — 2026-07-16

### Core — multi-task stream fairness

- **StreamFair scheduler**: active task ~60fps paint; background ~7fps; max 2 paints/frame; oldest-waiting fair order
- **Focus catch-up**: switching tasks immediately flushes that task's stream/thought
- **Tabs throttle** (~280ms) under multi-run; project strip rebuild only when ≥2 running
- **Live noise control**: background tool events batched; tree refresh only for active writes
- Task queue hint shows `N 并行 · 公平流` when multi-running

## [1.9.1] — 2026-07-16

### Core — stop / resume + turn markers

- **Stop**: user interrupt resolves cleanly (`agent:done` + `stopped`); keeps partial stream text
- **Stop bar**: Continue (resume session) · Retry prompt · Fresh session
- **Turn markers** in chat: mode chip · time · prompt snippet · done/stopped/error stamp
- `task.turns[]` recent history for timeline metadata
- Retry bar also shows error snippet; clearer stop Live phase

## [1.9.0] — 2026-07-16

### Core — task flow & streaming pipeline

- **Phase machine** on each run: `boot → thinking → tool → streaming → done` via `agent:phase`
- **Status throttle**: no longer spam `speaking…` on every token
- **Streaming JSON**: broader event types; sessionId/usage/`stopReason` from `end`
- **Chat stream UX**: caret on live assistant bubble; role shows `stream` / `think` / `tool`
- **Task tabs**: live phase chip (思考 / 工具 / 输出) + color dots
- **Usage footer** on completed assistant turn (`in` / `out` tokens when CLI provides)
- `agent:usage` event for Live phase / metrics

## [1.8.2] — 2026-07-16

### Fix Craft / Plan / Ask mode switching

- Bind mode chips **early** in `init` (no longer blocked if project restore fails)
- Capture-phase **event delegation** on `#modeBar` (robust clicks)
- Ctrl/Cmd+1/2/3 also match `Digit*` key codes
- Distinct active colors for Plan (orange) / Ask (violet) over flight-deck CSS
- Composer / mode bar raised above panel chrome (`z-index` + `pointer-events`)

## [1.8.1] — 2026-07-16

### Code / Diff chrome collapse — keep body visible

- **Diff**: turn tools (filmstrip · export · ticks · notes) behind **▸ 工具** (default collapsed); checkpoints collapse to one summary row
- **Diff layout**: chrome stack + scrollable body so line diffs always fill remaining height
- **Code**: Outline **default collapsed** (▸ rail); expand when needed
- Center tabs **nowrap** (no second row stealing height); Diff toolbar single-row scroll
- Heat legend default **off**

## [1.8.0] — 2026-07-16

### Layout simplify — default shell converge

- **Presets**: primary **Work** + **Review** only; Pilot / Full / Auto under **···** menu
- **Auto-Pilot default off** (no surprise ultra-wide flip)
- **Center tabs**: Live primary; Split / follow / path hidden on Live (shown on Code/Diff)
- Quieter project strip, calmer chat head icons, softer Agent chrome
- New `layout-simple.css` · Ctrl+K labels: Work first, advanced last

## [1.7.1] — 2026-07-16

### Plugin marketplace — TUI flag parity

- **Filters**: scope (all / installed / available / markets), status (enabled / disabled), marketplace select, free-text search
- **Actions**: `plugin update` (one + all), `plugin validate [path]`, install **`--trust`** checkbox
- Row: update · details · enable/disable · uninstall; ON/OFF badges
- IPC: `plugin:update`, `plugin:validate` · pure `filterPlugins` unit tests
- Closes ROADMAP “Plugin marketplace filters parity with every TUI flag”

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
