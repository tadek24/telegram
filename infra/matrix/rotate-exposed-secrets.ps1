[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDirectory = Join-Path $scriptRoot 'data'
$configPath = Join-Path $dataDirectory 'homeserver.yaml'
$helperSecretPath = Join-Path $dataDirectory 'registration-helper-secret'
$accessCodePath = Join-Path $dataDirectory 'registration-access-code'
$vapidPath = Join-Path $dataDirectory 'web-push-vapid.json'
$subscriptionsPath = Join-Path $dataDirectory 'web-push-subscriptions.json'
$changesApplied = $false

function New-RandomBase64([int]$Bytes = 48) {
  $buffer = [byte[]]::new($Bytes)
  $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($buffer) } finally { $random.Dispose() }
  return [Convert]::ToBase64String($buffer)
}

function New-AccessCode() {
  $alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  $buffer = [byte[]]::new(12)
  $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($buffer) } finally { $random.Dispose() }
  $suffix = -join ($buffer | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
  return "EPROM-$suffix"
}

function Set-YamlValue([string]$Text, [string]$Key, [string]$Value) {
  $pattern = "(?m)^$([regex]::Escape($Key)):\s*.*$"
  $line = "${Key}: $Value"
  if ($Text -match $pattern) { return [regex]::Replace($Text, $pattern, $line, 1) }
  return $Text.TrimEnd() + [Environment]::NewLine + $line + [Environment]::NewLine
}

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Restore-BackupFile([string]$BackupDirectory, [string]$Destination) {
  $backup = Join-Path $BackupDirectory (Split-Path -Leaf $Destination)
  if (Test-Path -LiteralPath $backup) {
    Copy-Item -LiteralPath $backup -Destination $Destination -Force
  } elseif (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Force
  }
}

