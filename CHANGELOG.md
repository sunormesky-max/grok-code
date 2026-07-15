# Changelog

All notable changes to GrokCode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- See [ROADMAP.md](ROADMAP.md)

## [1.0.0] — 2026-07-15

### Added

- Desktop shell (Electron) driving **local Grok Build CLI** headless (`streaming-json`)
- **Multi-project** workspaces with parallel agents
- **Multi-task** per project (independent CLI sessions)
- **Live / Code / Diff** mission control, unified diffs, restore / restore-all
- **Context inheritance** (`~/.grok-code/sessions`) + **L0–L3** compression
- Settings: general, **MCP** (list/add/remove/doctor/timeout), **Skills** (list/toggle/create/edit)
- Sci-fi UI, boot sequence, frameless title bar
- Open-source kit: MIT, CONTRIBUTING, CoC, SECURITY, examples, issue/PR templates
- CI workflow + electron-builder packaging (Windows NSIS + portable)

### Notes

- Requires installed Grok CLI + auth (`grok login` or `XAI_API_KEY`)
- YOLO / always-approve is full workspace trust

[Unreleased]: https://github.com/sunormesky-max/grok-code/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/sunormesky-max/grok-code/releases/tag/v1.0.0
