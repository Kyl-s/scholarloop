@echo off
chcp 65001 >nul
cd /d "%~dp0"
netstat -ano | findstr /r /c:":5173 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo ScholarLoop 已在运行，正在打开浏览器...
  start "" http://localhost:5173
  exit /b 0
)
if not exist node_modules (
  echo 首次运行，正在安装依赖，请稍候...
  call npm install
)
echo 正在启动 ScholarLoop，浏览器将自动打开...
start "" /b cmd /c "npm run dev"
timeout /t 5 /nobreak >nul
start "" http://localhost:5173
