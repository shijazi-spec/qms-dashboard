/**
 * githubEvidenceConnector — collects audit evidence from GitHub, read-only.
 *
 * WHAT THIS IS FOR
 * An external auditor examining ISO 27001 or SOC 2 asks the engineering team the
 * same handful of questions: can someone push straight to main, is code
 * reviewed, are known vulnerable dependencies tracked, who has write access.
 * Today those answers are gathered by hand into screenshots, at the moment
 * somebody remembers to take them. This records them on a schedule, with a
 * timestamp, so the answer to "was this true in March" is a query rather than an
 * archaeology exercise.
 *
 * SCOPE
 * One repository (GITHUB_EVIDENCE_REPO). Deliberately narrow to start: the
 * checks are the same shape at org level, and widening later is a loop over
 * repos, not a redesign.
 *
 * EVERY CALL IS READ-ONLY. This connector has no write path to GitHub by
 * construction — githubGet is the only API surface it imports.
 *
 * HONEST STATUSES
 * A check that cannot run reports 'not_applicable' or 'error', never 'pass'.
 * A connector that silently reports success when it could not look is worse than
 * no connector: it manufactures assurance, and an auditor relying on it would be
 * misled. 404 on the security endpoints means the feature is not enabled, which
 * is a real finding in itself and is recorded as 'not_applicable' with the
 * reason, not swallowed.
 */

import { githubGet, githubAppConfigured } from "./githubAppAuth";
import {
  recordObservations,
  type ConnectorObservation,
} from "./connectorEvidenceDatabase";
import { logger } from "./logger";

export const GITHUB_SOURCE = "github";

/** Repository to collect from, as owner/name. */
export function evidenceRepo(): string {
  return (process.env.GITHUB_EVIDENCE_REPO || "shijazi-spec/qms-dashboard").trim();
}

/**
 * Which clauses each check speaks to.
 *
 * Declared here, in code, rather than inferred: an auditor is entitled to ask
 * "why does this screenshot satisfy A.8.32", and the answer should be a
 * reviewable decision someone made, not the output of a similarity score. Codes
 * match the obligation_code format used by the framework seeds
 * (ISO27001-A.8.32, SOC2-CC8.1).
 */
export const CHECK_CLAUSE_MAP: Record<string, string[]> = {
  branch_protection: ["ISO27001-A.8.32", "SOC2-CC8.1"],
  code_review_required: ["ISO27001-A.8.32", "SOC2-CC8.1"],
  dependabot_alerts: ["ISO27001-A.8.8", "SOC2-CC7.1"],
  secret_scanning: ["ISO27001-A.8.12", "ISO27001-A.5.15"],
  repo_access: ["ISO27001-A.5.15", "ISO27001-A.5.18", "SOC2-CC6.1"],
};

const PER_PAGE = 100;
/** 10 pages = 1000 items. Past that, report the truncation rather than guess. */
const MAX_PAGES = 10;

/**
 * Read a paginated list endpoint in full.
 *
 * The first cut of this connector requested `per_page=100` and used whatever
 * came back. A repository with 150 open alerts therefore reported 100 — and the
 * summary line said "N open in total", stating a number that was simply wrong.
 * Wrong evidence is worse than absent evidence, because an auditor has no way
 * to tell it is wrong.
 *
 * So: follow pages until a short page arrives, and if the cap is reached say so
 * via `truncated` rather than presenting a partial count as a total.
 */
async function githubList(
  path: string,
): Promise<{ ok: boolean; status: number; items: any[]; truncated: boolean }> {
  const items: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await githubGet(`${path}${sep}per_page=${PER_PAGE}&page=${page}`);
    if (!res.ok) {
      return { ok: false, status: res.status, items, truncated: false };
    }
    const batch = Array.isArray(res.data) ? res.data : [];
    items.push(...batch);
    if (batch.length < PER_PAGE) {
      return { ok: true, status: res.status, items, truncated: false };
    }
  }
  return { ok: true, status: 200, items, truncated: true };
}

/** "12" normally; "at least 1000" when the page cap cut the list short. */
function count(n: number, truncated: boolean): string {
  return truncated ? `at least ${n}` : String(n);
}

function ok(
  check_key: string,
  subject: string,
  summary: string,
  observed: Record<string, any>,
): ConnectorObservation {
  return { source: GITHUB_SOURCE, check_key, subject, status: "pass", summary, observed };
}
function bad(
  check_key: string,
  subject: string,
  summary: string,
  observed: Record<string, any>,
): ConnectorObservation {
  return { source: GITHUB_SOURCE, check_key, subject, status: "fail", summary, observed };
}
function na(
  check_key: string,
  subject: string,
  summary: string,
  observed: Record<string, any> = {},
): ConnectorObservation {
  return {
    source: GITHUB_SOURCE,
    check_key,
    subject,
    status: "not_applicable",
    summary,
    observed,
  };
}
function err(
  check_key: string,
  subject: string,
  summary: string,
  observed: Record<string, any> = {},
): ConnectorObservation {
  return { source: GITHUB_SOURCE, check_key, subject, status: "error", summary, observed };
}

