<#
.SYNOPSIS
    WalaPlus Documentation Live Tracker - file-server collector.

.DESCRIPTION
    Scans the controlled documentation library, records what exists, hashes each
    file, validates the WP-* code, extracts document-to-document cross-references,
    and POSTs a full snapshot to the platform.

    WHAT THIS SENDS: metadata only - code, filename, folder, size, modified time,
    SHA-256 hash, code validity, and referenced document codes. It does NOT send
    document contents. Attaching an approved file to the register stays a
    deliberate human action in the platform UI, so a key sitting on a file server
    can never write document content into the controlled register.

    WHY FULL SNAPSHOTS, NOT DELTAS: 154-310 documents is a tiny payload, and
    sending the whole picture every time removes an entire class of sync bug. The
    server hashes the document facts (never the scan timestamp) and answers
    'duplicate' when nothing changed, so a frequent cadence costs almost nothing.

.PARAMETER Mode
    Manual  one-off push (default; used by Push-Now.cmd)
    Daily   scheduled full reconcile - catches anything the watcher missed while
            the machine was off, and network shares silently dropping events
    Live    stay resident, watch for changes, push after a 5-second debounce

.PARAMETER LibraryRoot
    Root of the controlled library. Defaults to the DOC_TRACKER_LIBRARY_ROOT
    environment variable, then to 'D:\GRQ files\Coded & Controlled'.

.PARAMETER DryRun
    Scan and report, but do not POST. Use this first - it prints exactly what
    would be sent.

.NOTES
    The ingest key is read from the DOC_TRACKER_INGEST_KEY environment variable
    and is NEVER stored in this file. See README.md for setting it machine-wide.

    Targets Windows PowerShell 5.1 (ships with Windows) - no ternary, no ??,
    no pipeline chain operators.
#>

[CmdletBinding()]
param(
    [ValidateSet('Manual', 'Daily', 'Live')]
    [string]$Mode = 'Manual',

    [string]$LibraryRoot,

    [string]$ApiBase,

    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# The hash spec this collector implements. Shipped from day one so a future
# change to what goes into the content hash is a negotiated upgrade rather than
# a fleet-wide rejection storm.
$Script:HashSpecVersion = 1
$Script:CollectorVersion = '1.0.0'

# Folders inside the library root that hold controlled documents.
$Script:Folders = @('Documents', 'Policies', 'SOPs', 'Forms', 'Security Controls')

# Extensions worth tracking. Anything else in the library is ignored rather than
# reported as an uncoded finding.
$Script:Extensions = @('.docx', '.doc', '.pdf', '.xlsx', '.xls', '.pptx')

# WP-<FAMILY>-<NNN>, anchored at the start of the filename.
$Script:CodePattern = '^(WP-(?:POL|DOC|SOP|FORM|CTL)-\d+)'
# Any WP code appearing in document text - used for cross-references.
$Script:RefPattern = 'WP-(?:POL|DOC|SOP|FORM|CTL)-\d+'

$Script:MaxDocuments = 2000
$Script:MaxRefsTotal = 20000

# ---------------------------------------------------------------- helpers ----

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$ts] [$Level] $Message"
}

