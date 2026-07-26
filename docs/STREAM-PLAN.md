# Long-horizon plan: streaming output reliability

**Owner:** GrokCode host (Electron) · **Upstream:** xai-org/grok-build  
**Status:** Active (2026-07-26) · **Shipped through 1.47.0** (paint + **execution route UX**) · **Next:** upstream 3.2–3.3; route polish  
**Goal:** Users never see a “frozen black box” during long turns; text/tools
progress is continuous, fair across multi-task, and diagnosable when silence
is CLI-side.

This plan does **not** invent a second agent loop. Host only paints and
diagnoses what ACP / headless actually emit.

---

## 1. Problem map (what “流式输出问题” still means)

| Symptom | User perception | Primary layer | Host can fix? |
|---------|-----------------|---------------|---------------|
| **A. Inter-stage silence** | Progress bar stuck for 30s–minutes between tools | CLI no `session/update` | Partial — activity clock already; improve copy + metrics |
| **B. Long tool no mid-flight** | Tool card `running…` with no real progress | CLI `Pending→Completed` only | Partial — local timer; true progress needs InProgress patch / upstream |
| **C. First-token delay** | Blank after send | Handshake + model TTFT | Partial — boot phases + compress budget |
| **D. Coalesced / laggy text** | Stream jumps, not smooth | IPC coalesce + StreamFair + stream-gate | Yes — host tuning |
| **E. Multi-task unfair paint** | Background task freezes UI | StreamFair / scheduler | Yes — host |
| **F. History replay flood** | Fake tools/stream on resume | `session/load` updates | Done — gate on `streaming` |
| **G. Headless black box** | No tools at all | transport headless | Process — force ACP for tools; doctor warns |
| **H. Empty final reply** | “无文本输出” | Model tools-only turn | UX — already placeholder; improve Live summary |
| **I. Stream gate hide** | Short text invisible | stream-gate hold | Done — fail-open quiet (1.29.1) |

### Pipeline (host)

```text
CLI ACP session/update | headless NDJSON
        │
        ▼
  agent-stream.js  (pure reduce / fixtures)
        │
        ▼
  agent.js  ordered 16ms coalesce + activity clock + ToolCallDelta
        │  IPC agent:text | thought | tool_* | phase | route | usage
        ▼
  StreamFair + stream-scheduler  (multi-task paint fairness)
        │
        ▼
  upsertAssistant / Live mirrors / ToolStorm / #execRouteStrip / stream-gate
```

**Execution route (v1.47):** pure `execution-route.js` + Live chip strip — see
[STREAM-EXEC-ROUTE.md](STREAM-EXEC-ROUTE.md).

### Already shipped (do not re-do)

| Area | Versions |
|------|----------|
| ACP stdio for tools | 1.10.x |
| Gate history during load | 1.10.8+ |
| Activity clock whole prompt | 1.10.11 |
| session_notification / ToolCallDelta | 1.10.12–1.11.1 |
| ToolStorm | 1.11.0–1.11.1 |
| bufferingSettings tight | 1.10.10+ |
| InProgress host paint + patch kit | 1.16 / 1.21–1.22 |
| StreamFair pure scheduler | 1.9.2+ |
| Stream gate fail-open | 1.28–1.29.1 |

---

## 2. Success metrics (definition of done)

### Quantitative (host logs / fixtures)

| Metric | Target |
|--------|--------|
| Active-task text IPC latency after chunk | p95 ≤ 50ms (STREAM_IPC_MS=16 + 1 rAF) |
| Multi-task: active paint priority | Active always first in `planTick` (unit locked) |
| Fixture: ACP text order | tool_start before tool_end; text accumulates (existing) |
| Stream debug `firstTokenMs` | Logged every run; p50 trackable in `%TEMP%\grokcode-stream.log` |
| No silent hang without phase change | Activity clock ticks every 500ms while running |

### Qualitative

