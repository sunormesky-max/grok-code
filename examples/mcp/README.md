# Example MCP presets

These are **templates** for community MCP setups. Copy into Settings → MCP, or:

```bash
grok mcp add <name> -- <command...>
# or
grok mcp add --transport http <name> <url>
```

| File | Description |
|------|-------------|
| `filesystem.stdio.example.json` | Local filesystem MCP via npx |
| `http.remote.example.json` | Remote HTTP MCP skeleton |

**Never commit real API keys.** Use env vars or `${VAR}` in config where supported.
