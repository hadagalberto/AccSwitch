<#
.SYNOPSIS
  Instala (ou remove) o AccSwitch no Windows sem npm.

.DESCRIPTION
  Copia o programa para uma pasta do usuario, cria os atalhos de linha de
  comando `accswitch` e `acs`, e adiciona a pasta ao PATH do usuario.
  Nao precisa de administrador. Requer apenas o Node.js 20+.

.EXAMPLE
  Direto do GitHub, sem clonar nada:

    irm https://raw.githubusercontent.com/hadagalberto/AccSwitch/main/install.ps1 | iex

  Com opcoes (o pipe para iex nao aceita parametros; use um scriptblock):

    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/hadagalberto/AccSwitch/main/install.ps1))) -Tray

  Da pasta clonada:

    .\install.ps1                 instala em %LOCALAPPDATA%\AccSwitch
    .\install.ps1 -Tray           instala e liga o tray junto com o Windows
    .\install.ps1 -Dest D:\Tools\AccSwitch
    .\install.ps1 -Uninstall      remove o programa (mantem os perfis salvos)
    .\install.ps1 -Uninstall -PurgeVault   remove tambem ~/.accswitch (tokens!)
#>
[CmdletBinding()]
param(
  [string]$Dest = (Join-Path $env:LOCALAPPDATA 'AccSwitch'),
  [string]$Repo = 'hadagalberto/AccSwitch',
  [string]$Branch = 'main',
  [switch]$Tray,
  [switch]$Uninstall,
  [switch]$PurgeVault
)

$ErrorActionPreference = 'Stop'
$MinNode = 20

function Write-Step([string]$Text) { Write-Host "  > $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text)   { Write-Host "  + $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "  ! $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "  x $Text" -ForegroundColor Red }

function Get-UserPath {
  [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Set-UserPath([string]$Value) {
  [Environment]::SetEnvironmentVariable('Path', $Value, 'User')
}

function Add-ToUserPath([string]$Dir) {
  $entries = (Get-UserPath) -split ';' | Where-Object { $_ }
  if ($entries -contains $Dir) { return $false }
  Set-UserPath (($entries + $Dir) -join ';')
  return $true
}

function Remove-FromUserPath([string]$Dir) {
  $entries = (Get-UserPath) -split ';' | Where-Object { $_ -and $_ -ne $Dir }
  Set-UserPath ($entries -join ';')
}

function Test-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $null }
  $raw = (& $node.Source -v) -replace '^v', ''
  $major = [int]($raw.Split('.')[0])
  [pscustomobject]@{ Path = $node.Source; Version = $raw; Major = $major }
}

# ---------------------------------------------------------------------------

Write-Host ''
Write-Host 'AccSwitch - instalador' -ForegroundColor White
Write-Host ''

if ($Uninstall) {
  Write-Step "Removendo $Dest"

  $startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'AccSwitch Tray.lnk'
  if (Test-Path $startupLink) {
    Remove-Item $startupLink -Force
    Write-Ok 'Atalho de inicializacao removido'
  }

  # Get-Process nao expoe CommandLine no PowerShell 5.1; CIM expoe (tray).
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*AccSwitchTray.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  Remove-FromUserPath $Dest
  Write-Ok 'Removido do PATH do usuario'

  if (Test-Path $Dest) {
    Remove-Item $Dest -Recurse -Force
    Write-Ok 'Arquivos removidos'
  }

  $vault = Join-Path $env:USERPROFILE '.accswitch'
  if ($PurgeVault -and (Test-Path $vault)) {
    Remove-Item $vault -Recurse -Force
    Write-Ok 'Vault ~/.accswitch removido (perfis e tokens apagados)'
  } elseif (Test-Path $vault) {
    Write-Warn "Perfis mantidos em $vault (use -PurgeVault para apagar)"
  }

  Write-Host ''
  Write-Host 'Pronto. Abra um novo terminal para o PATH atualizar.' -ForegroundColor White
  return
}

# --- pre-requisito: Node 20+ ------------------------------------------------

$nodeInfo = Test-Node
if (-not $nodeInfo) {
  Write-Fail 'Node.js nao encontrado no PATH.'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $answer = Read-Host '  Instalar Node.js LTS via winget agora? [s/N]'
    if ($answer -match '^[sSyY]') {
      winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
      Write-Warn 'Node instalado. Abra um NOVO terminal e rode o install.ps1 de novo.'
      return
    }
  }
  Write-Host '  Baixe em https://nodejs.org (versao LTS) e rode este script de novo.'
  exit 1
}
if ($nodeInfo.Major -lt $MinNode) {
  Write-Fail "Node $($nodeInfo.Version) encontrado; precisa de $MinNode ou superior."
  exit 1
}
Write-Ok "Node $($nodeInfo.Version) em $($nodeInfo.Path)"