1. User always sees **phase + elapsed** during silence (“等待模型继续… Ns”).  
2. Tool cards always show **elapsed seconds** while open.  
3. After long tools, user can open Doctor → know if CLI lacks InProgress.  
4. Dev can replay fixtures without Electron for regressions.

### Explicit non-goals

- Inventing tool stdout mid-flight without agent frames  
- Host-side fake token drip  
- Second LLM stream path bypassing Grok CLI  

---

## 3. Phases (long-horizon backlog)

### Phase 0 — Instrumentation & truth table (host) · **DONE · v1.40.0**

**Deliverables**

1. `docs/STREAM-PLAN.md` (this file) linked from ARCHITECTURE / ROADMAP.  
2. **Stream session summary** line at end of each ACP run in stream log:
   - `firstTokenMs`, `textChunks`, `thoughtChunks`, `toolStarts`, `toolInProgress`,
     `maxSilentSec`, `transport`, `patchedCli`  
3. Optional settings toggle: **详细流式日志** (already force-debug patterns — document path).  
4. Golden matrix table in this doc: symptom → layer → fix owner.

**Exit:** One log line per run is enough to triage “host vs CLI”. ✅

### Phase 1 — Host paint path hardening · **P0 · host-only · in flight → v1.41**

| Work item | Priority | Status | Notes |
|-----------|----------|--------|--------|
| 1.1a `pickToolInfo` snake_case IDs | **P0** | ✅ 1.41.0 | Parity with `resolveToolCallDelta` (`tool_call_id`, `call_id`) |
| 1.1b `flushStreamIpc` before ToolCallDelta cards | **P0** | ✅ 1.41.0 | tool_call already flushes; xAI delta path too |
| 1.1c `fail()` flush + STREAM_SUMMARY | **P0** | ✅ 1.41.0 | Pending 16ms text not lost on error |
| 1.1d ToolCallDelta increments `toolStarts` | P0 | ✅ 1.41.0 | Metrics truth for tools-first turns |
| 1.2 StreamFair under 3+ concurrent tasks | P1 | ✅ 1.42.0 | MAX 6 + autoScale; 5-task golden |
| 1.3 Live mirror + chat dual-paint race | P1 | ✅ 1.42.0 | streamBuf → StreamFair only |
| 1.4 Phase strip SR (silence ≥ 5s throttle) | P1 | ✅ 1.42.0 | Clock skip announce; ≥5s / 8s |
| 1.5 Empty tools-only turn UX | **P0** | ✅ 1.41.0 | Count tools in placeholder + Live signal |

**Exit:** No host-side drop of chunks under multi-task load (fixture + manual). ✅

### Phase 2 — Tool mid-flight (host + optional CLI patch) · **P1**

| Work item | Notes | Status |
|-----------|--------|--------|
| 2.1 Prefer InProgress partial text | ToolCallDelta `result` from arguments_delta | ✅ 1.42.0 |
| 2.2 Doctor InProgress actions | Done 1.37 — keep linked | ✅ |
| 2.3 Patch kit keep-alive | README note vs grok-build 0.2.111 | ✅ 1.44.0 |
| 2.4 Feedback one-click | Done — keep FEEDBACK.md fresh | ✅ |

**Exit:** With patched CLI, long `run_terminal` shows InProgress transition in Live.

### Phase 3 — Silence & heartbeat · **P1 · mostly upstream**

| Work item | Owner | Status |
|-----------|--------|--------|
| 3.1 Host: richer silence UI (last tool name, last phase) | Host | ✅ 1.42.0 |
| 3.2 Upstream: inter-stage heartbeat / more frequent updates | grok-build | open |
| 3.3 Upstream: normal-tool InProgress (stock) | grok-build | open |
| 3.4 Host: document expected silence ceilings | Host | ✅ 1.43.0 §5 |

**Exit:** Stock CLI still may silence; host never looks “dead”.

### Phase 4 — Headless / transport honesty · **P2**

