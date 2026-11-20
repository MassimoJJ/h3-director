#Requires -Version 5.1
# H3 Director Studio - boot launcher / supervisor.
# Brings up the backend on 127.0.0.1:8788 and waits until the UI actually answers
# HTTP before reporting READY. Safe to run multiple times: an already-running
# service (or another launcher) is detected and skipped rather than started twice.
#
# ComfyUI is NOT started unless you ask for it with -WithComfy: the engine is yours
# to launch (run_nvidia_gpu.bat, or the app's "Start" button in the top bar). If it
# is already running the launcher only notes that, so it can never start a second one.
#
# The UI opens in the system default browser. If you need a specific Chrome
# identity, pass -ChromeProfile "Profile 1" (or set H3_CHROME_PROFILE). Pass
# -ChromeProfile none to force the default browser explicitly.
#
# Logs:
#   logs\autostart.log          launcher decisions and restarts
#   logs\backend.log / .error   the backend's own stdout/stderr
#   logs\comfyui.log            ComfyUI output, when the launcher does start it
#   logs\comfyui-launch.stamp   when ComfyUI was last started (boot-window guard)

[CmdletBinding()]
param(
  # Open the UI in the default browser once it answers. The logon shortcut and
  # start.bat both pass this, so the app lands on screen by itself.
  [switch]$Open,

  # Opt in to starting the ComfyUI engine as well. Off by default: the engine costs
  # a few minutes and most of the VRAM, and the usual wish is to have the app on
  # screen at logon and start the engine only when a render is actually wanted.
  [switch]$WithComfy,

  # Optional Chrome profile directory, e.g. "Profile 1". Defaults to the
  # H3_CHROME_PROFILE environment variable, or the system default browser when
  # that variable is unset. Use "none" to force the default browser.
  [string]$ChromeProfile = $env:H3_CHROME_PROFILE
)

$ErrorActionPreference = "Continue"

# Resolve paths from this script, so the repo can live anywhere.
$root    = Split-Path -Parent $PSScriptRoot
$logs    = Join-Path $root "logs"
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Force -Path $logs | Out-Null }

$logFile = Join-Path $logs "autostart.log"
function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

# --- read app settings so we follow whatever port the UI actually uses -------
$port     = 8788
$comfyUrl = "http://127.0.0.1:8188"
$comfyRoot = ""
$settingsPath = Join-Path $root "data\settings.json"
if (Test-Path $settingsPath) {
  try {
    $s = Get-Content $settingsPath -Raw | ConvertFrom-Json
    if ($s.port)      { $port = [int]$s.port }
    if ($s.comfyUrl)  { $comfyUrl = [string]$s.comfyUrl }
    if ($s.comfyRoot) { $comfyRoot = [string]$s.comfyRoot }
  } catch { Write-Log "settings.json unreadable: $($_.Exception.Message)" }
}
$comfyPort = 8188
try { $comfyPort = ([uri]$comfyUrl).Port } catch {}

# The portable launcher (.bat) lives one level above the ComfyUI folder. Accept
# either that portable root or the ComfyUI folder itself in settings/env.
$comfyHome = $env:H3_COMFY_HOME
if (-not $comfyHome -and $comfyRoot) {
  if (Test-Path (Join-Path $comfyRoot "run_nvidia_gpu.bat")) { $comfyHome = $comfyRoot }
  elseif (Test-Path (Join-Path (Split-Path -Parent $comfyRoot) "run_nvidia_gpu.bat")) { $comfyHome = Split-Path -Parent $comfyRoot }
  else { $comfyHome = $comfyRoot }
}
if (-not $comfyHome) { $comfyHome = Split-Path -Parent $root }

function Test-Port([int]$p) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if ($c) { return $true }
  # fallback for very old Windows / restricted hosts
  return [bool]((netstat -ano) -match ":$p\s+.*LISTENING")
}

Write-Log "launcher started (backend port=$port, comfy port=$comfyPort)"

# --- 1) ComfyUI engine -------------------------------------------------------
# ComfyUI needs 1-3 minutes to load its models before 8188 opens, so "the port is
# closed" does NOT mean "it is not running". Starting it on every launcher run is
# how you end up with two engines fighting over 8188 and two copies of the models
# in VRAM. A start is therefore only issued when nothing is listening, no
# ComfyUI main.py is alive, and the last start is older than the boot window.
$comfyStamp   = Join-Path $logs "comfyui-launch.stamp"
$comfyLog     = Join-Path $logs "comfyui.log"
$comfyBootSec = 480   # how long a fresh ComfyUI may take before we try again

