#Requires -Version 5.1
# Installs (or removes) the H3 Director Studio autostart entry.
#   .\install-autostart.ps1            -> install
#   .\install-autostart.ps1 -Uninstall  -> remove
#   .\install-autostart.ps1 -Status     -> report
#
# Default mechanism: a shortcut in the per-user Startup folder (no admin rights).
# If this shell is elevated, a logon Scheduled Task is installed as well
# (it survives Startup-folder quirks and is easier to spot in Task Manager).

[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$root   = Split-Path -Parent $PSScriptRoot
$vbs    = Join-Path $root "scripts\start-h3-director-hidden.vbs"
$taskNm = "H3 Director Studio"
$lnkNm  = "H3 Director Studio.lnk"
$startup = [Environment]::GetFolderPath("Startup")
$lnkPath = Join-Path $startup $lnkNm

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

function Test-Installed {
  $lnk = Test-Path $lnkPath
  $task = $null
  try { $task = Get-ScheduledTask -TaskName $taskNm -ErrorAction Stop } catch { $task = $null }
  [pscustomobject]@{ Shortcut = $lnk; ShortcutPath = $lnkPath; ScheduledTask = [bool]$task; IsAdmin = $isAdmin }
}

if ($Status) {
  $s = Test-Installed
  "Autostart status"
  "  Startup shortcut : $($s.Shortcut)  ($($s.ShortcutPath))"
  "  Scheduled task   : $($s.ScheduledTask)"
  "  Running elevated : $($s.IsAdmin)"
  $c = netstat -ano | Select-String ":8788 .*LISTENING"
  "  Backend on 8788  : $([bool]$c)"
  return
}

if ($Uninstall) {
  if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force; "Removed $lnkPath" } else { "No startup shortcut found" }
  try { Unregister-ScheduledTask -TaskName $taskNm -Confirm:$false -ErrorAction Stop; "Removed scheduled task '$taskNm'" }
  catch { "No scheduled task '$taskNm'" }
  return
}

if (-not (Test-Path $vbs)) { throw "Launcher not found: $vbs" }

# --- 1) Startup-folder shortcut (works without admin) -----------------------
$wsh = New-Object -ComObject WScript.Shell
$sc  = $wsh.CreateShortcut($lnkPath)
$sc.TargetPath       = Join-Path $env:WINDIR "System32\wscript.exe"
$sc.Arguments        = '"' + $vbs + '"'
$sc.WorkingDirectory = $root
$sc.IconLocation     = "$env:WINDIR\System32\wscript.exe,0"
$sc.Description      = "H3 Director Studio - starts ComfyUI (if down) and the backend on 127.0.0.1:8788"
$sc.WindowStyle      = 7
$sc.Save()
"Installed startup shortcut: $lnkPath"

# --- 2) Scheduled task (only when elevated) ---------------------------------
if ($isAdmin -or $Force) {
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR "System32\wscript.exe") -Argument ('"' + $vbs + '"')
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\$env:USERNAME") -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $taskNm -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "H3 Director Studio autostart" -Force | Out-Null
  "Installed scheduled task '$taskNm' (at logon)"
} else {
  "Not elevated -> skipped the scheduled task (startup shortcut is enough)."
}

# --- 3) Optional: start it right now ----------------------------------------
$already = [bool](netstat -ano | Select-String ":8788 .*LISTENING")
if ($already) {
  "Backend already listening on 8788 - left running instance alone."
} else {
  "Starting the launcher now..."
  Start-Process -FilePath (Join-Path $env:WINDIR "System32\wscript.exe") -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden
  Start-Sleep -Seconds 6
  $up = [bool](netstat -ano | Select-String ":8788 .*LISTENING")
  if ($up) { "Backend is up: http://127.0.0.1:8788" } else { "Backend did not answer yet - check $root\logs\autostart.log" }
}
