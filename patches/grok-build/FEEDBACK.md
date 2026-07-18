# Feedback for Grok Build (paste into `/feedback` or support)

**Title:** ACP streaming granularity — InProgress tools, finer message chunks, silence heartbeat

**Version:** grok Build 0.2.x · Transport: `grok agent stdio` (ACP)

## Observed on the wire

From `session/prompt` send:

1. **Silent gaps** 1–20s+ with zero `session/update` (model between stages / tools).
2. **Message/thought chunks** often arrive in same-millisecond bursts (many small deltas).
3. **Tools** for the normal loop: `Pending` then soon `Completed`; no mid-flight `InProgress` for long `run_terminal_command` / large reads. (Backend tools already use `InProgress`.)

## Source pointers (open-source tree)

- `crates/codegen/xai-grok-shell/src/agent/update_chunk_merge.rs` — `BufferingSettings` / `ReplayBuffer`
- `mvp_agent/acp_agent.rs` — `meta.bufferingSettings` on initialize
- `session/acp_session_impl/updates.rs` — high-frequency path through ReplayBuffer
- `session/acp_session_impl/tool_calls.rs` — tool start `Pending`, complete `Completed`; backend path already emits `InProgress`

## Ask (backward-compatible)

1. Emit **`tool_call_update` `status=in_progress`** when normal tools begin execution (and optional partial stdout for shell tools).
2. Prefer **earlier/finer** `agent_message_chunk` / `agent_thought_chunk` (even 50–100ms cadence).
3. Optional **heartbeat** `session/update` every ~500ms during silence so hosts can show “alive”.
4. Document **`meta.bufferingSettings`** contract for IDE clients.

Desktop hosts (e.g. GrokCode) already forward all updates; they cannot invent tokens or tool progress not emitted by the agent.

Happy to share a minimal ACP timestamp probe.
