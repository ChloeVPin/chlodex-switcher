# FAQ

Common questions about Codex Switcher.

## Is this a GUI app or a CLI tool?

It is a GUI desktop app. It manages Codex account workflows, but the user experience is a graphical desktop interface.

## Does it change my CLI account automatically?

Yes. When you switch accounts, the app updates the local account state used by the Codex-related workflows.

## Does Codex Switcher send my credentials somewhere?

Not by default. The app keeps local account state on your machine and only uses the network when you explicitly use features like usage refresh, warm-up, or browser/LAN mode.

## Can I run it on Windows?

Yes. Windows is the primary supported platform.

## What do I need installed?

- WebView2
- Go
- Bun
- Wails CLI

`wails doctor` is the fastest way to check the setup.

## Why does the window disappear when I close it?

That is expected. The app is designed to stay available in the tray instead of exiting immediately.

## How do I fully quit the app?

Use the tray menu and choose Quit.

## What is browser / LAN mode?

It serves the UI over HTTP so you can open Codex Switcher in a browser on the same machine or another machine on the same local network.

## Is browser / LAN mode public-facing?

No. It is intended for trusted local use.

## How do I build it?

```bash
wails build
```

For the Windows single-exe distribution build:

```bash
bun run build:windows
```

## Where should I look if a build fails?

Start with `wails doctor`, then check the Windows prerequisites, Go toolchain, and WebView2 installation.
