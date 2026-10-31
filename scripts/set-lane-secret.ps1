[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateSet('A', 'B', 'C')]
    [string]$Lane,

    [Parameter(Mandatory)]
    [ValidatePattern('^https://')]
    [string]$ApiBase,

    [string[]]$Repositories = @(
        'ptjworks/ci-central',
        'TshyGO/NebulaLab',
        'ptjworks/NebulaLab-Docs',
        'ptjworks/NebulaLab-Plugins',
        'ptjworks/resume-form-assistant-plugin',
        'ptjworks/AI-Thesis-Polisher',
        'TshyGO/NebulaGraph-License-Service'
    )
)

$ErrorActionPreference = 'Stop'
$keyName = "PR_AGENT_LANE_${Lane}_KEY"
$baseName = "PR_AGENT_LANE_${Lane}_API_BASE"

# Check every target before asking for the key. A lane with credential_providers keeps a
# version-1 JSON bundle in its slots, and a plain key written there would disable the lane.
# GitHub names are case-insensitive, so configs are matched that way; a target without one
# has an unknown slot format and is refused as well.
$configDirectory = [System.IO.Path]::Combine($PSScriptRoot, '..', 'review-action', 'config', 'repositories')
if (-not (Test-Path -LiteralPath $configDirectory -PathType Container)) {
    throw "Central repository configs not found at $configDirectory. No secrets were written."
}
$configs = @{}
foreach ($file in Get-ChildItem -LiteralPath $configDirectory -Filter '*.json' -File) {
    $configs[$file.BaseName.ToLowerInvariant()] = $file.FullName
}
$bundled = @()
$unknown = @()
foreach ($repository in $Repositories) {
    if ($repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
        throw "Invalid repository identifier: $repository"
    }
    $configPath = $configs[($repository -replace '/', '__').ToLowerInvariant()]
    if (-not $configPath) {
        $unknown += $repository
        continue
    }
    $laneConfig = (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).lanes | Where-Object id -eq $Lane
    if ($laneConfig -and $laneConfig.PSObject.Properties['credential_providers']) { $bundled += $repository }
}
if ($unknown) {
    throw "No central config in review-action/config/repositories for $($unknown -join ', '), so its Lane $Lane slot format is unknown. No secrets were written."
}
if ($bundled) {
    throw "Lane $Lane uses a version-1 provider credential bundle in $($bundled -join ', '). This script writes a plain key and would disable it. Leave those repositories out with -Repositories and update their bundle as docs/nebulalab-openai-c-migration.md describes. No secrets were written."
}

$secureKey = Read-Host "Enter the new Lane $Lane API key" -AsSecureString
$key = [System.Net.NetworkCredential]::new('', $secureKey).Password

try {
    if ([string]::IsNullOrWhiteSpace($key)) {
        throw 'The API key must not be empty.'
    }
    foreach ($repository in $Repositories) {
        if ($PSCmdlet.ShouldProcess($repository, "set $keyName and $baseName")) {
            $key | & gh secret set $keyName --repo $repository --app actions
            if ($LASTEXITCODE -ne 0) { throw "Failed to set $keyName for $repository." }
            $ApiBase.TrimEnd('/') | & gh secret set $baseName --repo $repository --app actions
            if ($LASTEXITCODE -ne 0) { throw "Failed to set $baseName for $repository." }
            Write-Host "Updated Lane $Lane secret slots for $repository."
        }
    }
}
finally {
    $key = $null
    $secureKey.Dispose()
}
