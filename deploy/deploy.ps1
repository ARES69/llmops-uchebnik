<#
.SYNOPSIS
    Деплой учебника DevOps & MLOps на VPS.

.DESCRIPTION
    Собирает сайт локально, упаковывает, отправляет на сервер по scp,
    разворачивает и проверяет, что сайт отвечает.

.EXAMPLE
    .\deploy.ps1 -Server 10.0.0.5 -User ubuntu
    .\deploy.ps1 -Server dev.example.ru -User root -Email admin@example.ru
    .\deploy.ps1 -Server 10.0.0.5 -User ubuntu -DryRun      # ничего не отправляет
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Server,
    [string] $User = "root",
    [int]    $Port = 22,
    [string] $Domain = "",
    [string] $Email = "",
    [string] $WebRoot = "/var/www/uchebnik",
    [string] $RemoteTmp = "/tmp",
    [switch] $SkipBuild,
    [switch] $SkipTls,
    [switch] $DryRun
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DeployDir   = $PSScriptRoot

# ---------------------------------------------------------------- вывод ---
function Step  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok    ($m) { Write-Host "    [ok] $m" -ForegroundColor Green }
function Info  ($m) { Write-Host "    $m"   -ForegroundColor DarkGray }
function Warn  ($m) { Write-Host "    [!] $m"  -ForegroundColor Yellow }
function Fail  ($m) { Write-Host "    [x] $m"  -ForegroundColor Red }

function Die ($m) { Fail $m; exit 1 }

# ------------------------------------------------------------ проверки ---
function Need-Command ($name, $hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Die "не найдена команда '$name'. $hint"
    }
}

Step "Проверяю окружение"
Need-Command "ssh"    "Установи OpenSSH Client: winget install Microsoft.OpenSSH.Client"
Need-Command "scp"    "Обычно входит в OpenSSH Client"
Need-Command "tar"    "Входит в Windows 10 1803+"

if (-not $SkipBuild) {
    Need-Command "python" "Установи Python 3.9+ с python.org"
}

$SshKey = Join-Path $HOME ".ssh\id_ed25519"
$UseKey = ""
if (Test-Path $SshKey) {
    $UseKey = "-i `"$SshKey`""
    Info "используется ключ $SshKey"
}

$Target = "$User@$Server"
function SshCmd { param([string]$Cmd) @("ssh", $UseKey, "-p", $Port, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", $Target, $Cmd) }
function ScpCmd { param([string]$Src, [string]$Dst) @("scp", $UseKey, "-P", $Port, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", $Src, "$Target`:$Dst") }

function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments, [string]$What = "команда")
    Info "$Exe $($Arguments -join ' ')"
    if ($DryRun) { return $null }
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { Die "$What завершилась с кодом $LASTEXITCODE" }
    return $null
}

# --------------------------------------------------------- 1. сборка ---
if (-not $SkipBuild) {
    Step "Собираю сайт"
    Push-Location $ProjectRoot
    try {
        Invoke-Native "python" @("build.py") "сборка"
    } finally { Pop-Location }
    Ok "html собран"
} else {
    Warn "сборка пропущена (-SkipBuild), едет текущий HTML"
}

if (-not (Test-Path (Join-Path $ProjectRoot "index.html"))) {
    Die "нет index.html — сначала запусти python build.py"
}
if (-not (Test-Path (Join-Path $ProjectRoot "lectures\index.html"))) {
    Die "нет lectures\index.html — сборка не удалась"
}

# ------------------------------------------- 2. что именно поедет на сервер
Step "Готовлю архив"
$Payload = @("index.html", "lectures", "assets")
foreach ($p in $Payload) {
    if (-not (Test-Path (Join-Path $ProjectRoot $p))) { Die "нет $p" }
}
# служебное точно не должно уехать наружу
$Leaks = @("content", "__pycache__", "build.py", "minidown.py", "template.html", "README.md") |
         Where-Object { Test-Path (Join-Path $ProjectRoot $_) }
if ($Leaks) { Info "в архив НЕ попадут: $($Leaks -join ', ')" }

$TarName = "uchebnik-$(Get-Date -Format 'yyyyMMdd-HHmm').tar.gz"
$TarPath = Join-Path $env:TEMP $TarName

