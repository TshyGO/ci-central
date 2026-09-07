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
$configPath = Join-Path $PSScriptRoot '..' 'review-action' 'config' 'repositories' $configName
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
    $models = @($laneConfig.primary) + @($laneConfig.fallbacks)
    Write-Host "Probing Lane $Lane provider=$($laneConfig.provider) protocol=$($laneConfig.protocol) models=$($models.id -join ',')"

    if ($laneConfig.protocol -eq 'openai-chat-completions') {
        $headers = @{ Authorization = "Bearer $key" }
        $available = @()
        try {
            $modelsResponse = Invoke-RestMethod -Method Get -Uri "$base/models" -Headers $headers -TimeoutSec 30
            $available = @($modelsResponse.data.id)
        }
        catch {
            if ($laneConfig.provider -ne 'volcengine-ark-coding') { throw }
            Write-Warning "GET /models failed for Volcengine Ark Coding; continuing with the generation probe: $($_.Exception.Message)"
        }

        foreach ($modelConfig in $models) {
            $model = $modelConfig.id
            if ($available.Count -gt 0 -and $model -notin $available) {
                if ($laneConfig.provider -ne 'volcengine-ark-coding') {
                    throw "Model $model is not present in the provider model list."
                }
                Write-Warning "Model $model is not present in the Volcengine Ark Coding model list; continuing with the generation probe because the Coding API may omit callable aliases."
            }
            $request = @{ model = $model; messages = @(@{ role = 'user'; content = 'Reply with OK.' }); stream = $false }
            # Reasoning models can spend a tiny ceiling entirely on hidden reasoning and
            # return no final text. Give the one-time probe enough room to prove usable output.
            if (-not $modelConfig.omit_max_tokens) { $request.max_tokens = 512 }
            $body = $request | ConvertTo-Json -Depth 6
            $result = Invoke-RestMethod -Method Post -Uri "$base/chat/completions" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 60
            if ([string]::IsNullOrWhiteSpace($result.choices[0].message.content)) { throw "Probe returned no final content for $model." }
            Write-Host "Lane $Lane model $model probe succeeded."
        }
    }
    elseif ($laneConfig.protocol -eq 'google-generate-content') {
        $headers = @{ 'x-goog-api-key' = $key }
        # A high-thinking Gemini probe needs enough completion room to reach final text;
        # tiny ceilings can be consumed entirely by private reasoning.
        $generationConfig = @{ maxOutputTokens = 512 }
        if (-not [string]::IsNullOrWhiteSpace($laneConfig.primary.thinking_level)) {
            $generationConfig.thinkingConfig = @{
                thinkingLevel = $laneConfig.primary.thinking_level.ToUpperInvariant()
            }
        }
        $body = @{
            contents = @(@{ role = 'user'; parts = @(@{ text = 'Reply with OK.' }) })
            generationConfig = $generationConfig
        } | ConvertTo-Json -Depth 8
        $escapedModel = [Uri]::EscapeDataString($model)
        $result = Invoke-RestMethod -Method Post -Uri "$base/models/${escapedModel}:generateContent" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 60
        $final = @($result.candidates[0].content.parts | Where-Object thought -NE $true | ForEach-Object text) -join "`n"
        if ([string]::IsNullOrWhiteSpace($final)) { throw 'Probe returned no final content.' }
    }
    else {
        throw "Unsupported protocol: $($laneConfig.protocol)"
    }
    Write-Host "Lane $Lane provider probe succeeded."
}
finally {
    $key = $null
    $secureKey.Dispose()
}
