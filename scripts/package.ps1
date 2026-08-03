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

$tests = @(
    'tests/test-offscreen.js',
    'tests/test-background.js',
    'tests/test-content.js',
    'tests/test-logger.js',
    'tests/test-theme.js'
)
foreach ($test in $tests) {
    & node (Join-Path $projectRoot $test)
    if ($LASTEXITCODE -ne 0) { throw "Test failed: $test" }
}

$runtimeFiles = @(
    'background.js',
    'content.js',
    'logger.js',
    'manifest.json',
    'offscreen-boot.js',
    'offscreen.html',
    'offscreen.js',
    'rules.json',
    'sidepanel.css',
    'sidepanel.html',
    'sidepanel.js',
    'theme.js'
)
$iconFiles = @('icon16.png', 'icon48.png', 'icon128.png')

$manifest = Get-Content (Join-Path $projectRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $manifest.version) { throw 'manifest.json has no version' }
$zipPath = Join-Path $OutputRoot ("bilibili-music-player-v{0}.zip" -f $manifest.version)

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
if (Test-Path -LiteralPath $releaseDir) {
    Remove-Item -LiteralPath $releaseDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $releaseDir 'icons') | Out-Null

foreach ($file in $runtimeFiles) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination (Join-Path $releaseDir $file)
}
foreach ($file in $iconFiles) {
    Copy-Item -LiteralPath (Join-Path $projectRoot (Join-Path 'icons' $file)) -Destination (Join-Path $releaseDir (Join-Path 'icons' $file))
}

$packagedFiles = $runtimeFiles + ($iconFiles | ForEach-Object { Join-Path 'icons' $_ })
foreach ($file in $packagedFiles) {
    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $projectRoot $file)).Hash
    $releaseHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $releaseDir $file)).Hash
    if ($sourceHash -ne $releaseHash) { throw "Release hash mismatch: $file" }
}

if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $releaseDir '*') -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host ("Release ready: {0}" -f $releaseDir)
Write-Host ("Package ready: {0}" -f $zipPath)
