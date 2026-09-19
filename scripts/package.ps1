param(
    [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -Force
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Archive/Microsoft.PowerShell.Archive.psd1') -Force
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path (Split-Path $projectRoot -Parent) 'release'
}
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$releaseDir = [IO.Path]::GetFullPath((Join-Path $OutputRoot 'bilibili-music-player'))

$comparison = [StringComparison]::OrdinalIgnoreCase
$sourcePrefix = $projectRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$releasePrefix = $releaseDir.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if ($releaseDir.Equals($projectRoot, $comparison) -or
    $releaseDir.StartsWith($sourcePrefix, $comparison) -or
    $projectRoot.StartsWith($releasePrefix, $comparison)) {
    throw "The release directory must not overlap the source directory: $releaseDir"
}
if ((Split-Path $releaseDir -Leaf) -ne 'bilibili-music-player') {
    throw "Unsafe release directory: $releaseDir"
}
# Lexical checks alone do not protect a source directory reached through a junction.
foreach ($start in @($releaseDir, $projectRoot)) {
    $pathToCheck = $start
    while ($pathToCheck) {
        if ((Test-Path -LiteralPath $pathToCheck) -and
            ((Get-Item -LiteralPath $pathToCheck -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "The package path must not pass through a junction or symbolic link: $pathToCheck"
        }
        $pathToCheck = Split-Path -Parent $pathToCheck
    }
}
if (Test-Path -LiteralPath (Join-Path $releaseDir '.git')) {
    throw "The release destination contains a Git checkout and cannot be replaced: $releaseDir"
}

& npm.cmd --prefix $projectRoot test
if ($LASTEXITCODE -ne 0) { throw 'Syntax checks or tests failed' }

$packageFiles = @(
    'src/background/background.js',
    'src/charts/apple.js',
    'src/charts/qq.js',
    'src/charts/netease.js',
    'src/charts/matcher.js',
    'src/charts/chart-picker.html',
    'src/charts/chart-picker.css',
    'src/charts/chart-picker.js',
    'src/content/content.js',
    'LICENSE',
    'src/shared/logger.js',
    'manifest.json',
    'src/player/offscreen-boot.js',
    'src/player/offscreen.html',
    'src/player/offscreen.js',
    'src/network/rules.json',
    'src/rename/renamer.js',
    'src/rename/rules.json',
    'src/panel/sidepanel.css',
    'src/panel/sidepanel.html',
    'src/panel/sidepanel.js',
    'src/shared/theme.js',
    'update.bat',
    'scripts/update.ps1',
    'docs/user-guide.md',
    'assets/icons/icon16.png',
    'assets/icons/icon48.png',
    'assets/icons/icon128.png'
)

$manifest = Get-Content (Join-Path $projectRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $manifest.version) { throw 'manifest.json has no version' }
$zipPath = Join-Path $OutputRoot ("bilibili-music-player-v{0}.zip" -f $manifest.version)

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
if (Test-Path -LiteralPath $releaseDir) {
    Remove-Item -LiteralPath $releaseDir -Recurse -Force
}
foreach ($file in $packageFiles) {
    $destination = Join-Path $releaseDir $file
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $destination
}

$packagedFiles = $packageFiles
foreach ($file in $packagedFiles) {
    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $projectRoot $file)).Hash
    $releaseHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $releaseDir $file)).Hash
    if ($sourceHash -ne $releaseHash) { throw "Release hash mismatch: $file" }
}
& (Join-Path $projectRoot 'scripts/update.ps1') -InstallRoot $releaseDir -ValidateOnly

if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $releaseDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
$zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
$checksumPath = $zipPath + '.sha256'
Set-Content -LiteralPath $checksumPath -Value ("{0}  {1}" -f $zipHash, [IO.Path]::GetFileName($zipPath)) -Encoding ASCII

Write-Host ("Release ready: {0}" -f $releaseDir)
Write-Host ("Package ready: {0}" -f $zipPath)
Write-Host ("Checksum ready: {0}" -f $checksumPath)
