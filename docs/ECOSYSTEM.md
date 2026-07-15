# GrokCode open-source ecosystem

## Pillars

| Pillar | Repo location | Community action |
|--------|---------------|------------------|
| **Core app** | `electron/`, `renderer/` | PRs, bug reports |
| **MCP presets** | `examples/mcp/` | Add JSON templates (no secrets) |
| **Skills** | `examples/skills/` | Share SKILL.md packs |
| **Docs** | `docs/`, README, ROADMAP | Tutorials, translations |
| **Releases** | GitHub Releases | Download installers, file install bugs |

## Channels

- **Issues** — bugs & features (templates provided)  
- **Discussions** — Q&A, Show & Tell, ideas  
- **Pull requests** — code & examples  
- **Security** — see [SECURITY.md](../SECURITY.md)  

## Suggested Discussion categories

| Category | Purpose |
|----------|---------|
| Announcements | Maintainers only |
| Q&A | Help with install / CLI / MCP |
| Ideas | Feature brainstorming |
| Show and tell | Screenshots, forks, skill packs |
| Polls | Prioritize roadmap items |

## Versioning

- `main` — development  
- Tags `vX.Y.Z` — GitHub Actions builds **Windows + Linux + macOS** community artifacts (unsigned by default)  
- Changelog: [CHANGELOG.md](../CHANGELOG.md)  

## Catalog & themes

- MCP / Skill examples → `examples/` → `npm run catalog` → Settings → Catalog  
- Theme token examples → `examples/themes/`  
- Plugin bridge → Settings → Plugins (`grok plugin` / marketplace)  


## Branding

- Name: **GrokCode**  
- Position: desktop agent **for** Grok CLI, not a fork of Grok  
- Visual: void black · ice cyan · mars orange (see `renderer/styles.css`)  

## Non-goals

- Replacing Grok CLI runtime  
- Shipping vendor API keys  
- Silent telemetry by default  
