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
- [x] **i18n** (en / zh shell UI)
- [x] **Theme packs** (built-in + community tokens under `examples/themes/`)
- [x] **Linux / macOS** artifacts in Release matrix (unsigned community builds)
- [x] **Virtualized Live timeline** for long sessions
- [x] **Project profiles** export / import
- [x] **Telemetry opt-in** (local crash logs; optional endpoint)
- [x] **Skill / MCP catalog** from `examples/` (`npm run catalog`)

## Next

- [ ] Richer i18n coverage (dynamic toasts / Live strings)
- [ ] Theme pack import UI (drag JSON)
- [ ] Signed macOS / Windows code-signing when certs available
- [ ] Plugin search UX parity with TUI marketplace filters
- [ ] Optional Graphite / multi-PR workflow docs for contributors

## Later

- [ ] Shared cloud team profiles (optional sync service)
- [ ] Static docs site for catalog (GitHub Pages)
- [ ] Accessibility audit (keyboard / screen readers)

## How to influence

1. Open a [Feature request](https://github.com/sunormesky-max/grok-code/issues/new?template=feature_request.md)
2. Or start a [Discussion](https://github.com/sunormesky-max/grok-code/discussions) (Show & Tell / Ideas)
3. Ship a PR — see [CONTRIBUTING.md](CONTRIBUTING.md)
