# ===== start_backend.ps1 =====
# Loads literay_backend\.env into THIS PowerShell process's environment,
# then starts the ADK agent server — without touching config.py and without
# needing to install python-dotenv.
#
# Usage (from inside literay_backend):
#   .\start_backend.ps1
#
# Every time you edit .env, just re-run this script — no need to reopen
# the terminal.

$envFile = Join-Path $PSScriptRoot ".env"

if (-not (Test-Path $envFile)) {
    Write-Host "No .env file found at $envFile" -ForegroundColor Red
    Write-Host "Copy .env.example to .env in this same folder and fill in real values first." -ForegroundColor Yellow
    exit 1
}

Write-Host "Loading environment variables from $envFile ..." -ForegroundColor Cyan

Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    # skip blank lines and comments
    if ($line -and -not $line.StartsWith('#')) {
        $parts = $line -split '=', 2
        if ($parts.Length -eq 2) {
            $name = $parts[0].Trim()
            $value = $parts[1].Trim()
            if ($name) {
                [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
                Write-Host "  set $name" -ForegroundColor DarkGray
            }
        }
    }
}

# Fail fast with a clear message instead of letting config.py's traceback be
# the first thing you see, if the two required values are still empty.
if (-not $env:GOOGLE_CLOUD_PROJECT) {
    Write-Host "GOOGLE_CLOUD_PROJECT is empty in .env — fill it in and re-run." -ForegroundColor Red
    exit 1
}
if (-not $env:VERTEX_SEARCH_ENGINE_ID) {
    Write-Host "VERTEX_SEARCH_ENGINE_ID is empty in .env — fill it in and re-run." -ForegroundColor Red
    exit 1
}

Write-Host "Starting adk web literay_agent ..." -ForegroundColor Green
adk web literay_agent