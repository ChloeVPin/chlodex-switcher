# Contributing to Codex Switcher

Thanks for helping improve Codex Switcher. This guide covers the local setup, the main commands, and the expectations for pull requests.

## Prerequisites

| Tool            | Notes                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| Go              | Use the version from `go.mod`                                            |
| Bun             | Used for frontend scripts                                                |
| Wails toolchain | Install with `go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0` |
| WebView2        | Required on Windows for the desktop shell                                |

Check your environment with:

```bash
wails doctor
```

## Local setup

```bash
git clone <repository-url>
cd codex-switcher
bun install
```

## Main commands

| Command                 | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `bun run dev`           | Start the Wails dev app                           |
| `wails dev`             | Same as above                                     |
| `wails build`           | Build the standard desktop app                    |
| `bun run build:windows` | Build the single-file Windows launcher            |
| `bun run lan`           | Build the frontend and start the browser/LAN mode |

## Project layout

```text
main.go                 Wails app bootstrap
app.go                  Backend methods exposed to the UI
tray.go                 Tray behavior and window handling
src/                    React + TypeScript frontend
src/wailsjs/            Generated Wails bindings
src-electron/           Browser/LAN runtime support
docs/                   Maintainer and user documentation
build/                  Generated build assets
```

Do not edit generated files in `src/wailsjs/` by hand.

## Working on changes

1. Make the smallest change that solves the problem.
2. Test it in `wails dev` when the change touches the UI or desktop runtime.
3. Run `wails build` before opening a PR.
4. If the change affects browser/LAN mode, also run `bun run lan`.

## Pull request expectations

- Keep each PR focused on one idea.
- Explain what changed and why it matters.
- Include screenshots for UI changes.
- Call out any follow-up work that should happen later.
- Use the GitHub issue forms for bugs and feature requests so reports stay structured.

## Code style

- Go: use `gofmt`.
- TypeScript and markdown: keep the style consistent with the repo.
- Avoid introducing machine-specific paths or generated junk into committed files.

## Need help?

Open an issue or start a discussion with enough context for someone else to reproduce the problem.
