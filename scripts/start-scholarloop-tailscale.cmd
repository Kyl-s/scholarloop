@echo off
setlocal
cd /d "%~dp0.."

where node >nul 2>nul || (
  echo [ScholarLoop] Node.js was not found in PATH.
  exit /b 1
)

where tailscale >nul 2>nul || (
  echo [ScholarLoop] Tailscale CLI was not found in PATH.
  echo Install Tailscale and sign in on this computer first.
  exit /b 1
)

echo [ScholarLoop] Starting local server on 127.0.0.1:8787...
start "ScholarLoop Server" /b cmd /c "npm start"

echo [ScholarLoop] Waiting for the local server to become healthy...
for /l %%i in (1,1,30) do (
  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 1 -UseBasicParsing | Out-Null; exit 0 } catch { exit 1 }"
  if not errorlevel 1 goto server_ready
  timeout /t 1 /nobreak >nul
)

echo [ScholarLoop] Local server did not become healthy in 30 seconds.
exit /b 1

:server_ready
echo [ScholarLoop] Publishing the local server through Tailscale Serve...
tailscale serve --https=443 http://127.0.0.1:8787

endlocal
