# erban: Architecture Overview

**Built on:** the [OpenClaw](https://openclaw.ai) agent framework.

erban is a thin packaging layer that gets OpenClaw onto a non-technical user's Windows PC in one
click and keeps it running as a tidy corner chat window. It does not add an agent runtime, a gateway,
or a chat UI — those are OpenClaw's. It adds an installer, a corner surface, a first-run naming flow,
and a watchdog.

## The flow

1. The user runs the one-liner (`irm https://erban.xyz/install.ps1 | iex`) or the `.exe`.
2. An embedded progress window opens instantly while the install engine runs in the background:
   install Node → OpenClaw → Chrome → model engine; download + extract the app bundle; write the
   OpenClaw config; register scheduled tasks; start the gateway.
3. A first-run window asks the owner to name the assistant.
4. The corner box opens in the bottom-right and the assistant is ready to chat. The taskbar icon
   stays pinned for one-click access afterwards.

## Components

### 1. Installer (`installer/install.ps1`, `install.sh`)
Self-elevates (one UAC), creates `C:\OpenClawBusiness\` (`app`, `profile`, `browser`, `logs`, `ui`),
installs the essentials, downloads `erban-assets.zip`, writes `openclaw.json` + a gateway launcher,
registers the gateway / surface / watchdog scheduled tasks and a firewall rule, and opens the corner
box. Every external step is timed out so a hung sub-installer can't wedge the run. The progress UI is
served from a tiny local HTTP listener and polls `/status`.

### 2. Local gateway (OpenClaw)
A loopback OpenClaw gateway on a local port, token-authed, serving the rebranded Control UI from
`surface/control-ui`. This is plain OpenClaw — the installed agent has OpenClaw's normal tools.

### 3. Corner surface (`surface/`)
A chromeless Chrome `--app` window (`launch-surface.ps1`) in the bottom-right showing the Control UI,
with `erban-overlay.{css,js}` for the rebrand and the first-run naming screen. Running it in Chrome
(not Edge) is deliberate: Chrome `--app` carries OpenClaw's own favicon as the taskbar icon.

### 4. Identity / naming service (`surface/identity-service/`)
A zero-dependency loopback WebSocket server (`server.mjs`) that takes the chosen name from the
first-run screen and writes it as the server-side source of truth (`erban-identity.json` +
`IDENTITY.md`, which is injected into the agent's system prompt). `provider-auth.mjs` drives one-click
"Sign in with Claude" so the model backend is authenticated without the user touching a config file.

### 5. Watchdog
A scheduled task that restarts the gateway or the corner window if either dies — deterministic
relaunch, no model in the loop.

## Hosting + distribution

The landing page and installers are served from Cloudflare Pages (project `erban`, erban.xyz). The
`.exe` and `erban-assets.zip` are build artifacts of this repo's `installer/` + `surface/` + `agent/`.
See `site/README.md` for the deploy pipeline.
