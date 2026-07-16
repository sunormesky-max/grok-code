# Architecture

GrokCode is a thin **desktop control plane** over the local **Grok Build CLI**.

## Principles

1. **CLI is the brain** — tools, MCP, skills, permissions live in `grok`, not reimplemented.
2. **UI is the flight deck** — multi-project, multi-task, Live/Code/Diff, settings.
3. **Local-first** — sessions under `~/.grok-code/`, secrets never in the repo.
4. **Stream first** — every run paints tokens/tools/path live; no black-box-until-done.
5. **Converge chrome** — default shell is Work (Agent + Live); advanced layouts stay tucked.

## Process model

```text
┌──────────────────────────────────────────────────────────┐
│ Renderer (Chromium)                                      │
│  projects · tasks · modes · Live/Code/Diff · StreamFair  │
│  LiveBatcher · goal track · layout-simple                │
└───────────────────────────┬──────────────────────────────┘
                            │ contextBridge IPC (preload allowlist)
┌───────────────────────────▼──────────────────────────────┐
│ Main (Node)                                              │
│  electron/main.js     multi-project map, IPC             │
│  electron/agent.js    spawn grok headless per task       │
│  electron/modes.js    Craft / Plan / Goal / Ask + rules  │
│  electron/tools.js    sandbox FS + terminal for UI       │
│  electron/persist.js  session JSON (+ task.goal)         │
│  electron/context-compress.js  L0–L3 heuristics          │
│  electron/mcp-skills.js  grok mcp + ~/.grok/skills       │
└───────────────────────────┬──────────────────────────────┘
                            │ child_process (streaming-json)
┌───────────────────────────▼──────────────────────────────┐
│ grok CLI  (user install)                                 │
│  --prompt-file · --cwd · streaming-json · --resume       │
│  --always-approve · MCP · Skills · same as TUI           │
└──────────────────────────────────────────────────────────┘
```

## Work modes

| Mode | Intent | Tools | Notes |
|------|--------|-------|--------|
| **Craft** | Act now | Full | Default flight |
| **Plan** | Design first | Limited turns | 「执行」→ Craft |
| **Goal** | Anchor outcome | Full (+ turns) | Sticky `task.goal` + progress parse |
| **Ask** | Read-only Q&A | No writes | Soft + hard blocks |

Goal state lives on the task (`title`, `status`, `progress`, `next`), is persisted, and is re-injected into each prompt via `modePromptPrefix(..., { goal })`.

## Multi-project / multi-task

- **Project** = absolute workspace path + tools + agent + watcher + task map  
- **Task** = UI conversation + optional CLI `sessionId` + messages + L0–L3 context + optional goal  
- Concurrent: many projects × many tasks, each with its own `grok` process  

## Streaming & performance path

```text
CLI stdout (NDJSON)
  → agent.js handleEvent  (text / thought / tool_* / phase / usage / done)
  → webContents.send      (preload allowlist — must include phase+usage)
  → renderer bindAgentEvents
       ├─ StreamFair     active: every frame · bg: throttle
       ├─ upsertAssistant / upsertThought / tool rows  (Chat)
       ├─ LiveBatcher    coalesce timeline rebuilds (~56ms)
       └─ live mirrors   sticky think/stream cards mid-run
```

Hot paths to keep cheap:

- Prefer **append** over full Live rebuild when filter is `all`
- Active task stream paint has **zero min delay** (rAF coalesce only)
- Tabs / project strip throttle under multi-run
- Background Live tool noise is batched

## Context inheritance

- On disk: `~/.grok-code/sessions/<hash(path)>.json`  
- On each run: compress history → inject L3→L2→L1→L0 + mode prefix + optional goal block + current prompt  
- CLI `--resume` used when session id still valid  

## Security boundaries

- File tools resolve under project root only  
- YOLO auto-approves CLI tools — treat workspace as trusted  
- Renderer has no Node integration; all FS/agent via IPC  
- Preload only exposes an allowlisted set of IPC event channels
