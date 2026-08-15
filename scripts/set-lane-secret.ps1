[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateSet('A', 'B', 'C')]
    [string]$Lane,

    [Parameter(Mandatory)]
    [ValidatePattern('^https://')]
    [string]$ApiBase,

    [string[]]$Repositories = @(
        'TshyGO/ci-central',
        'TshyGO/NebulaLab',
        'TshyGO/NebulaLab-Docs',
        'TshyGO/NebulaLab-Plugins'
    )
)

$ErrorActionPreference = 'Stop'
$keyName = "PR_AGENT_LANE_${Lane}_KEY"
$baseName = "PR_AGENT_LANE_${Lane}_API_BASE"
$secureKey = Read-Host "Enter the new Lane $Lane API key" -AsSecureString
$key = [System.Net.NetworkCredential]::new('', $secureKey).Password

try {
    if ([string]::IsNullOrWhiteSpace($key)) {
        throw 'The API key must not be empty.'
    }
    foreach ($repository in $Repositories) {
        if ($repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
            throw "Invalid repository identifier: $repository"
        }
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
