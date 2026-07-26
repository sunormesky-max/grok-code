# Live / Code / Diff — host review desk

**Status:** Active · **Shipped breakthrough:** v1.46.8  
**Rule:** Host paints disk snapshots from tool/fs events. No second agent, no invented patches.

## Pipeline

```text
tool_start (write) → noteToolFrameMeta + cacheWriteBaselineFromTool → cacheFileBefore
                     (before ToolStorm early-return · task project · openTools Map)
tool_end (path from end args OR start meta) / fs:changed → recordFileChangeForProject
        │
        ├─ Live event (path) · side “本轮变更”
        ├─ Diff tab (scheduleDiffPaint)
        └─ Review bridge chip + Diff badge
```

## Breakthroughs (1.46 → 1.46.8)

| Feature | Where |
|---------|--------|
| Race-safe baseline | join in-flight `contentCachePending` only — never invent before post-write |
| BG project baseline | tool_start write always caches for **task project**, not only active |
| ToolStorm multi-write | baseline **before** storm early-return; storm paths not active-only |
| tool_end path retention | `mergeToolMeta` + openTools Map (ACP **and headless**) |
| baselineMiss honesty | shell/late fs without pre-write snap still lists path; restore off |
| Shell path baseline | `run_terminal`/shell extract → `cacheFileBefore` when path guessed |
| Truncation recovery | `beforeIncomplete` sticky; after-only truncate can recover; restore gated correctly |
| restore-all safety | skips truncated/missing baselines; button hidden when none safe |
| Tool meta turn clear | `_toolFrameMeta.clear()` on new turn |
| BG truncation parity | same flags on background `recordFileChangeForProject` |
| BG Live title honesty | use `entry.created` not `keepBefore === ''` (baselineMiss ≠ 创建) |
| Hunk actions gate | unified only · also `!baselineMiss` belt+suspenders |
| Paint coalesce | `scheduleDiffPaint` (rAF + scroll restore) |
| Live → Diff | Live write/tool rows `data-path` → `openReviewBridge` |
| Word highlight | `DiffUtil.wordDiffHtml` on paired del/add |
| Binary honesty | `looksBinary` · banner · empty ops |
| Truncation honesty | `beforeIncomplete` sticky · after may recover · restore only if baseline OK |
| List filter | path / pending / reviewed / binary |
| Accept-and-next | after review / dismiss → next pending |
| Hunk keep/reject | unified ✓ / ↩ · `DiffUtil.applyHunkDecisions` · disk write on reject |

## Keyboard (Diff tab)

| Key | Action |
|-----|--------|
| j/k · ↑↓ | Next/prev file |
| Shift+j/k | Multi-select range |
| x | Toggle select |
| * | Select all pending |
| n/p | Next/prev hunk |
| a | Mark reviewed (+ next) |
| s | Unified / split |

## Hunk actions (unified · Live view)

| Control | Behavior |
|---------|----------|
| ✓ Keep | Mark hunk kept; all kept → file reviewed + next pending |
| ↩ Reject | Revert that hunk on disk toward `before`; recompute ops; all gone → restored |

Disabled for: binary, incomplete snapshot, restored, import pack, compare mode, checkpoint view.

## Non-goals

- Fake mid-write token patches from the model  
- Host monkey-patch of CLI file tools as sole source of truth  
- Full git index / three-way merge as P0  
- Second review agent  

## Next (optional)

- Worker for multi-MB LCS  
- Side-by-side hunk actions (unified first)

See also: [ARCHITECTURE.md](ARCHITECTURE.md), [VISUAL-QA.md](VISUAL-QA.md).
