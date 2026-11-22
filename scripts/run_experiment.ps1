param(
  [ValidateSet('ideal', 'degradado', 'intermitente')]
  [string]$Profile = 'ideal',
  [ValidateRange(1, 500)]
  [int]$Vus = 10,
  [string]$Duration = '2m',
  [switch]$SkipQualityChecks
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$resultsDirectory = Join-Path $repoRoot 'results'
New-Item -ItemType Directory -Force -Path $resultsDirectory | Out-Null
$runId = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$Profile-vus$Vus"
$previousEnvironment = @{
  RUN_ID = $env:RUN_ID
  NETEM_PROFILE = $env:NETEM_PROFILE
  VUS = $env:VUS
  DURATION = $env:DURATION
}
$env:RUN_ID = $runId
$env:NETEM_PROFILE = $Profile
$env:VUS = [string]$Vus
$env:DURATION = $Duration
$netemApplied = $false
$locationPushed = $false

function Invoke-Compose([string[]]$ComposeArguments) {
  & docker compose @ComposeArguments
  if ($LASTEXITCODE -ne 0) { throw "docker compose falló: $($ComposeArguments -join ' ')" }
}

function Apply-Netem([string]$Service, [string]$NetemProfile) {
  Invoke-Compose @('run', '--rm', '-e', "NETEM_PROFILE=$NetemProfile", $Service)
}

function Get-RangeQuery([string]$PrometheusQuery, [long]$Start, [long]$End) {
  $escapedQuery = [uri]::EscapeDataString($PrometheusQuery)
  $url = "http://localhost:9090/api/v1/query_range?query=$escapedQuery&start=$Start&end=$End&step=5"
  Invoke-RestMethod -Uri $url -TimeoutSec 20
}

try {
  Push-Location $repoRoot
  $locationPushed = $true
  if (-not $SkipQualityChecks) {
    & docker build --target verify -t reciclaje-backend-verify ./backend
    if ($LASTEXITCODE -ne 0) { throw 'Falló build verify: incluye cargo test, cargo check y cargo clippy.' }
  }

  Invoke-Compose @('up', '-d', '--build', 'api', 'prometheus', 'cadvisor', 'client-sim')
  $prometheusReady = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      Invoke-RestMethod -Uri 'http://localhost:9090/-/ready' -TimeoutSec 3 | Out-Null
      Invoke-RestMethod -Uri 'http://localhost:8091/metrics' -TimeoutSec 3 | Out-Null
      $prometheusReady = $true
      break
    } catch { Start-Sleep -Seconds 2 }
  }
  if (-not $prometheusReady) { throw 'Prometheus o la ruta /metrics de la API no respondieron.' }

  $targetUp = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $target = Invoke-RestMethod -Uri 'http://localhost:9090/api/v1/query?query=up%7Bjob%3D%22api-rust%22%7D' -TimeoutSec 10
    if ($target.data.result.Count -gt 0 -and $target.data.result[0].value[1] -eq '1') { $targetUp = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $targetUp) {
    throw 'Prometheus todavía no scrapea api:8080; revisa http://localhost:9090/targets.'
  }

  Apply-Netem 'netem-api' $Profile
  $netemApplied = $true
  Apply-Netem 'netem-client' $Profile
  $startedAt = [DateTimeOffset]::UtcNow
  & docker compose --profile load run --rm k6
  $k6Exit = $LASTEXITCODE
  $endedAt = [DateTimeOffset]::UtcNow

  $startEpoch = $startedAt.ToUnixTimeSeconds()
  $endEpoch = $endedAt.ToUnixTimeSeconds()
  $queries = [ordered]@{
    api_request_rate = 'sum(rate(http_requests_total{route=~"/api/.*"}[1m]))'
    api_request_p95_seconds = 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{route=~"/api/.*"}[1m])))'
    api_cpu_cores = 'sum(rate(container_cpu_usage_seconds_total{container_label_com_docker_compose_service="api"}[1m]))'
    api_memory_working_set_bytes = 'sum(container_memory_working_set_bytes{container_label_com_docker_compose_service="api"})'
    cadvisor_scrape_up = 'up{job="cadvisor"}'
  }
  $queryResults = [ordered]@{}
  foreach ($entry in $queries.GetEnumerator()) {
    $queryResults[$entry.Key] = Get-RangeQuery $entry.Value $startEpoch $endEpoch
  }

  $metadata = [ordered]@{
    run_id = $runId
    network_profile = $Profile
    configured_vus = $Vus
    duration = $Duration
    started_at_utc = $startedAt.ToString('o')
    ended_at_utc = $endedAt.ToString('o')
    k6_exit_code = $k6Exit
    api_scrape_target = 'api:8080/metrics'
    results = $queryResults
  }
  $metadataPath = Join-Path $resultsDirectory "$runId-prometheus.json"
  $metadata | ConvertTo-Json -Depth 30 | Set-Content -Path $metadataPath -Encoding utf8
  Write-Host "Run ID: $runId"
  Write-Host "k6: $(Join-Path $resultsDirectory "$runId-k6.json")"
  Write-Host "Prometheus y cAdvisor: $metadataPath"
  if ($k6Exit -ne 0) { throw "k6 terminó con código $k6Exit; se conservaron los resultados para analizar la corrida." }
} finally {
  if ($netemApplied) {
    try { Apply-Netem 'netem-api' 'clear' } catch { Write-Warning 'No se pudo limpiar netem-api; ejecuta docker compose run --rm -e NETEM_PROFILE=clear netem-api.' }
    try { Apply-Netem 'netem-client' 'clear' } catch { Write-Warning 'No se pudo limpiar netem-client; ejecuta docker compose run --rm -e NETEM_PROFILE=clear netem-client.' }
  }
  if ($locationPushed) { Pop-Location }
  foreach ($name in $previousEnvironment.Keys) {
    if ($null -eq $previousEnvironment[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$name" $previousEnvironment[$name] }
  }
}
