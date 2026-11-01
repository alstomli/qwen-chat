@echo off
setlocal
cd /d "%~dp0"
set "chatNode=%~dp0..\.tools\node_modules\node\bin\node.exe"
if not exist "%chatNode%" set "chatNode=node"
"%chatNode%" -e "if(Number(process.versions.node.split('.')[0]) < 22) { console.error('Please install Node.js 22 or later.'); process.exit(1); }"
if errorlevel 1 exit /b 1
if not exist "node_modules\next\dist\bin\next" (
  echo Install project dependencies with npm ci first.
  exit /b 1
)
set "NEXT_TELEMETRY_DISABLED=1"
"%chatNode%" scripts/setup.mjs
if errorlevel 1 exit /b 1
"%chatNode%" node_modules\next\dist\bin\next dev --hostname 127.0.0.1 --port 3001