if (-not $DryRun) {
    Push-Location $ProjectRoot
    try {
        $tarArgs = @(
            "-czf", $TarPath,
            "--exclude=__pycache__",
            "--exclude=*.py",
            "--exclude=*.md",
            "--exclude=deploy",
            $Payload
        )
        & tar @tarArgs
        if ($LASTEXITCODE -ne 0) { Die "не удалось собрать архив" }
    } finally { Pop-Location }
    $SizeKB = [math]::Round((Get-Item $TarPath).Length / 1KB)
    Ok "$TarName ($SizeKB КБ)"

    # быстрая проверка: секретов и исходников внутри быть не должно
    $listing = & tar -tzf $TarPath
    $bad = $listing | Where-Object { $_ -match '\.py$|\.md$|__pycache__' }
    if ($bad) { Die "в архиве посторонние файлы: $($bad -join ', ')" }
    Ok "архив чистый"
}

# ------------------------------------------------------ 3. отправка ---
$RemoteTar = "$RemoteTmp/$TarName"
$RemoteNginx = "$RemoteTmp/uchebnik-nginx.conf"
$RemoteSetup = "$RemoteTmp/uchebnik-setup.sh"

Step "Копирую на $Target"
Invoke-Native "scp" (ScpCmd $TarPath        $RemoteTar)    "передача архива"
Ok "архив на сервере: $RemoteTar"
Invoke-Native "scp" (ScpCmd (Join-Path $DeployDir "nginx.conf")     $RemoteNginx) "передача конфига"
Ok "конфиг на сервере"
Invoke-Native "scp" (ScpCmd (Join-Path $DeployDir "server-setup.sh") $RemoteSetup) "передача установщика"
Ok "установщик на сервере"

# ---------------------------------------------------- 4. развёртывание ---
$ServerName = if ($Domain) { $Domain } else { $Server }
Step "Разворачиваю (setup на сервере)"

$RemoteCmd = "sudo bash $RemoteSetup $RemoteNginx $RemoteTar $WebRoot $ServerName"
Invoke-Native "ssh" (SshCmd $RemoteCmd) "развёртывание"
Ok "сайт разложен в $WebRoot"

# ------------------------------------------------------- 5. проверка ---
Step "Проверяю, что сайт отвечает"
$CheckCmd = "curl -s -o /dev/null -w '%{http_code}' -H 'Host: $ServerName' http://127.0.0.1/"
if ($DryRun) {
    Info "было бы: ssh $Target `"$CheckCmd`""
} else {
    $code = (& ssh @($UseKey, "-p", $Port, "-o", "BatchMode=yes", $Target, $CheckCmd) 2>$null)
    if ($code -eq "200") {
        Ok "HTTP 200 — сайт живой"
    } else {
        Warn "сервер отвечает HTTP '$code'. Смотри логи:"
        Warn "  ssh $Target 'tail -n 40 /var/log/nginx/uchebnik.error.log'"
    }
}

# --------------------------------------------------------- 6. HTTPS ---
if ($Domain -and -not $SkipTls -and -not $DryRun) {
    if (-not $Email) {
        Warn "домен $Domain указан, но нет -Email — сертификат не выпущу"
        Warn "выпусти вручную: ssh $Target `"sudo certbot --nginx -d $Domain --redirect`""
    } else {
        Step "Выпускаю TLS-сертификат для $Domain"
        Invoke-Native "ssh" (SshCmd "sudo certbot --nginx -d $Domain --redirect --non-interactive --agree-tos -m $Email") "certbot"
        Ok "HTTPS готов"
    }
}

# ---------------------------------------------------------- итог ---
Write-Host ""
if ($DryRun) {
    Write-Host "  Это был пробный прогон. Ничего не отправлено." -ForegroundColor Yellow
} else {
    Write-Host "  Готово." -ForegroundColor Green
    $scheme = if ($Domain -and -not $SkipTls -and $Email) { "https" } else { "http" }
    Write-Host "    ${scheme}://$ServerName/"
    Write-Host "    Прямая ссылка: ${scheme}://$ServerName/lectures/index.html"
}
Write-Host ""
Write-Host "  Откат на предыдущую версию:"
Write-Host "    ssh $Target `"sudo rm -rf $WebRoot && sudo mv $WebRoot.previous $WebRoot && sudo systemctl reload nginx`""
Write-Host ""

if ($DryRun) {
    Remove-Item $TarPath -ErrorAction SilentlyContinue
}