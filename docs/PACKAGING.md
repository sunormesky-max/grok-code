# Packaging, releases & code signing

GrokCode ships community builds via **GitHub Releases** (`electron-builder` +
`electron-updater`). This note is for maintainers and for users who hit Windows
**SmartScreen** or macOS Gatekeeper warnings.

## What CI produces

Workflow: [`.github/workflows/release.yml`](../.github/workflows/release.yml)

| Platform | Artifacts (typical) |
|----------|---------------------|
| Windows | NSIS installer + portable `.exe`, `latest.yml`, blockmap |
| Linux | AppImage, `.deb` |
| macOS | `.dmg` / zip |

Publish is tag-driven (`v*`). Builds run with `--publish never` then
`softprops/action-gh-release` uploads files (avoids `latest.yml` races).

## Auto-update (installed builds only)

- Engine: `electron-updater` against GitHub Releases  
- **Dev / unpackaged** (`npm start`, `electron . --dev`): update checks are
  **disabled** by design  
- UI: Settings → Diagnostics → **软件更新** (check / download / install /
  open Releases); titlebar **↑** when an update is pending  

See `electron/updater.js` and renderer settings update panel (v1.38+).

## Windows SmartScreen (“Windows protected your PC”)

Community builds are often **not code-signed**. SmartScreen may show:

> Windows protected your PC · Unknown publisher  

**For end users**

1. Prefer downloads from the official
   [GitHub Releases](https://github.com/sunormesky-max/grok-code/releases) page
   only.  
2. “More info” → **Run anyway** is normal for unsigned OSS if you trust the
   source.  
3. Compare the release asset name / version with `package.json` / tag.  
4. Portable vs installer: both may warn; portable does not write uninstall keys.

**For maintainers who want fewer warnings**

Signing requires a **code-signing certificate** (EV or standard OV) and secrets
in CI. High-level electron-builder path:

1. Obtain a Windows Authenticode certificate (`.pfx` or cloud HSM).  
2. Store secrets in GitHub Actions (examples only — names may vary):

   | Secret | Purpose |
   |--------|---------|
   | `CSC_LINK` | Base64 or path to cert (or URL) |
   | `CSC_KEY_PASSWORD` | Certificate password |
   | `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Win-specific overrides |

3. On the Windows release job, pass env into `electron-builder` (do **not**
   commit the cert). With a valid cert, builder signs the installer and
   portable exe.  
4. First-time reputation still needs download volume; EV certs reduce SmartScreen
   friction faster than standard certs.  
5. Keep `CSC_IDENTITY_AUTO_DISCOVERY: "false"` unless you intentionally use
   local machine cert stores in CI.

**Optional local sign after build** (advanced):

```bash
# After npm run dist:win — example only
# signtool sign /f cert.pfx /p PASS /tr http://timestamp.digicert.com /td sha256 /fd sha256 release\*.exe
```

## macOS Gatekeeper / notarization

Unsigned or un-notarized macOS apps may be blocked (“can't be opened because
Apple cannot check it for malicious software”).

Maintainer path (summary):

1. Apple Developer ID Application certificate  
2. Notarization credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`)  
3. electron-builder `mac` + notarize hook / `@electron/notarize`  

Community CI currently sets discovery off and may ship **unsigned** macOS
artifacts for contribution builds — document that clearly on the Release notes
if so.

## Linux

AppImage / deb usually need no “publisher” UX like SmartScreen. Users should
still verify they downloaded from the project Releases page. Deb may need
`chmod +x` on AppImage.

## Security notes

- Never commit certificates or private keys  
- Rotate any leaked `CSC_*` / Apple secrets immediately  
- Auto-update only trusts the configured GitHub provider feed for this app id  
- Report supply-chain issues privately when possible — [SECURITY.md](../SECURITY.md)

## Related

- [docs/A11Y.md](A11Y.md) — keyboard / screen-reader checklist (incl. HC theme)  
- [CONTRIBUTING.md](../CONTRIBUTING.md) — local `npm run check` / dist dry-run  
- Release tags: `vMAJOR.MINOR.PATCH` on `main`  
