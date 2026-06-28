# erban: Build Spec

Read this before writing code.

## The product, in one line

A one-click installer that puts [OpenClaw](https://openclaw.ai) (MIT) on a non-technical user's
Windows PC: it installs everything, asks the owner to name the assistant, and opens it as a tidy chat
window pinned to the taskbar. No terminal, no config files. erban is a thin wrapper — the agent
runtime, gateway and Control UI are all OpenClaw's.

## What it does

1. **Installs the essentials.** Node, OpenClaw (`npm i -g openclaw`), Chrome (so the corner `--app`
   window carries OpenClaw's own taskbar icon), and the model engine.
2. **Sets up a local gateway.** Writes an OpenClaw config + gateway launcher under
   `C:\OpenClawBusiness\` and registers gateway / surface / watchdog scheduled tasks + a firewall rule.
3. **Names the assistant.** A first-run window asks for a name; the identity helper persists it as the
   server-side source of truth (`erban-identity.json` + `IDENTITY.md` injected into the system prompt).
4. **Opens the corner box.** A chromeless Chrome `--app` window in the bottom-right, running the
   rebranded OpenClaw Control UI. Closing it closes OpenClaw; the taskbar icon stays pinned for
   one-click access.

The installed agent is **plain OpenClaw** — named and ready to chat, with OpenClaw's normal tools.

## What OpenClaw gives us (don't rebuild)

- Its own runtime, Gateway (local port), and Control UI (custom UI via `gateway.controlUi.root`).
- Onboarding/health commands (`openclaw --version`, `openclaw doctor`, `openclaw gateway status`).
- Treat all inbound channel content as untrusted. Pin/vendor a specific OpenClaw version.

So erban is: the installer (`installer/install.ps1`, `install.sh`), the corner surface
(`surface/`), and the named-agent workspace (`agent/workspace/`). Everything underneath is OpenClaw.

## Key files

- `installer/install.ps1` — Windows one-click installer (the embedded progress UI, the install engine,
  the generated `openclaw.json`, the scheduled tasks). `install.sh` is the macOS/Linux equivalent.
- `surface/launch-surface.ps1` — launches the corner `--app` window.
- `surface/control-ui/` — the rebranded OpenClaw Control UI + `erban-overlay.{css,js}`.
- `surface/identity-service/` — first-run naming (`server.mjs`) + one-click provider sign-in
  (`provider-auth.mjs`), over a loopback WebSocket.
- `agent/workspace/` — `SOUL.md` / `AGENTS.md` / `IDENTITY.md` etc., injected into the agent's prompt.
- `site/` — the landing page (erban.xyz) and its screenshots.

## Conventions

- User-facing copy: casual, direct, plain Australian English. No em-dashes, no AI filler.
- Idempotent, re-runnable installers; lean on `openclaw doctor`-style checks.
- Don't reimplement what you can call through OpenClaw's CLI.
- The `.exe` and `erban-assets.zip` on the site are build artifacts of this source (see
  `site/README.md`); rebuild them when the installer or `surface/`/`agent/` change.
