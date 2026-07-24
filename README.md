# GrokCode

**Desktop flight deck for the local open-source [Grok Build CLI](https://github.com/xai-org/grok-build)** — multi-project, multi-task, Live/Code/Diff, context inheritance.

[![License: MIT](https://img.shields.io/badge/License-MIT-skyblue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-desktop-47848F?logo=electron)](https://www.electronjs.org/)
[![xAI Grok](https://img.shields.io/badge/xAI-Grok%20CLI-000)](https://grok.x.ai)

> Not a second agent runtime. GrokCode **hosts your installed `grok` CLI** over ACP (`grok agent stdio`) with headless fallback (`streaming-json` / `grok -p`). Same tools, MCP, skills, and plan mode as the TUI — with a multi-project UI.

![stack](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

---

## Features

| Area | What you get |
|------|----------------|
| **Transport** | ACP primary · auto headless on Build 403 · settings `agentTransport` |
| **Modes** | **CLI-native** only — host docks `session/set_mode` (`default` / `plan` / `ask`); no Craft/Plan/Ask inject |
| **Plan / Q&A** | Interactive `exit_plan_mode` + `ask_user_question` bars (open-source outcomes) |
| **Model** | Live list from `grok models` + ACP modelState · `session/set_model` · effort chip (`/effort`) |
| **Multi-project** | Several workspaces; agents in parallel per project |
| **Multi-task** | Per-project tabs; warm ACP pool between turns |
| **Live / Code / Diff** | Mission control, file tree, unified diffs + restore |
| **Context** | `~/.grok-code/sessions` · L0–L3 compress |
| **Settings** | CLI path, YOLO, MCP, Skills, Plugins, Catalog, Doctor |
| **Appearance** | i18n en/zh · themes · density · FX / reduce-motion |

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

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for stream path, transport table, and open-source docking.

```text
┌─────────────────────────────────────────┐
│  Electron renderer                      │
│  projects · tasks · Live/Code/Diff      │
│  CLI mode / model / effort chips        │
└─────────────────┬───────────────────────┘
                  │ IPC (preload allowlist)
┌─────────────────▼───────────────────────┐
│  Electron main                          │
│  agent.js ACP + headless · persist      │
│  doctor · models · plan/ask reverse-req │
└─────────────────┬───────────────────────┘
                  │ child_process
┌─────────────────▼───────────────────────┐
│  grok CLI (same binary as TUI)          │
│  primary:  grok agent … stdio  (ACP)    │
│  fallback: grok -p … streaming-json     │
│  YOLO: --always-approve · plan: CLI     │
└─────────────────────────────────────────┘
```

**Host ↔ open-source (high level)**

| UI | ACP / CLI |
|----|-----------|
| Plan approval | `x.ai/exit_plan_mode` |
| Questionnaire | `x.ai/ask_user_question` |
| Mode chip | `session/set_mode` |
| Model chip | `session/set_model` · `grok models` |
| Effort chip | `set_model` meta `reasoning_effort` |
| Long tools | handles `in_progress`; optional CLI patch under `patches/grok-build/` |

---

## Accessibility & motion

GrokCode’s flight-deck UI includes glows and micro-animations. They **respect OS reduced-motion**:

| Setting | Effect |
|---------|--------|
| **Windows** | Settings → Accessibility → Visual effects → Animation effects **Off** |
| **macOS** | System Settings → Accessibility → Display → **Reduce motion** |
| **Linux** | Desktop “reduce animation” (varies by DE) |

When reduced motion is on, boot rings, send pulse, Live timeline entrance, scrub flashes, and most decorative loops are disabled. Functional layout and themes still work.

**Visual FX intensity** (Settings → Appearance): **Normal** (default) or **High**. **Force reduce motion** checkbox applies even if the OS setting is off. **Cinematic idle** ambient is off by default.

---

## Repo layout

```text
grok-code/
  electron/          # main process, agent, persist, MCP/skills
  renderer/          # UI, multi-project/task, settings
  patches/grok-build # experimental CLI InProgress patch + /feedback text
  docs/              # ARCHITECTURE, ACP audit, …
  scripts/           # check, tests, catalog
  examples/          # community MCP / skill snippets
```

---

## Open-source ecosystem

| Contribute | Where |
|------------|--------|
| Core features / bugs | PRs on this repo |
| MCP presets | [`examples/mcp/`](examples/mcp/) |
| Skill packs | [`examples/skills/`](examples/skills/) + Discussions |
| Experimental CLI patches | [`patches/grok-build/`](patches/grok-build/) |
| Themes / i18n | `renderer/` |

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

Open **Settings → MCP / Skills** in the app. **Diagnostics** includes Doctor, optional `grok -p` probe, and InProgress patch help.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Launch desktop app |
| `npm run dev` | Launch with DevTools |
| `npm run check` | Syntax + unit tests + catalog build |
| `npm run catalog` | Generate Settings catalog from `examples/` |
| `npm run icons` | Generate `build/icon.png` for packaging |
| `npm run audit:official` | `npm audit` against registry.npmjs.org |
| `npm test` | Unit tests |
| `npm run pack` | electron-builder unpacked dir |
| `npm run dist:win` | Windows NSIS + portable → `release/` |
| `npm run dist:linux` | AppImage + deb |
| `npm run dist:mac` | dmg (unsigned in OSS CI) |

## Releases

Installers ship on [GitHub Releases](https://github.com/sunormesky-max/grok-code/releases) when a tag `v*` is pushed (see `.github/workflows/release.yml`).

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Catalog site

Community MCP / Skills catalog is published via GitHub Pages:

https://sunormesky-max.github.io/grok-code/

## Ecosystem

| Doc | Topic |
|-----|--------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process model · transports · docking |
| [docs/ACP-SOURCE-AUDIT.md](docs/ACP-SOURCE-AUDIT.md) | ACP surface map |
| [docs/ECOSYSTEM.md](docs/ECOSYSTEM.md) | Community channels |
| [ROADMAP.md](ROADMAP.md) | What’s next |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

## License

[MIT](LICENSE)
