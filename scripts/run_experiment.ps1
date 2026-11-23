param(
  [ValidateSet('ideal', 'degradado', 'intermitente')]
  [string]$Profile = 'ideal',
  [ValidateRange(1, 500)]
  [int]$Vus = 10,
  [string]$Duration = '2m',
  [switch]$InjectOutage,
  [switch]$SkipQualityChecks,
  [switch]$SkipOfflineSync
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$resultsDirectory = Join-Path $repoRoot 'results'
New-Item -ItemType Directory -Force -Path $resultsDirectory | Out-Null
$runId = "$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')-$Profile-vus$Vus"
$conditionSuffix = if ($InjectOutage) { '_outage' } else { '' }
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

function Get-K6MetricValue($Summary, [string]$MetricName, [string]$ValueName) {
  $metricProperty = $Summary.metrics.PSObject.Properties[$MetricName]
  if (-not $metricProperty) { return $null }
  $metric = $metricProperty.Value
  $valuesProperty = $metric.PSObject.Properties['values']
  if ($valuesProperty) { $metric = $valuesProperty.Value }
  $valueProperty = $metric.PSObject.Properties[$ValueName]
  if ($valueProperty) { return $valueProperty.Value }
  return $null
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
  $outageJob = $null
  if ($InjectOutage) {
    if ($Profile -eq 'corte') { throw 'Use -InjectOutage con ideal, degradado o intermitente; corte ya representa una desconexión completa.' }
    $outageJob = Start-Job -ArgumentList $repoRoot,$Profile -ScriptBlock {
      param($root,$restoreProfile)
      Set-Location $root
      function Invoke-JobCompose([string[]]$ComposeArguments) {
        & docker compose @ComposeArguments 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "docker compose falló: $($ComposeArguments -join ' ')" }
      }
      Start-Sleep -Seconds 20
      Invoke-JobCompose @('run', '--rm', '-e', 'NETEM_PROFILE=corte', 'netem-api')
      Invoke-JobCompose @('run', '--rm', '-e', 'NETEM_PROFILE=corte', 'netem-client')
      Start-Sleep -Seconds 15
      Invoke-JobCompose @('run', '--rm', '-e', "NETEM_PROFILE=$restoreProfile", 'netem-api')
      Invoke-JobCompose @('run', '--rm', '-e', "NETEM_PROFILE=$restoreProfile", 'netem-client')
    }
  }
  $startedAt = [DateTimeOffset]::UtcNow
  & docker compose --profile load run --rm k6
  $k6Exit = $LASTEXITCODE
  $endedAt = [DateTimeOffset]::UtcNow
  if ($outageJob) {
    Wait-Job $outageJob | Out-Null
    $outageState = $outageJob.State
    $outageReason = $outageJob.ChildJobs[0].JobStateInfo.Reason
    Receive-Job $outageJob -ErrorAction SilentlyContinue | Out-Null
    Remove-Job $outageJob -Force
    $outageJob = $null
    if ($outageState -ne 'Completed') {
      $reason = if ($outageReason) { $outageReason.Message } else { 'fallo sin detalle adicional' }
      throw "Falló la tarea de corte/restauración de red: $reason"
    }
  }

  $offlineSyncExit = $null
  $convergenceSeconds = $null
  if (-not $SkipOfflineSync) {
    if ($netemApplied) {
      Apply-Netem 'netem-api' 'clear'
      Apply-Netem 'netem-client' 'clear'
      $netemApplied = $false
    }
    # Windows PowerShell 5.1 converts native stderr into error records. Compose
    # writes harmless progress there, so capture it without letting the global
    # Stop preference abort before the exit code and convergence are recorded.
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $offlineOutput = @(& docker compose run --rm -e SIM_MODE=offline-sync client-sim 2>&1 | ForEach-Object { "$_" })
      $offlineSyncExit = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    $offlineOutput | ForEach-Object { Write-Host $_ }
    $offlineText = $offlineOutput -join "`n"
    $convergenceMatch = [regex]::Match($offlineText, 'CONVERGENCE_SECONDS=(?<seconds>[0-9]+(?:\.[0-9]+)?)')
    if ($offlineSyncExit -eq 0 -and $convergenceMatch.Success) {
      $convergenceSeconds = [double]::Parse($convergenceMatch.Groups['seconds'].Value, [Globalization.CultureInfo]::InvariantCulture)
    }
    elseif ($offlineSyncExit -eq 0) {
      $offlineSyncExit = 1
      Write-Warning 'client-sim terminó sin reportar CONVERGENCE_SECONDS; se conservarán los resultados de k6 y la corrida quedará marcada como incompleta.'
    }
  }

  $k6SummaryPath = Join-Path $resultsDirectory "$runId-k6.json"
  if (Test-Path $k6SummaryPath) {
    $k6Summary = Get-Content -Raw $k6SummaryPath | ConvertFrom-Json
    $summaryRow = [pscustomobject]@{
      run_id = $runId
      condition = "A1_${Profile}_vus${Vus}_$($Duration -replace '[^a-zA-Z0-9]', '')$conditionSuffix"
      profile = $Profile
      vus = $Vus
      duration = $Duration
      throughput_rps = Get-K6MetricValue $k6Summary 'http_reqs' 'rate'
      latency_avg_ms = Get-K6MetricValue $k6Summary 'http_req_duration' 'avg'
      latency_p95_ms = Get-K6MetricValue $k6Summary 'http_req_duration' 'p(95)'
      checks_passed = Get-K6MetricValue $k6Summary 'checks' 'passes'
      checks_failed = Get-K6MetricValue $k6Summary 'checks' 'fails'
      business_flow_success_rate = Get-K6MetricValue $k6Summary 'business_flow_success' 'value'
      http_failure_rate = Get-K6MetricValue $k6Summary 'http_req_failed' 'value'
      offline_sync_exit_code = $offlineSyncExit
      convergence_seconds = $convergenceSeconds
      k6_exit_code = $k6Exit
      started_at_utc = $startedAt.ToString('o')
      ended_at_utc = $endedAt.ToString('o')
    }
    $summaryPath = Join-Path $resultsDirectory 'observations.csv'
    if (Test-Path $summaryPath) {
      $existingRows = @(Import-Csv -Path $summaryPath)
      foreach ($row in $existingRows) {
        $priorSummaryPath = Join-Path $resultsDirectory "$($row.run_id)-k6.json"
        if (Test-Path $priorSummaryPath) {
          $priorSummary = Get-Content -Raw $priorSummaryPath | ConvertFrom-Json
          $row.throughput_rps = Get-K6MetricValue $priorSummary 'http_reqs' 'rate'
          $row.latency_avg_ms = Get-K6MetricValue $priorSummary 'http_req_duration' 'avg'
          $row.latency_p95_ms = Get-K6MetricValue $priorSummary 'http_req_duration' 'p(95)'
          $row.checks_passed = Get-K6MetricValue $priorSummary 'checks' 'passes'
          $row.checks_failed = Get-K6MetricValue $priorSummary 'checks' 'fails'
          Add-Member -InputObject $row -NotePropertyName business_flow_success_rate -NotePropertyValue (Get-K6MetricValue $priorSummary 'business_flow_success' 'value') -Force
          Add-Member -InputObject $row -NotePropertyName http_failure_rate -NotePropertyValue (Get-K6MetricValue $priorSummary 'http_req_failed' 'value') -Force
        }
        else {
          Add-Member -InputObject $row -NotePropertyName business_flow_success_rate -NotePropertyValue $null -Force
          Add-Member -InputObject $row -NotePropertyName http_failure_rate -NotePropertyValue $null -Force
        }
        Add-Member -InputObject $row -NotePropertyName offline_sync_exit_code -NotePropertyValue $null -Force
        Add-Member -InputObject $row -NotePropertyName convergence_seconds -NotePropertyValue $null -Force
      }
      @($existingRows) + @($summaryRow) | Export-Csv -Path $summaryPath -NoTypeInformation
    }
    else { $summaryRow | Export-Csv -Path $summaryPath -NoTypeInformation }
  }

  $startEpoch = $startedAt.ToUnixTimeSeconds()
  $endEpoch = $endedAt.ToUnixTimeSeconds()
  $queries = [ordered]@{
    api_request_rate = 'sum(rate(http_requests_total{route=~"/api/.*"}[1m]))'
    api_request_rate_by_route = 'sum by (route) (rate(http_requests_total{route=~"/api/.*"}[1m]))'
    api_request_p95_seconds_by_route = 'histogram_quantile(0.95, sum by (route, le) (rate(http_request_duration_seconds_bucket{route=~"/api/.*"}[1m])))'
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
    inject_outage = [bool]$InjectOutage
    started_at_utc = $startedAt.ToString('o')
    ended_at_utc = $endedAt.ToString('o')
    k6_exit_code = $k6Exit
    offline_sync_exit_code = $offlineSyncExit
    convergence_seconds = $convergenceSeconds
    api_scrape_target = 'api:8080/metrics'
    results = $queryResults
  }
  $metadataPath = Join-Path $resultsDirectory "$runId-prometheus.json"
  $metadata | ConvertTo-Json -Depth 30 | Set-Content -Path $metadataPath -Encoding utf8
  Write-Host "Run ID: $runId"
  Write-Host "k6: $(Join-Path $resultsDirectory "$runId-k6.json")"
  Write-Host "Prometheus y cAdvisor: $metadataPath"
  if (Test-Path (Join-Path $resultsDirectory 'observations.csv')) { Write-Host "Resumen acumulado: $(Join-Path $resultsDirectory 'observations.csv')" }
  if ($k6Exit -ne 0) { throw "k6 terminó con código $k6Exit; se conservaron los resultados para analizar la corrida." }
  if ($null -ne $offlineSyncExit -and $offlineSyncExit -ne 0) { throw "client-sim offline-sync terminó con código $offlineSyncExit; se conservaron los resultados de k6." }
} finally {
  if ($outageJob) {
    Wait-Job $outageJob | Out-Null
    Receive-Job $outageJob -ErrorAction SilentlyContinue
    Remove-Job $outageJob -Force -ErrorAction SilentlyContinue
  }
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