| Work item | Notes | Status |
|-----------|--------|--------|
| 4.1 Doctor: headless = no tool stream warning (stronger) | Host | ✅ 1.43.0 |
| 4.2 Auto transport: surface “ACP failed → headless, tools hidden” banner | Host | ✅ 1.42.0 |
| 4.3 Headless fixture expand for text-only smoothness | Host | ✅ 1.44.0 |

### Phase 5 — Observability productization · **P2**

| Work item | Notes | Status |
|-----------|--------|--------|
| 5.1 Settings: open stream log folder | Host | ✅ 1.42.0 |
| 5.2 Export last-run stream summary into diagnostic zip | Host | ✅ 1.43.0 |
| 5.3 Optional telemetric counters (opt-in only) | Host | ✅ 1.44.0 |

---

## 4. Suggested execution order (weeks)

| Week | Focus | Ship as |
|------|--------|---------|
| W1 | Phase 0 metrics | ✅ v1.40.0 |
| W1 | Phase 1.1/1.5 critical host paint | ✅ v1.41.0 |
| W2 | Phase 1.2–1.4 multi-task + SR phase | ✅ v1.42.0 |
| W2 | Phase 2.1 / 3.1 / 4.2 / 5.1 host | ✅ v1.42.0 |
| W3 | Phase 4.1 / 5.2 / 3.4 + patch keep-alive | v1.43+ |
| Ongoing | Phase 3.2–3.3 upstream feedback | — |

---

## 5. Debug & triage runbook

1. Reproduce with **one task**, ACP transport forced.  
2. Open `%TEMP%\grokcode-stream.log` (Windows) / tmp stream log — Settings → **打开流式日志**.  
3. Check: `firstTokenMs`, tool_start/end pairs, gaps without lines.  
4. If **no session/update for minutes** after tools → CLI silence (Phase 3).  
5. If **updates present but UI frozen** → host paint (Phase 1).  
6. Doctor → **长工具 InProgress** → patch path if tools never mid-flight.  
7. Export diagnostics → includes `stream-summaries.txt` + log tail (Phase 5.2).

### Expected silence ceilings (Phase 3.4 · host honesty)

These are **normal** with stock grok-build; host must stay alive (phase clock), not invent tokens.

| Stage | Typical | Ceiling before user should worry | Host UI |
|-------|---------|----------------------------------|---------|
| First token after send | 1–15s | **60s** (model TTFT + handshake) | `等待模型首包… Ns` |
| Between tool batches | 5–90s | **3–5 min** (planning / large context) | `等待模型继续…` + last tool |
| Long tool (no InProgress) | tool duration | tool wall-clock; no mid progress | tool card elapsed only |
| Long tool (patched InProgress) | chunks | same | mid-flight refresh |
| After last tool → final text | 2–30s | **2 min** | activity clock continues |

If silence **exceeds ceiling** with **no** new stream log lines → CLI/network; file issue with diagnostic bundle.  
If stream log **is** growing but UI frozen → host bug (open STREAM-PLAN Phase 1 regression).

---

## 6. Test strategy

| Layer | Existing | Add |
|-------|----------|-----|
| Pure reduce | `agent-stream-basic.ndjson`, `agent-stream-acp-updates.json` | Long silence fixture; multi-tool InProgress fixture |
| Scheduler | `testStreamFairness` | 5-task fairness golden |
| Stream gate | `testStreamGate` | Keep fail-open locked |
| Manual | Live + multi-task craft | Script in STREAM-PLAN §5 |

---

## 7. Related docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — pipeline sketch  
- [ACP-SOURCE-AUDIT.md](ACP-SOURCE-AUDIT.md) — severity matrix  
- [patches/grok-build/README.md](../patches/grok-build/README.md) — InProgress patch  
- [OPENWORKER-INHERIT.md](OPENWORKER-INHERIT.md) — do not import engine SMs  

---

