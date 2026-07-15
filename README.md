# GrokCode

**Desktop coding agent powered by the local [Grok Build CLI](https://grok.x.ai)** — OpenCode / Codex–style UI, multi-project, multi-task, context inheritance.

[![License: MIT](https://img.shields.io/badge/License-MIT-skyblue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-desktop-47848F?logo=electron)](https://www.electronjs.org/)
[![xAI Grok](https://img.shields.io/badge/xAI-Grok%20CLI-000)](https://grok.x.ai)

> Not a second copy of the agent runtime. GrokCode **drives your installed `grok` CLI** in headless mode (`streaming-json`), so you get the same tools, MCP, and skills as the terminal — with a flight-deck UI.

![stack](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

---

## Features

| Area | What you get |
|------|----------------|
| **Agent** | Headless `grok` + multi-turn `--resume` sessions |
| **Multi-project** | Mount several repos; agents run in parallel per project |
| **Multi-task** | Per-project task tabs; parallel CLI processes |
| **Live / Code / Diff** | Mission control timeline, file review, real unified diffs + restore |
| **Context inheritance** | Persist chats under `~/.grok-code/sessions`; L0–L3 compression |
| **Settings** | CLI path, model, YOLO, **MCP** & **Skills** management |
| **UI** | Sci-fi Grok aesthetic + boot sequence |

---

## Requirements

- **Node.js 18+**
- **[Grok Build CLI](https://grok.x.ai)** (`grok` on PATH, or `%USERPROFILE%\.grok\bin\grok.exe`)
- Auth: `grok login` **or** `XAI_API_KEY`

---

## Quick start

```bash
git clone https://github.com/sunormesky-max/grok-code.git
cd grok-code
npm install
npm start
```


1. **＋ 项目** — open one or more workspaces  
2. Confirm **CLI** is online in the title bar  
3. Describe a task → **Grok it** (`Ctrl+Enter`)  

Optional:

```bash
export XAI_API_KEY=xai-...   # or set in Settings
```

---

## Architecture

```text
┌─────────────────────────────────────────┐
│  Electron renderer (UI)                 │
│  projects · tasks · Live/Code/Diff      │
└─────────────────┬───────────────────────┘
                  │ IPC
┌─────────────────▼───────────────────────┐
│  Electron main                          │
│  multi-project agents · fs · persist    │
│  MCP/Skills (via grok + ~/.grok)        │
└─────────────────┬───────────────────────┘
                  │ spawn headless
┌─────────────────▼───────────────────────┐
│  grok CLI  (-p / streaming-json / YOLO) │
│  tools · MCP · skills · same as TUI     │
└─────────────────────────────────────────┘
```

---

## Repo layout

```text
grok-code/
  electron/          # main process, agent, persist, MCP/skills
  renderer/          # UI, multi-project/task, settings
  scripts/           # maintenance helpers
  examples/          # community MCP / skill snippets
  LICENSE            # MIT
  CONTRIBUTING.md
  CODE_OF_CONDUCT.md
```

---

## Open-source ecosystem

We want GrokCode to be a **community flight deck** for Grok coding:

| Contribute | Where |
|------------|--------|
| Core features / bugs | PRs on this repo |
| MCP presets | [`examples/mcp/`](examples/mcp/) |
| Skill packs | [`examples/skills/`](examples/skills/) + share on Discussions |
| Themes / i18n | `renderer/` |
| Packaging / CI | Issues labeled `infra` |

See **[CONTRIBUTING.md](CONTRIBUTING.md)** and **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)**.

### Security

- **Never commit** API keys or GitHub PATs  
- Report vulnerabilities privately when possible ([SECURITY.md](SECURITY.md))  
- If a secret was pasted in chat or a log, **revoke it immediately**

---

## Settings (MCP & Skills)

GrokCode manages the **same** config the CLI uses:

- MCP → `~/.grok/config.toml` via `grok mcp …`  
- Skills → `~/.grok/skills/**/SKILL.md`  

Open **Settings → MCP / Skills** in the app.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Launch desktop app |
| `npm run dev` | Launch with DevTools |

---

## License

[MIT](LICENSE) — free to use, fork, and ship.

---

**Built for people who grok code.**  
Issues & PRs welcome.