# --- copia dos arquivos -----------------------------------------------------

# Rodando da pasta clonada, instala dali. Rodando via `irm | iex`, nao ha
# pasta nenhuma: baixa o zip do branch direto do GitHub.
$source = $null
$downloaded = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'src\cli.js'))) {
  $source = $PSScriptRoot
  Write-Ok "Fonte: pasta local ($source)"
} else {
  $zipUrl = "https://github.com/$Repo/archive/refs/heads/$Branch.zip"
  $downloaded = Join-Path $env:TEMP ("accswitch-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $downloaded | Out-Null
  $zip = Join-Path $downloaded 'repo.zip'

  Write-Step "Baixando $zipUrl"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $downloaded -Force

  $source = Get-ChildItem $downloaded -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'src\cli.js') } | Select-Object -First 1 -ExpandProperty FullName
  if (-not $source) {
    Write-Fail 'O zip baixado nao contem src\cli.js. Repo ou branch errados?'
    exit 1
  }
  Write-Ok "Fonte: GitHub $Repo@$Branch"
}

Write-Step "Instalando em $Dest"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

foreach ($item in @('src', 'tray', 'package.json', 'README.md')) {
  $from = Join-Path $source $item
  $to = Join-Path $Dest $item
  if (-not (Test-Path $from)) { continue }
  if (Test-Path $to) { Remove-Item $to -Recurse -Force }
  Copy-Item $from $to -Recurse -Force
}
Copy-Item (Join-Path $source 'install.ps1') (Join-Path $Dest 'install.ps1') -Force

# O tar/zip do GitHub pode entregar o .ps1 do tray sem BOM; o Windows
# PowerShell 5.1 leria como ANSI e os acentos quebrariam o parser. Reescreve
# com BOM garantido.
$trayPs1 = Join-Path $Dest 'tray\AccSwitchTray.ps1'
if (Test-Path $trayPs1) {
  $text = Get-Content $trayPs1 -Raw -Encoding UTF8
  [System.IO.File]::WriteAllText($trayPs1, $text, (New-Object System.Text.UTF8Encoding $true))
}
Write-Ok 'Arquivos copiados'

# --- shims de linha de comando ----------------------------------------------

$shim = "@echo off`r`nnode `"%~dp0src\cli.js`" %*`r`n"
foreach ($name in @('accswitch', 'acs')) {
  [System.IO.File]::WriteAllText((Join-Path $Dest "$name.cmd"), $shim, [System.Text.Encoding]::ASCII)
}
Write-Ok 'Comandos accswitch e acs criados'

# --- PATH -------------------------------------------------------------------

if (Add-ToUserPath $Dest) {
  Write-Ok 'Adicionado ao PATH do usuario'
} else {
  Write-Ok 'Ja estava no PATH'
}
# Deixa disponivel nesta sessao tambem, sem precisar reabrir o terminal.
if (($env:Path -split ';') -notcontains $Dest) { $env:Path = "$env:Path;$Dest" }

# --- primeira execucao: cria o vault com ACL restrita -----------------------

& node (Join-Path $Dest 'src\cli.js') doctor | Out-Null
Write-Ok 'Vault criado em ~/.accswitch'

# --- tray (opcional) --------------------------------------------------------

if ($Tray) {
  & node (Join-Path $Dest 'src\cli.js') startup on | Out-Null
  & node (Join-Path $Dest 'src\cli.js') tray | Out-Null
  Write-Ok 'Tray ligado e configurado para iniciar com o Windows'
}

if ($downloaded -and (Test-Path $downloaded)) {
  Remove-Item $downloaded -Recurse -Force -ErrorAction SilentlyContinue
}

# --- resumo -----------------------------------------------------------------

Write-Host ''
Write-Host 'Instalado.' -ForegroundColor White
Write-Host ''
Write-Host '  Proximos passos:'
Write-Host '    accswitch doctor              ve quais CLIs foram detectadas'
Write-Host '    accswitch save codex pessoal  salva o login atual como perfil'
Write-Host '    accswitch                     seletor interativo'
Write-Host '    accswitch usage               limite usado por conta'
if (-not $Tray) {
  Write-Host '    accswitch tray                icone na bandeja (ou rode install.ps1 -Tray)'
}
Write-Host ''
Write-Host "  Desinstalar: & `"$Dest\install.ps1`" -Uninstall" -ForegroundColor DarkGray
Write-Host '  Terminais ja abertos precisam ser reabertos para enxergar o comando.' -ForegroundColor DarkGray
Write-Host ''
