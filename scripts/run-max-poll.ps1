$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectDir ".local-data\logs"
$OutLog = Join-Path $LogDir "max-poll-task.log"
$ErrLog = Join-Path $LogDir "max-poll-task.err.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $ProjectDir

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$stamp] npm run max:poll" | Out-File -FilePath $OutLog -Append -Encoding utf8

& npm run max:poll 1>> $OutLog 2>> $ErrLog
$exitCode = $LASTEXITCODE

$done = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$done] exit=$exitCode" | Out-File -FilePath $OutLog -Append -Encoding utf8

exit $exitCode
