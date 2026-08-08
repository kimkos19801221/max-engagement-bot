param(
  [Parameter(Mandatory = $true)]
  [string]$HostName,

  [string]$User = "root",

  [string]$RemoteDir = "/opt/max-engagement-bot",

  [string]$ArchivePath = ""
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
if (-not $ArchivePath) {
  $ArchivePath = Join-Path $ProjectDir ".deploy\max-engagement-bot-timeweb.zip"
}

$EnvPath = Join-Path $ProjectDir ".env.timeweb"
if (-not (Test-Path -LiteralPath $ArchivePath)) {
  throw "Archive not found: $ArchivePath. Run scripts\build-timeweb-package.ps1 first."
}
if (-not (Test-Path -LiteralPath $EnvPath)) {
  throw ".env.timeweb not found. Run scripts\prepare-timeweb-env.ps1 first."
}

$Target = "$User@$HostName"

ssh $Target "mkdir -p '$RemoteDir'"
scp $ArchivePath "${Target}:$RemoteDir/max-engagement-bot-timeweb.zip"
scp $EnvPath "${Target}:$RemoteDir/.env.timeweb"
ssh $Target "cd '$RemoteDir' && rm -rf Dockerfile docker-compose.timeweb.yml package.json package-lock.json tsconfig.json src supabase docs scripts && unzip -o max-engagement-bot-timeweb.zip >/dev/null && docker compose -p max-engagement-bot -f docker-compose.timeweb.yml up -d --build && docker compose -p max-engagement-bot -f docker-compose.timeweb.yml ps"
