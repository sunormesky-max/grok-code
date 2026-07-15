# Roadmap

Living plan for the GrokCode open-source ecosystem. Order may change based on community feedback.

## Now (v1.x)

- [x] Core desktop agent + Grok CLI bridge
- [x] Multi-project / multi-task
- [x] Context inheritance + L0–L3
- [x] MCP & Skills in Settings
- [x] Public GitHub repo + CI + packaging pipeline
- [x] First GitHub Release (`v1.0.0`) with Windows installers
- [x] First-run onboarding + environment doctor
- [x] Session reliability (resume fallback, retry bar, diagnostics export)
- [x] Optional LLM L1/L2 context summaries
- [x] Diff / Code → VS Code / Cursor
- [x] Auto-update channel (electron-updater + GitHub Releases)
- [x] Renderer modularization (utils / onboarding / settings-extra / …)
- [x] Discussions enabled for Q&A and showcase
- [x] **Plugin marketplace bridge** (`grok plugin` in Settings)
- [x] **i18n** (en / zh shell UI + dynamic toasts / Live strings)
- [x] **Theme packs** (built-in + JSON import / drag-drop)
- [x] **Linux / macOS** artifacts in Release matrix (unsigned; deb maintainer fixed)
- [x] **Virtualized Live timeline** for long sessions
- [x] **Project profiles** export / import
- [x] **Telemetry opt-in** (local crash logs; optional endpoint)
- [x] **Skill / MCP catalog** from `examples/` + static `docs/catalog/`
- [x] Plugin search / filter in Settings
- [x] A11y basics (skip link, focus-visible, aria labels)
- [x] Contributor stack workflow docs + signing guide

## Next

- [ ] Broader i18n for MCP/Skills management copy
- [ ] GitHub Pages publish for `docs/catalog/`
- [ ] App icon / branding assets (replace default Electron icon)
- [ ] Signed builds when maintainers have certs (see docs/SIGNING.md)
- [ ] Message virtualization for very long chat panes

## Later

- [ ] Shared cloud team profiles (optional sync service)
- [ ] Full accessibility audit (screen readers)
- [ ] Plugin marketplace filters parity with every TUI flag

## How to influence

1. Open a [Feature request](https://github.com/sunormesky-max/grok-code/issues/new?template=feature_request.md)
2. Or start a [Discussion](https://github.com/sunormesky-max/grok-code/discussions) (Show & Tell / Ideas)
3. Ship a PR — see [CONTRIBUTING.md](CONTRIBUTING.md)