## 8. Multi-expert audit synthesis (2026-07-25)

Four parallel audits (ACP main stream · renderer paint · program board · fixtures)
agreed on the following. **Do not import a second agent state machine.**

### Consensus: what is host-fixable now

| ID | Finding | Layer | Severity | Phase |
|----|---------|-------|----------|-------|
| E1 | `pickToolInfo` only reads `toolCallId` / `id` — snake_case `tool_call_id` → random `tool-${Date.now()}` → start/end mismatch, ghost tools | acp-client | **Critical** | 1.1a |
| E2 | `tool_call` flushes IPC; **ToolCallDelta does not** → text can land after tool card / reorder | agent.js | **High** | 1.1b |
| E3 | ACP `fail()` never `flushStreamIpc` / `logStreamSummary` → last tokens + metrics lost | agent.js | **High** | 1.1c |
| E4 | ToolCallDelta open path skips `toolStarts++` → STREAM_SUMMARY undercounts | agent.js | Medium | 1.1d |
| E5 | Tools-only turn: generic “无文本输出” — weak Live/mission signal when tools>0 | renderer | Medium | 1.5 |
| E6 | Multi-task fairness / dual-paint / SR silence | renderer | Medium | 1.2–1.4 |
| E7 | Mid-tool stdout without InProgress | CLI | Out of host | 2–3 |
| E8 | Inter-stage silence minutes | CLI | Out of host | 3 |

### Execution board (careful cadence)

```text
DONE  through v1.45.1 — host stream path + ordered coalesce + park/boot + fixtures + telemetry
DONE  ordered thought/text IPC coalesce queue (paint order fidelity) — 1.45.0
DONE  ACP_FALLBACK STREAM_SUMMARY before headless retry — 1.45.0
DONE  park map clear on stop/cleanup (stale 等待授权 clock) — 1.45.1
OPEN  Phase 3.2–3.3 upstream (heartbeat + stock InProgress) — not host
AUTO  interval continues for regression polish only (host backlog exhausted)
```

**Rule of pace:** one critical host fix cluster per release; re-run
`npm test` + STREAM_SUMMARY manual glance; never invent tokens.

### Golden triage (post-1.41)

1. Updates in stream log but UI frozen → paint (1.2–1.3).  
2. No session/update for minutes → CLI (Phase 3); host phase strip only.  
3. tool_start id changes every frame → check pickToolInfo / E1 regression.  
4. Error after partial text with empty chat → fail flush (E3) regression.

---

## 9. Decision log

