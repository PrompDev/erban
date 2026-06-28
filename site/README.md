# Website — erban.xyz (OpenClaw for Business)

The public landing page + installer downloads.

## Hosting

- **Cloudflare Pages**, project **`erban`** (`erban-3ug.pages.dev`), custom domain **erban.xyz**
  (apex `CNAME -> erban-3ug.pages.dev`, proxied). Account: Drdeandrehyde@gmail.com
  (`a49cc77a6fe0d7347e84ea914e617aac`). Direct-upload (no git integration) — deployed via `wrangler`.

## What's served (flat, at the domain root)

| URL | Source |
|-----|--------|
| `/` | `site/index.html` |
| `/favicon.svg`, `/openclaw.png` | `site/` |
| `/install.ps1`, `/install.sh` | `../installer/` |
| `/erban-assets.zip` | build artifact — the app bundle `install.ps1` downloads (zip of `../surface` + `../mcp` + `../agent`) |
| `/OpenClaw-for-Business-Setup.exe` | build artifact — `ps2exe` wrapper of `../installer/install.ps1` |

The two build artifacts live in `site/artifacts/` (gitignored — derivable, kept out of git to avoid
binary drift). Recover the current live ones with:

```powershell
iwr https://erban.xyz/erban-assets.zip                -OutFile site/artifacts/erban-assets.zip
iwr https://erban.xyz/OpenClaw-for-Business-Setup.exe -OutFile site/artifacts/OpenClaw-for-Business-Setup.exe
```

## Deploy

```powershell
powershell -File site/deploy.ps1     # assembles the flat site + artifacts, then `wrangler pages deploy`
```
Requires `wrangler` auth (`npx wrangler whoami`). Pages keeps every deployment immutable with instant
rollback in the dashboard if a deploy goes wrong.

## ⚠️ Before rebuilding `erban-assets.zip`

`erban-assets.zip` is currently the **stable, pre-gate** app bundle. Do **not** rebuild it from the
current `../surface` and redeploy until the installer is updated to drive the **claude-cli capability
gate** + **one-click provider sign-in** — otherwise the corner box ships a sign-in flow the installed
machine can't complete. See the root `../README.md` ("Status / known gaps").
