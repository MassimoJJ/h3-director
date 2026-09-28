@echo off
rem H3 Director Studio launcher.
rem Brings up the backend on http://127.0.0.1:8788, waits until the UI answers and opens
rem it. ComfyUI is NOT started - use the app's Start button when you render (or run the
rem script below with -WithComfy to start the engine too). Same script the logon shortcut runs.
cd /d "%~dp0"

if not exist node_modules (
  echo First run: installing dependencies...
  call npm install --no-audit --no-fund
)
if not exist web\dist (
  echo Building the web UI...
  call npm run build
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-h3-director.ps1" -Open
echo.
echo The launcher supervises the backend in the background and restarts it if it crashes.
echo Leave this window open for that; closing it leaves the backend running unsupervised.
pause
