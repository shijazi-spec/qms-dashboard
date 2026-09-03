/**
 * Pure derived-state functions for the Certification Roadmap.
 *
 * These functions turn the three relationship columns on a certification
 * milestone plan (`depends_on_key`, `unlocks_codes`, `gates_keys`) into what
 * a roadmap UI renders: chain order, per-milestone state, and per-framework
 * readiness. No I/O, no database access — safe to unit test directly.
 *
 * Dates are plain 'YYYY-MM-DD' strings throughout. Lexicographic string
 * comparison is correct and safe for that format, so we deliberately avoid
 * `new Date()` — this codebase has already been bitten twice by timezone
 * bugs from parsing date-only strings as UTC/local Date objects.
 */

export interface RoadmapRow {
  milestone_key: string;
  milestone_type: string;
  certification: string;
  milestone_name: string;
  planned_date: string | null;
  delivered_date: string | null;
  status: string;
  owner: string;
  notes: string;
  regulation_code: string | null;
  depends_on_key: string | null;
  unlocks_codes: string[];
  gates_keys: string[];
}

export type MilestoneState =
  | "delivered_on_time"
  | "delivered_late"
  | "overdue"
  | "active"
  | "blocked"
  | "planned";

/**
 * Orders rows by walking `depends_on_key` chains (root -> ... -> leaf),
 * rather than trusting incoming array order.
 *
 * Cycle-safe: each row is only ever emitted once (tracked via `visited`),
 * so a cyclic chain cannot loop forever.
 *
 * Never drops rows: any row whose predecessor is missing from the input,
 * or that is otherwise left unvisited after the chain walk (e.g. it sits
 * inside a cycle that was never reached as a chain root), is appended at
 * the end in `planned_date` order. Row count in === row count out, always
 * — driven entirely by ARRAY INDEX, so this holds even when the very same
 * row object reference appears more than once in the input.
 */
export function orderChain(rows: RoadmapRow[]): RoadmapRow[] {
  // Indexed view: every downstream structure below tracks rows by their
  // position in `rows`, never by object identity or by key string, so two
  // rows that share a milestone_key — or are literally the same object
  // reference — are still both emitted exactly once each.
  const items = rows.map((row, i) => ({ row, i }));

  // `byKey` is used only for parent/predecessor lookup — first-wins on a
  // duplicate key is fine there, since it only decides which row a child
  // attaches under, not whether any row gets emitted.
  const byKey = new Map<string, RoadmapRow>();
  for (const { row } of items) {
    if (!byKey.has(row.milestone_key)) {
      byKey.set(row.milestone_key, row);
    }
  }

  // Children indexed by the key they depend on -> list of child indices.
  const childrenOf = new Map<string, number[]>();
  for (const { row, i } of items) {
    if (row.depends_on_key != null && byKey.has(row.depends_on_key)) {
      const list = childrenOf.get(row.depends_on_key) ?? [];
      list.push(i);
      childrenOf.set(row.depends_on_key, list);
    }
  }

  const visited = new Set<number>(); // row indices
  const ordered: RoadmapRow[] = [];

  const visit = (i: number): void => {
    if (visited.has(i)) return; // cycle guard
    visited.add(i);
    ordered.push(rows[i]);
    const children = childrenOf.get(rows[i].milestone_key) ?? [];
    for (const childIdx of children) {
      visit(childIdx);
    }
  };

  // Roots: no depends_on_key, or the predecessor isn't present in this set.
  const roots = items.filter(
    ({ row }) => row.depends_on_key == null || !byKey.has(row.depends_on_key),
  );
  for (const { i } of roots) {
    visit(i);
  }

  // Anything still unvisited (e.g. trapped entirely inside a cycle with no
  // reachable root, or a duplicate-key/duplicate-reference row never
  // reached as anyone's child) is appended in planned_date order, never
  // dropped.
  const remainder = items
    .filter(({ i }) => !visited.has(i))
    .sort((a, b) => {
      const ad = a.row.planned_date ?? "";
      const bd = b.row.planned_date ?? "";
      return ad < bd ? -1 : ad > bd ? 1 : 0;
    });
  for (const { row } of remainder) {
    ordered.push(row);
  }

  return ordered;
}

