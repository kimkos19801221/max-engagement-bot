$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectDir ".local-data\logs"
$OutLog = Join-Path $LogDir "max-poll-task.log"
$ErrLog = Join-Path $LogDir "max-poll-task.err.log"
$RestartDelaySeconds = [Math]::Max(5, [int]($env:MAX_POLL_RESTART_DELAY_SECONDS -as [int]))

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $ProjectDir

while ($true) {
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "[$stamp] npm run max:watch" | Out-File -FilePath $OutLog -Append -Encoding utf8

  & npm run max:watch 1>> $OutLog 2>> $ErrLog
  $exitCode = $LASTEXITCODE

  $done = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "[$done] exit=$exitCode; restart in ${RestartDelaySeconds}s" | Out-File -FilePath $OutLog -Append -Encoding utf8

  Start-Sleep -Seconds $RestartDelaySeconds
}
