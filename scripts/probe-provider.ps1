[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('A', 'B', 'C')]
    [string]$Lane,

    [string]$Repository = 'TshyGO/NebulaLab',

    [Parameter(Mandatory)]
    [ValidatePattern('^https://')]
    [string]$ApiBase
)

$ErrorActionPreference = 'Stop'
$configName = $Repository.Replace('/', '__') + '.json'
$configPath = Join-Path $PSScriptRoot "..\review-action\config\repositories\$configName"
if (-not (Test-Path -LiteralPath $configPath)) { throw "No central config exists for $Repository." }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$laneConfig = @($config.lanes | Where-Object id -EQ $Lane)
if ($laneConfig.Count -ne 1) { throw "Repository config must contain exactly one Lane $Lane." }
$laneConfig = $laneConfig[0]
$secureKey = Read-Host "Enter the Lane $Lane API key for a one-time probe" -AsSecureString
$key = [System.Net.NetworkCredential]::new('', $secureKey).Password

try {
    if ([string]::IsNullOrWhiteSpace($key)) { throw 'The API key must not be empty.' }
    $base = $ApiBase.TrimEnd('/')
    $model = $laneConfig.primary.id
    Write-Host "Probing Lane $Lane provider=$($laneConfig.provider) protocol=$($laneConfig.protocol) model=$model"

    if ($laneConfig.protocol -eq 'openai-chat-completions') {
        $headers = @{ Authorization = "Bearer $key" }
        $modelsResponse = Invoke-RestMethod -Method Get -Uri "$base/models" -Headers $headers -TimeoutSec 30
        $available = @($modelsResponse.data.id)
        if ($available.Count -gt 0 -and $model -notin $available) { throw "Primary model $model is not present in the provider model list." }
        $body = @{ model = $model; messages = @(@{ role = 'user'; content = 'Reply with OK.' }); max_tokens = 16; stream = $false } | ConvertTo-Json -Depth 6
        $result = Invoke-RestMethod -Method Post -Uri "$base/chat/completions" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 60
        if ([string]::IsNullOrWhiteSpace($result.choices[0].message.content)) { throw 'Probe returned no final content.' }
    }
    elseif ($laneConfig.protocol -eq 'google-generate-content') {
        $headers = @{ 'x-goog-api-key' = $key }
        $body = @{ contents = @(@{ role = 'user'; parts = @(@{ text = 'Reply with OK.' }) }); generationConfig = @{ maxOutputTokens = 16 } } | ConvertTo-Json -Depth 8
        $escapedModel = [Uri]::EscapeDataString($model)
        $result = Invoke-RestMethod -Method Post -Uri "$base/models/${escapedModel}:generateContent" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 60
        $final = @($result.candidates[0].content.parts | Where-Object thought -NE $true | ForEach-Object text) -join "`n"
        if ([string]::IsNullOrWhiteSpace($final)) { throw 'Probe returned no final content.' }
    }
    else {
        throw "Unsupported protocol: $($laneConfig.protocol)"
    }
    Write-Host "Lane $Lane probe succeeded."
}
finally {
    $key = $null
    $secureKey.Dispose()
}