function Get-Config {
    $root = $LibraryRoot
    if ([string]::IsNullOrWhiteSpace($root)) { $root = $env:DOC_TRACKER_LIBRARY_ROOT }
    if ([string]::IsNullOrWhiteSpace($root)) { $root = 'D:\GRQ files\Coded & Controlled' }

    $api = $ApiBase
    if ([string]::IsNullOrWhiteSpace($api)) { $api = $env:DOC_TRACKER_API_BASE }
    if ([string]::IsNullOrWhiteSpace($api)) { $api = 'https://qms-dashboard.replit.app' }

    $collectorId = $env:DOC_TRACKER_COLLECTOR_ID
    if ([string]::IsNullOrWhiteSpace($collectorId)) { $collectorId = $env:COMPUTERNAME }

    return [pscustomobject]@{
        LibraryRoot = $root.TrimEnd('\')
        ApiBase     = $api.TrimEnd('/')
        CollectorId = $collectorId
        Key         = $env:DOC_TRACKER_INGEST_KEY
        QueueDir    = (Join-Path $PSScriptRoot 'queue')
    }
}

<#
    Language is carried by the folder or filename ("Policies_AR", "..._AR.docx").
    EN and AR are separate register codes on the platform side (WP-POL-001 vs
    WP-POL-001-AR) because policy_number is globally unique, so getting this
    wrong would silently merge an Arabic document onto its English row.
#>
function Get-DocLanguage {
    param([string]$FolderName, [string]$FileName)
    if ($FolderName -match '(?i)(^|[_\-\s])AR($|[_\-\s])' -or $FolderName -match '(?i)arabic') { return 'AR' }
    if ($FileName   -match '(?i)[_\-]AR(\.[a-z0-9]+)?$' -or $FileName -match '(?i)arabic')     { return 'AR' }
    return 'EN'
}

<#
    Extract readable text from a .docx so cross-references can be found.
    A .docx is a zip; word/document.xml holds the body. Tags are stripped rather
    than parsed - we only need to spot WP-* codes, not reproduce the document.

    Other formats return empty: .pdf text extraction is not worth a dependency
    here, and a missing reference is a smaller problem than a fragile collector.
    Never throws - an unreadable file becomes an issue on the document, not a
    failed scan.
#>
function Get-DocxText {
    param([string]$Path)
    try {
        if ([System.IO.Path]::GetExtension($Path).ToLowerInvariant() -ne '.docx') { return '' }
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
        $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
        try {
            # Match on a normalised path. The zip spec mandates '/', and Word
            # complies, but some producers (including .NET's own
            # ZipFile::CreateFromDirectory on Windows) emit 'word\document.xml'.
            # An exact '/' comparison silently finds nothing and every document
            # reports zero cross-references.
            $entry = $zip.Entries |
                     Where-Object { $_.FullName.Replace('\', '/').ToLowerInvariant() -eq 'word/document.xml' } |
                     Select-Object -First 1
            if ($null -eq $entry) { return '' }
            $reader = New-Object System.IO.StreamReader($entry.Open())
            try { $xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
            # Close paragraph/tab boundaries so codes never fuse across runs.
            $xml = $xml -replace '</w:p>', ' '
            $xml = $xml -replace '<[^>]+>', ''
            return $xml
        } finally { $zip.Dispose() }
    } catch {
        return ''
    }
}

function Get-FileSha256 {
    param([string]$Path)
    try {
        $h = Get-FileHash -LiteralPath $Path -Algorithm SHA256
        return 'sha256:' + $h.Hash.ToLowerInvariant()
    } catch {
        return $null
    }
}

# ------------------------------------------------------------------ scan ----

function Invoke-LibraryScan {
    param([string]$Root)

    if (-not (Test-Path -LiteralPath $Root)) {
        # ${Root} is brace-delimited so the following '.' is punctuation, not a
        # member-access operator.
        throw "Library root not found: ${Root} - if the share is simply unmounted, do NOT let this push, because an empty scan would look like every document was deleted."
    }

    # Canonicalise the root before deriving relative folders. Get-ChildItem
    # returns fully-resolved DirectoryName values, so subtracting a literal
    # (possibly 8.3-shortened, differently-cased, or mapped-drive) root string
    # silently truncates the folder name.
    $Root = (Resolve-Path -LiteralPath $Root).ProviderPath.TrimEnd('\')

    $documents = New-Object System.Collections.ArrayList
    $refTotal = 0
    $seenCodes = New-Object 'System.Collections.Generic.HashSet[string]'

    # Resolve-Path -Relative works against the CURRENT location, so anchor it at
    # the library root for the duration of the scan. Restored in the finally
    # block below so a failure cannot leave the session in the wrong directory.
    Push-Location -LiteralPath $Root
    try {

    # Match top-level folders by PREFIX, not exact name. Bilingual libraries
    # split the set as "Policies_EN" / "Policies_AR" (the shape the handover
    # spec itself uses), and exact matching would silently skip every Arabic
    # document - the worst kind of miss, because the board would look complete.
    $topLevel = Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue
    $matched = New-Object System.Collections.ArrayList
    foreach ($d in $topLevel) {
        foreach ($base in $Script:Folders) {
            if ($d.Name -eq $base -or $d.Name -like ($base + '_*') -or $d.Name -like ($base + '-*')) {
                [void]$matched.Add($d.Name)
                break
            }
        }
    }
    if ($matched.Count -eq 0) {
        Write-Log "No recognised document folders under $Root (expected: $($Script:Folders -join ', ') , optionally suffixed _EN / _AR)" 'WARN'
    } else {
        Write-Log "Scanning folders: $($matched -join ', ')"
    }

    foreach ($folder in $matched) {
        $folderPath = Join-Path $Root $folder
        if (-not (Test-Path -LiteralPath $folderPath)) {
            Write-Log "Folder missing, skipping: $folder" 'WARN'
            continue
        }

        $files = Get-ChildItem -LiteralPath $folderPath -Recurse -File -ErrorAction SilentlyContinue |
                 Where-Object { $Script:Extensions -contains $_.Extension.ToLowerInvariant() } |
                 Where-Object { $_.Name -notmatch '^~\$' }   # Word lock files

        foreach ($f in $files) {
            if ($documents.Count -ge $Script:MaxDocuments) {
                Write-Log "Document cap ($($Script:MaxDocuments)) reached - remaining files skipped" 'WARN'
                break
            }

            $issues = New-Object System.Collections.ArrayList
            $code = $null
            $codeOk = $false

            $m = [regex]::Match($f.Name, $Script:CodePattern)
            if ($m.Success) {
                $code = $m.Groups[1].Value.ToUpperInvariant()
                $codeOk = $true
            } else {
                [void]$issues.Add('no_document_code')
            }

            # Derive the folder by asking the filesystem for a relative path
            # rather than subtracting string lengths. Windows can hand back 8.3
            # short forms, different casing, or a mapped-drive alias, and any of
            # those makes a Substring silently slice into the folder name (we
            # were reporting "5a96ec\Documents" instead of "Documents").
            $relFolder = $folder
            try {
                $relFull = Resolve-Path -LiteralPath $f.FullName -Relative
                $parent = Split-Path $relFull -Parent
                $parent = $parent -replace '^\.[\\/]', ''
                if (-not [string]::IsNullOrWhiteSpace($parent)) { $relFolder = $parent }
            } catch {
                # Fall back to the known top-level folder name.
            }
            $lang = Get-DocLanguage -FolderName $relFolder -FileName $f.Name

            $hash = Get-FileSha256 -Path $f.FullName
            if ($null -eq $hash) {
                [void]$issues.Add('unreadable_file')
            }

            # Duplicate codes are a real finding: two files claiming to be the
            # same controlled document means one of them is uncontrolled.
            $registerCode = $code
            if ($null -ne $code) {
                if ($lang -eq 'AR') { $registerCode = "$code-AR" }
                if ($seenCodes.Contains($registerCode)) {
                    [void]$issues.Add('duplicate_code')
                } else {
                    [void]$seenCodes.Add($registerCode)
                }
            }

            $refs = @()
            if ($refTotal -lt $Script:MaxRefsTotal) {
                $text = Get-DocxText -Path $f.FullName
                if (-not [string]::IsNullOrWhiteSpace($text)) {
                    $found = [regex]::Matches($text, $Script:RefPattern) |
                             ForEach-Object { $_.Value.ToUpperInvariant() } |
                             Select-Object -Unique
                    if ($null -ne $found) {
                        # A document referencing itself is noise, not a dependency.
                        $refs = @($found | Where-Object { $_ -ne $code })
                        $refTotal += $refs.Count
                    }
                }
            }

            $title = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
            if ($null -ne $code) {
                $title = $title -replace ('^' + [regex]::Escape($code) + '[_\-\s]*'), ''
            }
            $title = ($title -replace '[_]+', ' ').Trim()
            if ([string]::IsNullOrWhiteSpace($title)) { $title = $f.Name }

            [void]$documents.Add([pscustomobject]@{
                code        = $code
                lang        = $lang
                title       = $title
                file        = $f.Name
                folder      = $relFolder
                sizeKB      = [math]::Round($f.Length / 1KB, 2)
                modifiedAt  = $f.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ssZ')
                contentHash = $hash
                codeOk      = $codeOk
                issues      = @($issues)
                refs        = $refs
            })
        }
    }

    } finally {
        Pop-Location
    }

    # The leading comma stops PowerShell unrolling the collection on return.
    # Without it an EMPTY scan returns $null instead of an empty list, and the
    # caller's .Count check throws under StrictMode - which would turn the
    # single most important safety check (refuse to push an empty library) into
    # a crash.
    return ,$documents
}

# ------------------------------------------------------------------ push ----

function Send-Snapshot {
    param([object]$Config, [object]$Documents, [string]$PushMode)

    $payload = [pscustomobject]@{
        collectorId      = $Config.CollectorId
        collectorVersion = $Script:CollectorVersion
        hashSpecVersion  = $Script:HashSpecVersion
        libraryRoot      = $Config.LibraryRoot
        mode             = $PushMode.ToLowerInvariant()
        documents        = @($Documents)
    }

    # Depth matters: PowerShell 5.1 defaults to 2 and would silently flatten the
    # nested issues/refs arrays into type names.
    $json = $payload | ConvertTo-Json -Depth 6 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)

    Write-Log "Snapshot: $($Documents.Count) document(s), $([math]::Round($bytes.Length/1KB,1)) KB"

    if ($DryRun) {
        Write-Log 'DRY RUN - not sending. First 3 documents:' 'INFO'
        $Documents | Select-Object -First 3 | ConvertTo-Json -Depth 6 | Write-Host
        return $true
    }

    if ([string]::IsNullOrWhiteSpace($Config.Key)) {
        throw 'DOC_TRACKER_INGEST_KEY is not set. See README.md - the key must be a machine environment variable, never stored in this script.'
    }

    $uri = "$($Config.ApiBase)/api/documentation-tracker/ingest"
    $headers = @{ 'X-Tracker-Key' = $Config.Key; 'Content-Type' = 'application/json; charset=utf-8' }

    try {
        $resp = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $bytes -TimeoutSec 120
        $status = $resp.status
        Write-Log "Server accepted snapshot: status=$status inserted=$($resp.counts.inserted) updated=$($resp.counts.updated) removed=$($resp.counts.soft_deleted) orphans=$($resp.counts.orphans)"
        if ($status -eq 'partial') {
            # The server refused the delete sweep because the payload collapsed
            # the active set. Almost always an unmounted share or renamed folder.
            Write-Log "SERVER APPLIED PARTIALLY - mass-deletion guard tripped. Inserts/updates were applied, removals were NOT. Check the library share is fully mounted." 'WARN'
            if ($null -ne $resp.warnings) { $resp.warnings | ForEach-Object { Write-Log "  $_" 'WARN' } }
        }
        if ($status -eq 'duplicate') {
            Write-Log 'Nothing changed since the last accepted snapshot.'
        }
        return $true
    } catch {
        $msg = $_.Exception.Message
        $code = ''
        if ($null -ne $_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        Write-Log "Push failed ($code): $msg" 'ERROR'
        if ($code -eq 503) { Write-Log 'The platform reports ingest is not configured - DOC_TRACKER_INGEST_KEY is unset on the SERVER.' 'ERROR' }
        if ($code -eq 401) { Write-Log 'Key rejected. Confirm DOC_TRACKER_INGEST_KEY matches the value in Replit Secrets.' 'ERROR' }
        Save-QueuedSnapshot -Config $Config -Json $json
        return $false
    }
}

<#
    A failed push is queued to disk rather than dropped, and retried on the next
    run. Only the most recent snapshot is worth keeping - an older one describes
    a library state that no longer exists - so the queue holds exactly one file.
#>
function Save-QueuedSnapshot {
    param([object]$Config, [string]$Json)
    try {
        if (-not (Test-Path -LiteralPath $Config.QueueDir)) {
            New-Item -ItemType Directory -Path $Config.QueueDir -Force | Out-Null
        }
        $path = Join-Path $Config.QueueDir 'pending-snapshot.json'
        [System.IO.File]::WriteAllText($path, $Json, [System.Text.Encoding]::UTF8)
        Write-Log "Snapshot queued for retry: $path" 'WARN'
    } catch {
        Write-Log "Could not queue snapshot: $($_.Exception.Message)" 'ERROR'
    }
}

function Send-Heartbeat {
    param([object]$Config, [string]$LastError)
    if ($DryRun) { return }
    if ([string]::IsNullOrWhiteSpace($Config.Key)) { return }
    try {
        $body = [pscustomobject]@{
            collectorId      = $Config.CollectorId
            collectorVersion = $Script:CollectorVersion
            libraryRoot      = $Config.LibraryRoot
            lastError        = $LastError
        } | ConvertTo-Json -Depth 4 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $headers = @{ 'X-Tracker-Key' = $Config.Key; 'Content-Type' = 'application/json; charset=utf-8' }
        Invoke-RestMethod -Uri "$($Config.ApiBase)/api/documentation-tracker/heartbeat" `
                          -Method Post -Headers $headers -Body $bytes -TimeoutSec 30 | Out-Null
    } catch {
        Write-Log "Heartbeat failed: $($_.Exception.Message)" 'WARN'
    }
}

function Invoke-Push {
    param([object]$Config, [string]$PushMode)
    # NOT wrapped in @(): Invoke-LibraryScan already returns ',$documents' to
    # stop PowerShell unrolling the collection. Wrapping again would produce an
    # array containing the list, so .Count would always read 1 - including for
    # an empty scan, which would defeat the refuse-to-push check below.
    $docs = Invoke-LibraryScan -Root $Config.LibraryRoot

    if ($docs.Count -eq 0) {
        # Refuse locally as well as server-side. An empty scan from a mounted
        # share is possible; from an unmounted one it is a catastrophe waiting
        # to be applied.
        Write-Log 'Scan found ZERO documents - refusing to push. Verify the library share is mounted and the folder names are correct.' 'ERROR'
        Send-Heartbeat -Config $Config -LastError 'scan_returned_zero_documents'
        return $false
    }

    $ok = Send-Snapshot -Config $Config -Documents $docs -PushMode $PushMode
    if ($ok) { Send-Heartbeat -Config $Config -LastError $null }
    return $ok
}

function Invoke-QueuedRetry {
    param([object]$Config)
    $path = Join-Path $Config.QueueDir 'pending-snapshot.json'
    if (-not (Test-Path -LiteralPath $path)) { return }
    if ($DryRun) { return }
    if ([string]::IsNullOrWhiteSpace($Config.Key)) { return }
    Write-Log 'Retrying previously queued snapshot...'
    try {
        $json = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $headers = @{ 'X-Tracker-Key' = $Config.Key; 'Content-Type' = 'application/json; charset=utf-8' }
        Invoke-RestMethod -Uri "$($Config.ApiBase)/api/documentation-tracker/ingest" `
                          -Method Post -Headers $headers -Body $bytes -TimeoutSec 120 | Out-Null
        Remove-Item -LiteralPath $path -Force
        Write-Log 'Queued snapshot delivered.'
    } catch {
        Write-Log "Queued retry still failing: $($_.Exception.Message)" 'WARN'
    }
}

# ------------------------------------------------------------------ live ----

<#
    Live mode. Office writes a document as several file operations, so a single
    save fires many events - without the debounce this would push a dozen times
    per save. Events only mark the library dirty; the timer does the work.
#>
function Start-LiveWatch {
    param([object]$Config)

    $debounceSeconds = 5
    $heartbeatMinutes = 15
    $Script:Dirty = $false
    $Script:LastChange = [DateTime]::MinValue
    $lastHeartbeat = [DateTime]::UtcNow

    $watcher = New-Object System.IO.FileSystemWatcher
    $watcher.Path = $Config.LibraryRoot
    $watcher.IncludeSubdirectories = $true
    $watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite -bor `
                            [System.IO.NotifyFilters]::FileName -bor `
                            [System.IO.NotifyFilters]::Size
    $watcher.EnableRaisingEvents = $true

    $action = {
        $Script:Dirty = $true
        $Script:LastChange = [DateTime]::UtcNow
    }
    Register-ObjectEvent -InputObject $watcher -EventName Changed -Action $action | Out-Null
    Register-ObjectEvent -InputObject $watcher -EventName Created -Action $action | Out-Null
    Register-ObjectEvent -InputObject $watcher -EventName Deleted -Action $action | Out-Null
    Register-ObjectEvent -InputObject $watcher -EventName Renamed -Action $action | Out-Null

    Write-Log "Watching $($Config.LibraryRoot) (debounce ${debounceSeconds}s). Ctrl+C to stop."
    Invoke-Push -Config $Config -PushMode 'live' | Out-Null

    try {
        while ($true) {
            Start-Sleep -Seconds 1

            if ($Script:Dirty) {
                $quiet = ([DateTime]::UtcNow - $Script:LastChange).TotalSeconds
                if ($quiet -ge $debounceSeconds) {
                    $Script:Dirty = $false
                    Write-Log 'Change settled - pushing.'
                    Invoke-QueuedRetry -Config $Config
                    Invoke-Push -Config $Config -PushMode 'live' | Out-Null
                }
            }

            # A quiet library still heartbeats. Without this, "nothing changed"
            # and "the agent died" look identical to the platform.
            if (([DateTime]::UtcNow - $lastHeartbeat).TotalMinutes -ge $heartbeatMinutes) {
                Send-Heartbeat -Config $Config -LastError $null
                $lastHeartbeat = [DateTime]::UtcNow
            }
        }
    } finally {
        $watcher.EnableRaisingEvents = $false
        $watcher.Dispose()
        Get-EventSubscriber | Where-Object { $_.SourceObject -eq $watcher } | Unregister-Event
    }
}

# ------------------------------------------------------------------ main ----

$config = Get-Config
Write-Log "WalaPlus Documentation Collector v$($Script:CollectorVersion) (hash spec $($Script:HashSpecVersion))"
Write-Log "Mode=$Mode  Collector=$($config.CollectorId)"
Write-Log "Library=$($config.LibraryRoot)"
Write-Log "Platform=$($config.ApiBase)"
if ($DryRun) { Write-Log 'DRY RUN - nothing will be sent.' 'WARN' }

try {
    if ($Mode -eq 'Live') {
        Start-LiveWatch -Config $config
    } else {
        Invoke-QueuedRetry -Config $config
        $ok = Invoke-Push -Config $config -PushMode $Mode
        if (-not $ok) { exit 1 }
    }
    exit 0
} catch {
    Write-Log $_.Exception.Message 'ERROR'
    Send-Heartbeat -Config $config -LastError $_.Exception.Message
    exit 1
}
