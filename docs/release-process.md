# Release Process

This is the release flow for Codex Switcher.

## Versioning

Codex Switcher uses Semantic Versioning:

- Patch: bug fixes and small corrections
- Minor: backward-compatible features
- Major: breaking changes

The version is kept in sync through the repository scripts and `wails.json`.

## Before a release

1. Update the version with the repo helper, for example `bun run version:patch`.
2. Update `CHANGELOG.md`.
3. Run the build.
4. Smoke test the app on Windows.
5. Confirm the README and docs still match the current behavior.

## Recommended commands

```bash
bun run version:patch
bun run version:minor
bun run version:major
bun run release patch
```

For the desktop build:

```bash
wails build
```

For the Windows single-exe build:

```bash
bun run build:windows
```

## Release checklist

- Verify the GUI launches.
- Verify account switching works.
- Verify usage refresh and warm-up flows.
- Verify import and export still work.
- Verify tray behavior.
- Verify browser/LAN mode if that path changed.

## Publishing

When the release is ready:

1. Tag the version.
2. Push the tag.
3. Create or update the GitHub release entry.
4. Attach the appropriate build artifact.
5. Paste the matching changelog entry into the release notes.

## Post-release

- Confirm the release page looks right.
- Confirm the download links work.
- Update any follow-up documentation if the release changed user-facing behavior.