if (-not (Test-Path -LiteralPath $configPath)) { throw 'Nie znaleziono lokalnej konfiguracji serwera.' }
$resolvedData = (Resolve-Path -LiteralPath $dataDirectory).Path
$resolvedProject = (Resolve-Path -LiteralPath (Join-Path $scriptRoot '..\..')).Path
if (-not $resolvedData.StartsWith($resolvedProject, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Katalog danych znajduje sie poza projektem.'
}

$backupDirectory = Join-Path $dataDirectory ("security-backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
$pathsToBackup = @($configPath, $helperSecretPath, $accessCodePath, $vapidPath, $subscriptionsPath)
foreach ($path in $pathsToBackup) {
  if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $backupDirectory }
}

Push-Location $scriptRoot
try {
  docker compose version | Out-Null
  $config = Get-Content -LiteralPath $configPath -Raw -Encoding utf8
  if ($config -match '(?m)^old_signing_keys:\s*$') {
    throw 'Klucz podpisujacy byl juz wczesniej zmieniany. Zatrzymano automatyczna rotacje.'
  }

  $signingMatch = [regex]::Match($config, '(?m)^signing_key_path:\s*(\S+)')
  if (-not $signingMatch.Success) { throw 'Nie znaleziono sciezki klucza podpisujacego.' }
  $signingFileName = Split-Path -Leaf $signingMatch.Groups[1].Value.Trim([char[]]@(34, 39))
  $signingPath = Join-Path $dataDirectory $signingFileName
  if (-not (Test-Path -LiteralPath $signingPath)) { throw 'Nie znaleziono klucza podpisujacego.' }
  Copy-Item -LiteralPath $signingPath -Destination $backupDirectory

  $oldKeyOutput = docker compose run --rm --no-deps --entrypoint export_signing_key synapse -x "/data/$signingFileName"
  if ($LASTEXITCODE -ne 0) { throw 'Nie udalo sie wyeksportowac starego klucza publicznego.' }
  $oldKeyEntry = $oldKeyOutput | Where-Object { $_ -match 'ed25519:' } | Select-Object -First 1
  if (-not $oldKeyEntry) { throw 'Nie udalo sie odczytac starego klucza publicznego.' }

  $newSigningFileName = "$signingFileName.new"
  $newSigningPath = Join-Path $dataDirectory $newSigningFileName
  if (Test-Path -LiteralPath $newSigningPath) { Remove-Item -LiteralPath $newSigningPath -Force }
  docker compose run --rm --no-deps --entrypoint generate_signing_key synapse -o "/data/$newSigningFileName"
  if ($LASTEXITCODE -ne 0) { throw 'Nie udalo sie utworzyc nowego klucza podpisujacego.' }
  if (-not (Test-Path -LiteralPath $newSigningPath)) { throw 'Nowy klucz podpisujacy nie zostal zapisany.' }

  $registrationSecret = New-RandomBase64
  $newConfig = Set-YamlValue $config 'registration_shared_secret' "'$registrationSecret'"
  $newConfig = Set-YamlValue $newConfig 'macaroon_secret_key' "'$(New-RandomBase64)'"
  $newConfig = Set-YamlValue $newConfig 'form_secret' "'$(New-RandomBase64)'"
  $newConfig = $newConfig.TrimEnd() + [Environment]::NewLine + 'old_signing_keys:' + [Environment]::NewLine + "  $($oldKeyEntry.Trim())" + [Environment]::NewLine
  $candidateConfigPath = "$configPath.rotating"
  Write-Utf8NoBom $candidateConfigPath $newConfig

  docker compose run --rm --no-deps --entrypoint python synapse -c "import yaml; yaml.safe_load(open('/data/homeserver.yaml.rotating'))"
  if ($LASTEXITCODE -ne 0) { throw 'Nowa konfiguracja serwera jest nieprawidlowa.' }

  Copy-Item -LiteralPath $candidateConfigPath -Destination $configPath -Force
  [System.IO.File]::WriteAllText($helperSecretPath, $registrationSecret, [System.Text.Encoding]::ASCII)
  [System.IO.File]::WriteAllText($accessCodePath, (New-AccessCode), [System.Text.Encoding]::ASCII)
  Copy-Item -LiteralPath $newSigningPath -Destination $signingPath -Force
  docker compose run --rm --no-deps --entrypoint sh synapse -c "chown 991:991 /data/$signingFileName && chmod 600 /data/$signingFileName"
  if ($LASTEXITCODE -ne 0) { throw 'Nie udalo sie ustawic uprawnien nowego klucza podpisujacego.' }
  Remove-Item -LiteralPath $candidateConfigPath, $newSigningPath -Force
  if (Test-Path -LiteralPath $vapidPath) { Remove-Item -LiteralPath $vapidPath -Force }
  if (Test-Path -LiteralPath $subscriptionsPath) { Remove-Item -LiteralPath $subscriptionsPath -Force }
  $changesApplied = $true

  docker compose up -d --force-recreate synapse registration-helper push-gateway gateway
  $ready = $false
  foreach ($attempt in 1..45) {
    try {
      Invoke-RestMethod -Uri 'http://127.0.0.1:8008/_matrix/client/versions' -TimeoutSec 2 | Out-Null
      Invoke-RestMethod -Uri 'http://127.0.0.1:8008/_eprom/push/public-key' -TimeoutSec 2 | Out-Null
      $ready = $true
      break
    } catch { Start-Sleep -Seconds 2 }
  }
  if (-not $ready) { throw 'Serwer nie wrocil do dzialania w oczekiwanym czasie.' }
  Write-Host 'Sekrety zostaly bezpiecznie zmienione. Istniejace konta i rozmowy zachowano.'
  Write-Host 'Nowy kod dostepu znajduje sie tylko w lokalnym pliku infra\matrix\data\registration-access-code.'
  Write-Host 'Powiadomienia trzeba ponownie wlaczyc na telefonach.'
} catch {
  $rotationError = $_
  if ($changesApplied) {
    Write-Warning 'Przywracanie poprzedniej konfiguracji z kopii...'
    Restore-BackupFile $backupDirectory $configPath
    Restore-BackupFile $backupDirectory $helperSecretPath
    Restore-BackupFile $backupDirectory $accessCodePath
    Restore-BackupFile $backupDirectory $vapidPath
    Restore-BackupFile $backupDirectory $subscriptionsPath
    Restore-BackupFile $backupDirectory $signingPath
    docker compose run --rm --no-deps --entrypoint sh synapse -c "chown 991:991 /data/$signingFileName && chmod 600 /data/$signingFileName" | Out-Host
    docker compose up -d --force-recreate synapse registration-helper push-gateway gateway | Out-Host
  }
  Write-Warning "Rotacja nie zostala ukonczona: $($rotationError.Exception.Message)"
  Write-Warning "Kopia poprzednich plikow znajduje sie w: $backupDirectory"
  throw $rotationError
} finally {
  if (Test-Path -LiteralPath "$configPath.rotating") { Remove-Item -LiteralPath "$configPath.rotating" -Force }
  if ($newSigningPath -and (Test-Path -LiteralPath $newSigningPath)) { Remove-Item -LiteralPath $newSigningPath -Force }
  Pop-Location
}
