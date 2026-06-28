# Erban — OpenClaw for Business

A one-click installer that wraps [OpenClaw](https://openclaw.ai) (MIT) into a locked-down,
**read-and-draft** back-office assistant for non-technical trades/small businesses. It installs
OpenClaw, parks a chromeless chat box in the corner of the screen, and on first run asks the owner
to name the assistant. The agent can **read the CRM and draft work** for the owner to check and
send — it does **not** send, post, delete or pay.

> Brand note: the product ships publicly as **"OpenClaw for Business"**; "Erban" is the internal/code name.

## Repo layout

| Path | What it is |
|------|------------|
| `CLAUDE.md` | Authoritative build spec (v2, post red-team). Start here. |
| `architecture.md` | Original design overview (superseded where it conflicts with `CLAUDE.md`). |
| `surface/` | The corner box: `launch-surface.ps1` (chromeless `--app` launcher), the rebranded OpenClaw Control UI under `control-ui/` with the injected `erban-overlay.{css,js}`, the first-run + provider sign-in helper under `identity-service/`, and `erban-uninstall.ps1`. |
| `mcp/erban-crm/` | The read-only CRM MCP server (the one real integration) + sample `crm.json`. |
| `agent/workspace/` | The agent's workspace files (`SOUL.md`, `AGENTS.md`, `IDENTITY.md`, …) injected into its system prompt. |
| `installer/` | The published installers — `install.ps1` (Windows) and `install.sh` (nix). The `.exe` and `erban-assets.zip` on the site are **build artifacts** of this source (see below). |
| `site/` | The marketing landing page served at erban.xyz. |

## How install works (published flow)

```
iwr -useb https://erban.xyz/install.ps1 | iex     # Windows one-liner
# ...or download OpenClaw-for-Business-Setup.exe (a wrapper around install.ps1)
```

`install.ps1` installs everything under **`C:\OpenClawBusiness\`** (`app`, `profile`, `browser`,
`logs`, `ui`): it installs Node + OpenClaw, downloads the app bundle (`erban.xyz/erban-assets.zip`,
which is a zip of this repo's `surface/` + `mcp/` + `agent/`), writes the OpenClaw config + gateway
launcher, registers the **OpenClaw Business Gateway / Surface / Watchdog** scheduled tasks and a
firewall rule, and opens the corner box.

Build artifacts (not committed; produced from this source): `erban-assets.zip` = zip of the app
folders; `OpenClaw-for-Business-Setup.exe` = a `ps2exe`-style wrapper of `installer/install.ps1`.
Both are hosted on erban.xyz. *(A build/deploy script for these is not yet in the repo — TODO.)*

## Status / known gaps (important)

The **published** `installer/install.ps1` is an early build and has two known issues being addressed
in `surface/`:

1. **Model auth is not provisioned.** The installer never logs the model backend in, so a fresh
   machine errors `No API key found for provider anthropic`. The fix is one-click provider sign-in
   (`surface/identity-service/provider-auth.mjs` + the overlay's "Sign in with …" buttons) — wired
   for Claude, with ChatGPT/Gemini gated behind their own capability-gate proofs.
2. **The capability gate is not real in the published build.** It runs the OpenClaw *embedded*
   runtime with a prompt/persona-only "read-and-draft" boundary. The hardened gate uses the
   **claude-cli** backend with native tools stripped (`--tools ""`) so only the 5 `erban-crm` MCP
   tools are reachable — a true capability-level lockout, not persona.

See `CLAUDE.md` for the full design and the safety model.

## Built on OpenClaw

Erban is a thin trades-specific policy + workflow layer over OpenClaw. The heavy lifting (agent
runtime, gateway, Control UI) is OpenClaw's. We don't rebuild any of it.
