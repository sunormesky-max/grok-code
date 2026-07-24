# OpenWorker → GrokCode inheritance

Research note: [OpenWorker](https://github.com/andrewyng/openworker) is a full
local agent (Python engine + multi-provider + connectors). GrokCode is a **thin
Electron host** for the local Grok CLI (ACP / headless).

**Do not** port the engine, providers, or connector gateway. **Do** port
product/UX patterns that improve the host surface — and only after stripping
OpenWorker-specific internal-flow footguns.

## Adopted (surface only)

| Pattern | Where | Version | Our twist |
|---------|--------|---------|-----------|
| Stream gate quiet / answer | `renderer/stream-gate.js` | 1.28 → **1.29.1** | **No blank `hold`** (fail-open) |
| Tool humanize one-liners | `renderer/humanize.js` | 1.28.0 | CLI tool names only |
| Global Inbox (plan + question) | `renderer/inbox.js` | 1.29 → **1.29.1** | **Shared resolve lock**; mirror of ACP park, not a second SM |

## Hard boundaries (never break)

- Modes stay CLI-owned (`session/set_mode`); no host Craft/Plan inject  
- Permission options only those returned by the CLI  
- **No second agent loop** inside Electron  
- Inbox is a **view + reply shell** over already-parked ACP reverse-reqs  
- Source of truth for park state = **ACP client**, not the Inbox map  

## Anti-patterns we refuse (OpenWorker-style internal flow)

These are product/engine patterns that often feel “clever” but break trust.
Do **not** reintroduce them into GrokCode:

1. **Blank stream hold** — hide all tokens until N words land  
   → We only use quiet one-line + early promote to full answer.  
2. **Dual state machines** — Inbox SM + session SM + unattended SM fighting  
   → One park in ACP; UI mirrors; first resolve wins with **in-flight lock**.  
3. **Host-owned permission modes** (discuss / interactive / auto / unattended)  
   → CLI YOLO / plan / ask only.  
4. **Standing grants that invent optionIds**  
   → May auto-pick only options the CLI listed.  
5. **Second tool loop / multi-provider router in the host**  
   → Always `grok agent` / headless.  
6. **Connectors / Slack gateway as first-class core**  
   → Optional MCP later; not a second product.  
7. **Durable resume that rewrites agent history**  
   → Prefer CLI session resume; host only rehydrates UI.  

If a future “inherit” idea needs any of the above, **stop and redesign**
against the thin-host contract instead of copying OpenWorker.

## Next candidates (optional, still host-only)

1. Plan-card execute permission tier via **existing** settings (alwaysApprove)  
2. Session standing grants **within CLI option IDs only**  
3. Compact vs full approval density (presentation)  

Not scheduled: unattended router, multi-root permission engine, automation
scheduler, provider matrix.
