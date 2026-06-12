# Development Guide

This guide covers the local workflow for working on Codex Switcher.

## Prerequisites

| Tool            | Notes                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| Go              | Use the version from `go.mod`                                            |
| Bun             | Used for frontend dependencies and scripts                               |
| Wails toolchain | Install with `go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0` |
| WebView2        | Required on Windows                                                      |

Check the environment with:

```bash
wails doctor
```

## Setup

```bash
git clone <repository-url>
cd codex-switcher
bun install
```

## Common commands

| Command                 | Purpose                                             |
| ----------------------- | --------------------------------------------------- |
| `bun run dev`           | Start the Wails development app                     |
| `wails dev`             | Same as above                                       |
| `wails build`           | Build the standard desktop binary                   |
| `bun run build:windows` | Build the Windows single-exe launcher               |
| `bun run lan`           | Build the frontend and start the browser/LAN server |
| `wails doctor`          | Check the local toolchain                           |

## How the dev loop works

- React files in `src/` hot reload in the Wails window.
- Go changes trigger a backend rebuild.
- Generated bindings in `src/wailsjs/` update when Wails runs.

## Practical workflow

1. Make the change.
2. Run `wails dev` and test the GUI path.
3. If the change touches browser/LAN mode, run `bun run lan`.
4. Run `wails build` before you open a PR.

## Windows notes

- WebView2 must be installed.
- CGO must be enabled for Wails builds.
- If the build cannot find a compiler, run `wails doctor` and fix the reported environment issue first.
- Tray and frameless window behavior should always be checked on Windows before release.

## Working on the frontend

The frontend is in `src/` and uses React, TypeScript, Tailwind, and shadcn-style components.

Useful areas:

- `src/App.tsx`
- `src/components/`
- `src/components/ui/`
- `src/hooks/`
- `src/lib/`

## Working on the backend

The backend entry points are `main.go`, `app.go`, and `tray.go`.

When you change exported backend methods, Wails regenerates the bridge code. Restart `wails dev` if the frontend does not pick up the change immediately.

## Related docs

- [Architecture](architecture.md)
- [Release process](release-process.md)
- [FAQ](faq.md)
