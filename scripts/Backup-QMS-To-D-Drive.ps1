#requires -Version 5.1
<#
.SYNOPSIS
    Pull a fresh pg_dump from Supabase and save it as a gzipped backup on
    the D: drive. Designed to run automatically via Windows Task Scheduler
    every Saturday morning Riyadh time, ~12 hours after the Replit-side
    scheduled job refreshes Supabase from the live Replit Postgres.

.DESCRIPTION
    Architecture:
        Fri 23:00 Riyadh:  Mastra scheduled job  →  Supabase     (automatic)
        Sat 09:00 Riyadh:  This script           →  D:\…\*.sql    (automatic)

    The script:
        1. Reads SUPABASE_DATABASE_URL from an environment variable.
        2. Runs pg_dump in custom format against that URL.
        3. Writes the dump to D:\2_QMS Platform\_local_backup_sql\.
        4. Names it qms-YYYY-MM-DD.dump for sortability.
        5. Deletes backups older than 28 days (4-week rolling retention).
        6. Logs progress to D:\2_QMS Platform\_local_backup_sql\backup.log.

.PARAMETER BackupRoot
    Where to write the backup. Default: D:\2_QMS Platform\_local_backup_sql

.PARAMETER RetentionDays
    Days to keep older backups. Default: 28 (4 weeks).

.PARAMETER PgDumpPath
    Full path to pg_dump.exe. If empty, the script looks at PATH and the
    standard PostgreSQL install locations.

.EXAMPLE
    Backup-QMS-To-D-Drive.ps1

.EXAMPLE
    Backup-QMS-To-D-Drive.ps1 -RetentionDays 56

.NOTES
    Required environment variable: SUPABASE_DATABASE_URL
        Format: postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
        (use the Transaction pooler URL — port 6543 — not the Session pooler.)

    Set it for the CURRENT USER persistently with:
        [Environment]::SetEnvironmentVariable("SUPABASE_DATABASE_URL", "postgresql://...", "User")

    Then Windows Task Scheduler will inherit it automatically as long as
    the task runs as that user.
#>

[CmdletBinding()]
param(
    [string] $BackupRoot = "D:\2_QMS Platform\_local_backup_sql",
    [int]    $RetentionDays = 28,
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
$connStr = $env:SUPABASE_DATABASE_URL
if (-not $connStr) {
    throw "SUPABASE_DATABASE_URL environment variable is not set. See script .NOTES for setup."
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

Write-Log "Backup started"
Write-Log "BackupRoot   = $BackupRoot"
Write-Log "RetentionDays= $RetentionDays"

try {
    $pgDump = Find-PgDump
    Write-Log "pg_dump      = $pgDump"

    # ─── Run pg_dump ─────────────────────────────────────────────────────────
    $dateStamp = $startedAt.ToString("yyyy-MM-dd")
    $outFile   = Join-Path $BackupRoot "qms-$dateStamp.dump"

    Write-Log "Running pg_dump → $outFile"

    # -Fc = custom format (compressed, smaller than plain SQL, restorable
    # with pg_restore). --no-owner avoids GRANT/REVOKE noise from a
    # different role. --no-acl drops object-level ACLs that wouldn't
    # restore cleanly anyway.
    & $pgDump --format=custom --no-owner --no-acl --file=$outFile $connStr 2>&1 | ForEach-Object {
        Write-Log "pg_dump: $_" "DEBUG"
    }
    if ($LASTEXITCODE -ne 0) {
        throw "pg_dump exited with code $LASTEXITCODE"
    }
    $sizeMB = [math]::Round((Get-Item $outFile).Length / 1MB, 1)
    Write-Log "✓ Dump complete: $sizeMB MB"

    # ─── Rolling retention ───────────────────────────────────────────────────
    $cutoff = (Get-Date).AddDays(-$RetentionDays)
    $purged = 0
    Get-ChildItem -Path $BackupRoot -Filter "qms-*.dump" |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        ForEach-Object {
            Write-Log "Purging old backup: $($_.Name) ($([math]::Round($_.Length / 1MB, 1)) MB)"
            Remove-Item $_.FullName -Force
            $purged++
        }
    if ($purged -gt 0) {
        Write-Log "Purged $purged backup(s) older than $RetentionDays days"
    }

    # ─── Summary ─────────────────────────────────────────────────────────────
    $elapsed = (Get-Date) - $startedAt
    Write-Log ("Backup finished in {0:N1}s ✓" -f $elapsed.TotalSeconds)
    exit 0
} catch {
    Write-Log "BACKUP FAILED: $($_.Exception.Message)" "ERROR"
    Write-Log $_.ScriptStackTrace "ERROR"
    exit 1
}
