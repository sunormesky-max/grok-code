# Architecture

GrokCode is a thin **desktop control plane** over the local **Grok Build CLI**.

## Principles

1. **CLI is the brain** — tools, MCP, skills, permissions live in `grok`, not reimplemented.
2. **UI is the flight deck** — multi-project, multi-task, Live/Code/Diff, settings.
3. **Local-first** — sessions under `~/.grok-code/`, secrets never in the repo.

## Process model

```text
┌──────────────────────────────────────────────────────────┐
│ Renderer (Chromium)                                      │
│  renderer/*.js  — projects, tasks, Live/Code/Diff, MCP UI│
└───────────────────────────┬──────────────────────────────┘
                            │ contextBridge IPC (preload)
┌───────────────────────────▼──────────────────────────────┐
│ Main (Node)                                              │
│  electron/main.js     multi-project map, IPC             │
│  electron/agent.js    spawn grok headless per task       │
│  electron/tools.js    sandbox FS + terminal for UI       │
│  electron/persist.js  session JSON                       │
│  electron/context-compress.js  L0–L4 heuristics          │
│  electron/mcp-skills.js  grok mcp + ~/.grok/skills       │
└───────────────────────────┬──────────────────────────────┘
                            │ child_process
┌───────────────────────────▼──────────────────────────────┐
│ grok CLI  (user install)                                 │
│  --prompt-file · --cwd · streaming-json · --resume       │
│  --always-approve · MCP · Skills · same as TUI           │
└──────────────────────────────────────────────────────────┘
```

## Multi-project / multi-task

- **Project** = absolute workspace path + tools + agent + watcher + task map  
- **Task** = UI conversation + optional CLI `sessionId` + messages + L0–L3 context  
- Concurrent: many projects × many tasks, each with its own `grok` process  

## Context inheritance

- On disk: `~/.grok-code/sessions/<hash(path)>.json`  
- On each run: compress history → inject L3→L2→L1→L0 + current prompt  
- CLI `--resume` used when session id still valid  

## Security boundaries

- File tools resolve under project root only  
- YOLO auto-approves CLI tools — treat workspace as trusted  
- Renderer has no Node integration; all FS/agent via IPC  
