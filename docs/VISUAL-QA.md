# Visual QA checklist — GrokCode flight deck

Use after UI/visual changes. Prefer a **wide window (≥1600px)** and **Normal FX**, then spot-check **High FX**.

## Prep

- [ ] `npm start` on a clean build (`git pull` + install if needed)
- [ ] Theme: **Grok** (default), then spot **Ice / Mars / Void**
- [ ] Layout: **Work** (default) → **Review**; **···** → Pilot / Full / Auto (Auto default off)
- [ ] FX: Settings → Appearance → **标准 / 高强度**
- [ ] Optional: **强制减少动效** on, then off

## Boot & chrome

- [ ] Boot sequence: logo glow, log terminal, progress bar; skip with Enter works
- [ ] Title bar: brand gradient, layout presets capsule, CLI pill
- [ ] Windows: system min/max/close clickable (titleBarOverlay)
- [ ] Status bar: ice/mars telemetry strip readable

## Agent primary

- [ ] Chat panel has stronger edge glow than Explorer / Live
- [ ] Welcome card: kicker, hero shine, template chips
- [ ] Composer focus bloom; **Send** gradient + press pulse
- [ ] Mode chips Craft/Plan/Ask active state clear

## Live / Code / Diff

- [ ] Live empty state: sigil + card
- [ ] Live events: timeline rail, kind colors, hover
- [ ] Code empty card cinematic
- [ ] Diff empty placeholder
- [ ] Diff filmstrip cards match HUD language when scrubbing
- [ ] Review bridge chip appears when there are changes

## Outline · Split · Explorer

- [ ] **Outline** (open a source file): STRUCTURE · Outline head, kind chips, active ice rail
- [ ] Outline empty: muted mono “打开文件后显示大纲”
- [ ] Theme **Mars/Ice**: outline active rail matches theme accent
- [ ] **Split** (Code|Diff): dual-pane top edge ice/mars; divider grip glows on hover
- [ ] Split toggle active: gradient capsule + glow
- [ ] **Explorer**: panel-label ice glow, filter focus bloom, toolbar mono caps
- [ ] Tree active file: left ice rail + name glow; ext tint bar on files
- [ ] Density **紧凑**: outline/tree rows still readable; split grip thinner

## Overlays

- [ ] **Ctrl+K**: glass card, group labels, active row ice rail + hint kbd chip
- [ ] **Ctrl+P** / **Ctrl+Shift+F**: mode pills, active result row matches palette
- [ ] **Ctrl+/** or **?**: shortcuts overlay kicker + kbd chips + hover rail
- [ ] Settings: section titles (CLI / Theme / Telemetry / MCP / Skills)
- [ ] Onboarding (Ctrl+K → 首启向导): kickers, dots, hero cards
- [ ] Toasts: glass + ok/err left accent

## Density & themed boot

- [ ] Density **紧凑**: layout presets, filmstrip, palette still readable (no glow washout)
- [ ] Theme **Ice** then restart / re-open boot (or reload): boot grid/log cyan-tinted
- [ ] Theme **Mars** boot: orange scan + log
- [ ] Theme **Void** boot: mono stellar
- [ ] Theme **Ember** boot: red residual

## Cinematic idle (optional)

- [ ] Setting **电影级待机** defaults **off** (no body.cinematic-idle until checked)
- [ ] Enable → wait ~12s without mouse/keys: motes + vignette + secondary beam appear
- [ ] Move mouse → ambient damps (`.is-idle` removed)
- [ ] With **强制减少动效** or OS reduce motion: idle layer hidden / no extra animations
- [ ] Ctrl+K → “电影级待机” toggles same as settings

## Motion / a11y

- [ ] OS **Reduce motion** → no boot rings / send pulse spam
- [ ] App **强制减少动效** → same, independent of OS
- [ ] Keyboard focus-visible still visible on tabs / buttons

## Regression smoke

- [ ] Enter sends chat; Shift+Enter newline
- [ ] Open project; Agent run shows Live + Diff bridge
- [ ] Layout Auto (if enabled) does not fight Review/Full
- [ ] Import storyboard with mini-diffs: Diff shows unified/SBS ops (recon badge), not only raw text
- [ ] With project open + paths exist: rehydrate may show **recon full** / disk before
- [ ] **Code**: editor fills pane; Outline is collapsed rail (▸) until expanded
- [ ] **Diff**: primary row is Turns scrub only; **▸ 工具** reveals filmstrip/export; line diff scrolls below
- [ ] Diff Checkpoints collapsed summary until expanded

## Notes

Record theme, OS, and GPU tier if something looks wrong (e.g. blur too heavy on integrated graphics → set FX **标准**).
