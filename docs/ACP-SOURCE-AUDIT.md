# GrokCode × grok-build ACP source audit

Date: 2026-07-18  
Upstream tree: [xai-org/grok-build](https://github.com/xai-org/grok-build) (local clone)  
GrokCode focus: `electron/acp-client.js`, `electron/agent.js`, renderer stream path

This audit maps **what the agent actually emits** to **what GrokCode consumes**, and lists residual black-box / correctness gaps.

---

## 1. Two notification planes (critical)

| Plane | Wire method | Content | GrokCode today |
|-------|-------------|---------|----------------|
| **ACP core** | `session/update` | `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `user_message_chunk` | **Handled** (1.11.x full surface) |
| **xAI extension** | `x.ai/session_notification` | `ToolCallDeltaChunk`, `RetryState`, `AutoCompact*`, `GoalUpdated`, `TurnCompleted`, `Subagent*`, `TaskCompleted`, … | **Handled** since 1.10.12 (phase + tool delta + `agent:ext`) |

Source (`updates.rs`):

- High-frequency **ACP** text/thought → `ReplayBuffer` → `session/update`
- High-frequency **xAI** `ToolCallDeltaChunk` → **only** `ExtNotification("x.ai/session_notification")`, **not** standard `session/update`, **not** persisted for replay

**Impact:** Tool argument streaming / mid-tool deltas never reach the UI. Auto-compact, retry, goal, subagent progress also invisible.

---

## 2. ACP `session/update` types

| Type | Upstream role | GrokCode |
|------|---------------|----------|
| `agent_message_chunk` | Assistant text deltas | ✅ → `agent:text` |
| `agent_thought_chunk` | Reasoning deltas | ✅ → `agent:thought` |
| `tool_call` | Tool start (`Pending` common) | ✅ → `agent:tool_start` |
| `tool_call_update` | Status/fields/result | ✅ partial (`in_progress`/`completed`/…) |
| `user_message_chunk` | Echo | ✅ ignored (ok) |
| `plan` | Execution plan entries | ✅ `agent:plan` + Live (1.11.0) |
| `available_commands_update` | Slash/tools meta | ✅ `agent:commands` (1.11.0) |
| `current_mode_update` | Session mode | ✅ `agent:mode` (1.11.0) |

---

## 3. Buffering (`ReplayBuffer`)

Source: `update_chunk_merge.rs` + `mvp_agent/acp_agent.rs`

| Client `initialize` | Server behavior |
|---------------------|-----------------|
| No `bufferingSettings` | `None` → **no merge**, each chunk sent immediately |
| Object present | Merge text/thought by `maxItems` / `maxBytes` / `maxDurationMs` |
| Struct defaults (when object partial) | 100 items / 2KB / **10ms** window |

Window clock is **`_meta.agentTimestampMs` (agent wall clock)**, not client `Date.now()`.

GrokCode ships tight profile + Desktop identity (1.11.2):

```js
_meta / meta: {
  clientType: 'grok_desktop',           // ClientType::Desktop (serde rename)
  clientIdentifier: 'grok-desktop',     // fallback if clientType parse fails
  clientSource: 'grok-desktop',         // PromptMetadata preference chain
  clientVersion: '<package.version>',
  bufferingSettings: { maxItems: 1, maxBytes: 1, maxDurationMs: 1 },
}
// clientInfo.name stays "GrokCode" — NOT used by mvp_agent for ClientType
```

**Does not fix:** multi-second/minute **inter-stage silence** (no updates at all).

---

## 4. Tool lifecycle (normal tools)

Source: `tool_calls.rs`

1. Early `ToolCall` often `status: Pending`
2. Optional refine update (title/locations)
3. Parallel dispatch after approval
4. On finish: `ToolCallUpdate` `Completed` / failed

Backend tools may emit `InProgress` (`BackendToolCallStarted`).  
Experimental patch: `patches/grok-build/0001-tool-in-progress.patch` emits `InProgress` before dispatch for normal tools.

GrokCode: local `running… Ns` clock compensates missing mid-flight events.

---

## 5. Session / process lifecycle

| Topic | Upstream | GrokCode | Risk |
|-------|----------|----------|------|
| Cold start | `initialize` → `session/new` \| `load` → `prompt` | Same | First-token silent ~1–4s (handshake + model) |
| Warm reuse | Persistent agent process (leader / long-lived stdio) | `acpPool` parks client after turn | ✅ skips init; **bufferingSettings stick to first init** |
| Cancel | `session/cancel` | On stop/abort | OK |
| History on load | Replay via `session/update` | Gated: only while `streaming` (prompt) | ✅ avoids history flood |
| Permission | `session/request_permission` reverse request | Auto-approve when YOLO | Shape is best-effort; non-YOLO returns cancel |

---

## 6. Usage / spend

Upstream documents ACP `_meta.usage` as **full** input (includes cache); headless projects **uncached** input.

GrokCode maps camelCase usage on prompt result; `formatUsageBrief` surfaces cache / incomplete / cost-partial flags (1.11.0+).  
Live mid-turn estimate: each `session/update` `_meta.totalTokens` → throttled `agent:usage` (1.11.2).

---

## 7. Headless fallback (`streaming-json`)

Source: `headless.rs` + docs

Emits only **`text` / `thought` / `end`** (plus error / max_turns). **No tools.**

GrokCode headless path must not be used for Craft/tool UX; ACP is mandatory for tool visibility.

---

## 8. Reverse requests (agent → client)

| Method | Risk if empty reply |
|--------|---------------------|
| `session/request_permission` | Handled (YOLO / cancel) |
| `x.ai/exit_plan_mode` | **Handled (1.14.0)** — park + UI approve/revise/quit; outcomes `approved` \| `abandoned` \| `cancelled` + `feedback` |
| `x.ai/ask_user_question` | **Handled (1.15.0)** — park + questionnaire UI; outcomes `accepted` \| `cancelled` \| `chat_about_this` \| `skip_interview` |
| Other `x.ai/*` reverse methods (fs, terminal, …) | **Empty `{}`** — fs/terminal not advertised |

We advertise **no** client fs/terminal capabilities (correct for “agent runs tools itself”).

---

## 9. UI / process gaps (GrokCode-specific)

| Issue | Severity | Notes |
|-------|----------|-------|
| Inter-stage silence after first token | High (UX) | Fixed in 1.10.11: activity clock for whole prompt |
| `x.ai/session_notification` dropped | High | Fixed 1.10.12+; ToolCallDelta progress refresh 1.11.1 |
| Thought collapsed while streaming | Medium | Fixed 1.10.11: keep open while live |
| Warm pool skips re-init | Low | Settings changes need process recycle (buffering stuck on first init) |
| Tool storm (N tools same ms) | Medium | Fixed 1.11.0 `ToolStorm`; late-wave merge 1.11.1 |
| Plan / mode / commands updates | Low | Fixed 1.11.0 Live mirrors |
| Multimodal content blocks | Low | `pickChunkText` joins text blocks, skips image/audio (1.11.1) |
| Permission option IDs | Medium | Fixed 1.11.0 `acp-permission.js` (AllowOnce first) |
| Concurrent GrokCode processes | Ops | Multiple Electron instances confuse logs |

---

## 10. Severity matrix (what still makes “black box”)

```
                    ┌─────────────────────────────────────┐
  Can GrokCode fix? │  Yes (host)     │  Only upstream    │
┌───────────────────┼─────────────────┼───────────────────┤
│ Within span fine  │ bufferingSettings│ sampler cadence  │
│   stream of text  │ (tight profile)  │                   │
├───────────────────┼─────────────────┼───────────────────┤
│ Silent 1–N min    │ activity clock   │ need heartbeat /  │
│   between stages  │ + expanded think │ more updates      │
├───────────────────┼─────────────────┼───────────────────┤
│ Tool mid progress │ local timer;     │ InProgress +      │
│                   │ ToolCallDelta*   │ ToolCallDelta     │
│                   │ if we subscribe  │ from agent        │
└───────────────────┴─────────────────┴───────────────────┘
```

\* `x.ai/session_notification` / `ToolCallDeltaChunk` subscribed since 1.10.12; tool-storm UI since 1.11.0.

---

## 11. Recommended work order

| Item | Status |
|------|--------|
| P0 `x.ai/session_notification` | Done (1.10.12) |
| P0 whole-prompt activity clock | Done (1.10.11) |
| P1 Tool-storm UI | Done (1.11.0 `ToolStorm`) |
| P1 Permission option picker | Done (1.11.0 `acp-permission.js`) |
| P2 plan / mode / commands | Done (1.11.0 `agent:plan|mode|commands`) |
| P2 usage incomplete flags | Done (formatUsageBrief) |
| P2 ToolStorm late-wave merge + delta args | Done (1.11.1) |
| P2 multimodal text extract | Done (1.11.1 pickChunkText) |
| P2 unknown reverse-req breadcrumb | Done (1.11.1 `agent:ext` reverse_request) |
| P2 clientType Desktop identity | Done (1.11.2 meta clientType/clientIdentifier) |
| P2 live `_meta.totalTokens` | Done (1.12.x throttled agent:usage) |
| P1 CLI-native modes (no host Craft/Plan inject) | Done (1.12.0) |
| P1 project restore from sessions index | Done (1.12.1) |
| P1 ACP 403 → headless (like grok -p) | Done (1.11.5+) |
| P2 agentTransport setting auto/acp/headless | Done (1.13.0) |
| P2 doctor Build gate + auth.json | Done (1.13.0) |
| P1 `x.ai/exit_plan_mode` interactive UI | Done (1.14.0 park + approve/revise/quit) |
| P1 `x.ai/ask_user_question` interactive UI | Done (1.15.0 park + questionnaire ExtResponse) |
| P1 `session/set_mode` host cycle | Done (1.16.0 default/plan/ask) |
| P2 doctor `grok -p` probe | Done (1.16.0 opt-in) |
| P1 `session/set_model` live switch | Done (1.17.0 + ModelChanged mirror) |
| P2 reasoning effort /effort | Done (1.18.0 set_model meta + chip) |
| P2 model list CLI + ACP modelState | Done (1.19.0 `grok models` + init/session) |
| P2 per-model effort options meta | Done (1.20.0 supportsReasoningEffort + reasoningEfforts) |
| Upstream `/feedback` | `patches/grok-build/FEEDBACK.md` |

---

## 12. File map

| Area | GrokCode | Upstream |
|------|----------|----------|
| JSON-RPC transport | `electron/acp-client.js` | `xai-acp-lib`, agent stdio |
| Prompt loop / emit | `electron/agent.js` | `acp_session_impl/*` |
| Chunk merge | client meta only | `update_chunk_merge.rs` |
| Tools | agent onUpdate | `tool_calls.rs` |
| xAI ext notify | `agent.js` onNotification | `extensions/notification.rs` + `emit_buffered` |
| Headless | `runHeadless` | `headless.rs` |
| UI stream | `renderer/app.js` StreamFair | n/a |
