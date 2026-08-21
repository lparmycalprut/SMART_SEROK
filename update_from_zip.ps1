param(
    [Parameter(Mandatory = $true)]
    [string]$ZipPath
)

$ErrorActionPreference = "Stop"
$BotRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ResolvedZip = (Resolve-Path $ZipPath).Path
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("gmgn_trading_bot_update_" + [guid]::NewGuid())

# File/folder lokal ini tidak boleh disentuh saat update.
$Preserve = @("bot.env", "config.toml", "var")

try {
    New-Item -ItemType Directory -Path $TempDir | Out-Null
    $BackupDir = Join-Path $TempDir "local_config_backup"
    New-Item -ItemType Directory -Path $BackupDir | Out-Null
    foreach ($LocalName in @("bot.env", "config.toml")) {
        $LocalPath = Join-Path $BotRoot $LocalName
        if (Test-Path $LocalPath) {
            Copy-Item -LiteralPath $LocalPath -Destination (Join-Path $BackupDir $LocalName) -Force
        }
    }
    Expand-Archive -LiteralPath $ResolvedZip -DestinationPath $TempDir -Force
    $Source = Join-Path $TempDir "gmgn_trading_bot"
    if (-not (Test-Path (Join-Path $Source "pyproject.toml"))) {
        throw "ZIP bukan paket gmgn_trading_bot yang valid."
    }

    foreach ($Item in Get-ChildItem -LiteralPath $Source -Force) {
        if ($Preserve -contains $Item.Name) {
            Write-Host "PRESERVE $($Item.Name)" -ForegroundColor Yellow
            continue
        }
        $Destination = Join-Path $BotRoot $Item.Name
        Copy-Item -LiteralPath $Item.FullName -Destination $Destination -Recurse -Force
        Write-Host "UPDATE   $($Item.Name)" -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "Update selesai. bot.env, config.toml, dan var/ tetap lokal." -ForegroundColor Cyan
    Write-Host "Validasi dengan: python -m gmgn_trading_bot.cli --config config.toml --check-config"
}
finally {
    $BackupDir = Join-Path $TempDir "local_config_backup"
    if (Test-Path $BackupDir) {
        foreach ($LocalName in @("bot.env", "config.toml")) {
            $BackupPath = Join-Path $BackupDir $LocalName
            if (Test-Path $BackupPath) {
                Copy-Item -LiteralPath $BackupPath -Destination (Join-Path $BotRoot $LocalName) -Force
            }
        }
    }
    if (Test-Path $TempDir) {
        Remove-Item -LiteralPath $TempDir -Recurse -Force
    }
}
