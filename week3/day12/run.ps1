# Прогон сценария day12: один и тот же набор вопросов с разными профилями
# пользователя (персонализация) и без него.
#
#   powershell -ExecutionPolicy Bypass -File week3/day12/run.ps1
#   powershell -ExecutionPolicy Bypass -File week3/day12/run.ps1 -Only tolko-kod
#
# Каждый прогон — отдельный процесс в one-shot режиме (-p): своя сессия, чистый
# контекст, никакой персонализации «на лету» (в one-shot профиль не дообучается),
# поэтому плечи сравнимы. Профили копируются из week3/day12/profiles в
# <DshHome>\user-profiles — ровно так, как их видит интерактивная сессия.
param(
  [string]$DshHome = "$env:USERPROFILE\.dsh-term",
  [string]$Only = ''
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dshTerm = Join-Path $root 'dsh-term\dsh-term.mjs'
$here = Join-Path $root 'week3\day12'
$runs = Join-Path $here 'runs'
New-Item -ItemType Directory -Force -Path $runs | Out-Null

# Профили — часть сценария: копируем их в home пользователя.
$profileDir = Join-Path $DshHome 'user-profiles'
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
Copy-Item (Join-Path $here 'profiles\*.md') $profileDir -Force
Write-Host "профили скопированы в $profileDir"

# Один и тот же набор вопросов для всех плеч (см. questions.md).
$questions = @(
  'Как в Node.js прочитать JSON-файл и обработать ошибку?',
  'Стоит ли заводить отдельную ветку в git под правку в одну строку?',
  'Что не так с этим кодом: const x = [1, 2]; x.forEach(async (v) => await save(v));'
)

# none — точка отсчёта: персонализация выключена.
$variants = @('none', 'kratko', 'podrobno', 'tolko-kod')

foreach ($variant in $variants) {
  if ($Only -and $Only -ne $variant) { continue }
  $ws = Join-Path $env:TEMP ("dsh-day12-ws-$variant")
  New-Item -ItemType Directory -Force -Path $ws | Out-Null
  for ($i = 0; $i -lt $questions.Count; $i++) {
    $q = $questions[$i]
    $n = $i + 1
    Write-Host "===== $variant · q$n"
    $nodeArgs = @($dshTerm, '--dsh-home', $DshHome, '--workspace', $ws, '--model', 'deepseek-v4-flash', '-p', $q)
    if ($variant -ne 'none') { $nodeArgs += @('--user-profile', $variant) }
    $errFile = Join-Path $env:TEMP "dsh-day12-$variant-q$n.err"
    $stdout = & node @nodeArgs 2> $errFile
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $outFile = Join-Path $runs "$variant-q$n.txt"
    [System.IO.File]::WriteAllText($outFile, ((@($stdout) -join "`n") + "`n"), $utf8)
    [System.IO.File]::AppendAllText($outFile, "`n# ===== stderr (метрики) =====`n" + (Get-Content $errFile -Raw -Encoding UTF8), $utf8)
    Write-Host "  → $outFile"
  }
}

Write-Host 'готово'
