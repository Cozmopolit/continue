# Continue Extension - Build & Publish Script
# Usage: .\publish.ps1 [-SkipInstall] [-PreRelease] [-Verbose]

param(
    [switch]$SkipInstall,
    [switch]$PreRelease,
    [switch]$Verbose
)

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot
$VsixPath = "$RepoRoot\extensions\vscode\build\continue-*.vsix"

function Write-Step($message) { Write-Host "=> $message" -ForegroundColor Cyan }
function Write-OK($message) { Write-Host "   $message" -ForegroundColor Green }
function Write-Err($message) { Write-Host "   $message" -ForegroundColor Red }

function Invoke-Quietly($scriptBlock) {
    if ($Verbose) {
        & $scriptBlock
    } else {
        & $scriptBlock 2>&1 | Out-Null
    }
}

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

# Step 1: Build GUI
Write-Step "Building GUI..."
Push-Location "$RepoRoot\gui"
try {
    Invoke-Quietly { npm run build }
    if ($LASTEXITCODE -ne 0) { throw "GUI build failed" }
    Write-OK "Done"
} finally { Pop-Location }

# Step 2: Prepackage Extension
Write-Step "Prepackaging..."
Push-Location "$RepoRoot\extensions\vscode"
try {
    Invoke-Quietly { npm run prepackage }
    if ($LASTEXITCODE -ne 0) { throw "Prepackage failed" }
    Write-OK "Done"
} finally { Pop-Location }

# Step 3: Package Extension
Write-Step "Packaging..."
Push-Location "$RepoRoot\extensions\vscode"
try {
    $cmd = if ($PreRelease) { "package:pre-release" } else { "package" }
    Invoke-Quietly { npm run $cmd }
    if ($LASTEXITCODE -ne 0) { throw "Package failed" }
    Write-OK "Done"
} finally { Pop-Location }

# Find the generated VSIX
$VsixFile = Get-ChildItem $VsixPath | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $VsixFile) {
    Write-Err "VSIX not found at $VsixPath"
    exit 1
}

$stopwatch.Stop()
Write-Host "`nVSIX: $($VsixFile.Name) (built in $([math]::Round($stopwatch.Elapsed.TotalSeconds))s)" -ForegroundColor Green

# Step 4: Install Extension (optional)
if (-not $SkipInstall) {
    Write-Step "Installing..."
    code --install-extension $VsixFile.FullName --force 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { 
        Write-Err "Installation failed"
        exit 1
    }
    Write-OK "Installed. Reload VS Code (Ctrl+Shift+P -> Reload Window)"
} else {
    Write-Host "To install: code --install-extension `"$($VsixFile.FullName)`" --force" -ForegroundColor DarkGray
}
