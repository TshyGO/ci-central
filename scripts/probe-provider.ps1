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
    $models = @($laneConfig.primary) + @($laneConfig.fallbacks | Where-Object { $null -ne $_ })
    Write-Host "Probing Lane $Lane provider=$($laneConfig.provider) protocol=$($laneConfig.protocol) models=$($models.id -join ',')"

    $available = $null
    foreach ($modelConfig in $models) {
        $model = $modelConfig.id
        # A fallback may name its own protocol; it still uses this Lane's key.
        $protocol = if ([string]::IsNullOrWhiteSpace($modelConfig.protocol)) { $laneConfig.protocol } else { $modelConfig.protocol }
        $session = "central-provider-probe-lane-$Lane"
        if ($protocol -eq 'openai-chat-completions') {
            $headers = @{ Authorization = "Bearer $key"; 'User-Agent' = 'NebulaLab-CI-Review/1.0'; 'x-opencode-session' = $session }
            if ($null -eq $available) {
                $available = @()
                try {
                    $modelsResponse = Invoke-RestMethod -Method Get -Uri "$base/models" -Headers $headers -TimeoutSec 30
                    $available = @($modelsResponse.data.id)
                }
                catch {
                    if ($laneConfig.provider -ne 'volcengine-ark-coding') { throw }
                    Write-Warning "GET /models failed for Volcengine Ark Coding; continuing with the generation probe: $($_.Exception.Message)"
                }
            }
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
            $final = $result.choices[0].message.content
        }
        elseif ($protocol -eq 'openai-responses') {
            $headers = @{ Authorization = "Bearer $key"; 'User-Agent' = 'NebulaLab-CI-Review/1.0'; 'x-opencode-session' = $session }
            $request = @{ model = $model; max_output_tokens = 2048; store = $false; input = 'Reply with OK.' }
            $result = Invoke-RestMethod -Method Post -Uri "$base/responses" -Headers $headers -ContentType 'application/json' -Body ($request | ConvertTo-Json -Depth 6) -TimeoutSec 120
            if ($result.status -ne 'completed') { throw "Probe returned no complete final content for $model." }
            $final = @($result.output | Where-Object type -EQ 'message' | ForEach-Object content | Where-Object type -EQ 'output_text' | ForEach-Object text) -join "`n"
        }
        elseif ($protocol -eq 'anthropic-messages') {
            # Go's Messages endpoint authenticates with x-api-key, not a bearer token.
            $headers = @{ 'x-api-key' = $key; 'anthropic-version' = '2023-06-01'; 'User-Agent' = 'NebulaLab-CI-Review/1.0'; 'x-opencode-session' = $session }
            $request = @{ model = $model; max_tokens = 2048; thinking = @{ type = 'adaptive' }; messages = @(@{ role = 'user'; content = 'Reply with OK.' }) }
            if (-not [string]::IsNullOrWhiteSpace($modelConfig.effort)) { $request.output_config = @{ effort = $modelConfig.effort } }
            $result = Invoke-RestMethod -Method Post -Uri "$base/messages" -Headers $headers -ContentType 'application/json' -Body ($request | ConvertTo-Json -Depth 6) -TimeoutSec 120
            if ($result.stop_reason -ne 'end_turn') { throw "Probe returned no complete final content for $model." }
            $final = @($result.content | Where-Object type -EQ 'text' | ForEach-Object text) -join "`n"
        }
        elseif ($protocol -eq 'google-generate-content') {
            # Go serves Gemini only under /inference/go/v1; the Lane base names /zen/go/v1.
            $googleBase = if ($laneConfig.provider -eq 'opencode-go') { $base -replace '^https://opencode\.ai/zen/go/v1$', 'https://opencode.ai/inference/go/v1' } else { $base }
            $headers = @{ 'x-goog-api-key' = $key }
            if ($laneConfig.provider -eq 'opencode-go') { $headers['x-opencode-session'] = $session }
            # A high-thinking Gemini probe needs enough completion room to reach final text;
            # tiny ceilings can be consumed entirely by private reasoning.
            $generationConfig = @{ maxOutputTokens = 2048 }
            if (-not [string]::IsNullOrWhiteSpace($modelConfig.thinking_level)) {
                $generationConfig.thinkingConfig = @{
                    thinkingLevel = $modelConfig.thinking_level.ToUpperInvariant()
                }
            }
            $body = @{
                contents = @(@{ role = 'user'; parts = @(@{ text = 'Reply with OK.' }) })
                generationConfig = $generationConfig
            } | ConvertTo-Json -Depth 8
            $escapedModel = [Uri]::EscapeDataString($model)
            $result = Invoke-RestMethod -Method Post -Uri "$googleBase/models/${escapedModel}:generateContent" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 120
            $final = @($result.candidates[0].content.parts | Where-Object thought -NE $true | ForEach-Object text) -join "`n"
        }
        else {
            throw "Unsupported protocol: $protocol"
        }
        if ([string]::IsNullOrWhiteSpace($final)) { throw "Probe returned no final content for $model." }
        Write-Host "Lane $Lane model $model ($protocol) probe succeeded."
    }
    Write-Host "Lane $Lane provider probe succeeded."
}
finally {
    $key = $null
    $secureKey.Dispose()
}