function Get-ComfyProcess {
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'ComfyUI[\\/]main\.py' }
}

$comfyProc = @(Get-ComfyProcess)
$stampAge  = $null
if (Test-Path $comfyStamp) {
  try { $stampAge = [int]((Get-Date) - (Get-Item $comfyStamp).LastWriteTime).TotalSeconds } catch { $stampAge = $null }
}

if (Test-Port $comfyPort) {
  Write-Log "ComfyUI already listening on $comfyPort"
} elseif ($comfyProc.Count -gt 0) {
  Write-Log "ComfyUI is already starting (pid $($comfyProc.ProcessId -join ',')) - not launching a second one"
} elseif (-not $WithComfy) {
  Write-Log "ComfyUI auto-start is off (pass -WithComfy to start it) - start the engine yourself when you render: the app's Start button, or run_nvidia_gpu.bat"
} elseif ($null -ne $stampAge -and $stampAge -lt $comfyBootSec) {
  Write-Log "ComfyUI was started $stampAge s ago, still inside its $comfyBootSec s boot window - not launching again (see $comfyLog)"
} else {
  $bat = Join-Path $comfyHome "run_nvidia_gpu.bat"
  if (Test-Path $bat) {
    Write-Log "ComfyUI is down - starting $bat (output: $comfyLog)"
    Set-Content -Path $comfyStamp -Value (Get-Date -Format "yyyy-MM-dd HH:mm:ss") -Encoding UTF8
    # "< NUL" matters: the .bat ends in `pause`, which would otherwise hang a
    # console forever once ComfyUI dies, making a second start look impossible.
    $cmdLine = '/c ""' + $bat + '" >> "' + $comfyLog + '" 2>&1 < NUL"'
    Start-Process -FilePath "cmd.exe" -ArgumentList $cmdLine -WorkingDirectory $comfyHome -WindowStyle Hidden
  } else {
    Write-Log "WARN: ComfyUI start script not found ($bat) - start it manually"
  }
}

