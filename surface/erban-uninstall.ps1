# Erban clean uninstall (per-user). Removes ONLY the Erban bits so you can re-run
# the installer on the same machine without resetting a VM checkpoint.
#
# It deliberately does NOT touch your MAIN OpenClaw:
#   - leaves %USERPROFILE%\.openclaw  (main profile, port 18789)
#   - leaves the "OpenClaw Gateway" and "OpenClaw Node" scheduled tasks
#
# Usage (run on the target machine):
#   powershell -ExecutionPolicy Bypass -File erban-uninstall.ps1 -Yes
#   ...optional: -AppDir "C:\path\to\file2212s"   (also resets the workspace markers)
#   ...optional: -PurgeClaudeAuth                 (also removes ~/.claude to test the fresh-auth path)
#
# Without -Yes it does a dry run and just prints what it WOULD remove.

param(
  [switch]$Yes,
  [string]$AppDir,
  [string]$InstallRoot = "C:\OpenClawBusiness",
  [switch]$PurgeClaudeAuth
)
$ErrorActionPreference = "SilentlyContinue"

$dry = -not $Yes
function Step($msg) { Write-Host ("[{0}] {1}" -f $(if($dry){"DRY"}else{"DO "}), $msg) }
function Remove-Dir($p) { if (Test-Path $p) { Step "remove dir  $p"; if (-not $dry) { Remove-Item -Recurse -Force $p } } else { Write-Host "  (absent)    $p" } }
function Remove-File($p) { if (Test-Path $p) { Step "remove file $p"; if (-not $dry) { Remove-Item -Force $p } } else { Write-Host "  (absent)    $p" } }

# The self-contained Windows installer registers 'OpenClaw Business *'; the older dev/macOS
# layout used 'OpenClaw Gateway (erban)'. Remove whichever are present.
$tasks = @("OpenClaw Business Gateway", "OpenClaw Business Surface", "OpenClaw Business Watchdog", "OpenClaw Gateway (erban)")
$port = 18901
$idPort = 8766

Write-Host "=== Erban uninstall ($(if($dry){'dry run - pass -Yes to act'}else{'LIVE'})) ==="

# 1. Stop + delete the erban scheduled tasks (NOT the main OpenClaw ones)
foreach ($task in $tasks) {
  if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
    Step "stop + delete scheduled task '$task'"
    if (-not $dry) { Stop-ScheduledTask -TaskName $task; Start-Sleep -Milliseconds 600; Unregister-ScheduledTask -TaskName $task -Confirm:$false }
  } else { Write-Host "  (absent)    scheduled task '$task'" }
}

# 2. Kill the erban gateway node (by port) and the identity helper (:8766)
foreach ($pn in @($port, $idPort)) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "$pn" -or $_.CommandLine -match 'OpenClawBusiness' -or $_.CommandLine -match 'openclaw-erban' -or $_.CommandLine -match 'identity-service' }
  foreach ($pr in $procs) { Step "kill node pid $($pr.ProcessId) (port $pn)"; if (-not $dry) { Stop-Process -Id $pr.ProcessId -Force } }
}
# close any open surface Chrome windows
$chrome = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'Erban\\chrome-surface' }
foreach ($c in $chrome) { Step "close surface chrome pid $($c.ProcessId)"; if (-not $dry) { Stop-Process -Id $c.ProcessId -Force } }

# 3. Remove the self-contained install root, the dev profile/state, runtime cache, and the vendored gate copy
Remove-Dir $InstallRoot
Remove-Dir "$env:USERPROFILE\.openclaw-erban"
Remove-Dir "$env:LOCALAPPDATA\Erban"
Remove-Dir "C:\Users\$env:USERNAME\AppData\Roaming\npm\node_modules\openclaw-erban"

# Drop the inbound firewall rule the installer adds (else repeat installs stack duplicates).
if (Get-NetFirewallRule -DisplayName 'OpenClaw Business (node)' -ErrorAction SilentlyContinue) {
  Step "remove firewall rule 'OpenClaw Business (node)'"
  if (-not $dry) { Remove-NetFirewallRule -DisplayName 'OpenClaw Business (node)' }
} else { Write-Host "  (absent)    firewall rule 'OpenClaw Business (node)'" }

# 4. Reset workspace markers if the app dir is known (so first-run shows again)
if ($AppDir) {
  $ws = Join-Path $AppDir "agent\workspace"
  Remove-File (Join-Path $ws "erban-provider.json")
  if (Test-Path (Join-Path $ws "erban-identity.json")) { Step "reset name marker"; if (-not $dry) { Set-Content -Path (Join-Path $ws "erban-identity.json") -Encoding utf8 -Value '{ "name": null }' } }
}

# 5. Optionally purge Claude Code auth to reproduce the true clean-machine (no-credentials) state
if ($PurgeClaudeAuth) { Remove-Dir "$env:USERPROFILE\.claude" }

Write-Host ""
Write-Host "Left untouched: %USERPROFILE%\.openclaw (main), 'OpenClaw Gateway' + 'OpenClaw Node' tasks, the openclaw CLI, Node."
Write-Host $(if($dry){"Dry run only. Re-run with -Yes to actually remove, then run the installer again."}else{"Done. Re-run the installer/EXE now for a clean install."})
