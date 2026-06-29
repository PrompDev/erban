# Erban corner surface launcher.
#
# Opens a chromeless Chrome --app window pointed at the running Erban OpenClaw
# Control UI, parked in the bottom-right corner. This is the chat-and-status
# pane, not a window manager: it never moves any other app's windows. Not --kiosk.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File launch-surface.ps1
#   ...optional: -Profile erban -Width 440 -Height 760 -RemoteDebugPort 9222

param(
  [string]$Root = "",        # install root (C:\OpenClawBusiness). The installer passes this; config lives under $Root\profile.
  [string]$NodePath = "",    # node.exe the installer resolved (Scheduled-Task PATH may not include it).
  [string]$Profile = "erban",
  [int]$Width = 440,
  [int]$Height = 760,
  [int]$Margin = 8,
  [int]$RemoteDebugPort = 0,  # 0 = off; set (e.g. 9222) to allow inspection
  [switch]$Reset             # clear the saved name (workspace + cache) and re-run first-run
)
$ErrorActionPreference = "Stop"

# Debug timer: a stopwatch + launch epoch so we can see real "click -> ready" latency.
# Each phase is echoed to the console (when run from a terminal) and appended to
# launch.log (so a hidden pin launch is still inspectable after the fact).
$sw  = [System.Diagnostics.Stopwatch]::StartNew()
$t0  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$logFile = Join-Path $env:LOCALAPPDATA "Erban\launch.log"
New-Item -ItemType Directory -Force -Path (Split-Path $logFile -Parent) | Out-Null
function T($msg) {
  $line = "{0,7}ms  {1}" -f $sw.ElapsedMilliseconds, $msg
  Write-Output $line
  try { Add-Content -Path $logFile -Value ("[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $line) -ErrorAction SilentlyContinue } catch {}
}
T "launch start (pid $PID)"

# Resolve node (Scheduled-Task PATH may not include it). Prefer the path the installer
# resolved; fall back to the default install location, then bare "node" on PATH.
$node = if ($NodePath -and (Test-Path $NodePath)) { $NodePath } else { "C:\Program Files\nodejs\node.exe" }
if (-not (Test-Path $node)) { $node = "node" }

# Taskbar identity. A Chrome --app window has no stable identity, so a pinned one
# falls back to the generic Chrome icon and the pin breaks on relaunch. We stamp the
# window with an explicit AppUserModelID + relaunch command + our .ico (built by
# make-icon.ps1) so the pin keeps the Erban logo and reopens the app, not bare Chrome.
$iconPath    = Join-Path $env:LOCALAPPDATA "Erban\erban.ico"
$aumid       = "Erban.Surface"
$displayName = "Erban"
$psExe       = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$relaunchCmd = "`"$psExe`" -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""

# Workspace = server-side source of truth for the assistant name. Prefer the install
# root's bundle copy ($Root\app\agent\workspace) when the installer passed -Root; else
# derive it from this script's location (works when run from the extracted bundle or dev).
$wsDir = if ($Root -and (Test-Path (Join-Path $Root "app\agent\workspace"))) { Join-Path $Root "app\agent\workspace" }
         else { Join-Path (Split-Path $PSScriptRoot -Parent) "agent\workspace" }
# Hand the workspace to every node child we spawn (the identity helper + provider-auth),
# so they write the name/provider HERE and not their hardcoded dev fallback path.
$env:ERBAN_WORKSPACE = $wsDir
# Self-contained Claude config home (matches the gateway's CLAUDE_CONFIG_DIR), so the
# one-click sign-in (provider-auth.mjs -> `claude setup-token`) writes the login where
# the gateway reads it. Only in an installed layout; dev runs use the default ~/.claude.
if ($Root) { $env:CLAUDE_CONFIG_DIR = Join-Path $Root "claude" }
# Claude Code on Windows shells out to bash and refuses to run without it (or PowerShell 7), so the
# one-click sign-in (provider-auth.mjs -> `claude setup-token`) needs a bash on CLAUDE_CODE_GIT_BASH_PATH.
# The installer installs Git for Windows; resolve bash.exe here so the identity-service child we spawn
# below inherits it. (The installer also pins this in the user env + gateway.cmd; this is the fallback.)
if (-not $env:CLAUDE_CODE_GIT_BASH_PATH) {
  $gitBash = @(
    "$env:ProgramFiles\Git\bin\bash.exe",
    "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
    "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($gitBash) { $env:CLAUDE_CODE_GIT_BASH_PATH = $gitBash }
}
$idJson = Join-Path $wsDir "erban-identity.json"
$idMd   = Join-Path $wsDir "IDENTITY.md"
# Active model-provider marker, written by the first-run sign-in (provider-auth.mjs).
# Its presence (plus a name) is what tells the surface setup is complete.
$provJson = Join-Path $wsDir "erban-provider.json"

# Ensure the identity helper (WebSocket on :8766) is running.
$idPort = 8766
$idUp = [bool](Get-NetTCPConnection -LocalPort $idPort -State Listen -ErrorAction SilentlyContinue)
if (-not $idUp) {
  $idServer = Join-Path $PSScriptRoot "identity-service\server.mjs"
  if (Test-Path $idServer) { Start-Process -FilePath $node -ArgumentList @($idServer) -WindowStyle Hidden | Out-Null; Start-Sleep -Milliseconds 700 }
}

# -Reset: clear the name from the workspace AND the browser cache, then re-trigger first-run.
if ($Reset) {
  if (Test-Path $wsDir) {
    Set-Content -Path $idJson -Encoding utf8 -Value '{ "name": null }'
    $emptyMd = @(
      '# IDENTITY.md - Who Am I?', '',
      '- **Name:**', '  _(not set yet - the owner names you on first run)_',
      '- **Role:** A helpful assistant living on the owner''s PC (the erban / OpenClaw corner box).', '',
      'You have not been named yet. When the owner names you on the first-run screen, that name',
      'becomes your identity and you should refer to yourself by it from then on.'
    ) -join "`n"
    Set-Content -Path $idMd -Encoding utf8 -Value $emptyMd
    Remove-Item -Path $provJson -Force -ErrorAction SilentlyContinue
    # Clear the canonical SQLite store too (name + provider live here now), incl.
    # its WAL sidecars, so reset really starts over and the DB can't resurrect the
    # old name. The identity helper recreates an empty db.mjs store on next launch.
    Get-ChildItem -Path $wsDir -Filter "erban-config.db*" -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*Erban\chrome-surface*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
  Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA "Erban\chrome-surface") -ErrorAction SilentlyContinue
  Write-Output "Erban: name + provider reset (workspace + localStorage cache cleared); first-run sign-in will show on launch."
}

