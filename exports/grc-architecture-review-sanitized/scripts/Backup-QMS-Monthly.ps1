#requires -Version 5.1
<#
.SYNOPSIS
    Monthly HostingPlatform → D: drive backup of the QMS Postgres database.
    Designed to run under Windows Task Scheduler on the 1st of every
    month at 09:00 Riyadh time.

.DESCRIPTION
    HostingPlatform is the sole environment for the QMS platform. This script is
    the on-premises backup: it pulls a fresh pg_dump directly from
    HostingPlatform's managed Postgres (DatabaseProvider under the hood) and lands the file
    on the user's D: drive. Nothing lives in the cloud that isn't HostingPlatform,
    and nothing lives on the PC that isn't a file.

    The script:
        1. Reads HostingPlatform_DATABASE_URL from a Windows user environment variable.
        2. Runs pg_dump in custom format (compressed, restore-friendly).
        3. Writes to D:\2_QMS Platform\_local_backup_sql\qms-YYYY-MM.dump.
           (YYYY-MM naming lets Windows sort backups chronologically.)
        4. Deletes backups older than 12 months (rolling retention).
        5. Logs progress to D:\2_QMS Platform\_local_backup_sql\backup.log.

.PARAMETER BackupRoot
    Where to write the backup. Default: D:\2_QMS Platform\_local_backup_sql

.PARAMETER RetentionMonths
    Months to keep older backups. Default: 12.

.PARAMETER PgDumpPath
    Full path to pg_dump.exe. If empty, the script looks at PATH and the
    standard PostgreSQL install locations.

.EXAMPLE
    .\Backup-QMS-Monthly.ps1

.EXAMPLE
    # Keep last 24 months instead of 12
    .\Backup-QMS-Monthly.ps1 -RetentionMonths 24

.NOTES
    Required environment variable: HostingPlatform_DATABASE_URL
        Source: HostingPlatform → your QMS Repl → Tools → Secrets → copy the value of
                DATABASE_URL (or PROD_DATABASE_URL — the DatabaseProvider connection string).
        Format: postgres://<user>:<pass>@<host>.DatabaseProvider.tech/<db>?sslmode=require

    Set it once, persistently, for your Windows user with:
        [Environment]::SetEnvironmentVariable(
            "HostingPlatform_DATABASE_URL",
            "<REDACTED_DSN>",
            "User"
        )

    Then Windows Task Scheduler will inherit it automatically as long as
    the task runs as your user.

    Task Scheduler setup (once):
        1. taskschd.msc → Create Task
        2. Triggers → New → Monthly, day 1, 09:00
        3. Actions → New → Program: powershell.exe
           Arguments:
             -ExecutionPolicy Bypass -NoProfile -File
             "D:\2_QMS Platform\ExampleOrg\scripts\Backup-QMS-Monthly.ps1"
        4. Settings → check "Run task as soon as possible after a
           scheduled start is missed" (in case PC is off on the 1st)
#>

[CmdletBinding()]
param(
    [string] $BackupRoot = "D:\2_QMS Platform\_local_backup_sql",
    [int]    $RetentionMonths = 12,
    [string] $PgDumpPath = ""
)

$ErrorActionPreference = "Stop"
$startedAt = Get-Date

# ─── Locate pg_dump.exe ──────────────────────────────────────────────────────
function Find-PgDump {
    if ($PgDumpPath -and (Test-Path $PgDumpPath)) {
        return $PgDumpPath
    }
    # PATH lookup first.
    $pathHit = (Get-Command pg_dump.exe -ErrorAction SilentlyContinue).Source
    if ($pathHit) { return $pathHit }
    # Standard install locations as fallback.
    $candidates = @(
        "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe",
        "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe",
        "C:\Program Files\PostgreSQL\15\bin\pg_dump.exe",
        "C:\Program Files\PostgreSQL\14\bin\pg_dump.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    throw "pg_dump.exe not found. Pass -PgDumpPath, install PostgreSQL client tools, or add pg_dump to PATH."
}

# ─── Locate connection string ────────────────────────────────────────────────
$connStr = $env:HostingPlatform_DATABASE_URL
if (-not $connStr) {
    throw "HostingPlatform_DATABASE_URL environment variable is not set. See script .NOTES for setup."
}

# ─── Prepare backup directory + log ──────────────────────────────────────────
if (-not (Test-Path $BackupRoot)) {
    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
}
$logFile = Join-Path $BackupRoot "backup.log"

function Write-Log {
    param([string] $Message, [string] $Level = "INFO")
    $line = "{0:yyyy-MM-dd HH:mm:ss} [{1}] {2}" -f (Get-Date), $Level, $Message
    Add-Content -Path $logFile -Value $line -Encoding utf8
    Write-Host $line
}

Write-Log "═══════════════════════════════════════════════════"
Write-Log "Monthly HostingPlatform → D: drive backup — started"
Write-Log "BackupRoot      = $BackupRoot"
Write-Log "RetentionMonths = $RetentionMonths"

try {
    $pgDump = Find-PgDump
    Write-Log "pg_dump         = $pgDump"

    # ─── Run pg_dump ─────────────────────────────────────────────────────────
    # Filename uses year-month (yyyy-MM) not full date so re-running mid-month
    # overwrites the same file instead of accumulating duplicates. If you'd
    # rather keep every attempt, change to "yyyy-MM-dd".
    $monthStamp = $startedAt.ToString("yyyy-MM")
    $outFile    = Join-Path $BackupRoot "qms-$monthStamp.dump"

    Write-Log "Running pg_dump → $outFile"

    # -Fc = custom format (compressed, restore with pg_restore).
    # --no-owner drops per-role GRANT/REVOKE noise that wouldn't apply on
    # a different DB anyway. --no-acl drops object-level ACLs same reason.
    & $pgDump --format=custom --no-owner --no-acl --file=$outFile $connStr 2>&1 | ForEach-Object {
        Write-Log "pg_dump: $_" "DEBUG"
    }
    if ($LASTEXITCODE -ne 0) {
        throw "pg_dump exited with code $LASTEXITCODE"
    }
    $sizeMB = [math]::Round((Get-Item $outFile).Length / 1MB, 1)
    Write-Log "✓ Dump complete: $sizeMB MB"

    # ─── Rolling retention ───────────────────────────────────────────────────
    $cutoff = (Get-Date).AddMonths(-$RetentionMonths)
    $purged = 0
    Get-ChildItem -Path $BackupRoot -Filter "qms-*.dump" |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        ForEach-Object {
            Write-Log "Purging old backup: $($_.Name) ($([math]::Round($_.Length / 1MB, 1)) MB)"
            Remove-Item $_.FullName -Force
            $purged++
        }
    if ($purged -gt 0) {
        Write-Log "Purged $purged backup(s) older than $RetentionMonths months"
    }

    # ─── Summary ─────────────────────────────────────────────────────────────
    $elapsed = (Get-Date) - $startedAt
    $totalBackups = (Get-ChildItem -Path $BackupRoot -Filter "qms-*.dump" | Measure-Object).Count
    $totalMB      = [math]::Round((Get-ChildItem -Path $BackupRoot -Filter "qms-*.dump" | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
    Write-Log ("Backup finished in {0:N1}s ✓" -f $elapsed.TotalSeconds)
    Write-Log "Backup shelf holds $totalBackups file(s), $totalMB MB total"
    exit 0
} catch {
    Write-Log "BACKUP FAILED: $($_.Exception.Message)" "ERROR"
    Write-Log $_.ScriptStackTrace "ERROR"
    exit 1
}
