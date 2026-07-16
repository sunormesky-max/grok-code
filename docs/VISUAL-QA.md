# Visual QA checklist — GrokCode flight deck

Use after UI/visual changes. Prefer a **wide window (≥1600px)** and **Normal FX**, then spot-check **High FX**.

## Prep

- [ ] `npm start` on a clean build (`git pull` + install if needed)
- [ ] Theme: **Grok** (default), then spot **Ice / Mars / Void**
- [ ] Layout: **Agent** → **Pilot** (if wide) → **Review** → **Full**
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

## Motion / a11y

- [ ] OS **Reduce motion** → no boot rings / send pulse spam
- [ ] App **强制减少动效** → same, independent of OS
- [ ] Keyboard focus-visible still visible on tabs / buttons

## Regression smoke

- [ ] Enter sends chat; Shift+Enter newline
- [ ] Open project; Agent run shows Live + Diff bridge
- [ ] Layout Auto (if enabled) does not fight Review/Full

## Notes

Record theme, OS, and GPU tier if something looks wrong (e.g. blur too heavy on integrated graphics → set FX **标准**).
