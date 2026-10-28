param([switch]$Gpu)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    $pythonPath = $null
    $installedPython = Get-Command python -ErrorAction SilentlyContinue
    if ($installedPython -and $installedPython.Source -notlike '*WindowsApps*') {
        $pythonPath = $installedPython.Source
    }
    if (-not $pythonPath) {
        $uvPython = Join-Path $env:APPDATA 'uv\python'
        $pythonPath = Get-ChildItem -Path "$uvPython\cpython-3.12*\python.exe" -ErrorAction SilentlyContinue |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if ($pythonPath) {
        & $pythonPath -m venv .venv
    } elseif (Get-Command py -ErrorAction SilentlyContinue) {
        py -3.12 -m venv .venv
    } else {
        throw 'Can Python 3.12. Cai tu https://www.python.org/downloads/ roi chay lai.'
    }
    if ($LASTEXITCODE -ne 0) { throw 'Khong tao duoc moi truong Python.' }
}
if ($Gpu) {
    & $venvPython -m pip install --upgrade 'torch==2.11.0' 'torchvision==0.26.0' --index-url https://download.pytorch.org/whl/cu128 --timeout 180
    if ($LASTEXITCODE -ne 0) { throw 'Cai CUDA wheel that bai. Chay lai setup.ps1 khong co -Gpu de dung CPU.' }
}
$installedFromCache = $false
if (Test-Path -LiteralPath '.data\wheels') {
    & $venvPython -m pip install --no-index --find-links '.data\wheels' -r requirements.txt
    $installedFromCache = $LASTEXITCODE -eq 0
}
if (-not $installedFromCache) {
    & $venvPython -m pip install -r requirements.txt --timeout 120
}
if ($LASTEXITCODE -ne 0) { throw 'Cai dependencies that bai. Xem loi pip phia tren.' }
& $venvPython tools\prepare_model.py
if ($LASTEXITCODE -ne 0) { throw 'Khong chuan bi duoc best.pt.' }
Write-Host 'Hoan tat. Chay: .\start.ps1' -ForegroundColor Green