# 1. Detect the running Erban gateway dashboard URL at runtime (port + token from its config).
# The self-contained Windows installer writes config to $Root\profile\openclaw.json; the
# dev/macOS layout uses ~/.openclaw-$Profile. Prefer the install root, fall back to the profile dir.
$cfgPath = if ($Root -and (Test-Path (Join-Path $Root "profile\openclaw.json"))) { Join-Path $Root "profile\openclaw.json" }
           else { Join-Path $env:USERPROFILE ".openclaw-$Profile\openclaw.json" }
if (-not (Test-Path $cfgPath)) { throw "Erban config not found: $cfgPath" }
$cfg = Get-Content -Raw $cfgPath | ConvertFrom-Json
$port = $cfg.gateway.port
$token = $cfg.gateway.auth.token
if (-not $port) { throw "gateway.port missing in $cfgPath" }

# 1b. Make sure the gateway is up. Normally it's already running (it starts at logon and
# self-restarts), so this is a no-op and the window opens instantly. If it's down we kick
# the service but DON'T block on it - opening the window is the priority; the Control UI
# reconnects by itself the moment the gateway binds the port.
$up = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($up) {
  T "gateway already up on :$port"
} else {
  # The Windows installer registers 'OpenClaw Business Gateway'; the dev/macOS layout used
  # 'OpenClaw Gateway (erban)'. Kick whichever exists.
  $gwTask = @("OpenClaw Business Gateway", "OpenClaw Gateway ($Profile)") |
            Where-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
  if ($gwTask) {
    Start-ScheduledTask -TaskName $gwTask
    T "gateway was down; kicked '$gwTask' (UI reconnects when it binds)"
  } else {
    T "gateway down; no gateway task found"
  }
}
$base = "http://127.0.0.1:$port/"
# erbanT0 (query) feeds the in-window debug badge; token stays in the hash where the app reads it.
$url  = if ($token) { "$base`?erbanT0=$t0#token=$token" } else { "$base`?erbanT0=$t0" }

