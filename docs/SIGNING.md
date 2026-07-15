# Code signing (optional)

OSS Release builds ship **unsigned** community artifacts:

| Platform | Default CI |
|----------|------------|
| Windows | NSIS + portable, no Authenticode |
| Linux | AppImage + deb |
| macOS | dmg, `identity: null` (not notarized) |

## When you have certificates

### Windows (Authenticode)

1. Obtain a code-signing cert (PFX).
2. In GitHub repo **Settings → Secrets**:
   - `CSC_LINK` — base64 of the `.pfx` **or** path handled by your pipeline
   - `CSC_KEY_PASSWORD` — PFX password
3. Remove or override `CSC_IDENTITY_AUTO_DISCOVERY: "false"` in `.github/workflows/release.yml` for the Windows job.
4. electron-builder will sign NSIS / portable when env is present.

### macOS (Developer ID + notarization)

1. Apple Developer Program membership.
2. Secrets typically:
   - `CSC_LINK` / `CSC_KEY_PASSWORD` (or keychain setup)
   - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarize
3. Set `mac.identity` in `package.json` `build.mac` (or via env) and enable hardened runtime / notarize plugin as needed.

### Linux

No code signature required for AppImage/deb in most distros; optional GPG of release assets is a separate step.

## Policy

- Do **not** commit certificates or passwords.
- Unsigned builds are intentional for community forks without a paid Apple/Windows identity.
