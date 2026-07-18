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

Paste `FEEDBACK.md` from this folder.

## Apply

```powershell
git clone https://github.com/xai-org/grok-build.git
cd grok-build
git apply path\to\grok-code\patches\grok-build\0001-tool-in-progress.patch
```

## Build (from upstream README)

Needs Rust (`rust-toolchain.toml`), DotSlash, protoc.

```powershell
cargo build -p xai-grok-pager-bin --release
# binary typically: target\release\xai-grok-pager.exe  (or grok name via package)
```

Point GrokCode Settings → Grok path at that binary, or:

```powershell
$env:PATH = "C:\path\to\target\release;" + $env:PATH
```

## Notes

- Stock 0.2.x already has `ToolCallStatus::InProgress` for **backend** tool events; normal tool loop mostly uses `Pending` → `Completed`. This patch fills the gap for the main tool dispatch path.
- Token-level streaming / silence heartbeats need larger changes in the sampler + `ReplayBuffer` path; tracked in FEEDBACK.md.
