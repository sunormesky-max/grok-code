# Long-horizon plan: streaming output reliability

**Owner:** GrokCode host (Electron) · **Upstream:** xai-org/grok-build  
**Status:** Active (2026-07-25) · **Baseline version:** 1.39.x  
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
  agent.js  emitTextStream (16ms coalesce) + activity clock + ToolCallDelta
        │  IPC agent:text | thought | tool_* | phase | usage
        ▼
  StreamFair + stream-scheduler  (multi-task paint fairness)
        │
        ▼
  upsertAssistant / Live mirrors / ToolStorm / stream-gate
```

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

### Phase 0 — Instrumentation & truth table (host) · **P0 · next sprint**

**Deliverables**

1. `docs/STREAM-PLAN.md` (this file) linked from ARCHITECTURE / ROADMAP.  
2. **Stream session summary** line at end of each ACP run in stream log:
   - `firstTokenMs`, `textChunks`, `thoughtChunks`, `toolStarts`, `toolInProgress`,
     `maxSilentSec`, `transport`, `patchedCli`  
3. Optional settings toggle: **详细流式日志** (already force-debug patterns — document path).  
4. Golden matrix table in this doc: symptom → layer → fix owner.

**Exit:** One log line per run is enough to triage “host vs CLI”.

### Phase 1 — Host paint path hardening · **P0 · host-only**

| Work item | Notes |
|-----------|--------|
| 1.1 Re-audit `STREAM_IPC_MS` / flush on tool_start | Ensure tool_start always `flushStreamIpc` before tool card |
| 1.2 StreamFair under 3+ concurrent tasks | Stress unit / manual; raise `MAX_PAINT_PER_TICK` if needed |
| 1.3 Live mirror + chat dual-paint race | Single source: streamBuf; avoid double append glitches |
| 1.4 Phase strip SR | Announce phase when silence ≥ 5s (throttle) |
| 1.5 “Empty tools-only turn” UX | Mission bar + Live summary when finalText empty but tools>0 |

**Exit:** No host-side drop of chunks under multi-task load (fixture + manual).

### Phase 2 — Tool mid-flight (host + optional CLI patch) · **P1**

| Work item | Notes |
|-----------|--------|
| 2.1 Prefer InProgress partial text | Already partial in 1.16 — extend to ToolCallDelta body |
| 2.2 Doctor InProgress actions | Done 1.37 — keep linked |
| 2.3 Patch kit keep-alive | Rebase `0001-tool-in-progress.patch` when upstream moves |
| 2.4 Feedback one-click | Done — keep FEEDBACK.md fresh |

**Exit:** With patched CLI, long `run_terminal` shows InProgress transition in Live.

### Phase 3 — Silence & heartbeat · **P1 · mostly upstream**

| Work item | Owner |
|-----------|--------|
| 3.1 Host: richer silence UI (last tool name, last phase) | Host |
| 3.2 Upstream: inter-stage heartbeat / more frequent updates | grok-build |
| 3.3 Upstream: normal-tool InProgress (stock) | grok-build |
| 3.4 Host: document expected silence ceilings | Host |

**Exit:** Stock CLI still may silence; host never looks “dead”.

### Phase 4 — Headless / transport honesty · **P2**

| Work item | Notes |
|-----------|--------|
| 4.1 Doctor: headless = no tool stream warning (stronger) | Host |
| 4.2 Auto transport: surface “ACP failed → headless, tools hidden” banner | Host |
| 4.3 Headless fixture expand for text-only smoothness | Host |

### Phase 5 — Observability productization · **P2**

| Work item | Notes |
|-----------|--------|
| 5.1 Settings: open stream log folder | Host |
| 5.2 Export last-run stream summary into diagnostic zip | Host |
| 5.3 Optional telemetric counters (opt-in only) | Host |

---

## 4. Suggested execution order (weeks)

| Week | Focus | Ship as |
|------|--------|---------|
| W1 | Phase 0 metrics + Phase 1.1/1.5 | v1.40.x |
| W2 | Phase 1 multi-task + SR phase | v1.40–1.41 |
| W3 | Phase 2 patch rebase + ToolCallDelta partials | v1.41–1.42 |
| Ongoing | Phase 3 upstream feedback; Phase 4–5 as capacity | — |

---

## 5. Debug & triage runbook

1. Reproduce with **one task**, ACP transport forced.  
2. Open `%TEMP%\grokcode-stream.log` (Windows) / tmp stream log.  
3. Check: `firstTokenMs`, tool_start/end pairs, gaps without lines.  
4. If **no session/update for minutes** after tools → CLI silence (Phase 3).  
5. If **updates present but UI frozen** → host paint (Phase 1).  
6. Doctor → **长工具 InProgress** → patch path if tools never mid-flight.

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

## 8. Decision log

| Date | Decision |
|------|----------|
| 2026-07-25 | Long-horizon stream work is **host-first**; no second agent stream |
| 2026-07-25 | InProgress true mid-tool remains **optional patch / upstream** |
| 2026-07-25 | Success = no black-box UI + diagnosable silence, not zero silence |