/**
 * True when some undelivered `dependency` row gates `row` via `gates_keys`.
 * Extracted so both the main precedence chain and the `active` candidate
 * pool below use the exact same definition of "blocked".
 */
function isBlocked(row: RoadmapRow, all: RoadmapRow[]): boolean {
  return all.some(
    (r) =>
      r.milestone_type === "dependency" &&
      r.gates_keys.includes(row.milestone_key) &&
      r.delivered_date == null,
  );
}

/**
 * True when `row` is undelivered and its planned_date has passed. Extracted
 * so both the main precedence chain and the `active` candidate pool below
 * use the exact same definition of "overdue".
 */
function isOverdue(row: RoadmapRow, today: string): boolean {
  return (
    row.delivered_date == null &&
    row.planned_date != null &&
    row.planned_date < today
  );
}

/**
 * Derives the display state of a single milestone.
 *
 * Precedence: delivered states first, then blocked, then overdue, then
 * active, then planned.
 */
export function milestoneState(
  row: RoadmapRow,
  all: RoadmapRow[],
  today: string,
): MilestoneState {
  if (row.delivered_date != null) {
    if (row.planned_date != null && row.delivered_date <= row.planned_date) {
      return "delivered_on_time";
    }
    return "delivered_late";
  }

  if (isBlocked(row, all)) {
    return "blocked";
  }

  if (isOverdue(row, today)) {
    return "overdue";
  }

  // "active" = the earliest milestone actually still in play: the earliest
  // undelivered `plan` row (not `dependency`/`framework_target` rows, which
  // aren't part of the plan chain a user walks) that is neither overdue nor
  // blocked. Restricting the pool this way matters because a single
  // past-due or blocked milestone anywhere in the data must not suppress
  // the "you are here" marker for the entire roadmap — without it, the
  // earliest-by-date row across ALL undelivered rows (including overdue/
  // blocked ones, which can never themselves be "active") would win the
  // comparison and no row would ever be marked active.
  const candidates = all.filter(
    (r) =>
      r.milestone_type === "plan" &&
      r.delivered_date == null &&
      r.planned_date != null &&
      !isOverdue(r, today) &&
      !isBlocked(r, all),
  );
  let earliest: RoadmapRow | null = null;
  for (const r of candidates) {
    if (earliest == null || r.planned_date! < earliest.planned_date!) {
      earliest = r;
    }
  }
  if (earliest != null && earliest.milestone_key === row.milestone_key) {
    return "active";
  }

  return "planned";
}

export interface FrameworkReadiness {
  code: string;
  planned_date: string | null;
  total: number;
  delivered: number;
  pct: number;
  unreachable: boolean;
}

/**
 * One entry per `framework_target` row. `total`/`delivered` count the
 * `plan` rows whose `unlocks_codes` include that framework's
 * `regulation_code`. When no milestone unlocks a framework, `total` is 0,
 * `pct` is guarded to 0 (never NaN), and `unreachable` is true — this is a
 * genuine gap in the source document that the roadmap must surface, not
 * paper over.
 */
export function frameworkReadiness(rows: RoadmapRow[]): FrameworkReadiness[] {
  // A framework_target with no regulation_code carries no framework to
  // report readiness for, so it's skipped rather than surfaced as a "null"
  // code entry. The type predicate narrows regulation_code to `string`
  // below, so no unsafe cast is needed to read it.
  const targets = rows.filter(
    (r): r is RoadmapRow & { regulation_code: string } =>
      r.milestone_type === "framework_target" && !!r.regulation_code,
  );
  const planRows = rows.filter((r) => r.milestone_type === "plan");

  return targets.map((target) => {
    const code = target.regulation_code;
    const unlocking = planRows.filter((r) => r.unlocks_codes.includes(code));
    const total = unlocking.length;
    const delivered = unlocking.filter((r) => r.delivered_date != null).length;
    const pct = total === 0 ? 0 : Math.round((delivered / total) * 100);
    return {
      code,
      planned_date: target.planned_date,
      total,
      delivered,
      pct,
      unreachable: total === 0,
    };
  });
}
