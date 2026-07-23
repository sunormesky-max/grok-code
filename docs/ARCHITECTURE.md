# Architecture

GrokCode is a thin **desktop host** over the local open-source **Grok Build CLI**
([xai-org/grok-build](https://github.com/xai-org/grok-build)).

## Principles

1. **CLI is the brain** — tools, MCP, skills, plan mode, permissions live in `grok`.
2. **UI is the flight deck** — multi-project, multi-task, Live/Code/Diff, settings.
3. **Do not reimplement agent modes** — session mode is CLI-owned (`/plan`, Shift+Tab,
   `enter_plan_mode` / `exit_plan_mode`). Host injects only user + project rules.
4. **Local-first** — sessions under `~/.grok-code/`, CLI auth under `~/.grok/auth.json`.
5. **Stream first** — paint tokens/tools live; activity clock for inter-stage silence.
6. **Transport honesty** — prefer ACP (`grok agent stdio`); fall back to headless
   (`streaming-json`, same family as `grok -p`) when Build agent API is 403-gated.

## Process model

```text
┌──────────────────────────────────────────────────────────┐
│ Renderer                                                 │
│  projects · tasks · Live/Code/Diff · StreamFair          │
│  CLI mode chip (mirrors agent:mode) · ToolStorm          │
└───────────────────────────┬──────────────────────────────┘
                            │ preload IPC allowlist
┌───────────────────────────▼──────────────────────────────┐
│ Main                                                     │
│  agent.js     ACP primary · headless fallback            │
│  acp-client   initialize · authenticate · prompt         │
│  persist      ~/.grok-code/sessions                      │
│  diagnostics  doctor (CLI + auth.json + Build gate log)  │
└───────────────────────────┬──────────────────────────────┘
                            │ child_process
┌───────────────────────────▼──────────────────────────────┐
│ grok CLI  (user install · same binary as TUI)            │
│  primary:  grok agent … stdio   (ACP session/update)     │
│  fallback: grok -p … streaming-json                      │
│  YOLO:     --always-approve  ← settings alwaysApprove    │
│  plan:     CLI /plan · Shift+Tab · tools (not host UI)   │
└──────────────────────────────────────────────────────────┘
```

## Transports (settings → `agentTransport`)

| Value | Behavior |
|-------|----------|
| **auto** (default) | ACP first; on Build 403 / cold fail → headless |
| **acp** | Only `grok agent stdio` (full tool stream when entitled) |
| **headless** | Only `streaming-json` (like `grok -p`; weak tool UX) |

Env overrides: `GROKCODE_AGENT_TRANSPORT`, `GROKCODE_ACP_NO_FALLBACK=1`.

## Mode policy (CLI-native)

Host **does not** ship Craft/Plan/Ask/Goal prompt prefixes (see `modes.CLI_NATIVE`).
Session mode updates from the agent arrive as `session/update` → `agent:mode` and
are shown on the CLI chip. To plan: use the **CLI** (`/plan` in TUI) or let the
agent call `enter_plan_mode`; host only displays.

## Multi-project / multi-task

- **Project** = workspace path + tools + agent + watcher  
- **Task** = conversation + optional CLI `sessionId` + L0–L3 context  
- Restart restore: seed from `~/.grok-code/sessions` index (not only electron-store recent)

## Streaming path

```text
ACP session/update  or  headless NDJSON
  → agent-stream.js reduce
  → agent.js emit IPC
  → StreamFair / ToolStorm / Live mirrors
```

Upstream silence between stages is normal; host shows activity clock + phase.

## Related open source

| Upstream | Role |
|----------|------|
| [xai-org/grok-build](https://github.com/xai-org/grok-build) | Agent runtime, ACP server, plan mode, tools |
| [Agent Client Protocol](https://agentclientprotocol.com) | JSON-RPC host↔agent wire |
| This repo | Electron host + multi-project UX |

See also: `docs/ACP-SOURCE-AUDIT.md`, `patches/grok-build/`.
