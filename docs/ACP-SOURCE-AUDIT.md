# GrokCode × grok-build ACP source audit

Date: 2026-07-18  
Upstream tree: [xai-org/grok-build](https://github.com/xai-org/grok-build) (local clone)  
GrokCode focus: `electron/acp-client.js`, `electron/agent.js`, renderer stream path

This audit maps **what the agent actually emits** to **what GrokCode consumes**, and lists residual black-box / correctness gaps.

---

## 1. Two notification planes (critical)

| Plane | Wire method | Content | GrokCode today |
|-------|-------------|---------|----------------|
| **ACP core** | `session/update` | `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `user_message_chunk` | **Handled** (subset) |
| **xAI extension** | `x.ai/session_notification` | `ToolCallDeltaChunk`, `RetryState`, `AutoCompact*`, `GoalUpdated`, `TurnCompleted`, `Subagent*`, `TaskCompleted`, … | **Dropped** (`onNotification` no-op) |

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
| `plan` | Execution plan entries | ❌ ignored |
| `available_commands_update` | Slash/tools meta | ❌ ignored |
| `current_mode_update` | Session mode | ❌ ignored |

---

## 3. Buffering (`ReplayBuffer`)

Source: `update_chunk_merge.rs` + `mvp_agent/acp_agent.rs`

| Client `initialize` | Server behavior |
|---------------------|-----------------|
| No `bufferingSettings` | `None` → **no merge**, each chunk sent immediately |
| Object present | Merge text/thought by `maxItems` / `maxBytes` / `maxDurationMs` |
| Struct defaults (when object partial) | 100 items / 2KB / **10ms** window |

Window clock is **`_meta.agentTimestampMs` (agent wall clock)**, not client `Date.now()`.

GrokCode ships tight profile:

```js
_meta / meta: { bufferingSettings: { maxItems: 1, maxBytes: 1, maxDurationMs: 1 } }
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

GrokCode maps camelCase usage on prompt result; incomplete/partial cost flags mostly unused in UI.

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
| Other `x.ai/*` reverse methods (plan approval, fs, terminal, …) | **Empty `{}` response** — may fail plan/exit_plan_mode or hang rare paths |

We advertise **no** client fs/terminal capabilities (correct for “agent runs tools itself”).

---

## 9. UI / process gaps (GrokCode-specific)

| Issue | Severity | Notes |
|-------|----------|-------|
| Inter-stage silence after first token | High (UX) | Fixed in 1.10.11: activity clock for whole prompt |
| `x.ai/session_notification` dropped | High | Tool deltas / compact / retry invisible |
| Thought collapsed while streaming | Medium | Fixed 1.10.11: keep open while live |
| Warm pool skips re-init | Low | Settings changes need process recycle |
| Tool storm (N tools same ms) | Medium | Floods chat; needs batch summary card |
| Plan / mode / commands updates | Low | No UI surface yet |
| Multimodal content blocks | Low | Text-only `pickChunkText` |
| Permission option IDs | Medium | Heuristic `allow-once` may not match all builds |
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

\* Subscribing to `x.ai/session_notification` for `ToolCallDeltaChunk` is a **host fix** still missing until implemented.

---

## 11. Recommended work order

1. **P0** Handle `x.ai/session_notification` (at least `tool_call_delta_chunk`, `retry_state`, `auto_compact_*`, `turn_completed`, `goal_updated`) → phase + Live events  
2. **P0** Keep whole-prompt activity clock (1.10.11)  
3. **P1** Tool-storm UI: collapse parallel tools into one “N tools · Ns” card  
4. **P1** Permission response: map options from request payload exactly  
5. **P2** Surface `plan` / mode / available_commands  
6. **P2** Document usage incomplete flags in settings/doctor  
7. **Upstream** `/feedback` using `patches/grok-build/FEEDBACK.md` (Issues disabled on repo)

---

## 12. File map

| Area | GrokCode | Upstream |
|------|----------|----------|
| JSON-RPC transport | `electron/acp-client.js` | `xai-acp-lib`, agent stdio |
| Prompt loop / emit | `electron/agent.js` | `acp_session_impl/*` |
| Chunk merge | client meta only | `update_chunk_merge.rs` |
| Tools | agent onUpdate | `tool_calls.rs` |
| xAI ext notify | **missing** | `extensions/notification.rs` + `emit_buffered` |
| Headless | `runHeadless` | `headless.rs` |
| UI stream | `renderer/app.js` StreamFair | n/a |
