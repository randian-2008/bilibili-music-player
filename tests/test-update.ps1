param(
    [string]$Scenario,
    [string]$FixtureRoot
)

$ErrorActionPreference = 'Stop'
# npm can inherit a PowerShell 7 module path while launching Windows PowerShell.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -Force
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Archive/Microsoft.PowerShell.Archive.psd1') -Force
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-FixturePath([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($FixtureRoot).TrimEnd('\', '/') + '\'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Test operation outside the isolated fixture: $resolved"
    }
}

if ($Scenario) {
    # Each case runs in a separate Windows PowerShell process, using actual ZIPs and
    # file operations. Only GitHub I/O and the selected failure point are mocked.
    $caseRoot = Join-Path $FixtureRoot $Scenario
    $install = Join-Path $caseRoot 'installed player'
    $package = Join-Path $caseRoot 'package'
    $env:TEMP = Join-Path $caseRoot 'temp'
    New-Item -ItemType Directory -Force -Path $install,$package,$env:TEMP | Out-Null
    $baseZip = Join-Path $FixtureRoot 'output/bilibili-music-player-v9.9.9.zip'
    Expand-Archive -LiteralPath $baseZip -DestinationPath $install
    Expand-Archive -LiteralPath $baseZip -DestinationPath $package
    $manifestPath = Join-Path $install 'manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $localVersion = switch ($Scenario) { 'same' { '9.9.9' }; 'newer' { '10.0.0' }; default { '1.0.0' } }
    $manifest.version = $localVersion
    $manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $install 'old-only.txt') -Value 'old file' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $install 'src/rename/rules.json') -Value '{"rules":[],"user":true}' -Encoding ASCII
    if ($Scenario -eq 'source-directory') {
        New-Item -ItemType Directory -Path (Join-Path $install '.git') | Out-Null
    }
    if ($Scenario -eq 'source-file') { Set-Content -LiteralPath (Join-Path $install '.git') -Value 'gitdir: elsewhere' }
    $missing = switch ($Scenario) {
        'missing-background' { 'src/background/background.js' }
        'missing-html-dependency' { 'src/player/offscreen.js' }
        'missing-import' { 'src/charts/matcher.js' }
        'missing-css' { 'src/panel/sidepanel.css' }
    }
    if ($missing) { Remove-Item -LiteralPath (Join-Path $package $missing) }
    if ($Scenario -eq 'wrong-version') {
        $newManifest = Get-Content -LiteralPath (Join-Path $package 'manifest.json') -Raw | ConvertFrom-Json
        $newManifest.version = '9.9.8'
        $newManifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $package 'manifest.json') -Encoding UTF8
    }
    $zip = Join-Path $caseRoot 'bilibili-music-player-v9.9.9.zip'
    Compress-Archive -Path (Join-Path $package '*') -DestinationPath $zip
    $checksum = $zip + '.sha256'
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash
    if ($Scenario -eq 'checksum') { $hash = '0' * 64 }
    Set-Content -LiteralPath $checksum -Value $hash -Encoding ASCII
    $script:requests = 0
    $script:downloads = 0
    function Invoke-RestMethod {
        param($Uri, $Headers, [switch]$UseBasicParsing)
        $script:requests++
        if ($Scenario -eq 'network') { throw 'Simulated network failure' }
        return [pscustomobject]@{ draft=$false; prerelease=$false; assets=@(
            [pscustomobject]@{name='bilibili-music-player-v9.9.9.zip';browser_download_url=$zip},
            [pscustomobject]@{name='bilibili-music-player-v9.9.9.zip.sha256';browser_download_url=$checksum}
        ) }
    }
    function Invoke-WebRequest {
        param($Uri, $OutFile, [switch]$UseBasicParsing)
        $script:downloads++
        Assert-FixturePath $OutFile
        Copy-Item -LiteralPath $Uri -Destination $OutFile
    }
    function Move-Item {
        [CmdletBinding()]
        param([string]$LiteralPath, [string]$Destination, [switch]$Force)
        Assert-FixturePath $LiteralPath
        Assert-FixturePath $Destination
        $leaf = Split-Path -Leaf $LiteralPath
        if ($leaf -like '.bpl-staging-*' -and $Scenario -in @('stage-failure', 'rollback-failure')) {
            throw 'Simulated staging move failure'
        }
        if ($leaf -like '.bpl-backup-*' -and $Scenario -eq 'rollback-failure') {
            throw 'Simulated rollback move failure'
        }
        Microsoft.PowerShell.Management\Move-Item @PSBoundParameters
        if ($leaf -like '.bpl-staging-*' -and $Scenario -eq 'installed-validation') {
            Microsoft.PowerShell.Management\Remove-Item -LiteralPath (Join-Path $Destination 'src/background/background.js')
        }
    }
    function Remove-Item {
        [CmdletBinding()]
        param([string]$LiteralPath, [switch]$Recurse, [switch]$Force)
        Assert-FixturePath $LiteralPath
        if ((Split-Path -Leaf $LiteralPath) -like '.bpl-backup-*' -and $Scenario -eq 'cleanup-failure') {
            Microsoft.PowerShell.Management\Remove-Item -LiteralPath (Join-Path $LiteralPath 'src/background/background.js')
            throw [UnauthorizedAccessException]::new('Simulated partial backup cleanup failure')
        }
        Microsoft.PowerShell.Management\Remove-Item @PSBoundParameters
    }
    $failure = ''
    $warnings = @()
    try {
        & (Join-Path $projectRoot 'scripts/update.ps1') -InstallRoot $install -WarningVariable warnings
    } catch { $failure = $_.Exception.Message }
    $backups = @(Get-ChildItem -LiteralPath $caseRoot -Directory -Force | Where-Object Name -Like '.bpl-backup-*')
    if ($Scenario -eq 'rollback-failure') {
        Assert ($failure -match 'Rollback failed:' -and $failure -match '\.bpl-backup-') 'Rollback failure must explain the backup location.'
        Assert ($backups.Count -eq 1) 'Failed recovery must preserve the original backup.'
        Assert (Test-Path -LiteralPath (Join-Path $backups[0].FullName 'src/background/background.js')) 'The recovery backup must still be complete.'
    } else {
        $actualVersion = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).version
        Assert (Test-Path -LiteralPath (Join-Path $install 'src/background/background.js')) 'A usable background must survive.'
        Assert ((Get-Content -LiteralPath (Join-Path $install 'src/rename/rules.json') -Raw) -match '"user":true') 'User rules must survive.'
        if ($Scenario -in @('normal', 'cleanup-failure')) {
            Assert (-not $failure -and $actualVersion -eq '9.9.9') 'Successful installation must keep the new version.'
            Assert (-not (Test-Path -LiteralPath (Join-Path $install 'old-only.txt'))) 'Full update must remove obsolete runtime files.'
            if ($Scenario -eq 'cleanup-failure') {
                Assert ($backups.Count -eq 1 -and $warnings.Count -gt 0) 'Cleanup failure must leave a warning and the remaining backup.'
            } else { Assert ($backups.Count -eq 0) 'Normal update should clean its backup.' }
        } else {
            Assert ($actualVersion -eq $localVersion) 'A rejected update must preserve the old version.'
            Assert (Test-Path -LiteralPath (Join-Path $install 'old-only.txt')) 'A rejected update must preserve all old files.'
            if ($Scenario -in @('same','newer')) {
                Assert (-not $failure -and $script:downloads -eq 0) 'Equal or newer local versions must skip downloads.'
            } else { Assert ([bool]$failure) 'The failure scenario must report an error.' }
            if ($Scenario -like 'source-*') {
                Assert ($script:requests -eq 0 -and (Test-Path -LiteralPath (Join-Path $install '.git'))) 'Source checkout must be rejected before network requests.'
            }
        }
    }
    Write-Host "PASS updater: $Scenario"
    exit 0
}

$FixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('bpl-update-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $FixtureRoot | Out-Null
try {
    $source = Join-Path $FixtureRoot 'bilibili-music-player'
    New-Item -ItemType Directory -Path $source | Out-Null
    foreach ($name in @('src','assets','scripts','docs','LICENSE','manifest.json','update.bat')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $source -Recurse
    }
    $manifestPath = Join-Path $source 'manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $manifest.version = '9.9.9'
    $manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    # JS tests have their own CI job; this suite exercises packaging and deployment.
    function npm.cmd { $global:LASTEXITCODE = 0 }
    $packageScript = Join-Path $source 'scripts/package.ps1'
    $sourceHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
    foreach ($output in @($FixtureRoot, (Join-Path $source 'release'))) {
        $failure = ''
        try { & $packageScript -OutputRoot $output } catch { $failure = $_.Exception.Message }
        Assert ($failure -match 'overlap') 'A source-overlapping output directory must be rejected.'
        Assert ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash -eq $sourceHash) 'Output rejection must leave sources intact.'
    }
    $checkoutOutput = Join-Path $FixtureRoot 'checkout-output'
    $checkoutGit = Join-Path $checkoutOutput 'bilibili-music-player/.git'
    New-Item -ItemType Directory -Force -Path $checkoutGit | Out-Null
    $failure = ''
    try { & $packageScript -OutputRoot $checkoutOutput } catch { $failure = $_.Exception.Message }
    Assert ($failure -match 'Git checkout' -and (Test-Path -LiteralPath $checkoutGit)) 'Packaging must not overwrite another source checkout.'
    $junctionOutput = Join-Path $FixtureRoot 'junction-output'
    New-Item -ItemType Junction -Path $junctionOutput -Target $source | Out-Null
    try {
        $failure = ''
        try { & $packageScript -OutputRoot $junctionOutput } catch { $failure = $_.Exception.Message }
        Assert ($failure -match 'junction') 'Packaging must reject a source reached through a junction.'
    } finally {
        # Delete the junction itself; never recursively remove its target.
        [IO.Directory]::Delete($junctionOutput)
    }
    $missingPath = Join-Path $source 'src/player/offscreen.js'
    $savedPath = Join-Path $FixtureRoot 'saved-offscreen.js'
    Move-Item -LiteralPath $missingPath -Destination $savedPath
    try {
        $failure = ''
        try { & $packageScript -OutputRoot (Join-Path $FixtureRoot 'incomplete-output') } catch { $failure = $_.Exception.Message }
        Assert ([bool]$failure) 'Packaging must fail when a required runtime file is missing.'
        Assert (-not (Test-Path -LiteralPath (Join-Path $FixtureRoot 'incomplete-output/bilibili-music-player-v9.9.9.zip'))) 'Incomplete packages must not produce release ZIPs.'
    } finally { Move-Item -LiteralPath $savedPath -Destination $missingPath }
    $output = Join-Path $FixtureRoot 'output'
    & $packageScript -OutputRoot $output
    $zip = Join-Path $output 'bilibili-music-player-v9.9.9.zip'
    Assert (Test-Path -LiteralPath $zip) 'Packaging must create a ZIP.'
    $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    Assert ((Get-Content -LiteralPath ($zip + '.sha256') -Raw) -match $hash) 'The checksum must match the ZIP.'
    Write-Host 'PASS package: source protection, dependency validation and ZIP checksum'
    foreach ($case in @('normal','same','newer','network','checksum','missing-background','missing-html-dependency',
        'missing-import','missing-css','wrong-version','stage-failure','installed-validation','rollback-failure',
        'cleanup-failure','source-directory','source-file')) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Scenario $case -FixtureRoot $FixtureRoot
        if ($LASTEXITCODE -ne 0) { throw "Updater regression failed: $case" }
    }
    Write-Host 'All Windows updater and package regression tests passed.'
} finally {
    $resolved = [IO.Path]::GetFullPath($FixtureRoot)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + '\'
    if ($resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolved) -like 'bpl-update-tests-*') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
