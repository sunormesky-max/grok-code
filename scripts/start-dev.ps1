# Start GrokCode from the latest source (not the installed Program Files build).
# Usage: right-click → Run with PowerShell, or:
#   powershell -ExecutionPolicy Bypass -File scripts\start-dev.ps1

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "GrokCode DEV from: $Root" -ForegroundColor Cyan

# Stop hung headless grok agents left by killed runs (safe: only streaming-json)
Get-CimInstance Win32_Process -Filter "Name='grok.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'streaming-json|grok-code-prompt' } |
  ForEach-Object {
    Write-Host "Stopping orphan agent PID $($_.ProcessId)" -ForegroundColor Yellow
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

if (-not (Test-Path (Join-Path $Root 'node_modules\electron'))) {
  Write-Host 'Installing deps…' -ForegroundColor Yellow
  npm install
}

Write-Host 'Launching electron .  (this is the repo build with latest fixes)' -ForegroundColor Green
npx electron .
