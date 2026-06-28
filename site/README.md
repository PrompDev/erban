# Website — erban.xyz

The public landing page + installer downloads for **erban** (a one-click OpenClaw installer).

## Hosting

- **Cloudflare Pages**, project **`erban`** (`erban-3ug.pages.dev`), custom domain **erban.xyz**
  (apex `CNAME -> erban-3ug.pages.dev`, proxied). Account: Drdeandrehyde@gmail.com
  (`a49cc77a6fe0d7347e84ea914e617aac`). Direct-upload (no git integration) — deployed via `wrangler`.

## What's served (flat, at the domain root)

| URL | Source |
|-----|--------|
| `/` | `site/index.html` |
| `/favicon.svg` | `site/` |
| `/openclaw.png`, `/installer.png`, `/taskbar.png`, `/chat.png` | `site/` (the landing-page screenshots) |
| `/install.ps1`, `/install.sh` | `../installer/` |
| `/erban-assets.zip` | build artifact — the app bundle `install.ps1` downloads (zip of `../surface` + `../agent`) |
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

## Rebuilding `erban-assets.zip`

`erban-assets.zip` is just a zip of `../surface` + `../agent` (the app bundle `install.ps1` downloads
and extracts to `C:\OpenClawBusiness\app`). Rebuild it whenever you change those folders or
`installer/install.ps1`, drop it in `site/artifacts/`, then redeploy. `OpenClaw-for-Business-Setup.exe`
is a `ps2exe` wrapper of `installer/install.ps1`; rebuild it when the installer changes so the `.exe`
download matches the one-liner.
