# MCP Evaluation Harness (programmatic-only)

Scripted, deterministic evaluation of the SDR Call Validation MCP surface.
Tests the **SDR Governance 2.1 JSON rules engine** end-to-end against curated
transcripts and asserts that the right governance issues are surfaced.

## How it works

1. Scenario JSON files in `tests/mcp-eval/scenarios/` declare:
   - `transcript` — the input text to evaluate
   - `expect` — required issue codes, forbidden codes, severity bounds
2. The runner loads each scenario, calls `evaluateLoadedGovernanceRules(transcript)`
   (the same code path used by the `evaluate-sdr-governance` MCP tool and the
   `reconcile-call` reconciliation route), and asserts the result.
3. Exit code is `0` if every scenario passes, `1` otherwise — suitable for CI.

## Running

```bash
# All scenarios
npx tsx tests/mcp-eval/runMcpEval.ts

# A single scenario file (by stem, without .json)
npx tsx tests/mcp-eval/runMcpEval.ts --scenario sdr-governance-baseline
```

## Adding a scenario

Append an entry to an existing file or create a new one in `scenarios/`. Each
scenario has the shape:

```json
{
  "id": "unique_id",
  "description": "human-readable purpose",
  "transcript": "...",
  "expect": {
    "must_include_codes": ["sdr_gov_forbidden_claim"],
    "must_exclude_codes": ["sdr_gov_transcript_too_short"],
    "min_critical": 1,
    "max_critical": 99,
    "min_warning": 0,
    "max_warning": 99
  }
}
```

Codes correspond to `rules[].code` in
`src/config/sdr-governance-2.1.rules.json`. When you tune that JSON (e.g. add
the exact opening phrases from the ExampleOrg SDR Governance 2.1 PDF), add or
update scenarios that pin the new behavior in place.

## Scope

- **Programmatic only** — no LLM-as-judge, no agent loop. Validates the JSON
  rules engine and indirectly the wiring through `evaluateLoadedGovernanceRules`.
- For agent-loop evaluation (testing whether `sdrQualityAgent` picks the right
  tools), add a separate scenario set that captures the tool-call trace from
  `wrapToolWithTelemetry` once that surface is wired into the eval runner.
- The Drive ingest path and the lead phone match path are not exercised here —
  they require live external systems. Cover them in integration tests instead.
