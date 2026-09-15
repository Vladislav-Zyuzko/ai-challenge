# Прогон сценария day10 на трёх стратегиях контекста.
#
#   powershell -ExecutionPolicy Bypass -File week2/context_strategies/run.ps1
#
# Каждое плечо — своя сессия (anchor) в общем home; turns.txt подаётся построчно
# в REPL, поэтому stdout содержит ответы, stderr — метрики хода.
param(
  [string]$DshHome = "$env:USERPROFILE\.dsh-term",
  [int]$Window = 6,
  [string]$Only = ''
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dshTerm = Join-Path $root 'dsh-term\dsh-term.mjs'
$here = Join-Path $root 'week2\context_strategies'
$runs = Join-Path $here 'runs'
New-Item -ItemType Directory -Force -Path $runs | Out-Null

$turns = Get-Content (Join-Path $here 'turns.txt') -Encoding UTF8 | Where-Object { $_.Trim() }
$branchB = Get-Content (Join-Path $here 'branch_b.txt') -Encoding UTF8 | Where-Object { $_.Trim() }

function Invoke-Arm([string]$name, [string[]]$script, [string]$strategyArg = '', [string]$extraArgs = '') {
  if ($Only -and $Only -ne $name) { return }
  if (-not $strategyArg) { $strategyArg = $name }
  $session = [guid]::NewGuid().ToString()
  $in = Join-Path $env:TEMP ("dsh-day10-$name.txt")
  # Своя рабочая папка на плечо: если модель всё-таки вызовет инструменты, её файлы
  # не попадут в репозиторий и не «протекут» в другое плечо (в первом прогоне
  # агент записал бриф в корень репозитория и потом нашёл в нём ответы грепом).
  $ws = Join-Path $env:TEMP ("dsh-day10-ws-$name")
  New-Item -ItemType Directory -Force -Path $ws | Out-Null
  # UTF-8 без BOM: dsh-term читает stdin как utf8.
  [System.IO.File]::WriteAllText($in, ($script -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "===== $name (сессия $session)"
  $outFile = Join-Path $runs "$name.txt"
  $errFile = Join-Path $env:TEMP "dsh-day10-$name.err"
  # cmd /c с редиректом из файла: PowerShell 5.1 не понимает '<', а пайп не
  # закрывает stdin у нативного процесса — dsh-term тогда ждёт ввода.
  # ВАЖНО: одной строкой. Перенос со ведущим '+' — это НОВОЕ выражение (unary plus),
  # и команда молча собирается обрезанной (без --strategy и без редиректа).
  $cmdLine = 'node "' + $dshTerm + '" --dsh-home "' + $DshHome + '" --workspace "' + $ws + '" --session ' + $session + ' --strategy ' + $strategyArg + ' --window ' + $Window + ' ' + $extraArgs + ' < "' + $in + '" 2> "' + $errFile + '"'
  $stdout = cmd /c $cmdLine
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($outFile, ((@($stdout) -join "`n") + "`n"), $utf8)
  [System.IO.File]::AppendAllText($outFile, "`n# ===== stderr (метрики) =====`n" + (Get-Content $errFile -Raw -Encoding UTF8), $utf8)
  Write-Host "  → $outFile"
}

# sliding / facts: весь сценарий линейно
foreach ($strategy in @('sliding', 'facts')) {
  Invoke-Arm $strategy $turns
}

# Справочное плечо: без стратегии (весь диалог в контексте, компрессия выключена) —
# с ним сравнивается расход токенов. Это не одна из трёх стратегий задания, а точка отсчёта.
Invoke-Arm 'harness-ref' $turns 'harness' '--compress off'

# branch: 7 сообщений (main) → чекпоинт + ветки A и B → сценарий в A → расходящийся
# хвост в B → возврат в A (проверка, что ветка помнит своё).
if (-not $Only -or $Only -eq 'branch') {
  $script = @()
  $script += $turns[0..6]                    # 1-7: до чекпоинта
  $script += '/branch new пилот'
  $script += $turns[7..13]                   # 8-14: продолжение в ветке A
  $script += '/branch b'
  $script += $branchB                        # расходящееся продолжение в B
  $script += '/branch a'
  $script += 'Ещё раз, для протокола: какой внутренний код проекта и какой бюджет? Ответь одной фразой.'
  Invoke-Arm 'branch' $script
}

Write-Host 'готово'
