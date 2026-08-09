$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
$SourcePath = Join-Path $ProjectDir ".env.local"
$TargetPath = Join-Path $ProjectDir ".env.timeweb"

if (-not (Test-Path -LiteralPath $SourcePath)) {
  throw ".env.local not found"
}

$source = @{}
foreach ($line in Get-Content -LiteralPath $SourcePath -Encoding UTF8) {
  if ($line -match '^\s*#' -or $line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
    continue
  }
  $source[$Matches[1]] = $Matches[2].Trim()
}

$keys = @(
  "MAX_ENGAGEMENT_ENABLED",
  "ENGAGEMENT_STORAGE",
  "MAX_API_BASE_URL",
  "MAX_API_MODE",
  "MAX_API_TOKEN",
  "MAX_API_CA_FILE",
  "MAX_WEBHOOK_URL",
  "MAX_WEBHOOK_SECRET",
  "MAX_WEBHOOK_UPDATE_TYPES",
  "MAX_ENGAGEMENT_POLL_MINUTES",
  "MAX_UPDATES_TIMEOUT",
  "MAX_POLL_IDLE_DELAY_MS",
  "MAX_POLL_ERROR_DELAY_MS",
  "MAX_API_REQUEST_TIMEOUT_MS",
  "MAX_POLL_WATCHDOG_MS",
  "MAX_WORKER_HEARTBEAT_MAX_AGE_MS",
  "MAX_ENGAGEMENT_DEFAULT_DRY_RUN",
  "MAX_ENGAGEMENT_ADMIN_ALERT_CHAT",
  "ADMIN_SECRET",
  "ADMIN_HOST",
  "ADMIN_PORT",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY"
)

$defaults = @{
  MAX_ENGAGEMENT_ENABLED = "true"
  ENGAGEMENT_STORAGE = "supabase"
  MAX_API_BASE_URL = "https://platform-api2.max.ru"
  MAX_API_MODE = "http"
  MAX_WEBHOOK_UPDATE_TYPES = "message_created,bot_started,bot_added,message_edited,message_removed"
  MAX_ENGAGEMENT_POLL_MINUTES = "2"
  MAX_UPDATES_TIMEOUT = "25"
  MAX_POLL_IDLE_DELAY_MS = "1000"
  MAX_POLL_ERROR_DELAY_MS = "5000"
  MAX_API_REQUEST_TIMEOUT_MS = "45000"
  MAX_POLL_WATCHDOG_MS = "120000"
  MAX_WORKER_HEARTBEAT_MAX_AGE_MS = "180000"
  MAX_ENGAGEMENT_DEFAULT_DRY_RUN = "true"
  ADMIN_HOST = "0.0.0.0"
  ADMIN_PORT = "4317"
}

$lines = foreach ($key in $keys) {
  $value = if ($source.ContainsKey($key) -and $source[$key]) {
    $source[$key]
  } elseif ($defaults.ContainsKey($key)) {
    $defaults[$key]
  } else {
    ""
  }
  "$key=$value"
}

Set-Content -LiteralPath $TargetPath -Value $lines -Encoding UTF8
Write-Output ".env.timeweb prepared"