# 3. Compute the bottom-right geometry from the primary screen's work area (excludes the taskbar).
Add-Type -AssemblyName System.Windows.Forms
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$w = [Math]::Min($Width,  $wa.Width  - (2 * $Margin))
$h = [Math]::Min($Height, $wa.Height - (2 * $Margin))
$posX = $wa.Right  - $w - $Margin
$posY = $wa.Bottom - $h - $Margin

# 4. Locate Chrome.
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw "Chrome not found." }

# 5. Dedicated, persistent profile dir (clean window, and an identifier the watchdog can match on).
$udd = Join-Path $env:LOCALAPPDATA "Erban\chrome-surface"
New-Item -ItemType Directory -Force -Path $udd | Out-Null

# 6. Launch the chromeless app window. The --window-* flags are passed as a hint,
#    but Chrome's --app mode often ignores --window-size, so we also force the exact
#    rect with MoveWindow once the window exists. This only touches OUR window.
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class ErbanWin {
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hgt, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@ -ErrorAction SilentlyContinue

# Window->taskbar identity via the Shell property store. Setting these four
# AppUserModel properties on the HWND makes a pinned window keep our icon and
# relaunch through us (so the relaunched window groups under the same pin).
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ErbanPin {
  [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Sequential)] struct PROPVARIANT { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out uint c);
    int GetAt(uint i, out PROPERTYKEY k);
    int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
    int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
    int Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid riid, out IPropertyStore pps);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pv);
  static readonly Guid APP = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
  const ushort VT_LPWSTR = 31;
  static void Set(IPropertyStore s, uint pid, string val) {
    PROPERTYKEY k = new PROPERTYKEY(); k.fmtid = APP; k.pid = pid;
    PROPVARIANT v = new PROPVARIANT(); v.vt = VT_LPWSTR; v.p = Marshal.StringToCoTaskMemUni(val);
    int hr = s.SetValue(ref k, ref v);
    PropVariantClear(ref v);
    if (hr != 0) throw new Exception("SetValue(" + pid + ") hr=" + hr);
  }
  public static void Stamp(IntPtr hwnd, string aumid, string relaunch, string icon, string name) {
    Guid iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    int hr = SHGetPropertyStoreForWindow(hwnd, ref iid, out store);
    if (hr != 0 || store == null) throw new Exception("SHGetPropertyStoreForWindow hr=" + hr);
    Set(store, 5, aumid);     // PKEY_AppUserModel_ID
    Set(store, 2, relaunch);  // PKEY_AppUserModel_RelaunchCommand
    Set(store, 3, icon);      // PKEY_AppUserModel_RelaunchIconResource  ("path,0")
    Set(store, 4, name);      // PKEY_AppUserModel_RelaunchDisplayNameResource
    store.Commit();
    Marshal.ReleaseComObject(store);
  }
}
"@ -ErrorAction SilentlyContinue

