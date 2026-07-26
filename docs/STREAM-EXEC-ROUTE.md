# 流式执行路线 (Stream execution route)

**Status:** Shipped v1.47.0 · headless v1.47.1 · ACP err-stop v1.47.2 · ACP abort summary v1.47.3  
**Rule:** Host paints only what ACP / headless already emit. No second agent, no invented tokens.

**Residual (optional):** `reduceRouteTick` not yet dual-bookkept from ACP activity clock —
Live silence/park already come from phase thrash + `agent:route` lifecycle.

## Problem

Mid-turn the UI only had a **mutable phase string** (overwritten every 500ms by the activity clock). Users could not scan:

```text
boot → think → tools × N → wait → text → done
```

Lifecycle frames (`goal_updated`, compact, subagent, retry) were **phase-only** and vanished after the next clock tick.

## Architecture

```text
CLI session/update | x.ai/session_notification
        │
        ▼
  agent-stream.js  (wire → actions)
        │
        ▼
  execution-route.js  (pure ledger — unit tested)
        │
        ▼
  agent.js  emit agent:phase | agent:route | agent:done.streamSummary
        │
        ▼
  Live #execRouteStrip · routeSteps[] · mission bar
```

## Surfaces

| Surface | Behavior |
|---------|----------|
| `#execRouteStrip` | Chip trail for current turn; current step highlighted |
| `task.routeSteps[]` | Append-only in-memory steps for this turn |
| `task.turns[].route` | Kind list after turn ends |
| Mission bar | Route string + STREAM_SUMMARY lite |
| Live timeline | Lifecycle breadcrumb for goal/compact/subagent |

## Pure API (`electron/execution-route.js`)

- `createRouteState` / `appendRouteStep` / `reduceRouteFromActions`
- `reduceRouteTick` (injected `nowMs` — silence + park freeze)
- `summarizeRoute` / `routeStripLabels`

## Non-goals

- Fake mid-tool progress without InProgress frames  
- Second agent SM / OpenWorker import  
- Replacing CLI plan/mode ownership  

## Related

- [STREAM-PLAN.md](STREAM-PLAN.md) — reliability phases  
- [ARCHITECTURE.md](ARCHITECTURE.md) — host vs CLI  
