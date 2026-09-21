# Проверка автоматической персонализации: профиль дообучается по ходу диалога.
#
#   powershell -ExecutionPolicy Bypass -File week2/day12/run-learn.ps1
#
# Сценарий: профиль с одним пунктом → одно сообщение, в котором пользователь явно
# говорит о своих предпочтениях → /exit. dsh-term фоновым вызовом LLM разбирает
# сообщение и дописывает пункты в профиль. Скрипт сохраняет профиль до и после,
# поэтому результат виден как дифф:
#
#   runs/auto-learn-before.md   — что было
#   runs/auto-learn-after.md    — что стало (этот файл пишет сам dsh-term)
#   runs/auto-learn-console.txt — stdout+stderr прогона (строка «· профиль: +N пунктов»)
param(
  [string]$DshHome = "$env:USERPROFILE\.dsh-term"
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dshTerm = Join-Path $root 'dsh-term\dsh-term.mjs'
$here = Join-Path $root 'week2\day12'
$runs = Join-Path $here 'runs'
New-Item -ItemType Directory -Force -Path $runs | Out-Null

# Исходный профиль: ровно один пункт, чтобы новые было видно.
$profileDir = Join-Path $DshHome 'user-profiles'
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
$src = Join-Path $here 'profiles\auto-learn-before.md'
$dst = Join-Path $profileDir 'auto-learn.md'
Copy-Item $src $dst -Force
Copy-Item $src (Join-Path $runs 'auto-learn-before.md') -Force

# Сообщение пользователя: явные предпочтения, которых в профиле нет.
$turns = @(
  'Запомни про меня: эмодзи не нужны, метрики всегда пиши в токенах, а в конце длинного ответа добавляй раздел Итого.',
  '/exit'
)
$in = Join-Path $env:TEMP 'dsh-day12-learn-in.txt'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($in, ($turns -join "`n") + "`n", $utf8)

$outFile = Join-Path $env:TEMP 'dsh-day12-learn-out.txt'
$errFile = Join-Path $env:TEMP 'dsh-day12-learn-err.txt'
$ws = Join-Path $env:TEMP 'dsh-day12-learn-ws'
New-Item -ItemType Directory -Force -Path $ws | Out-Null

# cmd /c с редиректом: PowerShell 5.1 не понимает '<'. Одной строкой (перенос
# с ведущим '+' — это новое выражение, команда молча соберётся обрезанной).
# Своя сессия (--session) обязательна: REPL без --session продолжает последнюю
# сессию home, и прогон дописался бы в чужой диалог.
$session = [guid]::NewGuid().ToString()
$cmdLine = 'node "' + $dshTerm + '" --dsh-home "' + $DshHome + '" --workspace "' + $ws + '" --session ' + $session + ' --strategy harness --user-profile auto-learn < "' + $in + '" > "' + $outFile + '" 2> "' + $errFile + '"'
Write-Host "запуск сессии $session с профилем auto-learn…"
cmd /c $cmdLine | Out-Null

# Собираем всё в один файл для отчёта: ответ модели + диагностика dsh-term.
$merged = (Get-Content $outFile -Raw -Encoding UTF8) + "`n# ===== stderr (диагностика dsh-term) =====`n" + (Get-Content $errFile -Raw -Encoding UTF8)
[System.IO.File]::WriteAllText((Join-Path $runs 'auto-learn-console.txt'), $merged, $utf8)
Copy-Item $dst (Join-Path $runs 'auto-learn-after.md') -Force

$before = (Get-Item (Join-Path $runs 'auto-learn-before.md')).Length
$after = (Get-Item (Join-Path $runs 'auto-learn-after.md')).Length
Write-Host "профиль: $before → $after байт"
Write-Host '----- diff (before → after) -----'
Compare-Object (Get-Content (Join-Path $runs 'auto-learn-before.md') -Encoding UTF8) (Get-Content (Join-Path $runs 'auto-learn-after.md') -Encoding UTF8) |
  ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" }
Write-Host 'готово'
