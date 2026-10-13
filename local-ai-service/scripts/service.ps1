#Requires -Version 5.1
<#
    Управление локальным AI-сервисом: LiteLLM как единственная точка входа
    к моделям Ollama (ключи, rate limit, лимит контекста).

        .\scripts\service.ps1 start
        .\scripts\service.ps1 status
        .\scripts\service.ps1 stop

    Ollama при этом не трогается: он слушает 127.0.0.1 и наружу не смотрит.
    Наружу публикуется только сервис, и именно он умеет отказывать.
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status', 'restart')]
    [string]$Action = 'status',

    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'out'
$pidFile = Join-Path $outDir 'litellm.pid'
$envFile = Join-Path $root '.env'
# Шаблон назван без ведущей точки: корневой .gitignore исключает `.env.*`,
# и файл-образец иначе молча не попал бы в репозиторий.
$exampleFile = Join-Path $root 'env.example'

function Read-EnvFile {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path $Path)) { return $map }
    foreach ($line in Get-Content $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $eq = $trimmed.IndexOf('=')
        if ($eq -gt 0) {
            $map[$trimmed.Substring(0, $eq).Trim()] = $trimmed.Substring($eq + 1).Trim()
        }
    }
    return $map
}

if (-not (Test-Path $envFile)) {
    Copy-Item $exampleFile $envFile
    Write-Host "создан .env из .env.example — проверьте ключ LITELLM_MASTER_KEY" -ForegroundColor Yellow
}

$config = Read-EnvFile -Path $envFile
$host_ = if ($config['LITELLM_HOST']) { $config['LITELLM_HOST'] } else { '0.0.0.0' }
$port = if ($config['LITELLM_PORT']) { $config['LITELLM_PORT'] } else { '4000' }
$key = if ($config['LITELLM_MASTER_KEY']) { $config['LITELLM_MASTER_KEY'] } else { 'sk-local-change-me' }
# Запускается консольный вход пакета: `python -m litellm` не работает — у пакета
# нет `__main__`. Это выяснилось только на живом запуске, в документации мелочь
# не упомянута.
$litellm = Join-Path $root '.venv\Scripts\litellm.exe'

function Get-ServiceProcess {
    if (-not (Test-Path $pidFile)) { return $null }
    $saved = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $saved) { return $null }
    return Get-Process -Id ([int]$saved) -ErrorAction SilentlyContinue
}

function Show-Status {
    $process = Get-ServiceProcess
    if ($process) {
        Write-Host "сервис запущен: PID $($process.Id), порт $port" -ForegroundColor Green
    } else {
        Write-Host "сервис не запущен" -ForegroundColor Yellow
    }
    $listening = netstat -ano | Select-String ":$port\s.*LISTENING"
    if ($listening) { Write-Host "порт $port слушается" } else { Write-Host "порт $port не слушается" }

    try {
        $models = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/models" -TimeoutSec 10 `
            -Headers @{ Authorization = "Bearer $key" }
        $names = ($models.data | ForEach-Object { $_.id }) -join ', '
        Write-Host "модели сервиса: $names" -ForegroundColor Green
    } catch {
        Write-Host "сервис не отвечает: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Start-Service_ {
    $existing = Get-ServiceProcess
    if ($existing) {
        Write-Host "уже запущен: PID $($existing.Id)" -ForegroundColor Yellow
        return
    }
    if (-not (Test-Path $litellm)) {
        throw "нет venv: выполните python -m venv .venv и pip install 'litellm[proxy]'"
    }
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $env:LITELLM_MASTER_KEY = $key
    $env:OLLAMA_API_KEY = if ($config['OLLAMA_API_KEY']) { $config['OLLAMA_API_KEY'] } else { 'ollama' }
    # Без этого сервис не поднимается на русской Windows: баннер LiteLLM содержит
    # псевдографику, консоль cp1251 её закодировать не может, и старт падает с
    # UnicodeEncodeError. Снаружи это выглядит как «сервис молча не запустился».
    $env:PYTHONIOENCODING = 'utf-8'
    $env:PYTHONUTF8 = '1'

    $arguments = @('--config', (Join-Path $root 'litellm\config.yaml'),
                   '--host', $host_, '--port', $port)
    if ($Foreground) {
        & $litellm @arguments
        return
    }
    $process = Start-Process -FilePath $litellm -ArgumentList $arguments -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $outDir 'litellm.out.log') `
        -RedirectStandardError (Join-Path $outDir 'litellm.err.log')
    $process.Id | Set-Content -Path $pidFile
    Write-Host "запущен PID $($process.Id) на $host_`:$port" -ForegroundColor Green
    Write-Host "логи: out\litellm.err.log"
    # Сервис поднимается не мгновенно: ждём порт до 40 секунд, а не «шесть и готово».
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Seconds 2
        if (netstat -ano | Select-String ":$port\s.*LISTENING") { break }
    }
    Show-Status
}

function Stop-Service_ {
    $process = Get-ServiceProcess
    if (-not $process) {
        Write-Host "сервис не запущен" -ForegroundColor Yellow
        if (Test-Path $pidFile) { Remove-Item $pidFile }
        return
    }
    # LiteLLM поднимает дочерние процессы: снимаем дерево, иначе порт остаётся занят.
    & taskkill /PID $process.Id /T /F | Out-Null
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    Write-Host "остановлен PID $($process.Id)" -ForegroundColor Green
}

switch ($Action) {
    'start' { Start-Service_ }
    'stop' { Stop-Service_ }
    'restart' { Stop-Service_; Start-Sleep -Seconds 2; Start-Service_ }
    'status' { Show-Status }
}
