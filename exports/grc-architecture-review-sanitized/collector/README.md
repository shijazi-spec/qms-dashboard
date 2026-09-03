# ExampleOrg Documentation Collector

Pushes the true state of the controlled documentation library to the
**Documentation Live Tracker** at `/documentation-tracker`.

Runs on the machine that holds the library — ideally an always-on file server.

---

## What it does, and what it deliberately does not

**Sends:** document code, filename, folder, size, last-modified time, a SHA-256
content hash, whether the code is well-formed, and which other WP-* documents
each one references.

**Does not send document contents.** Attaching an approved file to the register
stays a deliberate human action in the platform UI. That way a key sitting on a
file server can never write document content into the controlled register.

**Does not decide anything.** The collector reports what is on disk. Review
state, approval, and clause mapping are owned by the platform and are never
touched by a scan — that separation is what stops a tracker like this from
rotting.

---

## Setup

### 1. Get the ingest key

In Replit → **Secrets**, set `DOC_TRACKER_INGEST_KEY` to a random string of at
least 16 characters (32+ recommended). Until this is set the platform refuses
ingest with `503` — it fails closed rather than accepting unauthenticated writes.

Generate one:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
```

### 2. Set the key on this machine — machine-wide

The scheduled tasks run as SYSTEM, so a user-scoped variable is not enough.
From an **elevated** PowerShell prompt:

```powershell
[Environment]::SetEnvironmentVariable('DOC_TRACKER_INGEST_KEY', 'paste-the-key-here', 'Machine')
[Environment]::SetEnvironmentVariable('DOC_TRACKER_LIBRARY_ROOT', 'D:\GRQ files\Coded & Controlled', 'Machine')
[Environment]::SetEnvironmentVariable('DOC_TRACKER_API_BASE', 'https://<REDACTED_HOST>', 'Machine')
```

Close and reopen PowerShell afterwards — environment changes are not picked up
by existing sessions.

**The key must never be written into a script file or committed to source
control.** It is a bearer credential: anyone holding it can rewrite the tracker's
view of the library.

### 3. Dry run first

```powershell
.\WalaPlusDocCollector.ps1 -Mode Manual -DryRun
```

This scans and prints exactly what would be sent, without contacting the
platform. Check the document count looks right and the codes were detected
before sending anything real.

### 4. First real push

```powershell
.\WalaPlusDocCollector.ps1 -Mode Manual
```

Then open `/documentation-tracker`. The banner should change from *"No collector
has reported yet"* to a live board.

**Expect a large orphan count on the first push.** The register was seeded with
154 English codes and no `-AR` variants, so every Arabic document arrives as
"missing from the master list". Use **Promote all shown** on that panel — Arabic
copies inherit their English sibling's title, category and owner.

### 5. Schedule it

```powershell
# Always-on file server — daily reconcile plus the resident watcher
.\Install-Tasks.ps1 -LiveWatch

# A workstation that sleeps — daily reconcile only; use Push-Now.cmd when needed
.\Install-Tasks.ps1
```

---

## The three modes

| Mode | When | Why |
|---|---|---|
| **Manual** | `Push-Now.cmd`, or `-Mode Manual` | Certainty before a meeting |
| **Daily** | 06:00 via Task Scheduler | Full reconcile **and** the daily heartbeat |
| **Live** | resident watcher, 5s debounce | Changes appear within seconds |

**The daily push is not redundant with the watcher.** The watcher misses
everything that happens while the machine is off or after the agent has crashed,
and network shares drop `FileSystemWatcher` events under load *without reporting
that they did*. It is also the heartbeat: if no daily snapshot arrives within 26
hours the platform raises a stale-collector alert. Silence from the collector
must never be mistaken for "nothing changed".

The 5-second debounce exists because Office writes a document as several file
operations — without it, one save would trigger a dozen pushes.

---

## Safety behaviour

**An empty scan never pushes.** If the library root is missing or the scan finds
zero documents, the collector refuses locally and reports the problem. An
unmounted share would otherwise look exactly like "every document was deleted".

**The server refuses mass deletions too.** If a snapshot collapses the tracked
set by more than half, the platform applies the inserts and updates but **skips
the removals**, returning `partial` with reason `mass_deletion_guard`. You will
see a warning in the collector output. This is the guard that stops a
half-mounted share from wiping every review decision on the board in one push.

**Failed pushes are queued, not dropped.** The snapshot is written to
`queue\pending-snapshot.json` and retried on the next run. Only the latest is
kept — an older snapshot describes a library state that no longer exists.

**Re-sending an unchanged library costs nothing.** The server hashes the document
facts (never the scan timestamp) and answers `duplicate`, writing nothing and
generating no audit noise.

---

## Reading the output

```
[2026-07-29 <REDACTED_IP>] [INFO] Snapshot: 168 document(s), 47.2 KB
[2026-07-29 <REDACTED_IP>] [INFO] Server accepted snapshot: status=applied inserted=14 updated=3 removed=0 orphans=150
```

| Status | Meaning |
|---|---|
| `applied` | Accepted in full |
| `duplicate` | Nothing changed since the last accepted snapshot |
| `partial` | **Mass-deletion guard tripped** — check the share is fully mounted |

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `503` — ingest not configured | `DOC_TRACKER_INGEST_KEY` is unset **on the platform**, in Replit Secrets |
| `401` — key rejected | The machine's key does not match Replit's |
| `Library root not found` | Share unmounted, or the path/folder names differ |
| Scan finds 0 documents | Folder names must be `Documents`, `Policies`, `SOPs`, `Forms`, `Security Controls` |
| Everything shows as orphan | Expected on first push — promote them, especially the Arabic set |
| Task runs but nothing arrives | The key was set user-scoped; tasks run as SYSTEM and need it `Machine`-scoped |

Tracked file types: `.docx .doc .pdf .xlsx .xls .pptx`. Word lock files (`~$…`)
are ignored. **Cross-references are only extracted from `.docx`** — a PDF's
references will not be detected, which is a known limitation rather than a bug.

---

## Retuning without redeploying

The platform exposes the scan configuration it expects:

```powershell
$h = @{ 'X-Tracker-Key' = $env:DOC_TRACKER_INGEST_KEY }
Invoke-RestMethod -Uri 'https://<REDACTED_HOST>/api/documentation-tracker/collector-config' -Headers $h
```

`hashSpecVersion` is sent with every snapshot, so a future change to what goes
into the content hash becomes a negotiated upgrade rather than a fleet-wide
rejection storm.