# If a surface window is already open, focus it instead of stacking duplicates
# (a pin click should behave like a normal app: bring the one window forward).
if (-not $Reset) {
  $existing = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
              Where-Object { $_.CommandLine -like '*Erban\chrome-surface*' -and $_.CommandLine -like '*--app=*' }
  foreach ($e in $existing) {
    $p = Get-Process -Id $e.ProcessId -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
      [void][ErbanWin]::SetForegroundWindow($p.MainWindowHandle)
      T "focused existing window (reused, total $($sw.ElapsedMilliseconds)ms)"
      [PSCustomObject]@{ pid = $p.Id; url = $url; gatewayUp = $up; reused = $true; elapsedMs = $sw.ElapsedMilliseconds } | Format-List
      return
    }
  }
}

$chromeArgs = @(
  "--app=$url",
  "--window-position=$posX,$posY",
  "--window-size=$w,$h",
  "--user-data-dir=$udd",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-session-crashed-bubble",
  "--disable-features=Translate"
)
if ($RemoteDebugPort -gt 0) { $chromeArgs += "--remote-debugging-port=$RemoteDebugPort" }

$proc = Start-Process -FilePath $chrome -ArgumentList $chromeArgs -PassThru
T "chrome spawned (pid $($proc.Id))"

# Wait for the Control UI window.
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 60 -and $hwnd -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 250
  $win = Get-Process chrome -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowTitle -like '*OpenClaw*' } | Select-Object -First 1
  if ($win) { $hwnd = $win.MainWindowHandle }
}
T "window appeared"

# Stamp the taskbar identity IMMEDIATELY, before parking. Explorer decides how to group a
# window very soon after it appears, so stamping the AppUserModelID now (not after the ~7s
# parking dance) is what makes the live window merge into the Erban pin and show the running
# indicator. It also keeps the Erban logo and relaunches through us.
$iconStamped = $false
if ($hwnd -ne [IntPtr]::Zero -and (Test-Path $iconPath)) {
  try { [ErbanPin]::Stamp($hwnd, $aumid, $relaunchCmd, "$iconPath,0", $displayName); $iconStamped = $true; T "taskbar identity stamped (aumid=$aumid)" }
  catch { Write-Warning "Could not stamp taskbar identity: $($_.Exception.Message)" }
} elseif (-not (Test-Path $iconPath)) {
  Write-Warning "Icon not found at $iconPath - run make-icon.ps1 first; pin will use the default icon."
}

# Chrome's --app window resizes itself shortly after creation, so re-assert the
# rect a few times until it sticks.
$parked = $false
if ($hwnd -ne [IntPtr]::Zero) {
  for ($k = 0; $k -lt 6 -and -not $parked; $k++) {
    [void][ErbanWin]::MoveWindow($hwnd, $posX, $posY, $w, $h, $true)
    Start-Sleep -Milliseconds 1200
    $r = New-Object ErbanWin+RECT
    [void][ErbanWin]::GetWindowRect($hwnd, [ref]$r)
    if ($r.L -eq $posX -and $r.T -eq $posY -and ($r.R - $r.L) -eq $w -and ($r.B - $r.T) -eq $h) { $parked = $true }
  }
  [void][ErbanWin]::SetForegroundWindow($hwnd)
}
T "parked=$parked  DONE (total $($sw.ElapsedMilliseconds)ms)"

# Surface the signed-in provider (if any) in the launch summary.
$activeProvider = $null
try { if (Test-Path $provJson) { $activeProvider = (Get-Content -Raw $provJson | ConvertFrom-Json).provider } } catch {}

[PSCustomObject]@{
  pid            = $proc.Id
  url            = $url
  gatewayUp      = $up
  activeProvider = $activeProvider
  position       = "$posX,$posY"
  size           = "${w}x${h}"
  parked         = $parked
  aumid          = $aumid
  iconStamped    = $iconStamped
  elapsedMs      = $sw.ElapsedMilliseconds
  logFile        = $logFile
  userData       = $udd
} | Format-List
