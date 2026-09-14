# Демо компрессии контекста: одинаковые промпты прогоняются дважды — с выключенной
# компрессией (baseline) и с включённой. Экономия = разница размеров промпта одного
# и того же запроса в двух прогонах (входы одинаковые, поэтому сравнение честное).
#
# Запуск (из корня репозитория):
#   powershell -ExecutionPolicy Bypass -File dsh-term/tools/demo-compaction.ps1
#
# Почему такие значения:
#   префикс агента ≈ 8-9k токенов (system prompt + схемы инструментов) — не сжимается;
#   каждый промпт ниже — «отчёт» ~9k символов ≈ 3.5k токенов (текст однотипный,
#   поэтому сводка по нему получается короткой — так видно экономию);
#   запрос 2 = префикс + отчёт 1 + ответ + отчёт 2 ≈ 16k — порог 17.5k ещё не достигнут;
#   запрос 3 = + отчёт 3 ≈ 20k → порог срабатывает ровно на третьем промпте;
#   keep 2000 < размера отчёта (3.5k) → «хвост как есть» = последний отчёт,
#   а старше него (два отчёта + два ответа ≈ 7-8k) уходит в summary.
param(
  [string]$Ratio = '0.0175',
  [string]$Keep = '2000',
  [string]$DshHome = "$env:USERPROFILE\.dsh-term",
  [int]$Reports = 5
)
$ErrorActionPreference = 'Continue'
# Windows PowerShell 5.1: без этого кириллица из дочерних процессов приходит в CP866.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$errFile = Join-Path $env:TEMP 'dsh-demo-stderr.txt'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dshTerm = Join-Path $root 'dsh-term\dsh-term.mjs'
$ledger = Join-Path $root 'dsh-term\tools\session-ledger.mjs'

# Отчёт: однотипные строки метрик ≈ 9k символов. Такой текст сжимается в короткую
# сводку — именно на нём видно, что компакция экономит, а не переписывает текст целиком.
function New-Report([int]$n) {
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.AppendLine("ОТЧЁТ $n за смену. Ниже — метрики сервисов за период (сырые значения, без агрегации).")
  for ($i = 1; $i -le 120; $i++) {
    $p95 = 40 + (($i * 7 + $n * 13) % 180)
    $err = (($i * 3 + $n) % 9) / 10
    $rps = 100 + (($i * 11 + $n * 5) % 900)
    [void]$sb.AppendLine("  сервис api-${i}-${n}: p95 = $p95 мс; доля ошибок = $err %; rps = $rps; статус = норма")
  }
  [void]$sb.AppendLine("ИТОГО в отчёте $n`: 120 сервисов, отклонений нет.")
  [void]$sb.AppendLine('Вопрос: одной фразой — сколько сервисов перечислено в этом отчёте?')
  return $sb.ToString()
}

$prompts = @()
for ($i = 1; $i -le $Reports; $i++) { $prompts += (New-Report $i) }
$prompts += 'Вопрос: одной фразой — что общего у всех этих отчётов?'

Write-Host "Репозиторий: $root"
Write-Host "Политика:    --compress $Ratio --compress-keep $Keep (порог = $([math]::Round([double]$Ratio * 1000000)) токенов)"
Write-Host "Промптов:    $($prompts.Count) (одинаковые в обоих прогонах)"
Write-Host ''

$lastContext = @{}
foreach ($arm in @(
  @{ name = 'baseline (--compress off)'; args = @('--compress', 'off') },
  @{ name = "compress (--compress $Ratio --compress-keep $Keep)"; args = @('--compress', $Ratio, '--compress-keep', $Keep) }
)) {
  $session = [guid]::NewGuid().ToString()
  Write-Host "===== $($arm.name)"
  for ($i = 0; $i -lt $prompts.Count; $i++) {
    Write-Host "--- промпт $($i + 1)"
    $argv = @($dshTerm, '--dsh-home', $DshHome, '--session', $session) + $arm.args + @('-p', $prompts[$i])
    # stderr — отдельным файлом: в -p метрики идут туда, а 2>&1 при Stop-режиме
    # превращает любую строку stderr в фатальную ошибку.
    $out = & node @argv 2>$errFile
    $lines = (@($out) + @(Get-Content $errFile -Raw -ErrorAction SilentlyContinue)) -join "`n" -split "`n"
    foreach ($l in $lines) {
      if ($l -match 'context compacted|compaction failed|hint:|tokens: in|compression:|context:') { Write-Host "  $($l.TrimEnd())" }
      if ($l -match '^\s+context: ([\d.]+k?)') { $lastContext[$arm.name] = $Matches[1] }
    }
  }
  Write-Host ''
  & node $ledger --home $DshHome --session $session | Where-Object { $_ -match '^req |compaction|окно:|реально снято|затенено всего|встало на место|вызов:' } | ForEach-Object { Write-Host "  $_" }
  Write-Host ''
}

$a = $lastContext['baseline (--compress off)']
$b = $lastContext["compress (--compress $Ratio --compress-keep $Keep)"]
Write-Host '===== ИТОГ (измерено, одинаковые промпты)'
Write-Host "  последний запрос: baseline $a против compress $b"
Write-Host '  компакция держит окно на месте, baseline растёт линейно — разница и есть экономия.'