# --- 2) backend --------------------------------------------------------------
# A listening port is not proof of a working app: a process can hold the socket
# while the HTTP server inside it is dead. Readiness is therefore measured by a
# real request, so the READY line means the UI was actually served.
function Test-Backend {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -TimeoutSec 5 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

# --- opening the UI ----------------------------------------------------------
# Chrome is launched explicitly when a profile is named, instead of handing the
# URL to Windows: on machines with several Chrome profiles the system hand-off
# can open the app under the wrong Google account.
function Find-Chrome {
  $paths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($p in $paths) { if ($p -and (Test-Path $p)) { return $p } }
  foreach ($hive in @("HKLM:", "HKCU:")) {
    try {
      $p = (Get-ItemProperty "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" -ErrorAction Stop).'(default)'
      if ($p -and (Test-Path $p)) { return $p }
    } catch {
      # not registered in this hive
    }
  }
  return $null
}

# Trust the caller when we cannot see Chrome's profile list (custom --user-data-dir).
function Test-ChromeProfile([string]$name) {
  $root = "$env:LOCALAPPDATA\Google\Chrome\User Data"
  if (-not (Test-Path $root)) { return $true }
  return (Test-Path (Join-Path $root (Join-Path $name "Preferences")))
}

# Which profiles are already open (only a browser process carries --profile-directory).
function Get-RunningChromeProfiles {
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
    ForEach-Object {
      $m = [regex]::Match($_.CommandLine, '--profile-directory="([^"]+)"')
      if (-not $m.Success) { $m = [regex]::Match($_.CommandLine, '--profile-directory=([^"\s]+)') }
      if ($m.Success) { $m.Groups[1].Value }
    } | Where-Object { $_ } | Select-Object -Unique
}

# Open the UI in a named Chrome profile when asked, otherwise in the default
# browser. A named profile is useful when the machine has several Google
# accounts and the wrong one would otherwise receive the link.
function Open-Ui {
  $url = "http://127.0.0.1:$port/"
  $chrome = Find-Chrome
  $wanted = $ChromeProfile

  if ($wanted -and $wanted -ne "none" -and $chrome) {
    if (Test-ChromeProfile $wanted) {
      # Chrome only honours --profile-directory when *it* starts the browser process. If
      # another profile is already open, the Windows singleton hand-off gives the URL to
      # that running instance and the app lands in the wrong Google account. Nothing the
      # command line can do about it, so make it visible instead of silently wrong.
      $running = @(Get-RunningChromeProfiles)
      if ($running.Count -gt 0 -and $running -notcontains $wanted) {
        Write-Log "WARN: Chrome is already running (profile(s): $($running -join ', ')) - it will take the URL into that window, not '$wanted'. Close Chrome first (or at logon) and the app opens in '$wanted'."
      }
      Write-Log "opening $url in Chrome profile '$wanted'"
      Start-Process -FilePath $chrome -ArgumentList "--profile-directory=`"$wanted`"", $url
      return
    }
    Write-Log "WARN: Chrome profile '$wanted' does not exist - opening in the default browser instead"
  } elseif ($wanted -and $wanted -ne "none" -and -not $chrome) {
    Write-Log "WARN: chrome.exe not found - opening $url in the default browser instead"
  }

  Write-Log "opening $url in the default browser"
  Start-Process $url
}

if (Test-Backend) {
  Write-Log "backend already answering on $port - nothing to do"
  if ($Open) { Open-Ui }
  exit 0
}

# Two supervisors would each spawn a backend; the loser dies on the busy port and
# its restart loop makes the log unreadable. Only one launcher may run.
$otherLauncher = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -match 'start-h3-director\.ps1' })
if ($otherLauncher.Count -gt 0) {
  Write-Log "another launcher (pid $($otherLauncher.ProcessId -join ',')) is already running - exiting"
  exit 0
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue)
if ($node) { $node = $node.Source } else { $node = "C:\Program Files\nodejs\node.exe" }
if (-not (Test-Path $node)) {
  Write-Log "FATAL: node.exe not found - install Node.js 20+ or add it to PATH"
  exit 1
}

$tsxCli   = Join-Path $root "node_modules\tsx\dist\cli.mjs"
$entry    = Join-Path $root "backend\src\main.ts"
$outLog   = Join-Path $logs "backend.log"
$errLog   = Join-Path $logs "backend.error.log"
$restartDelay = 10
$readyWait    = 90   # how long a fresh backend may take to answer HTTP

while ($true) {
  if (Test-Backend) {
    Write-Log "backend is already up on $port and not managed here - supervisor exiting"
    exit 0
  }

  if (Test-Path $tsxCli) {
    Write-Log "starting backend: node `"$tsxCli`" `"$entry`""
    $p = Start-Process -FilePath $node `
      -ArgumentList @("`"$tsxCli`"", "`"$entry`"") `
      -WorkingDirectory $root `
      -WindowStyle Hidden `
      -RedirectStandardOutput $outLog `
      -RedirectStandardError $errLog `
      -PassThru
  } else {
    Write-Log "tsx not found at $tsxCli - falling back to: npm run start -w backend"
    $p = Start-Process -FilePath "cmd.exe" `
      -ArgumentList "/c", "npm run start -w backend" `
      -WorkingDirectory $root `
      -WindowStyle Hidden `
      -RedirectStandardOutput $outLog `
      -RedirectStandardError $errLog `
      -PassThru
  }

  # Wait for HTTP readiness while the child is alive, then go back to supervising
  # its exit - a backend that starts but never serves must not be left "running".
  $deadline = (Get-Date).AddSeconds($readyWait)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-Backend) { $ready = $true; break }
    if ($p.HasExited) { break }
    Start-Sleep -Seconds 2
  }

  if ($ready) {
    Write-Log "backend READY at http://127.0.0.1:$port (pid $($p.Id)) - supervising"
    if ($Open) { Open-Ui }
  } elseif (-not $p.HasExited) {
    Write-Log "backend pid $($p.Id) never answered HTTP within ${readyWait}s - killing it and retrying"
    try { $p.Kill() } catch {
      # already gone
    }
  }

  $p.WaitForExit()
  Write-Log "backend exited with code $($p.ExitCode) - restarting in $restartDelay s"
  Start-Sleep -Seconds $restartDelay
}
