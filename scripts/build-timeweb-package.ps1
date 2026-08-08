$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
$OutDir = Join-Path $ProjectDir ".deploy"
$ArchivePath = Join-Path $OutDir "max-engagement-bot-timeweb.zip"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path -LiteralPath $ArchivePath) {
  Remove-Item -LiteralPath $ArchivePath -Force
}

$items = @(
  "Dockerfile",
  "docker-compose.timeweb.yml",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "src",
  "supabase",
  "docs",
  "scripts"
)

$paths = foreach ($item in $items) {
  Join-Path $ProjectDir $item
}

Compress-Archive -LiteralPath $paths -DestinationPath $ArchivePath -Force
Write-Output $ArchivePath
