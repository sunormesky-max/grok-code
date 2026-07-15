# Theme packs

Built-in themes live in the app (**Settings → Appearance**):

| Id | Class | Mood |
|----|-------|------|
| `grok` | `theme-grok` | Default deep space |
| `void` | `theme-void` | Pure black |
| `mars` | `theme-mars` | Orange / heat |
| `ice` | `theme-ice` | Cyan flight deck |
| `ember` | `theme-ember` | Red residual glow |

## Community tokens

Drop a JSON file like `void.tokens.json` with a `vars` map of CSS custom properties.  
GrokCode can apply packs via `GrokThemes.applyCustomPack(pack)` (dev / future import UI).

```json
{
  "id": "my-theme",
  "name": "My theme",
  "vars": {
    "--ice": "#7dd3fc",
    "--accent": "#38bdf8"
  }
}
```

Share packs in GitHub Discussions (Show and tell).
