param([int]$Port = 8000)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    throw 'Hay chay .\setup.ps1 truoc.'
}
Write-Host "PeopleLens: http://127.0.0.1:$Port" -ForegroundColor Green
& $venvPython run.py --host 127.0.0.1 --port $Port

