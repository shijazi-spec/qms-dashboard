<#
.SYNOPSIS
    Register the WalaPlus documentation collector with Task Scheduler.

.DESCRIPTION
    Creates two scheduled tasks:

      "WalaPlus Doc Tracker - Daily Push"  06:00 daily, full reconcile.
      "WalaPlus Doc Tracker - Live Watch"  at startup, resident file watcher.

    BOTH ARE NEEDED, and the daily one is not redundant:
      - the watcher misses everything that happens while the machine is off or
        while the agent has crashed;
      - network shares drop FileSystemWatcher events under load WITHOUT
        reporting that they did;
      - it is a daily heartbeat. If no daily snapshot arrives, the platform
        raises a stale-collector alert. Silence from the collector must never be
        mistaken for "nothing changed".

    Run this from an elevated PowerShell prompt.

.PARAMETER LiveWatch
    Also register the resident watcher. Omit on a workstation that sleeps  - 
    there the daily reconcile plus Push-Now does the real work.

.PARAMETER RunAsUser
    Account the tasks run as. Defaults to SYSTEM, which survives sign-out. Use a
    service account if the library is on a share that SYSTEM cannot reach.
#>

[CmdletBinding()]
param(
    [switch]$LiveWatch,
    [string]$RunAsUser = 'SYSTEM',
    [string]$DailyTime = '06:00'
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'WalaPlusDocCollector.ps1'

if (-not (Test-Path -LiteralPath $script)) {
    throw "Collector script not found next to this installer: $script"
}

if ([string]::IsNullOrWhiteSpace($env:DOC_TRACKER_INGEST_KEY)) {
    Write-Warning 'DOC_TRACKER_INGEST_KEY is not set for this session.'
    Write-Warning 'The tasks will fail until it is set MACHINE-WIDE (see README.md).'
    Write-Warning 'A user-scoped variable is not enough - the tasks run as SYSTEM.'
}

function Register-CollectorTask {
    param([string]$Name, [string]$Arguments, [object]$Trigger)

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $Arguments
    $principal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                                             -DontStopIfGoingOnBatteries `
                                             -StartWhenAvailable `
                                             -RestartCount 3 `
                                             -RestartInterval (New-TimeSpan -Minutes 5)

    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
        Write-Host "Replaced existing task: $Name"
    }

    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger `
                           -Principal $principal -Settings $settings | Out-Null
    Write-Host "Registered: $Name"
}

# -StartWhenAvailable means a machine that was off at 06:00 still reconciles as
# soon as it comes back, which is exactly the gap the watcher cannot cover.
Register-CollectorTask `
    -Name 'WalaPlus Doc Tracker - Daily Push' `
    -Arguments "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Mode Daily" `
    -Trigger (New-ScheduledTaskTrigger -Daily -At $DailyTime)

if ($LiveWatch) {
    Register-CollectorTask `
        -Name 'WalaPlus Doc Tracker - Live Watch' `
        -Arguments "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Mode Live" `
        -Trigger (New-ScheduledTaskTrigger -AtStartup)
} else {
    Write-Host 'Live watcher NOT registered (pass -LiveWatch to enable).'
}

Write-Host ''
Write-Host 'Done. Verify with:'
Write-Host '  Get-ScheduledTask -TaskName "WalaPlus Doc Tracker*"'
Write-Host ''
Write-Host 'Test the daily task immediately with:'
Write-Host '  Start-ScheduledTask -TaskName "WalaPlus Doc Tracker - Daily Push"'
