# Duplicate Radar — Communication Eligibility Check

Answers the question **"Can SDR / Marketing communicate with this domain
right now, or is it an active customer?"** with a structured verdict that
combines three signals:

1. **Contract state** — has any matching Deal been signed (`Stage =
   Agreement Signed` / `Closed Won`) and / or paid (`Invoiced = Yes`)?
2. **CS lifecycle** — Phase + Churn Date (from the Customer Success
   section on the Deal record).
3. **Sector cool-off** — private (default 6 months) vs government
   (default 12 months), resolved via `Gov_Type` or the domain TLD.

Closes the gap in the prior "BLOCK / REVIEW / WARN by Phase alone" logic:
a lost prospect (deal that never signed) no longer carries the same
cool-off as a real churned customer.

## Verdict matrix

```
ever_a_customer = YES (Stage ∈ signed list OR Invoiced = Yes)
─────────────────────────────────────────────────────────────────────────
  no churn date                          →  BLOCK   active signed customer
  churn date < sector cool-off           →  BLOCK   in CS recovery window
  churn date ≥ sector cool-off           →  ALLOW   past cool-off, OK to retry

ever_a_customer = NO (prospect that never closed)
─────────────────────────────────────────────────────────────────────────
  Phase ∈ {Onboarding, Adoption, Renewal} →  REVIEW  deal in progress
                                                      but no contract
  Phase = Termination                     →  ALLOW   prospect that
                                                      never paid
  no Phase / no CS record                 →  ALLOW   genuinely new
```

## API surface

```
POST /api/duplicates/communication-check
Body: { "domain": "<REDACTED_HOST>" }
```

Response shape:

```json
{
  "success": true,
  "domain_query": "<REDACTED_HOST>",
  "examined_deals": 1,
  "verdict": "block",
  "reason": "active_signed_customer_no_churn",
  "ever_a_customer": true,
  "active_now": true,
  "suggested_action": "Do NOT contact. This is an active signed customer — route to CS owner.",
  "matched_deals": [
    {
      "duplicate_record_id": 12345,
      "CRMProvider_record_id": "<REDACTED_ID>",
      "account_name": "شركة سحاب الوطنية",
      "domain": "<REDACTED_HOST>",
      "company_domain": "<REDACTED_HOST>",
      "cluster_id": 678,
      "phase": "Adoption",
      "stage_value": "Agreement Signed",
      "is_signed": true,
      "is_paid": true,
      "ever_a_customer": true,
      "signed_signals": ["stage:Agreement Signed"],
      "paid_signals": ["field:Invoiced=Yes"],
      "churn_date": null,
      "churn_days": null,
      "sector": "private",
      "per_deal_verdict": "block",
      "per_deal_reason": "active_signed_customer_no_churn"
    }
  ]
}
```

Same role gate as the rest of the Duplicate Radar (admin, grc_manager,
quality_manager, head_of_operations_quality, ai_specialist, bu_owner,
executive).

## Agentic surface

The same logic is exposed as a Mastra tool
`check-communication-eligibility` and registered on the ExampleOrg SDR
Quality Specialist agent. The agent can call this BEFORE recommending
outreach for any domain an operator asks about, producing a
human-readable explanation alongside the structured verdict.

Use it from agent chat: *"Should we reach out to <REDACTED_HOST>?"* → the
agent calls the tool, gets the BLOCK verdict + signals, and replies
with the reasoning + suggested action (e.g. "Do not contact — this is
an active signed customer; route to the CS owner").

## Configuration

Detection thresholds inherit from the existing CS-overlap module:

```
DUPLICATE_RADAR_CS_ACTIVE_PHASES=Onboarding,Adoption,Renewal
DUPLICATE_RADAR_CS_TERMINATION_PHASE=Termination
DUPLICATE_RADAR_CHURN_COOLOFF_PRIVATE_DAYS=180
DUPLICATE_RADAR_CHURN_COOLOFF_GOVERNMENT_DAYS=365
```

Contract-state detection:

```
# Stage values that mean signed (case-insensitive match)
CS_SIGNED_STAGES=Agreement Signed,Closed Won,Won,Signed

# Boolean / status fields that ALSO mean signed (truthy value)
CS_SIGNED_FIELDS=Agreement_Signed,Contract_Signed,Contract_Status
CS_SIGNED_FIELD_TRUTHY=yes,true,1,active,signed

# Boolean / status fields that mean paid
CS_PAID_FIELDS=Invoiced,Payment_Status,Paid
CS_PAID_FIELD_TRUTHY=yes,true,1,paid,active

# Stage field name fallback chain (in raw_data)
CS_STAGE_FIELD_KEYS=Stage,stage,Deal_Stage
```

Defaults reflect ExampleOrg's CRMProvider field layout: `Stage = "Agreement
Signed"` for the signed signal and `Invoiced = "Yes"` for the paid signal.

## Tests

[`tests/vitest/csContractState.vitest.test.ts`](../tests/vitest/csContractState.vitest.test.ts)
covers:

- Stage-based signed detection (Agreement Signed / Closed Won / etc).
- `Invoiced = Yes` paid detection.
- Combined signed + paid → full customer.
- Custom field-based signed detection.
- The full verdict matrix (each row above).
- `normalizeQuery` (protocol/www stripping, Saudi multi-level TLD
  preservation).

## Relationship to existing layers

| Layer | What it answers |
|---|---|
| Preflight (`/api/duplicates/preflight`) | "Will pushing this batch of N rows create duplicates / hit active customers?" — bulk pre-import gate |
| Communication check (this module) | "Should I contact THIS specific domain right now?" — point lookup with richer contract-state reasoning |
| CS Overlap detection | Domain-level radar verdicts (BLOCK / REVIEW / WARN) displayed on the dashboard |
| CS Lifecycle Compliance | SLA / process violations (Onboarding overdue, Phase ↔ Churn desync, etc.) |
| Auto-CAPA (Option B + Phase 5) | Tracked corrective actions when overlap or lifecycle rules fire critical |
| Agent tool `check-communication-eligibility` | LLM-driven natural-language explanation of the verdict, callable from any agent flow |