| Date | Decision |
|------|----------|
| 2026-07-25 | Long-horizon stream work is **host-first**; no second agent stream |
| 2026-07-25 | InProgress true mid-tool remains **optional patch / upstream** |
| 2026-07-25 | Success = no black-box UI + diagnosable silence, not zero silence |
| 2026-07-25 | Multi-expert board: ship **1.1a–d + 1.5** first (IDs/flush/fail/tools-only); defer fairness/SR |
| 2026-07-25 | User auto-auth: autonomous long-horizon execution without wait; durable 2h follow-up |
| 2026-07-25 | Host stream path through **1.43.0** considered complete for P0/P1 host items |
| 2026-07-25 | Multi-expert breakthrough: park/boot clocks, 4.3 fixtures, 5.3 telemetry → **1.44.0** |
| 2026-07-25 | Research: Grok Build v0.2.111 — stream transforms, ACP stdio Windows hang fixes |
| 2026-07-25 | **1.45.0** ordered thought/text IPC coalesce (`createStreamIpcCoalesce`) + ACP_FALLBACK STREAM_SUMMARY |
| 2026-07-25 | **Host stream backlog exhausted** — remaining work is upstream 3.2–3.3; interval = regression polish only |
| 2026-07-25 | **1.45.1** regression polish: clear `interactiveParks` on stop + ACP cleanup (no stale park clock) |
| 2026-07-25 | Interval regression pass @ 1.45.1: unit suite green; items 1–3 verified present; no new host stream delta |
| 2026-07-25 | Interval: host stream backlog still exhausted; ship **1.46.1** Live/Diff residual (BG baseline parity + hunk reject) — not stream path |
| 2026-07-25 | Interval edge-case: ToolStorm early-return skipped write baseline → **1.46.2**; stream backlog still exhausted |
| 2026-07-25 | Interval edge-case: empty ACP tool_end args dropped Diff path → **1.46.3** mergeToolMeta; stream still upstream-only |
| 2026-07-25 | Interval regression @ **1.46.3**: unit suite green; Live/Diff residuals (hunk keep/reject, BG parity, ToolStorm baseline, tool_end path) present; **no new host ship** — optional SBS hunk / multi-MB LCS deferred; stream still upstream 3.2–3.3 only |
| 2026-07-25 | Interval: sticky after-truncate disabled restore forever → **1.46.4** `beforeIncomplete` recovery; stream still upstream-only |
| 2026-07-25 | Interval: `restoreAllFiles` missed beforeIncomplete gate → **1.46.5**; stream still upstream-only |
| 2026-07-25 | Interval: headless tool_end dropped path (no openTools merge) → **1.46.6**; stream still upstream-only |
| 2026-07-25 | Interval regression @ **1.46.6**: unit suite green; Live/Diff residual stack (hunk keep/reject, BG/ToolStorm baseline, tool_end path ACP+headless, beforeIncomplete, restore-all) verified present; **no new host ship** — optional SBS hunk / multi-MB LCS deferred; stream still upstream 3.2–3.3 only |
| 2026-07-25 | Interval: post-write cacheFileBefore silent Diff drop (shell/fs) → **1.46.7** baselineMiss; stream still upstream-only |
| 2026-07-25 | Interval regression @ **1.46.7**: unit suite green; residual stack smoke (hunk/merge/headless path) OK; **no new host ship** — Live/Diff host residual exhausted; optional SBS hunk / multi-MB LCS deferred; stream still upstream 3.2–3.3 only |
| 2026-07-26 | **1.47.0** stream execution route (`execution-route.js` + Live strip + agent:route lifecycle) |
| 2026-07-26 | **1.47.1** headless `agent:done.streamSummary` parity with ACP (mission bar TTFT/tools); pure tick wire still optional |
| 2026-07-26 | **1.47.2** ACP `user_stop_err_path` attaches streamSummary (was log-only); residual pure-tick still optional |
| 2026-07-26 | Interval @ **1.47.2**: unit suite green; headless+ACP streamSummary attach verified; pure-tick dual-bookkeep still optional (no UX gap — Live silence from phase); **no new host ship** |
| 2026-07-26 | **1.47.3** ACP signal-abort path attaches streamSummary (parity with headless onAbort); pure-tick still optional |
| 2026-07-26 | Interval @ **1.47.3**: unit green; all 9 `agent:done` sites carry streamSummary; pure-tick dual-bookkeep still optional; **no new host ship** |
| 2026-07-26 | Interval re-regression @ **1.47.3**: unit suite green; 9/9 `agent:done` + finish streamSummary (ACP+headless); exec route strip shipped; Diff baseline residual stack present; pure-tick dual-bookkeep still deferred (no UX gap — Live silence from phase); **no new host ship** — residual exhausted at 1.47.3+ |
| 2026-07-26 | Interval @ **1.47.3** (2nd hour): unit green; residual notes unchanged (pure-tick optional); streamSummary/exec strip/Diff baseline smoke OK; **no new host ship** |
| 2026-07-26 | Interval @ **1.47.3** (3rd hour): unit green; residual still exhausted; pure-tick dual-bookkeep deferred; **no new host ship** |
| 2026-07-26 | Interval @ **1.47.3** (4th hour): unit green; residual exhausted; pure-tick still deferred; **no new host ship** |
