[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$accessCodePath = Join-Path $scriptRoot 'data\registration-access-code'

$secureCode = Read-Host 'Wpisz nowy kod dostepu (minimum 8 znakow)' -AsSecureString
$credential = New-Object System.Management.Automation.PSCredential('access-code', $secureCode)
$accessCode = $credential.GetNetworkCredential().Password

if ($accessCode.Length -lt 8 -or $accessCode.Length -gt 64) {
  throw 'Kod dostepu musi miec od 8 do 64 znakow.'
}
if ($accessCode.Contains("`r") -or $accessCode.Contains("`n")) {
  throw 'Kod dostepu nie moze zawierac nowej linii.'
}

$dataDirectory = Split-Path -Parent $accessCodePath
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
[System.IO.File]::WriteAllText($accessCodePath, $accessCode, [System.Text.Encoding]::ASCII)

Write-Host 'Kod dostepu zostal zmieniony. Nowy kod dziala od razu dla nowych rejestracji.'
Write-Host 'Istniejace konta i ich PIN-y pozostaly bez zmian.'
