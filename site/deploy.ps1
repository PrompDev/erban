# Deploy the OpenClaw for Business (Erban) website to Cloudflare Pages.
#   Project:  erban   ->   https://erban.xyz   (apex CNAME -> erban-3ug.pages.dev, proxied)
#   Account:  Drdeandrehyde@gmail.com  (a49cc77a6fe0d7347e84ea914e617aac)
#
# The repo is the source of truth for the static site + installers. The two large build
# artifacts are NOT committed (derivable, kept out of git) and must be present in
# site/artifacts/ before deploying:
#   - erban-assets.zip                 the app bundle install.ps1 downloads (zip of ../surface + ../mcp + ../agent)
#   - OpenClaw-for-Business-Setup.exe  ps2exe wrapper of ../installer/install.ps1
# Recover the current live ones if you don't have them:
#   iwr https://erban.xyz/erban-assets.zip                -OutFile site/artifacts/erban-assets.zip
#   iwr https://erban.xyz/OpenClaw-for-Business-Setup.exe -OutFile site/artifacts/OpenClaw-for-Business-Setup.exe
#
# NOTE: erban-assets.zip is currently the STABLE (pre-gate) app bundle. Do NOT rebuild it from the
# current ../surface until the installer is updated to drive the claude-cli gate + one-click sign-in,
# or the box will ship a non-working sign-in. See ../README.md "Status / known gaps".
#
# Requires wrangler auth (npx wrangler whoami). Run:  powershell -File site/deploy.ps1

param([string]$Account = 'a49cc77a6fe0d7347e84ea914e617aac', [string]$Project = 'erban', [string]$Branch = 'main')
$ErrorActionPreference = 'Stop'
$site = $PSScriptRoot
$repo = Split-Path $site -Parent
$art  = Join-Path $site 'artifacts'
$out  = Join-Path $site '.deploy'

$need = @('erban-assets.zip','OpenClaw-for-Business-Setup.exe')
$missing = $need | Where-Object { -not (Test-Path (Join-Path $art $_)) }
if ($missing) { throw "Missing build artifact(s) in site/artifacts/: $($missing -join ', '). See this script's header to recover/build them." }

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $site 'index.html')   $out
Copy-Item (Join-Path $site 'favicon.svg')  $out
Copy-Item (Join-Path $site 'openclaw.png') $out
Copy-Item (Join-Path $repo 'installer/install.ps1') $out
Copy-Item (Join-Path $repo 'installer/install.sh')  $out
Copy-Item (Join-Path $art  'erban-assets.zip') $out
Copy-Item (Join-Path $art  'OpenClaw-for-Business-Setup.exe') $out

Write-Host "Deploying $((Get-ChildItem $out -File).Count) files to Pages project '$Project' (branch $Branch)..."
$env:CLOUDFLARE_ACCOUNT_ID = $Account
npx --yes wrangler@latest pages deploy $out --project-name $Project --branch $Branch
Remove-Item $out -Recurse -Force
Write-Host "Done. Live at https://erban.xyz"
