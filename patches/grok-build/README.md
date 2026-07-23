# Experimental patches for `xai-org/grok-build`

Upstream ACP streaming is **stage-batched** (see `update_chunk_merge.rs`).
GrokCode already mitigates with warm sessions, wait clocks, and
`initialize._meta.bufferingSettings`. These patches improve the **agent**
side when you build a custom `grok` binary.

## Status

| Patch | What it does |
|-------|----------------|
| `0001-tool-in-progress.patch` | After tools are approved and **before** parallel dispatch, emit `tool_call_update` with `status: InProgress` so hosts can start elapsed timers for long tools. |

Upstream GitHub Issues are **disabled** on `xai-org/grok-build`. Prefer:

```text
grok
/feedback
```

Paste `FEEDBACK.md` from this folder (GrokCode **Settings → Diagnostics → 复制上游 Feedback**).

## Why GrokCode cannot invent tool progress

Desktop hosts only forward ACP updates. Stock CLI tool loop is mostly
`Pending` → `Completed`. Without agent-side `InProgress`, the UI can only
show a local “still running” timer after the first tool frame — not true
mid-execution stdout or status from the agent.

GrokCode **already** handles `status=in_progress` / `pending` / `running` when
the agent emits them. This patch makes stock normal tools emit that frame.

## Apply (Windows PowerShell)

```powershell
# 1) Clone open-source CLI
git clone https://github.com/xai-org/grok-build.git
cd grok-build

# 2) Apply GrokCode experimental patch (adjust path to your clone)
git apply "C:\path\to\grok-code\patches\grok-build\0001-tool-in-progress.patch"
# or from a monorepo sibling:
# git apply ..\grok-code\patches\grok-build\0001-tool-in-progress.patch
```

If `git apply` fails on a newer upstream, open the patch and re-apply the
`ToolCallStatus::InProgress` block near tool dispatch in
`crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs`.

## Build (from upstream README)

Needs Rust (`rust-toolchain.toml`), DotSlash, protoc.

```powershell
cargo build -p xai-grok-pager-bin --release
# binary typically: target\release\xai-grok-pager.exe  (or grok name via package)
```

Point GrokCode **Settings → Grok path** at that binary, or:

```powershell
$env:PATH = "C:\path\to\target\release;" + $env:PATH
```

## Verify

1. Open GrokCode → Settings → Diagnostics → **一键体检**  
   Item **长工具 InProgress** should list this folder when packaged/dev.
2. Run a long `run_terminal_command` (e.g. `sleep 30`).  
   With the patch, ACP should emit `tool_call_update` `in_progress` before
   completion; GrokCode tool cards keep the running timer.

## Notes

- Stock 0.2.x already has `ToolCallStatus::InProgress` for **backend** tool events; normal tool loop mostly uses `Pending` → `Completed`. This patch fills the gap for the main tool dispatch path.
- Token-level streaming / silence heartbeats need larger changes in the sampler + `ReplayBuffer` path; tracked in FEEDBACK.md.
- Do **not** expect GrokCode to invent tokens the agent never sends.

## Related

- [FEEDBACK.md](./FEEDBACK.md) — paste into CLI `/feedback`
- GrokCode `docs/ARCHITECTURE.md` — host ↔ CLI transports
- Doctor export bundle may include `patch-README.md` + `patch-FEEDBACK.md`
