# Dependency security

## CI / Dependabot

- [`.github/dependabot.yml`](../.github/dependabot.yml) opens weekly PRs for npm + GitHub Actions.
- Prefer reviewing **electron-stack** group PRs carefully (Electron major bumps can break packaging).

## Local audit

Chinese npm mirrors often do **not** implement the audit API. Use the official registry:

```bash
npm audit --registry=https://registry.npmjs.org/
```

## Current posture (v1.2.3)

| Package | Notes |
|---------|--------|
| `electron-builder` ≥26 | Fixes historical `tar` high vulns in the packaging toolchain |
| `electron` 37–39 | Reduces older advisories; **some** Electron CVEs only fixed on newer majors (40+) |
| App hardening | `contextIsolation: true`, `nodeIntegration: false`, no custom protocol handlers by default |

Jumping to Electron 40+ / 43 is tracked as a deliberate major upgrade (retest `dist:win` / `dist:linux` / `dist:mac`).

## App-level mitigations

Even when Electron advisories remain on the current major:

- Renderer has **no Node integration**
- File access is sandboxed under project root via main-process tools
- Secrets stay in electron-store / env / `~/.grok` — never in the repo
