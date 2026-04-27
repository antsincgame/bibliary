#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Bootstrap Marker PDF extractor inside WSL for Bibliary.

.DESCRIPTION
    Installs uv + marker-pdf inside a dedicated WSL virtual-env at
    ~/.bibliary-tools/marker-venv/ using the default (or specified) distro.
    Idempotent — safe to re-run; skips if already installed.

.PARAMETER Distro
    WSL distro name. Defaults to the system default.

.PARAMETER Force
    Re-install even if marker is already present.

.EXAMPLE
    .\bootstrap-marker.ps1
    .\bootstrap-marker.ps1 -Distro Ubuntu-22.04 -Force
#>
param(
    [string]$Distro = "",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$wslArgs = @()
if ($Distro -ne "") { $wslArgs += @("-d", $Distro) }

function Invoke-Wsl {
    param([string[]]$Args)
    $cmd = @("wsl.exe") + $wslArgs + @("--") + $Args
    Write-Host ">> $($cmd -join ' ')"
    & wsl.exe @wslArgs -- @Args
    if ($LASTEXITCODE -ne 0) {
        throw "WSL command failed with exit code $LASTEXITCODE"
    }
}

Write-Host "=== Bibliary Marker Bootstrap ===" -ForegroundColor Cyan

# 1. Check WSL is available
try {
    wsl.exe --list --quiet 2>$null | Out-Null
} catch {
    Write-Error "WSL is not installed or not available. Install WSL2 first."
    exit 1
}

# 2. Check if already installed (unless -Force)
if (-not $Force) {
    $check = wsl.exe @wslArgs -- bash -c 'source ~/.bibliary-tools/marker-venv/bin/activate 2>/dev/null && command -v marker_single && echo "ok"' 2>$null
    if ($check -match "ok") {
        Write-Host "Marker already installed. Use -Force to reinstall." -ForegroundColor Green
        exit 0
    }
}

# 3. Install uv (universal Python package manager)
Write-Host "`n--- Step 1: Installing uv ---" -ForegroundColor Yellow
Invoke-Wsl bash -c 'curl -fsSL https://astral.sh/uv/install.sh | sh'
Invoke-Wsl bash -c 'echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> ~/.bashrc'

# 4. Create venv and install marker-pdf
Write-Host "`n--- Step 2: Creating marker-venv ---" -ForegroundColor Yellow
Invoke-Wsl bash -c '
    export PATH="$HOME/.local/bin:$PATH"
    mkdir -p ~/.bibliary-tools
    uv venv ~/.bibliary-tools/marker-venv --python 3.11
    source ~/.bibliary-tools/marker-venv/bin/activate
    uv pip install "marker-pdf>=1.6.0"
'

# 5. Verify
Write-Host "`n--- Step 3: Verifying installation ---" -ForegroundColor Yellow
$version = wsl.exe @wslArgs -- bash -c 'source ~/.bibliary-tools/marker-venv/bin/activate && marker_single --version 2>&1'
Write-Host "marker_single version: $version" -ForegroundColor Green

Write-Host "`n=== Done! Marker is ready. ===" -ForegroundColor Cyan
Write-Host "Set BIBLIARY_USE_MARKER=1 in Bibliary settings to enable layout-aware extraction."
