# OpenWorker → GrokCode inheritance

Research note: [OpenWorker](https://github.com/andrewyng/openworker) is a full
local agent (Python engine + multi-provider + connectors). GrokCode is a **thin
Electron host** for the local Grok CLI (ACP / headless).

**Do not** port the engine, providers, or connector gateway. **Do** port
product/UX patterns that improve the host surface.

## Adopted

| Pattern | Where | Version |
|---------|--------|---------|
| Stream gate `hold` / `quiet` / `answer` | `renderer/stream-gate.js` + chat/Live paint | 1.28.0 |
| Tool humanize one-liners | `renderer/humanize.js` + tool rows / Live | 1.28.0 |

## Next candidates (not yet)

1. **Global Inbox** — cross-task queue for plan / ask / permission parks  
2. **Plan card feedback** — revise path + execute permission tier  
3. **Session standing grants** — remember allow-once/always within CLI options  
4. **Approval card density** — compact file writes vs full shell cards  
5. **Durable park resume** — survive app restart  

## Hard boundaries

- Modes stay CLI-owned (`session/set_mode`); no host Craft/Plan inject  
- Permission options only those returned by the CLI  
- No second agent loop inside Electron  