/**
 * Branch protection on the default branch, and whether review is required.
 *
 * Reported as two checks from one API call because they answer different
 * questions: "can history be rewritten" and "does a second person see the code"
 * map to different clauses and can fail independently.
 */
async function checkBranchProtection(
  repo: string,
): Promise<ConnectorObservation[]> {
  const repoRes = await githubGet(`/repos/${repo}`);
  if (!repoRes.ok) {
    return [
      err("branch_protection", repo, `Could not read repository (HTTP ${repoRes.status}).`, {
        status: repoRes.status,
      }),
    ];
  }
  const branch = repoRes.data?.default_branch || "main";
  const subject = `${repo}:${branch}`;

  const prot = await githubGet(`/repos/${repo}/branches/${branch}/protection`);
  if (prot.status === 404) {
    // 404 here is GitHub's way of saying "no protection rule exists", which is
    // a finding rather than an error.
    return [
      bad("branch_protection", subject, `No branch protection on ${branch} — direct pushes and history rewrites are possible.`, { default_branch: branch, protected: false }),
      bad("code_review_required", subject, `No review requirement on ${branch} — code can merge unreviewed.`, { default_branch: branch, required_reviews: 0 }),
    ];
  }
  if (!prot.ok) {
    return [
      err("branch_protection", subject, `Could not read branch protection (HTTP ${prot.status}).`, { status: prot.status }),
    ];
  }

  const p = prot.data || {};
  const reviews = p.required_pull_request_reviews;
  const approvals = Number(reviews?.required_approving_review_count ?? 0);
  const forcePush = Boolean(p.allow_force_pushes?.enabled);
  const deletions = Boolean(p.allow_deletions?.enabled);

  const observed = {
    default_branch: branch,
    protected: true,
    required_approving_review_count: approvals,
    dismiss_stale_reviews: Boolean(reviews?.dismiss_stale_reviews),
    require_code_owner_reviews: Boolean(reviews?.require_code_owner_reviews),
    allow_force_pushes: forcePush,
    allow_deletions: deletions,
    required_status_checks: Boolean(p.required_status_checks),
    enforce_admins: Boolean(p.enforce_admins?.enabled),
  };

  const out: ConnectorObservation[] = [];
  out.push(
    forcePush || deletions
      ? bad("branch_protection", subject, `${branch} is protected but still allows ${forcePush ? "force pushes" : ""}${forcePush && deletions ? " and " : ""}${deletions ? "deletions" : ""}.`, observed)
      : ok("branch_protection", subject, `${branch} is protected: no force pushes, no deletions.`, observed),
  );
  out.push(
    approvals > 0
      ? ok("code_review_required", subject, `Merges to ${branch} require ${approvals} approving review(s).`, observed)
      : bad("code_review_required", subject, `Merges to ${branch} require no approving review.`, observed),
  );
  return out;
}

/** Open Dependabot alerts, counted by severity. */
async function checkDependabot(repo: string): Promise<ConnectorObservation[]> {
  const res = await githubList(`/repos/${repo}/dependabot/alerts?state=open`);
  if (res.status === 403 || res.status === 404) {
    return [
      na("dependabot_alerts", repo, "Dependabot alerts are not enabled, or the App lacks the security_events permission.", { status: res.status }),
    ];
  }
  if (!res.ok) {
    return [err("dependabot_alerts", repo, `Could not read Dependabot alerts (HTTP ${res.status}).`, { status: res.status })];
  }
  const alerts = res.items;
  const bySeverity: Record<string, number> = {};
  for (const a of alerts) {
    const sev = String(a?.security_advisory?.severity || "unknown").toLowerCase();
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;
  }
  const serious = (bySeverity.critical || 0) + (bySeverity.high || 0);
  const observed = {
    open_total: alerts.length,
    by_severity: bySeverity,
    truncated: res.truncated,
  };
  // The evidence is the number and its recency; "zero criticals" is the pass
  // condition an auditor recognises, not "zero alerts of any kind".
  //
  // A truncated list cannot produce a pass: "no critical alerts in the first
  // 1000" is not the same claim as "no critical alerts", and only the second
  // one is what a reader would take from a pass.
  if (res.truncated && serious === 0) {
    return [
      err("dependabot_alerts", repo, `More than ${MAX_PAGES * PER_PAGE} open alerts — too many to enumerate, so "no criticals" cannot be asserted.`, observed),
    ];
  }
  return [
    serious > 0
      ? bad("dependabot_alerts", repo, `${count(serious, res.truncated)} open critical/high dependency alert(s).`, observed)
      : ok("dependabot_alerts", repo, `No open critical or high dependency alerts (${alerts.length} open in total).`, observed),
  ];
}

