param(
  [string]$ApiBaseUrl = 'http://localhost:8091'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot '.env'

if (-not (Test-Path -LiteralPath $envPath)) {
  throw "No se encontró $envPath. Copia .env.example a .env y define las credenciales bootstrap requeridas."
}

$envValues = @{}
foreach ($line in Get-Content -LiteralPath $envPath) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
    $value = $Matches[2]
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $envValues[$Matches[1]] = $value
  }
}

$adminUsername = $envValues['BOOTSTRAP_ADMIN_USER']
$adminPassword = $envValues['BOOTSTRAP_ADMIN_PASSWORD']
if ([string]::IsNullOrWhiteSpace($adminUsername) -or [string]::IsNullOrWhiteSpace($adminPassword)) {
  throw '.env debe definir BOOTSTRAP_ADMIN_USER y BOOTSTRAP_ADMIN_PASSWORD.'
}

function Invoke-JsonApi {
  param(
    [Parameter(Mandatory)][string]$Method,
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)]$Body,
    [string]$Token
  )
  $headers = @{}
  if ($Token) { $headers.Authorization = "Bearer $Token" }
  $json = ConvertTo-Json -InputObject $Body -Depth 8 -Compress
  try {
    return Invoke-RestMethod -Uri "$ApiBaseUrl$Path" -Method $Method -ContentType 'application/json' -Headers $headers -Body $json
  } catch {
    $detail = $_.ErrorDetails.Message
    if ([string]::IsNullOrWhiteSpace($detail)) { $detail = $_.Exception.Message }
    throw "Falló $Method $($Path): $detail"
  }
}

function New-RandomPassword {
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = [byte[]]::new(32)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $password = -join ($bytes | ForEach-Object { $alphabet[[int]$_ % $alphabet.Length] })
  return "$password`!a7"
}

$session = Invoke-JsonApi -Method 'POST' -Path '/auth/login' -Body @{ username = $adminUsername; password = $adminPassword }
if ([string]::IsNullOrWhiteSpace($session.token)) { throw 'El login bootstrap no devolvió un token.' }
$token = $session.token
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$commerceId = "comercio:demo_p15_$suffix"
$now = [DateTime]::UtcNow.ToString('o')

$null = Invoke-JsonApi -Method 'PUT' -Path "/api/docs/$([Uri]::EscapeDataString($commerceId))" -Token $token -Body @{
  _id = $commerceId
  type = 'comercio'
  nombre = "Comercio de prueba P15 $suffix"
  giro = 'Comercio de prueba'
  zona = 'Zona de demostración'
  activo = $true
  creado_en = $now
}

$accounts = @(
  @{ suffix = 'admin'; role = 'admin_plataforma'; commerce = $null },
  @{ suffix = 'operaciones'; role = 'operador_acopio'; commerce = $null },
  @{ suffix = 'recolector'; role = 'recolector'; commerce = $null },
  @{ suffix = 'comercio'; role = 'comercio'; commerce = $commerceId }
)
$credentials = foreach ($account in $accounts) {
  $username = "demo_p15_$($account.suffix)_$suffix"
  $password = New-RandomPassword
  $body = @{ username = $username; password = $password; role = $account.role }
  if ($account.commerce) { $body.comercio_id = $account.commerce }
  $null = Invoke-JsonApi -Method 'POST' -Path '/api/users' -Token $token -Body $body
  [pscustomobject]@{
    Rol = $account.role
    Usuario = $username
    Contraseña = $password
    Comercio = if ($account.commerce) { $account.commerce } else { '—' }
  }
}

Write-Host "Cuentas creadas. Comercio asociado: $commerceId"
Write-Host 'Guarda estas credenciales ahora; no se escriben en .env ni en archivos.'
$credentials | Format-Table -AutoSize -Wrap
