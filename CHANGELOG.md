# Changelog

All notable changes to **erban** — the one-click [OpenClaw](https://openclaw.ai) installer for Windows.

## 2026-06-30 — one-click, fast, self-managing

### Highlights
- **Under 20 seconds to a working assistant.** Launching the corner box brings up the gateway + Control UI on demand in about 12 seconds — down from the old auto-start-at-login + watchdog flow that averaged ~3.5 minutes and left things running in the background.
- **Truly one-click sign-in.** "Sign in with Claude" runs the OAuth login inside a hidden pseudo-terminal (vendored ConPTY / node-pty): click **Approve** in your browser and you're in. No console window, no copying codes.
- **Open and close it like a normal app.** "OpenClaw Business" now has a **Desktop shortcut** and a **Start Menu entry** (so Windows search finds it). Closing the box fully stops OpenClaw; opening a shortcut relaunches the gateway + box.

### Fixed
- **Sign-in failed on a clean PC** ("Claude Code requires Git for Windows / PowerShell"). The installer now silently installs Git for Windows and wires `CLAUDE_CODE_GIT_BASH_PATH` everywhere claude runs.
- **Sign-in hung with no window.** `claude` is a TTY app that emits nothing over a pipe; the OAuth login now runs through a hidden ConPTY so it works without a visible console.
- **Agent error `spawn claude ENOENT`.** `npm i -g` only puts `claude.cmd` on PATH (which Node's `spawn` can't run); the gateway now has the real `claude.exe` directory on its PATH.
- **Agent error `Not logged in`.** OpenClaw's gateway spawns `claude` with its default home, so sign-in credentials are now mirrored into `~/.claude`.
- **Box showed "site can't be reached".** Launch now waits for the gateway to bind its port before opening the box (Chrome `--app` doesn't retry a refused connection).
- **Random PowerShell flashes** removed (dropped the every-2-minutes watchdog task; the launcher runs hidden via `wscript`).
- **Two sign-in popups** reduced to one.
- **Taskbar / box icon** is now the OpenClaw logo (built from the bundled logo at install time).

### Known limitations
- Windows does not allow an app to pin itself to the taskbar. Use the Desktop or Start Menu shortcut, or right-click the search result → **Pin to taskbar**.
- "Last chat" restoration is OpenClaw session state (persisted on disk); reopening should restore the last conversation.

### Internal
- Lifecycle is now **user-launched**: no scheduled tasks, no login auto-start, no watchdog. A no-flash `wscript` VBS launcher runs `surface/launch-surface.ps1`, which starts the gateway, opens the box, and stops everything when the box is closed.
