param(
    [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path (Split-Path $projectRoot -Parent) 'release'
}
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$releaseDir = [IO.Path]::GetFullPath((Join-Path $OutputRoot 'bilibili-music-player'))

if ((Split-Path $releaseDir -Leaf) -ne 'bilibili-music-player' -or
    -not $releaseDir.StartsWith($OutputRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe release directory: $releaseDir"
}

& npm.cmd --prefix $projectRoot test
if ($LASTEXITCODE -ne 0) { throw 'Syntax checks or tests failed' }

$packageFiles = @(
    'src/background/background.js',
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
