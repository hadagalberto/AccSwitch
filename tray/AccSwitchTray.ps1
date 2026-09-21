# AccSwitch tray - ícone na bandeja do Windows com troca de conta em 2 cliques.
# Roda em Windows PowerShell 5.1 ou PowerShell 7. Sem dependências externas.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic

$ErrorActionPreference = 'Stop'

# --- instância única -------------------------------------------------------
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\AccSwitchTray', [ref]$created)
if (-not $created) {
  [System.Windows.Forms.MessageBox]::Show('AccSwitch Tray já está rodando.', 'AccSwitch') | Out-Null
  return
}

$cli = Join-Path (Split-Path $PSScriptRoot -Parent) 'src\cli.js'
if (-not (Test-Path $cli)) { throw "cli.js não encontrado em $cli" }

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'node não encontrado no PATH.' }
$node = $nodeCmd.Source

# --- helpers ---------------------------------------------------------------

function Invoke-Cli {
  param([string[]]$CliArgs)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = (@("`"$cli`"") + $CliArgs) -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $proc = [System.Diagnostics.Process]::Start($psi)
  $out = $proc.StandardOutput.ReadToEnd()
  $err = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  [pscustomobject]@{ Ok = ($proc.ExitCode -eq 0); Out = $out; Err = $err }
}

function Get-Snapshot {
  param([switch]$Force)
  $cliArgs = @('usage', '--json')
  if ($Force) { $cliArgs += '--force' }
  $res = Invoke-Cli -CliArgs $cliArgs
  if (-not $res.Ok) { return $null }
  try { return $res.Out | ConvertFrom-Json } catch { return $null }
}

function Start-BackgroundRefresh {
  # Só aquece o cache; o menu lê na próxima abertura.
  Start-Process -FilePath $node -ArgumentList @("`"$cli`"", 'usage', '--json', '--force') `
    -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
}

function New-TrayIcon {
  param([int]$Percent = -1)
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'

  if ($Percent -lt 0)       { $fill = [System.Drawing.Color]::FromArgb(110, 118, 129) }
  elseif ($Percent -ge 90)  { $fill = [System.Drawing.Color]::FromArgb(218, 54, 51) }
  elseif ($Percent -ge 70)  { $fill = [System.Drawing.Color]::FromArgb(210, 153, 34) }
  else                      { $fill = [System.Drawing.Color]::FromArgb(35, 134, 54) }

  $brush = New-Object System.Drawing.SolidBrush $fill
  $g.FillEllipse($brush, 1, 1, 30, 30)
  $font = New-Object System.Drawing.Font 'Segoe UI', 15, ([System.Drawing.FontStyle]::Bold)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $g.DrawString('A', $font, [System.Drawing.Brushes]::White,
    (New-Object System.Drawing.RectangleF 0, 0, 32, 32), $fmt)
  $g.Dispose()

  $handle = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($handle)
  return $icon
}

# --- estado ----------------------------------------------------------------

$script:snapshot = $null
$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Icon = New-TrayIcon -Percent -1
$script:notify.Text = 'AccSwitch'
$script:notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.ShowImageMargin = $false
$script:notify.ContextMenuStrip = $menu

function Show-Balloon {
  param([string]$Title, [string]$Text)
  $script:notify.BalloonTipTitle = $Title
  $script:notify.BalloonTipText = $Text
  $script:notify.ShowBalloonTip(4000)
}

function Switch-Account {
  param([string]$ProviderId, [string]$ProviderName, [string]$Profile)
  $res = Invoke-Cli -CliArgs @('use', $ProviderId, "`"$Profile`"")
  if ($res.Ok) {
    Show-Balloon -Title 'Conta trocada' -Text "$ProviderName -> $Profile"
    Start-BackgroundRefresh
  } else {
    $msg = $res.Err
    if (-not $msg) { $msg = $res.Out }
    Show-Balloon -Title 'Falhou' -Text $msg.Trim()
  }
}

function Save-CurrentLogin {
  param([string]$ProviderId, [string]$ProviderName)
  $name = [Microsoft.VisualBasic.Interaction]::InputBox(
    "Nome do perfil para o login atual de $ProviderName", 'AccSwitch', 'pessoal')
  if ([string]::IsNullOrWhiteSpace($name)) { return }
  $res = Invoke-Cli -CliArgs @('save', $ProviderId, "`"$name`"")
  if ($res.Ok) {
    Show-Balloon -Title 'Perfil salvo' -Text "$ProviderName -> $name"
    Start-BackgroundRefresh
  } else {
    $msg = $res.Err
    if (-not $msg) { $msg = $res.Out }
    Show-Balloon -Title 'Falhou' -Text $msg.Trim()
  }
}

function Add-Header {
  param($Menu, [string]$Text)
  $item = New-Object System.Windows.Forms.ToolStripMenuItem $Text
  $item.Enabled = $false
  $item.Font = New-Object System.Drawing.Font($Menu.Font, [System.Drawing.FontStyle]::Bold)
  $Menu.Items.Add($item) | Out-Null
}

function Build-Menu {
  $menu.Items.Clear()
  $snap = $script:snapshot

  if (-not $snap) {
    Add-Header -Menu $menu -Text 'Falha ao ler contas'
  } else {
    $worst = -1
    $tooltip = @()

    foreach ($provider in $snap.providers) {
      Add-Header -Menu $menu -Text $provider.name

      foreach ($row in $provider.profiles) {
        $label = "   $($row.name)"
        if ($row.summary) { $label += "  -  $($row.summary)" }
        $item = New-Object System.Windows.Forms.ToolStripMenuItem $label
        $item.Checked = [bool]$row.active
        if ($row.account) { $item.ToolTipText = $row.account }
        if ($row.reset) { $item.ToolTipText = "$($item.ToolTipText)`n$($row.reset)" }

        if ($row.active) {
          $item.Enabled = $false
          if ($null -ne $row.worst -and $row.worst -gt $worst) { $worst = $row.worst }
          $tooltip += "$($provider.id): $($row.name) $($row.summary)"
        } else {
          $targetId = $provider.id; $targetName = $provider.name; $targetProfile = $row.name
          $item.Add_Click({
            Switch-Account -ProviderId $targetId -ProviderName $targetName -Profile $targetProfile
          }.GetNewClosure())
        }
        $menu.Items.Add($item) | Out-Null
      }

      if ($provider.live) {
        $liveLabel = '   (login atual, não salvo)'
        if ($provider.live.summary) { $liveLabel += "  -  $($provider.live.summary)" }
        $liveItem = New-Object System.Windows.Forms.ToolStripMenuItem $liveLabel
        $liveItem.Enabled = $false
        $menu.Items.Add($liveItem) | Out-Null
        if ($null -ne $provider.live.worst -and $provider.live.worst -gt $worst) { $worst = $provider.live.worst }
        $tooltip += "$($provider.id): $($provider.live.summary)"
      }

      $saveItem = New-Object System.Windows.Forms.ToolStripMenuItem '   + Salvar login atual...'
      $pid2 = $provider.id; $pname2 = $provider.name
      $saveItem.Add_Click({ Save-CurrentLogin -ProviderId $pid2 -ProviderName $pname2 }.GetNewClosure())
      $menu.Items.Add($saveItem) | Out-Null

      $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
    }

    $script:notify.Icon = New-TrayIcon -Percent $worst
    $tip = ($tooltip -join "`n")
    if ($tip.Length -gt 60) { $tip = $tip.Substring(0, 60) }
    if ($tip) { $script:notify.Text = $tip } else { $script:notify.Text = 'AccSwitch' }
  }

  $refresh = New-Object System.Windows.Forms.ToolStripMenuItem 'Atualizar uso agora'
  $refresh.Add_Click({
    $script:snapshot = Get-Snapshot -Force
    Build-Menu
    Show-Balloon -Title 'AccSwitch' -Text 'Uso atualizado.'
  })
  $menu.Items.Add($refresh) | Out-Null

  $openVault = New-Object System.Windows.Forms.ToolStripMenuItem 'Abrir pasta do vault'
  $openVault.Add_Click({ Start-Process explorer.exe (Join-Path $env:USERPROFILE '.accswitch') })
  $menu.Items.Add($openVault) | Out-Null

  $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

  $quit = New-Object System.Windows.Forms.ToolStripMenuItem 'Sair'
  $quit.Add_Click({
    $script:notify.Visible = $false
    $script:notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
  })
  $menu.Items.Add($quit) | Out-Null
}

# --- eventos ---------------------------------------------------------------

# Cada abertura do menu relê o snapshot (cache de 5 min no lado do Node,
# então é instantâneo na maior parte das vezes).
$menu.Add_Opening({
  $script:snapshot = Get-Snapshot
  Build-Menu
})

# Clique esquerdo também abre o menu -> troca em 2 cliques.
$script:notify.Add_MouseUp({
  if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $method = $script:notify.GetType().GetMethod('ShowContextMenu',
      [System.Reflection.BindingFlags]'NonPublic,Instance')
    $method.Invoke($script:notify, $null)
  }
})

# Aquece o cache a cada 10 minutos.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 600000
$timer.Add_Tick({ Start-BackgroundRefresh })
$timer.Start()

$script:snapshot = Get-Snapshot
Build-Menu

[System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
$mutex.ReleaseMutex()
