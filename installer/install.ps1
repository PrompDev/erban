# OpenClaw for Business - one-click installer (Windows).
#   irm https://erban.xyz/install.ps1 | iex        (one-liner)
#   ...or run OpenClaw-for-Business-Setup.exe       (1-click)
#
# Installs OpenClaw (which installs Node) and sets it up ENTIRELY under one folder
# (default C:\OpenClawBusiness). A friendly animated window opens INSTANTLY and
# shows a clean 4-step checklist.
#
# Switches:  -NoUi (console only)   -Demo (UI with simulated steps)   -NoElevate (testing)

param(
  [string]$InstallRoot = 'C:\OpenClawBusiness',
  [string]$Base = 'https://erban.xyz',
  [switch]$NoUi,
  [switch]$Demo,
  [switch]$NoElevate
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# Run elevated (create the folder, register auto-start, pre-authorise the firewall) -
# one UAC, no mid-install failures. The .exe already requests admin; this covers the one-liner.
if (-not $Demo -and -not $NoElevate) {
  $isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
  if (-not $isAdmin) {
    try { Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-Command',"irm $Base/install.ps1 | iex" -ErrorAction Stop } catch {}
    return
  }
}

# ---- Resolve install root (fall back off C:\ root if not writable) ------------------
$rootFellBack = $false
function Initialize-Root([string]$root) {
  New-Item -ItemType Directory -Force -Path $root -ErrorAction Stop | Out-Null
  $probe = Join-Path $root ('.w_' + [Guid]::NewGuid().ToString('N').Substring(0,6))
  Set-Content -Path $probe -Value 'x' -ErrorAction Stop; Remove-Item $probe -Force -ErrorAction SilentlyContinue
}
try { Initialize-Root $InstallRoot } catch { $InstallRoot = Join-Path $env:USERPROFILE 'OpenClaw Business'; Initialize-Root $InstallRoot; $rootFellBack = $true }
$AppDir=Join-Path $InstallRoot 'app'; $ProfileDir=Join-Path $InstallRoot 'profile'
$BrowserDir=Join-Path $InstallRoot 'browser'; $LogDir=Join-Path $InstallRoot 'logs'; $UiDir=Join-Path $InstallRoot 'ui'
# Self-contained Claude config home (settings/hooks/transcripts/login) - persistent,
# NOT under app/ (which is wiped on every reinstall), so the user's sign-in survives.
$ClaudeDir=Join-Path $InstallRoot 'claude'
New-Item -ItemType Directory -Force -Path $AppDir,$ProfileDir,$BrowserDir,$LogDir,$UiDir,$ClaudeDir | Out-Null
$Log = Join-Path $LogDir 'install.log'
"=== install $([DateTime]::Now.ToString('s')) root=$InstallRoot demo=$($Demo.IsPresent) ===" | Set-Content -Path $Log -Encoding utf8

# ---- Pick the browser: the user's default if it's Chrome/Edge, else Chrome then Edge -
function Get-DefaultChromium {
  $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe","${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe","$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe","$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  $progId = ''
  try { $progId = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice' -Name ProgId -ErrorAction Stop).ProgId } catch {}
  if ($progId -match 'Chrome' -and $chrome) { return $chrome }
  if ($progId -match 'Edge|MSEdge' -and $edge) { return $edge }
  if ($chrome) { return $chrome }   # default is neither -> Chrome first
  return $edge                      # then Edge
}

# ---- Embedded UI (written instantly - no download, so the window opens straight away) -
$UI_HTML = @'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenClaw for Business - setting up</title>
<style>
  :root{
    --bg:#0a0b0f; --bg2:#0c0e13; --ink:#ECEDF1; --muted:#8b8f9c; --dim:#5256617f;
    --red:#d8453a; --red2:#e2554a; --ok:#5fcf86;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    --mono:ui-monospace,"Cascadia Code","Consolas",monospace;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:radial-gradient(120% 90% at 50% -10%,#15121a 0%,var(--bg2) 45%,var(--bg) 100%);
       color:var(--ink);font-family:var(--sans);overflow:hidden;display:flex;align-items:center;justify-content:center;text-align:center}
  .aurora{position:fixed;inset:-20%;z-index:0;filter:blur(80px);opacity:.5;pointer-events:none}
  .aurora i{position:absolute;border-radius:50%;mix-blend-mode:screen;opacity:.13}
  .aurora i:nth-child(1){width:46vw;height:46vw;left:6%;top:4%;background:radial-gradient(circle,#d8453a,transparent 60%);animation:a1 26s ease-in-out infinite}
  .aurora i:nth-child(2){width:40vw;height:40vw;right:2%;top:34%;background:radial-gradient(circle,#a83bd8,transparent 60%);animation:a2 34s ease-in-out infinite}
  @keyframes a1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(6%,4%) scale(1.12)}}
  @keyframes a2{0%,100%{transform:translate(0,0) scale(1.05)}50%{transform:translate(-5%,6%) scale(.95)}}
  canvas#stars{position:fixed;inset:0;z-index:1;pointer-events:none}

  .wrap{position:relative;z-index:2;width:100%;max-width:440px;padding:36px 40px;display:flex;flex-direction:column;align-items:center}
  .brand{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);font-weight:600;margin-bottom:24px}
  .brand b{color:var(--ink)}

  .stage{width:120px;height:120px;position:relative}
  .glow{position:absolute;inset:-30%;border-radius:50%;background:radial-gradient(circle,rgba(216,69,58,.55),transparent 60%);filter:blur(15px);animation:pulse 3.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.5;transform:scale(.92)}50%{opacity:.95;transform:scale(1.06)}}
  .mascot{position:absolute;inset:0;animation:bob 3.4s ease-in-out infinite}
  .mascot svg{width:100%;height:100%;display:block;filter:drop-shadow(0 6px 18px rgba(216,69,58,.35))}
  @keyframes bob{0%,100%{transform:translateY(0) rotate(-1.5deg)}50%{transform:translateY(-8px) rotate(1.5deg)}}
  body.done .mascot{animation:hop .9s ease 3}
  @keyframes hop{0%,100%{transform:translateY(0)}40%{transform:translateY(-15px)}}

  .phase{margin:24px 0 3px;font-size:19px;font-weight:650;line-height:1.4;min-height:26px;max-width:360px}
  body.done .phase{color:var(--ok)} body.err .phase{color:var(--red2)}
  .activity{font-family:var(--mono);font-size:11.5px;color:var(--muted);height:16px;overflow:hidden;opacity:.85;max-width:330px;white-space:nowrap;text-overflow:ellipsis}

  .barwrap{width:300px;margin:20px 0 6px}
  .bar{height:5px;border-radius:99px;background:rgba(236,237,241,.08);overflow:hidden}
  .bar > i{display:block;height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,var(--red),var(--red2));transition:width .5s cubic-bezier(.2,.7,.2,1)}
  .meta{display:flex;justify-content:center;gap:16px;margin-top:9px;font-family:var(--mono);font-size:11px;color:var(--muted)}
  .meta b{color:var(--ink);font-weight:600}

  .list{margin:24px 0 0;display:flex;flex-direction:column;gap:16px}
  .item{display:flex;align-items:center;justify-content:center;gap:12px;font-size:15px;color:var(--dim);transition:color .35s}
  .item .mark{flex:none;width:22px;height:22px;border-radius:50%;border:2px solid #2b2f3a;display:grid;place-items:center;font-size:12px;color:transparent;transition:all .35s}
  .item.active{color:var(--ink)}
  .item.active .mark{border-color:var(--red2);box-shadow:0 0 0 4px rgba(216,69,58,.13)}
  .item.active .mark::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--red2);animation:blip 1s ease-in-out infinite}
  @keyframes blip{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
  .item.done{color:var(--ink)}
  .item.done .mark{border-color:var(--ok);background:var(--ok);color:#0a0b0f}
  .item.done .mark::after{content:"\2713"}
  .item.failed .mark{border-color:var(--red2);background:var(--red2);color:#0a0b0f}
  .item.failed .mark::after{content:"\2715"}
  .item .lab{display:flex;flex-direction:column;align-items:flex-start;text-align:left}
  .item .sub{font-size:11px;color:var(--muted);margin-top:1px}
</style>
</head>
<body>
  <div class="aurora"><i></i><i></i></div>
  <canvas id="stars"></canvas>
  <div class="wrap">
    <div class="brand">OpenClaw <b>for Business</b></div>
    <div class="stage">
      <div class="glow"></div>
      <div class="mascot">
        <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs><linearGradient id="lg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs>
          <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#lg)"/>
          <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill="url(#lg)"/>
          <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill="url(#lg)"/>
          <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round"/>
          <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round"/>
          <circle cx="45" cy="35" r="6" fill="#050810"/><circle cx="75" cy="35" r="6" fill="#050810"/>
          <circle cx="46" cy="34" r="2.5" fill="#00e5cc"/><circle cx="76" cy="34" r="2.5" fill="#00e5cc"/>
        </svg>
      </div>
    </div>

    <div class="phase" id="phase">Getting started...</div>
    <div class="activity" id="activity"></div>

    <div class="barwrap">
      <div class="bar"><i id="bar"></i></div>
      <div class="meta"><span><b id="pct">0%</b></span><span id="elapsed">0:00</span><span id="eta">getting ready</span></div>
    </div>

    <div class="list" id="list">
      <div class="item" data-i="0"><span class="mark"></span><span class="lab"><span>Checking your machine</span></span></div>
      <div class="item" data-i="1"><span class="mark"></span><span class="lab"><span>Installing the essentials</span><span class="sub">the big step - a few minutes</span></span></div>
      <div class="item" data-i="2"><span class="mark"></span><span class="lab"><span>Setting up your assistant</span></span></div>
      <div class="item" data-i="3"><span class="mark"></span><span class="lab"><span>Opening it up</span></span></div>
    </div>
  </div>

<script>
  var items=[].slice.call(document.querySelectorAll('.item')),
      phaseEl=document.getElementById('phase'), actEl=document.getElementById('activity'),
      barEl=document.getElementById('bar'), pctEl=document.getElementById('pct'),
      elEl=document.getElementById('elapsed'), etaEl=document.getElementById('eta'),
      finished=false, started=Date.now(), step=0, stepStart=Date.now();

  // progress ranges per step: [startPct, endPct, secondsToCreep]
  var R={0:[3,14,8], 1:[15,67,170], 2:[69,89,22], 3:[91,99,10]};
  var ETAS={0:'about 3-5 min',1:'about 2-4 min',2:'almost there',3:'almost there'};
  var FILES=['fetching node-v24-win-x64.zip','extracting runtime...','linking openclaw -> npm global',
    'node_modules/openclaw/dist/index.js','node_modules/openclaw/dist/gateway.js','node_modules/ws/index.js',
    'node_modules/@lit/reactive-element','writing package metadata','node_modules/zod/lib/index.js',
    'node_modules/openclaw/dist/control-ui','verifying checksums...','node_modules/commander/index.js',
    'node_modules/openclaw/dist/agent-runtime.js','resolving dependencies','node_modules/undici/index.js',
    'compiling control surface','node_modules/openclaw/skills','finalising install...'];

  function mmss(ms){var s=Math.floor(ms/1000);return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2);}
  function render(){
    var err=document.body.classList.contains('err');
    items.forEach(function(el){var i=+el.dataset.i;el.classList.remove('active','done','failed');
      if(finished && !err){el.classList.add('done');}
      else if(finished && err){ if(i<step){el.classList.add('done');} else if(i===step){el.classList.add('failed');} }
      else if(i<step){el.classList.add('done');}
      else if(i===step){el.classList.add('active');}});
  }
  function tick(){
    elEl.textContent=mmss(Date.now()-started);
    if(finished){ barEl.style.width='100%'; pctEl.textContent='100%'; etaEl.textContent='done'; return; }
    var r=R[step]||R[3]; var f=Math.min(1,(Date.now()-stepStart)/(r[2]*1000));
    var p=Math.round(r[0]+(r[1]-r[0])*f); barEl.style.width=p+'%'; pctEl.textContent=p+'%'; etaEl.textContent=ETAS[step]||'';
    // file scroll only during the "essentials" step
    if(step===1){ actEl.style.visibility='visible'; if(Math.random()<0.5) actEl.textContent=FILES[Math.floor(Math.random()*FILES.length)]; }
    else { actEl.textContent=''; }
  }
  setInterval(tick,140);

  // canvas starfield
  var c=document.getElementById('stars'),x=c.getContext('2d'),st=[];
  function sz(){c.width=innerWidth;c.height=innerHeight;} sz(); addEventListener('resize',sz);
  for(var i=0;i<80;i++){st.push({x:Math.random(),y:Math.random(),r:Math.random()*1.2+.2,p:Math.random()*6.28,s:Math.random()*0.014+0.004});}
  (function loop(){x.clearRect(0,0,c.width,c.height);for(var i=0;i<st.length;i++){var s=st[i];s.p+=s.s;x.globalAlpha=.3+.5*(0.5+0.5*Math.sin(s.p));x.fillStyle='#dfe3ff';x.beginPath();x.arc(s.x*c.width,s.y*c.height,s.r,0,6.28);x.fill();}requestAnimationFrame(loop);})();

  function poll(){
    fetch('/status',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
      if(d.phase) phaseEl.textContent=d.phase;
      if(typeof d.step==='number' && d.step!==step){ step=d.step; stepStart=Date.now(); }
      render();
      if(d.done && !finished){ finished=true;
        if(d.error){ document.body.classList.add('err'); phaseEl.textContent='Hit a snag - '+d.error; actEl.textContent=''; }
        else { document.body.classList.add('done'); phaseEl.textContent='All set - name your assistant'; actEl.textContent=''; }
        render();
      }
    }).catch(function(){}).finally(function(){ setTimeout(poll, finished?2000:350); });
  }
  poll();
</script>
</body>
</html>
'@
Set-Content -Path (Join-Path $UiDir 'installer.html') -Value $UI_HTML -Encoding utf8
$uiHtml = Join-Path $UiDir 'installer.html'

# ---- Shared status state (the UI polls /status) ------------------------------------
$state = [hashtable]::Synchronized(@{ step=0; phase='Getting started...'; pct=0; done=$false; ok=$false; error=$null; root=$InstallRoot; fellBack=$rootFellBack })

# ---- The install engine (background runspace) --------------------------------------
$engine = {
  param($ctx)
  $ErrorActionPreference='Stop'
  $s=$ctx.state
  function Log($m){ try{ Add-Content -Path $ctx.log -Value "$([DateTime]::Now.ToString('HH:mm:ss'))  $m" }catch{}; if($ctx.noui){ Write-Host $m } }
  function Step($i,$phase,$pct){ [System.Threading.Monitor]::Enter($s.SyncRoot); try{ $s.step=$i; $s.phase=$phase; if($null -ne $pct){$s.pct=[int]$pct} }finally{ [System.Threading.Monitor]::Exit($s.SyncRoot) }; Log "STEP$i $phase" }
  function Finish($ok,$err){ [System.Threading.Monitor]::Enter($s.SyncRoot); try{ if($ok){$s.step=4;$s.phase='All set - name your assistant';$s.pct=100;$s.ok=$true} else {$s.error=$err}; $s.done=$true }finally{ [System.Threading.Monitor]::Exit($s.SyncRoot) }; Log "FINISH ok=$ok $err" }
  try {
    if ($ctx.demo) {
      Step 0 'Getting to know your machine...' 8;  Start-Sleep 2
      Step 1 'Installing the essentials - hang tight...' 25; Start-Sleep 4
      Step 2 'Setting up your assistant...' 70; Start-Sleep 3
      Step 3 'Opening your assistant...' 95; Start-Sleep 2
      Finish $true; return
    }
    # 0 - machine + connectivity
    Step 0 'Getting to know your machine...' 6
    Log ("OS: " + (Get-CimInstance Win32_OperatingSystem).Caption + " arch=$env:PROCESSOR_ARCHITECTURE")
    $reach=$false; foreach($t in 1..3){ try{ Invoke-WebRequest -Uri "$($ctx.base)/install.ps1" -Method Head -TimeoutSec 12 -UseBasicParsing|Out-Null; $reach=$true; break }catch{ Log "net retry $t"; Start-Sleep 2 } }
    if(-not $reach){ throw 'no internet - connect and run again' }

    # 1 - the essentials: Node + OpenClaw, installed directly (no opaque upstream
    #     installer that can hang on a hidden prompt). Every external step is timed out.
    Step 1 'Installing the essentials - this is the slow bit, hang tight...' 15
    function RunTimed($file,$argList,$sec,$so,$se){
      $p=Start-Process -FilePath $file -ArgumentList $argList -PassThru -WindowStyle Hidden -RedirectStandardOutput $so -RedirectStandardError $se
      $deadline=(Get-Date).AddSeconds($sec)
      while(-not $p.HasExited){ if((Get-Date) -gt $deadline){ try{ $p.Kill() }catch{}; throw "a setup step took too long (>$sec s) and was stopped" }; Start-Sleep -Milliseconds 500 }
      try{ $p.WaitForExit() }catch{}                 # cache the real exit code: PassThru without -Wait can leave .ExitCode $null
      $code=$null; try{ $code=$p.ExitCode }catch{}
      if($null -eq $code){ return -1 }               # unknown -> let the caller verify by presence
      return [int]$code
    }
    $node=(Get-Command node -ErrorAction SilentlyContinue).Source
    if(-not $node -and (Test-Path 'C:\Program Files\nodejs\node.exe')){ $node='C:\Program Files\nodejs\node.exe' }
    if(-not $node){
      Step 1 'Downloading Node (the runtime)...' 22
      $ver='v24.9.0'
      try{ $idx=Invoke-RestMethod 'https://nodejs.org/dist/index.json' -TimeoutSec 25; $l=($idx|Where-Object{$_.version -like 'v24.*'}|Select-Object -First 1); if($l){$ver=$l.version} }catch{ Log "node index fallback: $($_.Exception.Message)" }
      $msiUrl="https://nodejs.org/dist/$ver/node-$ver-x64.msi"; $msi=Join-Path $ctx.logs 'node.msi'
      Log "downloading $msiUrl"
      Invoke-WebRequest $msiUrl -OutFile $msi -UseBasicParsing -TimeoutSec 300
      Step 1 'Installing Node...' 38
      $ec=RunTimed 'msiexec.exe' @('/i',"`"$msi`"",'/qn','/norestart') 300 (Join-Path $ctx.logs 'node-msi.out') (Join-Path $ctx.logs 'node-msi.err')
      if($ec -ne 0 -and $ec -ne 3010){ Log "node msi exit=$ec - not trusting exit code, will verify Node by presence" }
      $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')
      $node=(Get-Command node -ErrorAction SilentlyContinue).Source
      if(-not $node -and (Test-Path 'C:\Program Files\nodejs\node.exe')){ $node='C:\Program Files\nodejs\node.exe' }
    }
    if(-not $node){ throw 'Node did not install' }
    Log "node=$node ($(& $node --version 2>&1))"
    $npm=Join-Path (Split-Path $node) 'npm.cmd'; if(-not (Test-Path $npm)){ $npm='npm.cmd' }
    if((Get-Command openclaw -ErrorAction SilentlyContinue) -or (Test-Path "$env:APPDATA\npm\openclaw.cmd")){ Log 'openclaw already present' }
    else {
      Step 1 'Installing OpenClaw (almost there)...' 52
      $ec=RunTimed $npm @('install','-g','openclaw') 420 (Join-Path $ctx.logs 'npm.out') (Join-Path $ctx.logs 'npm.err')
      if($ec -ne 0 -and $ec -ne 3010){ Log "npm exit=$ec - not trusting exit code, will verify OpenClaw by presence (see logs\npm.err)" }
      Log 'openclaw installed via npm'
    }
    $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')
    $oc=Get-Command openclaw -ErrorAction SilentlyContinue
    if(-not $oc){ $c="$env:APPDATA\npm\openclaw.cmd"; if(Test-Path $c){ $env:Path+=';'+(Split-Path $c); $oc=Get-Command openclaw -ErrorAction SilentlyContinue } }
    if(-not $oc -and -not (Test-Path "$env:APPDATA\npm\openclaw.cmd")){ throw 'OpenClaw installed but not found on PATH' }
    $ocIndex=$null
    try{ $gr=(& $npm root -g 2>$null); if($gr){ $c=Join-Path ($gr|Select-Object -Last 1) 'openclaw\dist\index.js'; if(Test-Path $c){$ocIndex=$c} } }catch{}
    if(-not $ocIndex){ $c="$env:APPDATA\npm\node_modules\openclaw\dist\index.js"; if(Test-Path $c){$ocIndex=$c} }
    if(-not $ocIndex){ Log 'WARNING: openclaw index.js not located; will use the openclaw shim' }
    Log "node=$node ocIndex=$ocIndex"

    # 1c - ensure Chrome: the corner box runs in Chrome so its --app window shows OUR icon on the
    #      taskbar. Edge --app brands the taskbar button with the Edge icon and ignores the favicon.
    $chromeExe=@("$env:ProgramFiles\Google\Chrome\Application\chrome.exe","${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe","$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")|Where-Object{Test-Path $_}|Select-Object -First 1
    if(-not $chromeExe){
      Step 1 'Installing Chrome (for a clean app window)...' 64
      try{
        $cmsi=Join-Path $ctx.logs 'chrome.msi'
        Invoke-WebRequest 'https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise64.msi' -OutFile $cmsi -UseBasicParsing -TimeoutSec 600
        $ec=RunTimed 'msiexec.exe' @('/i',"`"$cmsi`"",'/qn','/norestart') 420 (Join-Path $ctx.logs 'chrome-msi.out') (Join-Path $ctx.logs 'chrome-msi.err')
        if($ec -ne 0 -and $ec -ne 3010){ Log "chrome msi exit=$ec (continuing; box falls back to Edge if Chrome absent)" }
        Remove-Item $cmsi -Force -ErrorAction SilentlyContinue; Log 'chrome install attempted'
      }catch{ Log "chrome install skipped: $($_.Exception.Message)" }
    } else { Log "chrome present: $chromeExe" }

    # 1d - install the Claude engine (OpenClaw runs the agent through the claude CLI backend).
    if(-not (Get-Command claude -ErrorAction SilentlyContinue) -and -not (Test-Path "$env:USERPROFILE\.local\bin\claude.exe")){
      Step 1 'Installing the Claude engine...' 58
      $ec=RunTimed $npm @('install','-g','@anthropic-ai/claude-code') 420 (Join-Path $ctx.logs 'claude.out') (Join-Path $ctx.logs 'claude.err')
      if($ec -ne 0 -and $ec -ne 3010){ Log "claude npm exit=$ec - verifying by presence (logs\claude.err)" }
      $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')
      Log 'claude CLI installed'
    } else { Log 'claude CLI already present' }

    # 2 - set everything up
    Step 2 'Setting up your assistant...' 60
    $zip=Join-Path $ctx.logs 'erban-assets.zip'
    Invoke-WebRequest -Uri "$($ctx.base)/erban-assets.zip" -OutFile $zip -UseBasicParsing
    if(Test-Path $ctx.app){ Remove-Item $ctx.app -Recurse -Force }; New-Item -ItemType Directory -Force $ctx.app|Out-Null
    Expand-Archive -Path $zip -DestinationPath $ctx.app -Force; Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Log 'bundle extracted'
    $controlUi=(Join-Path $ctx.app 'surface\control-ui') -replace '\\','/'
    $launcher=Join-Path $ctx.app 'surface\launch-surface.ps1'
    $workspace=Join-Path $ctx.app 'agent\workspace'
    $gw=18901; if(Get-NetTCPConnection -LocalPort $gw -State Listen -ErrorAction SilentlyContinue){ $gw=18920; while((Get-NetTCPConnection -LocalPort $gw -State Listen -ErrorAction SilentlyContinue) -and $gw -lt 18999){$gw++}; Log "port shifted to $gw" }
    $gwToken=-join (1..48|ForEach-Object{'0123456789abcdef'[(Get-Random -Maximum 16)]})
    $cfg=[ordered]@{
      agents=@{defaults=[ordered]@{workspace=$workspace;models=[ordered]@{'anthropic/claude-opus-4-8'=@{agentRuntime=@{id='claude-cli'}};'anthropic/claude-sonnet-4-6'=@{agentRuntime=@{id='claude-cli'}}};model=@{primary='anthropic/claude-opus-4-8'}}}
      gateway=[ordered]@{mode='local';port=$gw;bind='loopback';auth=@{mode='token';token=$gwToken};controlUi=@{root=$controlUi}}
      plugins=@{entries=@{anthropic=@{enabled=$true};'file-transfer'=@{enabled=$false};'memory-core'=@{enabled=$false}}}
    }
    $cfg|ConvertTo-Json -Depth 12|Set-Content (Join-Path $ctx.profile 'openclaw.json') -Encoding utf8
    $gwCmd=Join-Path $ctx.profile 'gateway.cmd'
    $gwExec= if($ocIndex){ "`"$node`" `"$ocIndex`" gateway --port $gw" } else { "`"$($oc.Source)`" gateway --port $gw" }
    @('@echo off',"set `"HOME=$env:USERPROFILE`"","set `"CLAUDE_CONFIG_DIR=$($ctx.claude)`"","set `"OPENCLAW_STATE_DIR=$($ctx.profile)`"","set `"OPENCLAW_CONFIG_PATH=$($ctx.profile)\openclaw.json`"",'set "OPENCLAW_PROFILE=erban"',"set `"OPENCLAW_GATEWAY_PORT=$gw`"","set `"ERBAN_WORKSPACE=$workspace`"",$gwExec) -join "`r`n" | Set-Content -Path $gwCmd -Encoding ascii
    # Self-contained Claude config: register the handover SessionStart hook in the
    # erban-local Claude home, so a freshly-rotated agent picks up the last handover
    # doc. CLAUDE_CONFIG_DIR (set above + in launch-surface + the wrapper below) keeps
    # the gateway, the sign-in, and the supervisor all pointed at the same Claude home.
    $hookScript=Join-Path $ctx.app 'surface\handover-service\session-start-hook.mjs'
    $claudeSettings=[ordered]@{ hooks=[ordered]@{ SessionStart=@( [ordered]@{ hooks=@( [ordered]@{ type='command'; command="`"$node`" `"$hookScript`"" } ) } ) } }
    $claudeSettings|ConvertTo-Json -Depth 8|Set-Content (Join-Path $ctx.claude 'settings.json') -Encoding utf8
    # Context-handover supervisor wrapper (same Claude home + workspace as the gateway).
    $hoCmd=Join-Path $ctx.profile 'erban-handover.cmd'
    $hoExec="`"$node`" `"$(Join-Path $ctx.app 'surface\handover-service\supervisor.mjs')`""
    @('@echo off',"set `"HOME=$env:USERPROFILE`"","set `"CLAUDE_CONFIG_DIR=$($ctx.claude)`"","set `"OPENCLAW_STATE_DIR=$($ctx.profile)`"","set `"OPENCLAW_CONFIG_PATH=$($ctx.profile)\openclaw.json`"","set `"ERBAN_WORKSPACE=$workspace`"",$hoExec) -join "`r`n" | Set-Content -Path $hoCmd -Encoding ascii
    $wd=Join-Path $ctx.app 'erban-watchdog.ps1'
    @('$ErrorActionPreference="SilentlyContinue"',"if(-not(Get-NetTCPConnection -LocalPort $gw -State Listen)){ Start-Process -FilePath `"$gwCmd`" -WindowStyle Hidden }","`$b=Get-CimInstance Win32_Process -Filter `"Name='chrome.exe' OR Name='msedge.exe'`" | Where-Object { `$_.CommandLine -like '*$($ctx.browser)*' }","if(-not `$b){ Start-ScheduledTask -TaskName 'OpenClaw Business Surface' }") -join "`r`n" | Set-Content -Path $wd -Encoding utf8
    try{ if(Get-NetFirewallRule -DisplayName 'OpenClaw Business (node)' -ErrorAction SilentlyContinue){ Log 'firewall rule already present' } else { New-NetFirewallRule -DisplayName 'OpenClaw Business (node)' -Direction Inbound -Program $node -Action Allow -Profile Any -ErrorAction Stop|Out-Null; Log 'firewall rule added' } }catch{ Log "firewall skipped: $($_.Exception.Message)" }
    $me=$env:USERNAME
    function RegTask($name,$action){ Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue; $pr=New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest; $tr=New-ScheduledTaskTrigger -AtLogOn -User $me; Register-ScheduledTask -TaskName $name -Action $action -Principal $pr -Trigger $tr -Force|Out-Null }
    try{ RegTask 'OpenClaw Business Gateway' (New-ScheduledTaskAction -Execute $gwCmd) }catch{ Log "gateway task skipped: $($_.Exception.Message)" }
    $surfArg="-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" -Root `"$($ctx.root)`" -NodePath `"$node`""
    try{ RegTask 'OpenClaw Business Surface' (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $surfArg) }catch{ Log "surface task skipped: $($_.Exception.Message)" }
    # Context-handover supervisor (observe-only until ERBAN_HANDOVER_LIVE=1; see surface/handover-service/DESIGN.md).
    try{ RegTask 'OpenClaw Business Handover' (New-ScheduledTaskAction -Execute $hoCmd) }catch{ Log "handover task skipped: $($_.Exception.Message)" }
    try{ $wdAct=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wd`""; $wdTr=New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(2)) -RepetitionInterval (New-TimeSpan -Minutes 2); $pr3=New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest; Unregister-ScheduledTask -TaskName 'OpenClaw Business Watchdog' -Confirm:$false -ErrorAction SilentlyContinue; Register-ScheduledTask -TaskName 'OpenClaw Business Watchdog' -Action $wdAct -Principal $pr3 -Trigger $wdTr -Force|Out-Null }catch{}
    Start-Process -FilePath $gwCmd -WindowStyle Hidden|Out-Null
    $gwUp=$false; for($i=0;$i -lt 40 -and -not $gwUp;$i++){ Start-Sleep -Milliseconds 800; if(Get-NetTCPConnection -LocalPort $gw -State Listen -ErrorAction SilentlyContinue){$gwUp=$true} }
    Log "gateway up=$gwUp on $gw"

    # 3 - open the assistant
    Step 3 'Opening your assistant...' 95
    try{ Start-ScheduledTask -TaskName 'OpenClaw Business Surface' }catch{ Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Root `"$($ctx.root)`" -NodePath `"$node`"" -WindowStyle Hidden|Out-Null }
    Finish $true
  } catch { Finish $false $_.Exception.Message }
}

# ---- Bring the window up FIRST, then run the engine --------------------------------
$listener=$null; $port=0
if (-not $NoUi) {
  $bound=$false
  for ($try=0; $try -lt 10 -and -not $bound; $try++) {
    $port=Get-Random -Minimum 49230 -Maximum 49900
    $listener=New-Object System.Net.HttpListener; $listener.Prefixes.Add("http://127.0.0.1:$port/")
    try { $listener.Start(); $bound=$true; Add-Content -Path $Log -Value "UI server on 127.0.0.1:$port" }
    catch { try { $listener.Close() } catch {}; Add-Content -Path $Log -Value "port $port busy ($($_.Exception.Message.Split([char]34)[0])), retrying" }
  }
  if (-not $bound) { Add-Content -Path $Log -Value 'UI listener failed after 10 ports'; $NoUi=$true }
}

# start the engine (runs while the window comes up)
$ctx=@{ state=$state; root=$InstallRoot; app=$AppDir; profile=$ProfileDir; browser=$BrowserDir; logs=$LogDir; ui=$UiDir; claude=$ClaudeDir; base=$Base; log=$Log; demo=$Demo.IsPresent; noui=$NoUi.IsPresent }
$iss=[System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault2()
$rs=[runspacefactory]::CreateRunspace($iss); $rs.ApartmentState='MTA'; $rs.Open(); $rs.SessionStateProxy.SetVariable('ctx',$ctx)
$psEngine=[powershell]::Create(); $psEngine.Runspace=$rs; [void]$psEngine.AddScript($engine).AddArgument($ctx)
$engineHandle=$psEngine.BeginInvoke()

# open the window immediately
$uiProc=$null
if (-not $NoUi -and $listener -and $listener.IsListening) {
  $browser=Get-DefaultChromium; Add-Content -Path $Log -Value "browser: $browser"
  if ($browser) {
    Add-Type -AssemblyName System.Windows.Forms
    $wa=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; $uw=560; $uh=680
    $ux=[int]($wa.Left+($wa.Width-$uw)/2); $uy=[int]($wa.Top+($wa.Height-$uh)/2)
    $bargs=@("--app=http://127.0.0.1:$port/","--window-size=$uw,$uh","--window-position=$ux,$uy","--user-data-dir=$(Join-Path $UiDir 'edge')","--no-first-run","--no-default-browser-check","--disable-features=Translate")
    $uiProc=Start-Process -FilePath $browser -ArgumentList $bargs -PassThru
    Add-Content -Path $Log -Value "window pid $($uiProc.Id)"
  } else { Start-Process "http://127.0.0.1:$port/" }

  # serve the UI + /status until the engine finishes (+grace so the final state shows)
  $doneAt=$null
  while ($true) {
    $req=$null; try { $req=$listener.GetContext() } catch { break }
    try {
      $resp=$req.Response; $resp.Headers.Add('Cache-Control','no-store')
      if ($req.Request.Url.AbsolutePath -eq '/status') {
        [System.Threading.Monitor]::Enter($state.SyncRoot)
        try { $snap=@{ step=$state.step; phase=$state.phase; pct=$state.pct; done=$state.done; ok=$state.ok; error=$state.error; root=$state.root; fellBack=$state.fellBack } }
        finally { [System.Threading.Monitor]::Exit($state.SyncRoot) }
        $j=[Text.Encoding]::UTF8.GetBytes(($snap|ConvertTo-Json -Compress)); $resp.ContentType='application/json'; $resp.OutputStream.Write($j,0,$j.Length)
      } else {
        $h=[Text.Encoding]::UTF8.GetBytes((Get-Content -Raw $uiHtml)); $resp.ContentType='text/html; charset=utf-8'; $resp.OutputStream.Write($h,0,$h.Length)
      }
      $resp.Close()
    } catch {}
    if ($state.done) { if (-not $doneAt) { $doneAt=Get-Date } elseif (((Get-Date)-$doneAt).TotalSeconds -gt 9) { break } }
  }
  try { $listener.Stop() } catch {}
  if ($uiProc) { try { Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$(Join-Path $UiDir 'edge')*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } catch {} }
}

while (-not $engineHandle.IsCompleted) { Start-Sleep -Milliseconds 300 }
try { $psEngine.EndInvoke($engineHandle) } catch {}
$rs.Dispose()

if ($state.error) { Write-Host "[OpenClaw for Business] $($state.error)  (log: $Log)" -ForegroundColor Red; exit 1 }
else { Write-Host "[OpenClaw for Business] All set - everything is under $InstallRoot" -ForegroundColor Green; if ($rootFellBack){ Write-Host "(used your user folder; C:\OpenClawBusiness wasn't writable)" -ForegroundColor Yellow } }
