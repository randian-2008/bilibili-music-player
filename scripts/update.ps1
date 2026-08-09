param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot
)

$ErrorActionPreference = 'Stop'

$Repository = 'randian-2008/bilibili-music-player'
$ProjectName = 'bilibili-music-player'
$LatestReleaseApi = "https://api.github.com/repos/$Repository/releases/latest"
$PreserveRelativePaths = @(
    'src\rename\rules.json'
)

function Get-NormalizedPath([string]$Path) {
    # cmd.exe can leave a trailing quote when a quoted Windows path ends in a backslash.
    $cleanPath = ([string]$Path).Trim().Trim('"').TrimEnd('\', '/')
    return [IO.Path]::GetFullPath($cleanPath)
}

function Read-Manifest([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "manifest.json was not found: $Path"
    }
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Get-Version([string]$Value) {
    $match = [regex]::Match([string]$Value, '(?<!\d)(\d+\.\d+\.\d+)(?!\d)')
    if (-not $match.Success) { throw "Invalid extension version: $Value" }
    return [version]$match.Groups[1].Value
}

function Get-ReleaseAsset($Release, [string]$Pattern) {
    $asset = @($Release.assets | Where-Object { $_.name -match $Pattern }) | Select-Object -First 1
    if (-not $asset) { throw "The latest release has no matching asset: $Pattern" }
    return $asset
}

function Assert-ProjectRoot([string]$Root) {
    $manifest = Read-Manifest (Join-Path $Root 'manifest.json')
    if ($manifest.manifest_version -ne 3 -or
        -not $manifest.background -or
        $manifest.background.service_worker -ne 'src/background/background.js') {
        throw 'The selected directory is not a bilibili-music-player installation.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'update.bat') -PathType Leaf)) {
        throw 'The installation does not contain update.bat. Download a complete release package first.'
    }
    return $manifest
}

function Get-Checksum([string]$ChecksumText) {
    $match = [regex]::Match($ChecksumText, '(?im)\b([0-9a-f]{64})\b')
    if (-not $match.Success) { throw 'The SHA-256 file does not contain a valid checksum.' }
    return $match.Groups[1].Value.ToUpperInvariant()
}

$root = Get-NormalizedPath $InstallRoot
$currentManifest = Assert-ProjectRoot $root
$currentVersion = Get-Version $currentManifest.version
$parent = Split-Path -Parent $root
$workRoot = Join-Path $env:TEMP ("bpl-update-" + [guid]::NewGuid().ToString('N'))
$stagingRoot = Join-Path $parent ('.bpl-staging-' + [guid]::NewGuid().ToString('N'))
$backupRoot = Join-Path $parent ('.bpl-backup-' + [guid]::NewGuid().ToString('N'))
$swapped = $false
$operation = 'starting update'

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

    $operation = 'checking GitHub for the latest release'
    Write-Host "Checking GitHub for the latest release..."
    $release = Invoke-RestMethod -Uri $LatestReleaseApi -Headers @{
        'Accept' = 'application/vnd.github+json'
        'User-Agent' = "$ProjectName-updater"
    } -UseBasicParsing
    if (-not $release -or $release.draft -or $release.prerelease) {
        throw 'The latest GitHub release is unavailable.'
    }

    $zipAsset = Get-ReleaseAsset $release '^bilibili-music-player-v\d+\.\d+\.\d+\.zip$'
    $releaseVersion = Get-Version $zipAsset.name
    if ($releaseVersion -eq $currentVersion) {
        Write-Host ("Already up to date: v{0}" -f $currentManifest.version)
        exit 0
    }
    if ($releaseVersion -lt $currentVersion) {
        Write-Host ("Local version v{0} is newer than the latest release v{1}. Downgrade skipped." -f $currentManifest.version, $releaseVersion)
        exit 0
    }

    $checksumAsset = Get-ReleaseAsset $release (('^' + [regex]::Escape($zipAsset.name) + '\.sha256$'))
    $zipPath = Join-Path $workRoot $zipAsset.name
    $checksumPath = Join-Path $workRoot ($zipAsset.name + '.sha256')
    $unpackRoot = Join-Path $workRoot 'unpack'

    $operation = 'downloading the release package'
    Write-Host ("Downloading v{0}..." -f $releaseVersion)
    Invoke-WebRequest -Uri $zipAsset.browser_download_url -OutFile $zipPath -UseBasicParsing
    $operation = 'downloading the package checksum'
    Invoke-WebRequest -Uri $checksumAsset.browser_download_url -OutFile $checksumPath -UseBasicParsing

    $expectedHash = Get-Checksum (Get-Content -LiteralPath $checksumPath -Raw -Encoding ASCII)
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToUpperInvariant()
    if ($expectedHash -ne $actualHash) {
        throw "SHA-256 verification failed. Expected $expectedHash, got $actualHash."
    }
    Write-Host 'Package checksum verified.'

    Expand-Archive -LiteralPath $zipPath -DestinationPath $unpackRoot -Force
    $manifestFiles = @(Get-ChildItem -LiteralPath $unpackRoot -Filter 'manifest.json' -File -Recurse)
    if ($manifestFiles.Count -ne 1) { throw 'The package must contain exactly one manifest.json.' }
    $packageRoot = Split-Path -Parent $manifestFiles[0].FullName
    $newManifest = Read-Manifest $manifestFiles[0].FullName
    if ($newManifest.manifest_version -ne 3 -or
        -not $newManifest.background -or
        $newManifest.background.service_worker -ne 'src/background/background.js') {
        throw 'The downloaded package is not this extension.'
    }
    $newVersion = Get-Version $newManifest.version
    if ($newVersion -lt $currentVersion) {
        Write-Host ("The downloaded package v{0} is older than local v{1}. Downgrade skipped." -f $newManifest.version, $currentManifest.version)
        exit 0
    }
    if ($newVersion -eq $currentVersion) {
        Write-Host ("The downloaded package is already installed: v{0}" -f $currentManifest.version)
        exit 0
    }
    foreach ($required in @('update.bat', 'scripts\update.ps1', 'src\rename\renamer.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $required) -PathType Leaf)) {
            throw "The package is incomplete: $required"
        }
    }

    $operation = 'preserving user rules'
    $preservedRoot = Join-Path $workRoot 'preserved'
    foreach ($relative in $PreserveRelativePaths) {
        $source = Join-Path $root $relative
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            $destination = Join-Path $preservedRoot $relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination -Force
        }
    }

    $operation = 'preparing the new files'
    New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
    Copy-Item -Path (Join-Path $packageRoot '*') -Destination $stagingRoot -Recurse -Force
    foreach ($relative in $PreserveRelativePaths) {
        $saved = Join-Path $preservedRoot $relative
        if (Test-Path -LiteralPath $saved -PathType Leaf) {
            $destination = Join-Path $stagingRoot $relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
            Copy-Item -LiteralPath $saved -Destination $destination -Force
        }
    }

    $operation = 'installing the new files'
    Write-Host ("Installing v{0}..." -f $newManifest.version)
    Move-Item -LiteralPath $root -Destination $backupRoot
    Move-Item -LiteralPath $stagingRoot -Destination $root
    $swapped = $true

    $operation = 'validating the installed files'
    $installedManifest = Assert-ProjectRoot $root
    if ((Get-Version $installedManifest.version) -ne $newVersion) {
        throw 'The installed package version did not pass validation.'
    }

    $operation = 'cleaning the temporary backup'
    Remove-Item -LiteralPath $backupRoot -Recurse -Force
    Write-Host ''
    Write-Host ("Update complete: v{0} -> v{1}" -f $currentManifest.version, $installedManifest.version)
    Write-Host 'Please restart the browser or reload the extension from the extensions page.'
} catch {
    if ($swapped -and (Test-Path -LiteralPath $root)) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $backupRoot) {
        Move-Item -LiteralPath $backupRoot -Destination $root -Force -ErrorAction SilentlyContinue
    }
    $message = [string]$_.Exception.Message
    $isPermissionError = $_.Exception -is [UnauthorizedAccessException] -or
        $message -match '(?i)access is denied|unauthorized|拒绝访问'
    $isNetworkOperation = $operation -match '(?i)GitHub|downloading|checksum'
    if ($isPermissionError) {
        Write-Error ("Update failed because permission was denied while {0}. Check the extension directory permissions or move it to a user-writable folder. Details: {1}" -f $operation, $message)
    } elseif ($isNetworkOperation) {
        Write-Error ("Update failed while {0}. Check the network connection and try again. Details: {1}" -f $operation, $message)
    } else {
        Write-Error ("Update failed while {0}. Details: {1}" -f $operation, $message)
    }
    exit 1
} finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $workRoot) {
        Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
