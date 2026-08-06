[CmdletBinding()]
param([string]$ServerName = 'eprom-test.local')

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDirectory = Join-Path $scriptRoot 'data'
$configPath = Join-Path $dataDirectory 'homeserver.yaml'
$helperSecretPath = Join-Path $dataDirectory 'registration-helper-secret'
$accessCodePath = Join-Path $dataDirectory 'registration-access-code'

function Set-YamlValue([string]$Text, [string]$Key, [string]$Value) {
  $pattern = "(?m)^$([regex]::Escape($Key)):\s*.*$"
  $line = "${Key}: $Value"
  if ($Text -match $pattern) { return [regex]::Replace($Text, $pattern, $line, 1) }
  return $Text.TrimEnd() + [Environment]::NewLine + $line + [Environment]::NewLine
}

function Set-YamlSectionValue([string]$Text, [string]$Section, [string]$Key, [string]$Value) {
  $sectionPattern = "(?ms)^$([regex]::Escape($Section)):\s*(?:#.*)?\r?\n(?<body>(?:^[ \t]+.*(?:\r?\n|$))*)"
  $sectionMatch = [regex]::Match($Text, $sectionPattern)
  $keyPattern = "(?m)^[ \t]+$([regex]::Escape($Key)):\s*.*$"
  $line = "  ${Key}: $Value"
  if ($sectionMatch.Success) {
    $sectionText = $sectionMatch.Value
    if ($sectionText -match $keyPattern) {
      $updatedSection = [regex]::Replace($sectionText, $keyPattern, $line, 1)
    } else {
      $updatedSection = [regex]::Replace($sectionText, "(?m)^$([regex]::Escape($Section)):\s*(?:#.*)?$", "${Section}:`n$line", 1)
    }
    return $Text.Substring(0, $sectionMatch.Index) + $updatedSection + $Text.Substring($sectionMatch.Index + $sectionMatch.Length)
  }
  return $Text.TrimEnd() + [Environment]::NewLine + "${Section}:" + [Environment]::NewLine + $line + [Environment]::NewLine
}

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

Push-Location $scriptRoot
try {
  docker compose version | Out-Null
  New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null

  if (-not (Test-Path -LiteralPath $configPath)) {
    Write-Host 'Generowanie lokalnej konfiguracji serwera...'
    docker compose run --rm -e "SYNAPSE_SERVER_NAME=$ServerName" -e SYNAPSE_REPORT_STATS=no synapse generate
  } else {
    Write-Host 'Istniejaca konfiguracja zostala zachowana.'
  }

  $config = Get-Content -LiteralPath $configPath -Raw
  $configBeforeUpdate = $config
  $config = Set-YamlValue $config 'enable_registration' 'false'
  $config = Set-YamlValue $config 'report_stats' 'false'
  $config = Set-YamlValue $config 'max_upload_size' '25M'
  $config = Set-YamlValue $config 'allow_public_rooms_without_auth' 'false'
  $config = Set-YamlValue $config 'allow_public_rooms_over_federation' 'false'
  $config = Set-YamlValue $config 'enable_room_list_search' 'false'
  $config = Set-YamlValue $config 'federation_domain_whitelist' '[]'
  $config = Set-YamlValue $config 'ip_range_whitelist' "['172.30.55.3/32']"
  $config = Set-YamlSectionValue $config 'push' 'include_content' 'false'
  $config = [regex]::Replace($config, '(?m)^[ \t]*-[ \t]*federation[ \t]*\r?\n?', '')
  Write-Utf8NoBom $configPath $config

  $secretMatch = [regex]::Match($config, '(?m)^registration_shared_secret:\s*(\S+)')
  if ($secretMatch.Success) {
    $sharedSecret = $secretMatch.Groups[1].Value.Trim([char[]]@(39, 34))
  } else {
    $secretBytes = [byte[]]::new(48)
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($secretBytes) } finally { $random.Dispose() }
    $sharedSecret = [Convert]::ToBase64String($secretBytes)
    $config = Set-YamlValue $config 'registration_shared_secret' "'$sharedSecret'"
    Write-Utf8NoBom $configPath $config
  }
  [System.IO.File]::WriteAllText($helperSecretPath, $sharedSecret, [System.Text.Encoding]::ASCII)

  docker compose run --rm --no-deps --entrypoint python synapse -c "import yaml; yaml.safe_load(open('/data/homeserver.yaml'))"
  if ($LASTEXITCODE -ne 0) {
    Write-Utf8NoBom $configPath $configBeforeUpdate
    throw 'Nowa konfiguracja serwera jest nieprawidlowa. Przywrocono poprzednia wersje.'
  }

  if (Test-Path -LiteralPath $accessCodePath) {
    $accessCode = (Get-Content -LiteralPath $accessCodePath -Raw).Trim()
  } else {
    $accessBytes = [byte[]]::new(18)
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($accessBytes) } finally { $random.Dispose() }
    $accessCode = [Convert]::ToBase64String($accessBytes).TrimEnd('=').Replace('+', 'A').Replace('/', 'B')
    [System.IO.File]::WriteAllText($accessCodePath, $accessCode, [System.Text.Encoding]::ASCII)
  }

  docker compose up -d --force-recreate --build
  Write-Host 'Oczekiwanie na uruchomienie serwera...'
  $ready = $false
  foreach ($attempt in 1..60) {
    try {
      Invoke-RestMethod -Uri 'http://127.0.0.1:8008/_matrix/client/versions' -TimeoutSec 2 | Out-Null
      Invoke-RestMethod -Uri 'http://127.0.0.1:8008/_eprom/push/public-key' -TimeoutSec 2 | Out-Null
      $ready = $true
      break
    } catch { Start-Sleep -Seconds 2 }
  }
  if (-not $ready) { throw 'Serwer nie uruchomil sie w oczekiwanym czasie. Sprawdz: docker compose logs synapse push-gateway' }

  Write-Host "`nSerwer dziala lokalnie pod adresem http://127.0.0.1:8008."
  Write-Host 'Konto zostanie utworzone automatycznie przy pierwszym logowaniu numerem i wlasnym PIN-em (minimum 8 znakow).'
  Write-Host 'Kod dostepu znajduje sie tylko w lokalnym pliku infra\matrix\data\registration-access-code.'
  Write-Host 'Dalsze kroki (tunel HTTPS i zmienne Vercel) opisuje infra/matrix/README.md.'
} finally {
  Pop-Location
}
