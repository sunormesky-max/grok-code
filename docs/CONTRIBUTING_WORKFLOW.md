# Contributor workflow (single PR & stacks)

## Default path (most contributors)

1. Fork → branch from `main` (`feat/…`, `fix/…`, `docs/…`)
2. `npm install && npm run check`
3. Open **one focused PR** against `main`
4. Use the PR template; include screenshots for UI

## Multi-PR / stacked changes

For large features that should land in reviewable slices:

### Option A — Graphite (if you use it)

```bash
# install graphite CLI, then
gt create feat-part-1 -m "feat: part 1"
# work…
gt create feat-part-2 -m "feat: part 2"
gt submit --stack
```

Reviewers see a stack; merge bottom-up.

### Option B — plain git stack

```bash
git checkout -b feat/context-a
# commit A
git push -u origin HEAD
# open PR A → main

git checkout -b feat/context-b
# commit B on top of A
git push -u origin HEAD
# open PR B → feat/context-a (or rebase onto main after A merges)
```

In the PR body, note **depends on #NN**.

### Option C — draft PRs

Open a draft for the full design, then split commits into follow-up PRs once the approach is approved (`/design` style docs welcome).

## CI expectations

- `npm run check` must pass (syntax + unit tests + catalog)
- Do not commit `node_modules`, secrets, or large binaries
- Release tags `v*` trigger multi-OS electron-builder (unsigned by default; see [SIGNING.md](SIGNING.md))

## Review etiquette

- Prefer small diffs
- UI: before/after screenshots
- MCP/Skill examples: never include real API keys
