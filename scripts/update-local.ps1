# Build and globally install both Dispatch and its bundled WebUI.
# Run from anywhere: & "C:\path\to\Dispatch\scripts\update-local.ps1"
# Stop running Dispatch instances before installing. Local changes are included.
[CmdletBinding()]
param(
    [string]$WebPath = (Join-Path $PSScriptRoot '..\..\Dispatch-WebUI'),
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

function Invoke-Npm {
    param([string[]]$NpmArgs)
    & npm.cmd @NpmArgs
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($NpmArgs -join ' ') failed (exit $LASTEXITCODE)."
    }
}

$dispatchRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$webRoot = (Resolve-Path $WebPath).Path
if (-not (Test-Path (Join-Path $webRoot 'package.json'))) {
    throw "No WebUI package.json found in $webRoot"
}

Write-Host "Dispatch: $dispatchRoot"
Write-Host "WebUI:    $webRoot"
Write-Host 'Using local files as-is; no pull, version bump, or publication.'
if (-not $SkipInstall) {
    Write-Host 'Stop running Dispatch instances before continuing with this update.'
}

Push-Location $dispatchRoot
try {
    Invoke-Npm -NpmArgs @('ci')
    Invoke-Npm -NpmArgs @('--prefix', $webRoot, 'ci')
    Invoke-Npm -NpmArgs @('run', 'build:release', '--', '--web-dir', $webRoot)
    Invoke-Npm -NpmArgs @('pack', './.release/package', '--pack-destination', '.release')

    $manifest = Get-Content (Join-Path $dispatchRoot '.release/package/package.json') -Raw | ConvertFrom-Json
    $tarball = Join-Path $dispatchRoot ".release/michaelt025-dispatch-$($manifest.version).tgz"
    if (-not (Test-Path $tarball)) {
        throw "Expected package not found: $tarball"
    }

    if ($SkipInstall) {
        Write-Host "Built package (global install skipped): $tarball"
    } else {
        Invoke-Npm -NpmArgs @('install', '-g', $tarball)
        Write-Host 'Local CLI and bundled WebUI updated. Restart with: dispatch --web'
    }
} finally {
    Pop-Location
}
