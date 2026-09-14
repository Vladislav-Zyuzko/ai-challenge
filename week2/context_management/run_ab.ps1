# A/B прогон эксперимента по компрессии контекста.
# Один и тот же сценарий (turns.txt) прогоняется дважды в чистых home:
#   baseline — компрессия выключена (--compress off)
#   compress — агрессивная компрессия (--compress 0.009 --compress-keep 1500)
# Результаты: runs/baseline.txt, runs/compress.txt (stdout+stderr целиком).
param(
  [string]$Mjs = 'C:\Users\user\Projects\ai-challenge\dsh-term\dsh-term.mjs',
  [string]$DshBin = 'C:\Users\user\.dsh\bin\dsh.cmd',
  [string]$Creds = 'C:\Users\user\.dsh-term\.credentials.yaml'
)

$ErrorActionPreference = 'Continue'
# $PSScriptRoot пуст, если скрипт выполняется через Invoke-Expression (политика
# выполнения на машине запрещает запуск unsigned-файлов) — тогда берём путь по умолчанию.
$base = if ($PSScriptRoot) { $PSScriptRoot } else { 'C:\Users\user\Projects\ai-challenge\week2\context_management' }
New-Item -ItemType Directory -Force -Path (Join-Path $base 'runs') | Out-Null
$turns = Get-Content (Join-Path $base 'turns.txt') -Encoding UTF8
$in = Join-Path $env:TEMP 'dsh-ab-in.txt'
Set-Content -LiteralPath $in -Encoding UTF8 -Value (($turns + '/context' + '/exit') -join "`r`n")

$arms = @(
  @{ name = 'baseline'; args = @('--compress', 'off') },
  @{ name = 'compress'; args = @('--compress', '0.009', '--compress-keep', '300') }
)

foreach ($arm in $arms) {
  # ВНИМАНИЕ: $home — зарезервированная переменная PowerShell, использовать нельзя.
  $dshHome = Join-Path $env:TEMP ("dsh-ab-" + $arm.name + "-home")
  Remove-Item -Recurse -Force $dshHome -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $dshHome | Out-Null
  Copy-Item $Creds (Join-Path $dshHome '.credentials.yaml') -Force
  $ws = Join-Path $env:TEMP ("dsh-ab-" + $arm.name + "-ws")
  New-Item -ItemType Directory -Force -Path $ws | Out-Null
  $outFile = Join-Path $base ("runs\" + $arm.name + ".txt")
  $argLine = ($arm.args | ForEach-Object { '"' + $_ + '"' }) -join ' '
  Write-Host ("=== arm " + $arm.name + " ===")
  & cmd /c ("`"node`" `"$Mjs`" --dsh-home `"$dshHome`" --dsh-bin `"$DshBin`" --workspace `"$ws`" " + $argLine + " < `"$in`"") 2>&1 |
    Out-File -FilePath $outFile -Encoding UTF8
  Write-Host ("arm " + $arm.name + " exit: " + $LASTEXITCODE)
}

Remove-Item -Force $in -ErrorAction SilentlyContinue
Write-Host 'DONE'
