$ErrorActionPreference = "Stop"
$workerDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $workerDirectory ".env"
if (-not (Test-Path -LiteralPath $envFile)) {
  throw "Create worker/.env from worker/.env.example and configure the preview URL and tokens."
}
Get-Content -LiteralPath $envFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
    $pair = $line.Split("=", 2)
    [Environment]::SetEnvironmentVariable($pair[0].Trim(), $pair[1].Trim(), "Process")
  }
}
python (Join-Path $workerDirectory "whisper_worker.py")