/** Open secret-scanning alerts. Any open alert is a finding. */
async function checkSecretScanning(repo: string): Promise<ConnectorObservation[]> {
  const res = await githubList(`/repos/${repo}/secret-scanning/alerts?state=open`);
  if (res.status === 403 || res.status === 404) {
    return [
      na("secret_scanning", repo, "Secret scanning is not enabled, or the App lacks the secret_scanning_alerts permission.", { status: res.status }),
    ];
  }
  if (!res.ok) {
    return [err("secret_scanning", repo, `Could not read secret-scanning alerts (HTTP ${res.status}).`, { status: res.status })];
  }
  const alerts = res.items;
  // Record only counts and types. The alert bodies contain the located secret,
  // which must not be copied into the evidence store.
  const byType: Record<string, number> = {};
  for (const a of alerts) {
    const t = String(a?.secret_type_display_name || a?.secret_type || "unknown");
    byType[t] = (byType[t] || 0) + 1;
  }
  const observed = {
    open_total: alerts.length,
    by_type: byType,
    truncated: res.truncated,
  };
  return [
    alerts.length > 0
      ? bad("secret_scanning", repo, `${count(alerts.length, res.truncated)} unresolved secret-scanning alert(s).`, observed)
      : ok("secret_scanning", repo, "No unresolved secret-scanning alerts.", observed),
  ];
}

/** Who can write to the repository. */
async function checkAccess(repo: string): Promise<ConnectorObservation[]> {
  const res = await githubList(`/repos/${repo}/collaborators`);
  if (res.status === 403 || res.status === 404) {
    return [na("repo_access", repo, "Collaborator list unavailable — the App lacks the members/administration permission.", { status: res.status })];
  }
  if (!res.ok) {
    return [err("repo_access", repo, `Could not read collaborators (HTTP ${res.status}).`, { status: res.status })];
  }
  const people = res.items;
  // Logins and permission levels only — an access list is the evidence; profile
  // data would be personal information the audit does not need.
  const roster = people.map((p: any) => ({
    login: p?.login,
    admin: Boolean(p?.permissions?.admin),
    push: Boolean(p?.permissions?.push),
  }));
  const admins = roster.filter((r) => r.admin).length;
  const writers = roster.filter((r) => r.push).length;
  return [
    ok("repo_access", repo, `${count(roster.length, res.truncated)} collaborator(s): ${admins} admin, ${writers} with write access.`, {
      total: roster.length,
      admins,
      writers,
      truncated: res.truncated,
      collaborators: roster,
    }),
  ];
}

/**
 * The checks, each carrying the keys it can emit.
 *
 * Exported so the invariant "every key a runner emits has a clause mapping" is
 * testable rather than merely intended — an unmapped key is evidence an auditor
 * cannot trace to a control.
 *
 * A runner may emit several keys (checkBranchProtection emits two); `keys` is
 * also what gets marked errored when the runner throws before returning.
 */
export const CHECK_RUNNERS: Array<{
  keys: string[];
  run: (repo: string) => Promise<ConnectorObservation[]>;
}> = [
  { keys: ["branch_protection", "code_review_required"], run: checkBranchProtection },
  { keys: ["dependabot_alerts"], run: checkDependabot },
  { keys: ["secret_scanning"], run: checkSecretScanning },
  { keys: ["repo_access"], run: checkAccess },
];

/**
 * Run every check and persist the results.
 *
 * Checks run sequentially and each is individually guarded: one failing endpoint
 * records its own 'error' row and the rest still collect, because partial
 * evidence is useful and an all-or-nothing run would lose the checks that did
 * work.
 */
export async function collectGithubEvidence(): Promise<{
  configured: boolean;
  repo: string;
  observations: ConnectorObservation[];
  written: number;
}> {
  const repo = evidenceRepo();
  if (!githubAppConfigured()) {
    return { configured: false, repo, observations: [], written: 0 };
  }

  // Each runner carries its check_key explicitly. Deriving it from the function
  // name (`run.name.replace(/^check/, "").toLowerCase()`) produced
  // "branchprotection" where every other row says "branch_protection", so a
  // thrown check filed its error under a key that matched nothing — and because
  // latestObservations() groups by (source, check_key, subject), the dashboard
  // went on serving the last SUCCESSFUL row while the check was failing. That is
  // the "manufactures assurance" failure this file's header warns about, so the
  // key cannot be derived. Function names are also mangled by bundlers, which
  // would have broken it a second way.
  //
  const observations: ConnectorObservation[] = [];
  for (const { keys, run } of CHECK_RUNNERS) {
    try {
      observations.push(...(await run(repo)));
    } catch (e) {
      const message = (e as Error).message;
      logger.warn(`[GitHubEvidence] ${keys.join("/")} threw: ${message}`);
      for (const key of keys) {
        observations.push(err(key, repo, `Check failed: ${message}`));
      }
    }
  }

  const written = await recordObservations(observations);
  return { configured: true, repo, observations, written };
}
