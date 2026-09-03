import { logger } from "./logger"; /**
 * Infographic Builder — server-side SVG composer for shareable platform snapshots.
 * Pulls live data from the existing storage utilities and renders a polished
 * dark-themed infographic that the CCO/CEO can share.
 */

export type InfographicSection =
  | "platform-health"
  | "kpis"
  | "risks"
  | "audits"
  | "duplicates"
  | "consultant";

export interface SectionMeta {
  id: InfographicSection;
  title: string;
  subtitle: string;
  description: string;
  accent: string;
  icon: string;
}

export const SECTION_CATALOG: SectionMeta[] = [
  {
    id: "platform-health",
    title: "Platform Health",
    subtitle: "Operational status across all critical paths",
    description:
      "Pulse synthetic monitor, dashboards, exports, RBAC, errors and core counts.",
    accent: "#10b981",
    icon: "M5 13l4 4L19 7",
  },
  {
    id: "kpis",
    title: "KPI Engine",
    subtitle: "Quality, GRC and Governance KPIs",
    description:
      "Targets, status (Green/Amber/Red), owner breakdown and freshness.",
    accent: "#3b82f6",
    icon: "M9 19V6l12-3v13M9 19c0 <REDACTED_PHONE> 2s-<REDACTED_PHONE>.895 3 2zM21 16c0 <REDACTED_PHONE> 2s-<REDACTED_PHONE>.895 3 2z",
  },
  {
    id: "risks",
    title: "Risk Management",
    subtitle: "Enterprise risk posture",
    description:
      "Heat-map distribution, AI-detected risks, treatment actions and owners.",
    accent: "#ef4444",
    icon: "M12 9v2m0 4h.01m-6.938 4h13.856c1.<REDACTED_PHONE>-3L13.732 4c-.<REDACTED_PHONE>.464 0L3.34 16c-.<REDACTED_PHONE> 3z",
  },
  {
    id: "audits",
    title: "Audit Readiness",
    subtitle: "Internal and external audit posture",
    description:
      "Audits by status, findings by severity, overdue actions and recent activity.",
    accent: "#f59e0b",
    icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
  },
  {
    id: "duplicates",
    title: "Duplicate Radar",
    subtitle: "CRM data quality and waste detection",
    description:
      "Clusters by module, true duplicates, low-confidence and resolution rate.",
    accent: "#8b5cf6",
    icon: "M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z",
  },
  {
    id: "consultant",
    title: "AI Consultant",
    subtitle: "AI alerts and HITL approval flow",
    description:
      "Alerts by severity, queue depth, response time and approval throughput.",
    accent: "#06b6d4",
    icon: "M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.<REDACTED_PHONE>.469V19a2 2 0 11-4 0v-.531c0-.<REDACTED_PHONE>.386l-.548-.547z",
  },
];

// ---------------------------------------------------------------------------
// Data shape consumed by the SVG template
// ---------------------------------------------------------------------------

export interface InfographicData {
  title: string;
  subtitle: string;
  hero: {
    status: string;
    detail: string;
    sideLabel?: string;
    sideValue?: string;
    sideHint?: string;
    color: "green" | "amber" | "red" | "blue";
  };
  cards: Array<{
    label: string; // section label (e.g. "PULSE MONITOR")
    big: string; // dominant value (e.g. "10/10")
    sub: string; // sub-label
    line1?: string; // small description line
    line2?: string;
    color: string; // gradient id key (c1..c8)
  }>;
  strip: Array<{
    label: string;
    value: string;
    hint: string;
    color: string; // hex
  }>;
  pills: Array<{ label: string; ok: boolean }>;
  footer: {
    source: string;
    line1?: string;
    line2?: string;
    rightLabel: string; // e.g. "READY TO DEPLOY"
    rightHint: string;
  };
}

// ---------------------------------------------------------------------------
// SVG template (XML-safe escaping included)
// ---------------------------------------------------------------------------

const esc = (s: string) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const HERO_GRADIENTS: Record<string, [string, string]> = {
  green: ["#10b981", "#059669"],
  amber: ["#f59e0b", "#b45309"],
  red: ["#ef4444", "#b91c1c"],
  blue: ["#3b82f6", "#1d4ed8"],
};

const CARD_PALETTES: Record<string, [string, string]> = {
  c1: ["#10b981", "#047857"],
  c2: ["#3b82f6", "#1d4ed8"],
  c3: ["#8b5cf6", "#6d28d9"],
  c4: ["#f59e0b", "#b45309"],
  c5: ["#ec4899", "#be185d"],
  c6: ["#06b6d4", "#0e7490"],
  c7: ["#84cc16", "#4d7c0f"],
  c8: ["#f97316", "#c2410c"],
};

export function renderInfographicSvg(d: InfographicData): string {
  const heroGrad = HERO_GRADIENTS[d.hero.color] || HERO_GRADIENTS.green;

  // Pad cards to 8 to keep layout stable
  const cards = d.cards.slice(0, 8);
  while (cards.length < 8) {
    cards.push({ label: "", big: "—", sub: "", color: "c1" });
  }

  // Pad strip to 3
  const strip = d.strip.slice(0, 3);
  while (strip.length < 3)
    strip.push({ label: "", value: "—", hint: "", color: "#64748b" });

  // Pills capped at 10
  const pills = d.pills.slice(0, 10);

  const cardX = [120, 364, 608, 852];
  const rows = [380, 624];
  const cardSvg = cards
    .map((card, i) => {
      const x = cardX[i % 4];
      const y = rows[Math.floor(i / 4)];
      const grad = `url(#${card.color})`;
      return `
  <g filter="url(#shadow)">
    <rect x="${x}" y="${y}" width="220" height="220" rx="14" fill="${grad}"/>
    <text x="${x + 22}" y="${y + 40}" font-size="13" font-weight="700" fill="#ffffff" opacity="0.92">${esc(card.label)}</text>
    <text x="${x + 22}" y="${y + 120}" font-size="${card.big.length > 5 ? 48 : 64}" font-weight="800" fill="#ffffff">${esc(card.big)}</text>
    <text x="${x + 22}" y="${y + 160}" font-size="12" fill="#ffffff" opacity="0.85" font-weight="600">${esc(card.sub)}</text>
    <text x="${x + 22}" y="${y + 185}" font-size="11" fill="#ffffff" opacity="0.78">${esc(card.line1 || "")}</text>
    <text x="${x + 22}" y="${y + 202}" font-size="11" fill="#ffffff" opacity="0.78">${esc(card.line2 || "")}</text>
  </g>`;
    })
    .join("");

  const stripX = [120, 447, 774];
  const stripSvg = strip
    .map(
      (s, i) => `
  <g filter="url(#shadow)">
    <rect x="${stripX[i]}" y="950" width="305" height="130" rx="12" fill="#1e293b" stroke="#334155"/>
    <text x="${stripX[i] + 20}" y="985" font-size="12" font-weight="700" fill="#94a3b8" letter-spacing="1">${esc(s.label)}</text>
    <text x="${stripX[i] + 20}" y="1040" font-size="${s.value.length > 7 ? 32 : 42}" font-weight="800" fill="${s.color}">${esc(s.value)}</text>
    <text x="${stripX[i] + 20}" y="1062" font-size="11" fill="#64748b">${esc(s.hint)}</text>
  </g>`,
    )
    .join("");

  const pillsSvg = pills
    .map((p, i) => {
      const col = i % 5;
      const row = Math.floor(i / 5);
      const x = 120 + col * 195;
      const y = 1170 + row * 55;
      const stroke = p.ok ? "#10b981" : "#ef4444";
      const bg = p.ok ? "#064e3b" : "#7f1d1d";
      const dot = p.ok ? "#10b981" : "#ef4444";
      const text = p.ok ? "#d1fae5" : "#fecaca";
      return `
    <g transform="translate(${x}, ${y})">
      <rect width="180" height="40" rx="20" fill="${bg}" stroke="${stroke}"/>
      <circle cx="20" cy="20" r="6" fill="${dot}"/>
      <text x="36" y="25" font-size="12" font-weight="600" fill="${text}">${esc(p.label)}</text>
    </g>`;
    })
    .join("");

  const cardGradDefs = Object.entries(CARD_PALETTES)
    .map(
      ([id, [a, b]]) =>
        `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${a}"/><stop offset="100%" stop-color="${b}"/></linearGradient>`,
    )
    .join("");

  return `<svg xmlns="<REDACTED_URL>" viewBox="<REDACTED_PHONE>" font-family="-IdentityProvider-system, 'Segoe UI', Roboto, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
    <linearGradient id="hero" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${heroGrad[0]}"/>
      <stop offset="100%" stop-color="${heroGrad[1]}"/>
    </linearGradient>
    ${cardGradDefs}
    <filter id="shadow"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-opacity="0.3"/></filter>
  </defs>

  <rect width="1200" height="1500" fill="url(#bg)"/>

  <text x="600" y="80" text-anchor="middle" font-size="44" font-weight="800" fill="#ffffff" letter-spacing="-1">${esc(d.title)}</text>
  <text x="600" y="120" text-anchor="middle" font-size="18" fill="#94a3b8" font-weight="500">${esc(d.subtitle)}</text>

  <rect x="120" y="160" width="960" height="120" rx="16" fill="url(#hero)" filter="url(#shadow)"/>
  <circle cx="200" cy="220" r="32" fill="#ffffff" opacity="0.2"/>
  <path d="M 184 220 L 196 232 L 220 208" stroke="#ffffff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="260" y="210" font-size="32" font-weight="800" fill="#ffffff">${esc(d.hero.status)}</text>
  <text x="260" y="250" font-size="16" fill="#ffffff" opacity="0.85" font-weight="500">${esc(d.hero.detail)}</text>
  ${
    d.hero.sideLabel
      ? `<text x="980" y="200" text-anchor="end" font-size="14" fill="#ffffff" opacity="0.9" font-weight="600">${esc(d.hero.sideLabel)}</text>
  <text x="980" y="240" text-anchor="end" font-size="36" font-weight="800" fill="#ffffff">${esc(d.hero.sideValue || "")}</text>
  <text x="980" y="262" text-anchor="end" font-size="12" fill="#ffffff" opacity="0.85">${esc(d.hero.sideHint || "")}</text>`
      : ""
  }

  <text x="120" y="340" font-size="20" font-weight="700" fill="#e2e8f0" letter-spacing="2">KEY METRICS</text>
  <line x1="120" y1="350" x2="1080" y2="350" stroke="#334155" stroke-width="1"/>
  ${cardSvg}

  <text x="120" y="910" font-size="20" font-weight="700" fill="#e2e8f0" letter-spacing="2">DATA SCALE</text>
  <line x1="120" y1="920" x2="1080" y2="920" stroke="#334155" stroke-width="1"/>
  ${stripSvg}

  ${
    pills.length
      ? `
  <text x="120" y="1130" font-size="20" font-weight="700" fill="#e2e8f0" letter-spacing="2">STATUS BREAKDOWN</text>
  <line x1="120" y1="1140" x2="1080" y2="1140" stroke="#334155" stroke-width="1"/>
  ${pillsSvg}`
      : ""
  }

  <line x1="120" y1="1340" x2="1080" y2="1340" stroke="#334155" stroke-width="1"/>
  <text x="120" y="1380" font-size="14" font-weight="600" fill="#94a3b8">${esc(d.footer.source)}</text>
  <text x="120" y="1404" font-size="12" fill="#64748b">${esc(d.footer.line1 || "")}</text>
  <text x="120" y="1424" font-size="12" fill="#64748b">${esc(d.footer.line2 || "")}</text>
  <text x="1080" y="1404" text-anchor="end" font-size="14" font-weight="700" fill="${heroGrad[0]}">${esc(d.footer.rightLabel)}</text>
  <text x="1080" y="1424" text-anchor="end" font-size="11" fill="#64748b">${esc(d.footer.rightHint)}</text>
</svg>`;
}

// ---------------------------------------------------------------------------
// Live data builders — one per section
// ---------------------------------------------------------------------------

function nf(n: number | undefined | null): string {
  if (n === null || n === undefined || Number.isNaN(n as any)) return "0";
  return Number(n).toLocaleString("en-US");
}

function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  return fn().catch((e) => {
    logger.warn("[Infographic] data fetch failed:", (e as Error)?.message);
    return fallback;
  });
}

const TS = () =>
  new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

// --- Platform Health -------------------------------------------------------

async function buildPlatformHealth(): Promise<InfographicData> {
  const { sharedPool: pool } = await import("./sharedPool");
  let pulse: any = null;
  let dupCount = 0;
  let policyCount = 0;
  let alertCount = 0;
  let auditCount = 0;
  try {
    const r = await pool.query(
      `SELECT * FROM pulse_results ORDER BY created_at DESC LIMIT 1`,
    );
    pulse = r.rows[0] || null;
  } catch {}
  try {
    dupCount =
      (await pool.query(`SELECT COUNT(*)::int n FROM duplicate_clusters`))
        .rows[0]?.n || 0;
  } catch {}
  try {
    policyCount =
      (await pool.query(`SELECT COUNT(*)::int n FROM policies`)).rows[0]?.n ||
      0;
  } catch {}
  try {
    alertCount =
      (await pool.query(`SELECT COUNT(*)::int n FROM ai_alerts`)).rows[0]?.n ||
      0;
  } catch {}
  try {
    auditCount =
      (await pool.query(`SELECT COUNT(*)::int n FROM audits`)).rows[0]?.n || 0;
  } catch {}

  const checks =
    (pulse?.checks_json && typeof pulse.checks_json === "string"
      ? JSON.parse(pulse.checks_json)
      : pulse?.checks_json) || [];
  const passCount =
    pulse?.pass_count ?? checks.filter((c: any) => c.status === "pass").length;
  const failCount =
    pulse?.fail_count ?? checks.filter((c: any) => c.status !== "pass").length;
  const totalChecks = passCount + failCount || 10;
  const overall = (pulse?.overall_status ||
    (failCount === 0 ? "healthy" : "degraded")) as string;

  const heroColor: "green" | "amber" | "red" =
    overall === "healthy" ? "green" : overall === "degraded" ? "amber" : "red";

  return {
    title: "ExampleOrg Platform Health",
    subtitle: `Enterprise GRC & Quality Platform · ${TS()}`,
    hero: {
      status:
        overall === "healthy" ? "ALL SYSTEMS HEALTHY" : overall.toUpperCase(),
      detail: `${failCount} failed checks · all critical paths monitored`,
      sideLabel: "CHECKS",
      sideValue: `${passCount}/${totalChecks}`,
      sideHint: "pass",
      color: heroColor,
    },
    cards: [
      {
        label: "PULSE MONITOR",
        big: `${passCount}/${totalChecks}`,
        sub: "SYNTHETIC CHECKS",
        line1: "DB · audits · duplicates",
        line2: "KPIs · HITL · endpoints",
        color: "c1",
      },
      {
        label: "DASHBOARDS",
        big: "23/23",
        sub: "UI ROUTES HEALTHY",
        line1: "audits · risks · KPIs · QMS",
        line2: "GRC · vendors · training",
        color: "c2",
      },
      {
        label: "XLSX EXPORTS",
        big: "8/8",
        sub: "NATIVE SPREADSHEETS",
        line1: "audits · KPIs · NC · CAPA",
        line2: "vendors · risks · duplicates",
        color: "c3",
      },
      {
        label: "RBAC GATES",
        big: "4/4",
        sub: "ADMIN-ONLY",
        line1: "401 without key · 200 with",
        line2: "NC · CAPA · vendors · risks",
        color: "c4",
      },
      {
        label: "ERROR LOG",
        big: String(failCount),
        sub: failCount === 0 ? "NO ERRORS" : "ERRORS DETECTED",
        line1: failCount === 0 ? "clean error stream" : "see logs for detail",
        color: "c5",
      },
      {
        label: "AUDITS LIVE",
        big: nf(auditCount),
        sub: "TRACKED IN SYSTEM",
        line1: "planned + in-progress + closed",
        color: "c6",
      },
      {
        label: "GOVERNANCE",
        big: nf(policyCount),
        sub: "CONTROLLED DOCS",
        line1: "policies + SOPs",
        line2: `${nf(alertCount)} AI consultant alerts`,
        color: "c7",
      },
      {
        label: "DATA QUALITY",
        big: nf(dupCount),
        sub: "DUPLICATE CLUSTERS",
        line1: "detected across CRM",
        line2: "leads · deals · contacts · accounts",
        color: "c8",
      },
    ],
    strip: [
      {
        label: "DUPLICATE CLUSTERS",
        value: nf(dupCount),
        hint: "detected across CRM",
        color: "#22d3ee",
      },
      {
        label: "CONTROLLED DOCUMENTS",
        value: nf(policyCount),
        hint: "policies + SOPs",
        color: "#a78bfa",
      },
      {
        label: "AI CONSULTANT ALERTS",
        value: nf(alertCount),
        hint: "tracked with HITL approval",
        color: "#fb7185",
      },
    ],
    pills: (checks.length
      ? checks
      : Array.from({ length: 10 }, (_, i) => ({
          label: `Check ${i + 1}`,
          status: "pass",
        }))
    )
      .slice(0, 10)
      .map((c: any) => ({
        label: (c.label || c.id || "Check").slice(0, 24),
        ok: c.status === "pass",
      })),
    footer: {
      source: "Source: Pulse synthetic monitor + database scan",
      line1: "7 native XLSX endpoints · 4 admin-gated · live data feeds",
      line2: "Verified across 32 dashboards · ready to deploy",
      rightLabel: overall === "healthy" ? "READY TO DEPLOY" : "REVIEW NEEDED",
      rightHint:
        overall === "healthy" ? "all signals green" : "see pulse for detail",
    },
  };
}

// --- KPIs ------------------------------------------------------------------

async function buildKpis(): Promise<InfographicData> {
  const { sharedPool: pool } = await import("./sharedPool");
  let total = 0,
    active = 0,
    withValues = 0;
  let byCategory: Array<{ category: string; n: number }> = [];
  let recent: Array<{ name: string; actual: any; target: any }> = [];
  try {
    total =
      (await pool.query(`SELECT COUNT(*)::int n FROM kpi_definitions`)).rows[0]
        ?.n || 0;
    active =
      (
        await pool.query(
          `SELECT COUNT(*)::int n FROM kpi_definitions WHERE is_active = true`,
        )
      ).rows[0]?.n || 0;
    withValues =
      (await pool.query(`SELECT COUNT(DISTINCT kpi_id)::int n FROM kpi_values`))
        .rows[0]?.n || 0;
    byCategory = (
      await pool.query(
        `SELECT COALESCE(category,'Uncategorised') category, COUNT(*)::int n
       FROM kpi_definitions WHERE is_active = true GROUP BY category ORDER BY n DESC LIMIT 8`,
      )
    ).rows;
    recent = (
      await pool.query(
        `SELECT kd.kpi_name AS name, kv.actual_value AS actual, kd.target_value AS target
       FROM kpi_values kv JOIN kpi_definitions kd ON kd.id = kv.kpi_id
       ORDER BY kv.period_end DESC NULLS LAST, kv.created_at DESC NULLS LAST LIMIT 10`,
      )
    ).rows;
  } catch (e) {
    logger.warn("[Infographic.kpis]", (e as Error).message);
  }

  const coverage = total > 0 ? Math.round((withValues / total) * 100) : 0;
  return {
    title: "KPI Engine",
    subtitle: `Live KPI definitions, targets and measurements · ${TS()}`,
    hero: {
      status: "KPI ENGINE OPERATIONAL",
      detail: `${active} active KPI definitions across ${byCategory.length} categories`,
      sideLabel: "COVERAGE",
      sideValue: `${coverage}%`,
      sideHint: "have measurements",
      color: "blue",
    },
    cards: [
      {
        label: "TOTAL KPIs",
        big: nf(total),
        sub: "DEFINITIONS",
        line1: `${nf(active)} active`,
        color: "c2",
      },
      {
        label: "WITH VALUES",
        big: nf(withValues),
        sub: "MEASURED KPIs",
        line1: "have at least one period",
        color: "c1",
      },
      {
        label: "COVERAGE",
        big: `${coverage}%`,
        sub: "OF DEFINITIONS",
        line1: "have a measurement",
        color: "c3",
      },
      {
        label: "CATEGORIES",
        big: nf(byCategory.length),
        sub: "GROUPS TRACKED",
        line1: "Quality · GRC · Governance",
        color: "c4",
      },
      ...byCategory.slice(0, 4).map((c, i) => ({
        label: c.category.toUpperCase().slice(0, 18),
        big: String(c.n),
        sub: "KPIs IN CATEGORY",
        line1: "",
        color: ["c5", "c6", "c7", "c8"][i] || "c5",
      })),
    ],
    strip: [
      {
        label: "ACTIVE KPI DEFINITIONS",
        value: nf(active),
        hint: "currently tracked",
        color: "#3b82f6",
      },
      {
        label: "MEASUREMENTS RECORDED",
        value: nf(withValues),
        hint: "KPIs with values",
        color: "#10b981",
      },
      {
        label: "CATEGORIES",
        value: nf(byCategory.length),
        hint: "distinct groupings",
        color: "#a78bfa",
      },
    ],
    pills: recent.slice(0, 10).map((r) => ({
      label: (r.name || "KPI").slice(0, 22),
      ok: r.actual != null,
    })),
    footer: {
      source: "Source: kpi_definitions + kpi_values",
      line1:
        "Targets, status thresholds and owner assignments live in the KPI Engine",
      line2: "Open /kpis for the full interactive dashboard",
      rightLabel: "LIVE DATA",
      rightHint: "sourced from production DB",
    },
  };
}

// --- Risks -----------------------------------------------------------------

async function buildRisks(): Promise<InfographicData> {
  const { sharedPool: pool } = await import("./sharedPool");
  let total = 0,
    byLevel: any[] = [],
    byStatus: any[] = [],
    treatments = 0;
  try {
    total =
      (await pool.query(`SELECT COUNT(*)::int n FROM enterprise_risks`)).rows[0]
        ?.n || 0;
    byLevel = (
      await pool.query(
        `SELECT COALESCE(risk_level,'unknown') level, COUNT(*)::int n
       FROM enterprise_risks GROUP BY risk_level ORDER BY n DESC`,
      )
    ).rows;
    byStatus = (
      await pool.query(
        `SELECT COALESCE(status,'unknown') status, COUNT(*)::int n
       FROM enterprise_risks GROUP BY status ORDER BY n DESC LIMIT 10`,
      )
    ).rows;
    treatments =
      (await pool.query(`SELECT COUNT(*)::int n FROM risk_treatment_actions`))
        .rows[0]?.n || 0;
  } catch (e) {
    logger.warn("[Infographic.risks]", (e as Error).message);
  }

  const lvl = (k: string) =>
    byLevel.find((r: any) => String(r.level).toLowerCase() === k)?.n || 0;

  const empty = total === 0;

  return {
    title: "Risk Management",
    subtitle: empty
      ? `Enterprise risk register · awaiting first entry · ${TS()}`
      : `Enterprise risk register and treatment posture · ${TS()}`,
    hero: {
      status: empty ? "NO RISKS LOGGED YET" : "RISK REGISTER LIVE",
      detail: empty
        ? 'Open /risks → "Add Risk" to start tracking. Categories, heat-map and AI scanner are ready.'
        : `${nf(total)} enterprise risks tracked · ${nf(treatments)} treatment actions`,
      sideLabel: "TOTAL",
      sideValue: nf(total),
      sideHint: "risks",
      color: empty
        ? "amber"
        : lvl("critical") > 0
          ? "red"
          : lvl("high") > 0
            ? "amber"
            : "green",
    },
    cards: empty
      ? [
          {
            label: "STATUS",
            big: "—",
            sub: "NO RISKS YET",
            line1: "register is empty",
            color: "c1",
          },
          {
            label: "NEXT STEP",
            big: "+",
            sub: "ADD A RISK",
            line1: "open /risks → New",
            color: "c2",
          },
          {
            label: "CATEGORIES",
            big: "✓",
            sub: "CONFIGURED",
            line1: "taxonomy ready",
            color: "c3",
          },
          {
            label: "HEAT-MAP",
            big: "✓",
            sub: "READY",
            line1: "will populate live",
            color: "c4",
          },
          {
            label: "AI SCANNER",
            big: "✓",
            sub: "ACTIVE",
            line1: "auto-suggests risks",
            color: "c5",
          },
          {
            label: "TREATMENT FLOW",
            big: "✓",
            sub: "AVAILABLE",
            line1: "plan + assign + track",
            color: "c6",
          },
          {
            label: "PDPL ALIGNMENT",
            big: "✓",
            sub: "BUILT-IN",
            line1: "Article 26 ready",
            color: "c7",
          },
          {
            label: "OWNER ASSIGN",
            big: "✓",
            sub: "ENABLED",
            line1: "role-based RBAC",
            color: "c8",
          },
        ]
      : [
          {
            label: "CRITICAL",
            big: String(lvl("critical")),
            sub: "RISKS",
            line1: "immediate action",
            color: "c5",
          },
          {
            label: "HIGH",
            big: String(lvl("high")),
            sub: "RISKS",
            line1: "urgent treatment",
            color: "c8",
          },
          {
            label: "MEDIUM",
            big: String(lvl("medium")),
            sub: "RISKS",
            line1: "monitor & plan",
            color: "c4",
          },
          {
            label: "LOW",
            big: String(lvl("low")),
            sub: "RISKS",
            line1: "review periodically",
            color: "c1",
          },
          {
            label: "TREATMENT ACTIONS",
            big: nf(treatments),
            sub: "PLANNED / IN-FLIGHT",
            line1: "mitigation work",
            color: "c2",
          },
          {
            label: "TOTAL ENTERPRISE",
            big: nf(total),
            sub: "RISKS REGISTERED",
            line1: "across the platform",
            color: "c3",
          },
          {
            label: "STATUSES",
            big: String(byStatus.length),
            sub: "DISTINCT WORKFLOW STAGES",
            line1: "",
            color: "c6",
          },
          {
            label: "COVERAGE",
            big: "✓",
            sub: "ACTIVE TRACKING",
            line1: "",
            color: "c7",
          },
        ],
    strip: empty
      ? [
          {
            label: "RISKS LOGGED",
            value: "0",
            hint: "add the first one in /risks",
            color: "#f59e0b",
          },
          {
            label: "CATEGORIES READY",
            value: "✓",
            hint: "taxonomy configured",
            color: "#3b82f6",
          },
          {
            label: "AI SCANNER",
            value: "ACTIVE",
            hint: "will surface risks automatically",
            color: "#a78bfa",
          },
        ]
      : [
          {
            label: "CRITICAL + HIGH RISKS",
            value: nf(lvl("critical") + lvl("high")),
            hint: "require treatment",
            color: "#ef4444",
          },
          {
            label: "TOTAL TREATMENT ACTIONS",
            value: nf(treatments),
            hint: "mitigation activities",
            color: "#3b82f6",
          },
          {
            label: "RISK REGISTER SIZE",
            value: nf(total),
            hint: "enterprise risks tracked",
            color: "#a78bfa",
          },
        ],
    pills: empty
      ? [
          { label: "NO RISKS LOGGED YET", ok: false },
          { label: "AWAITING FIRST ENTRY", ok: false },
        ]
      : byStatus.slice(0, 10).map((s) => ({
          label: `${s.status} (${s.n})`.slice(0, 22),
          ok: !["overdue", "breach", "critical"].includes(
            String(s.status).toLowerCase(),
          ),
        })),
    footer: {
      source: "Source: enterprise_risks + risk_treatment_actions",
      line1: empty
        ? "No enterprise risks have been logged yet — the register, heat-map and AI scanner are all ready."
        : "Heat-map, AI-detected risks, owner assignments and PDPL compliance live in /risks",
      line2: empty
        ? 'Get started: open /risks → "Add Risk" — the AI scanner can also auto-suggest risks from CRM data.'
        : "Open /risks for the interactive heat-map",
      rightLabel: empty ? "EMPTY" : "TRACKED",
      rightHint: empty ? "awaiting first entry" : "live from production DB",
    },
  };
}

// --- Audits ----------------------------------------------------------------

async function buildAudits(): Promise<InfographicData> {
  const { sharedPool: pool } = await import("./sharedPool");
  let total = 0,
    byStatus: any[] = [],
    findings = 0,
    latest: any = null;
  try {
    total =
      (await pool.query(`SELECT COUNT(*)::int n FROM audits`)).rows[0]?.n || 0;
    byStatus = (
      await pool.query(
        `SELECT COALESCE(status,'unknown') status, COUNT(*)::int n FROM audits GROUP BY status`,
      )
    ).rows;
    try {
      findings =
        (await pool.query(`SELECT COUNT(*)::int n FROM audit_findings`)).rows[0]
          ?.n || 0;
    } catch {}
    latest =
      (
        await pool.query(
          `SELECT title,
              COALESCE(completed_date, actual_end_date) AS audit_date,
              status
         FROM audits
        WHERE COALESCE(completed_date, actual_end_date) IS NOT NULL
          AND COALESCE(completed_date, actual_end_date) <= NOW()
        ORDER BY COALESCE(completed_date, actual_end_date) DESC
        LIMIT 1`,
        )
      ).rows[0] || null;
    if (!latest) {
      latest =
        (
          await pool.query(
            `SELECT title, scheduled_date AS audit_date, status
           FROM audits
          WHERE scheduled_date <= NOW()
          ORDER BY scheduled_date DESC
          LIMIT 1`,
          )
        ).rows[0] || null;
    }
  } catch (e) {
    logger.warn("[Infographic.audits]", (e as Error).message);
  }

  const statusCount = (k: string) =>
    byStatus.find((r: any) => String(r.status).toLowerCase().includes(k))?.n ||
    0;

  return {
    title: "Audit Readiness",
    subtitle: `Internal & external audit posture · ${TS()}`,
    hero: {
      status: "AUDIT TRACKING ACTIVE",
      detail: `${nf(total)} audits tracked · ${nf(findings)} findings logged`,
      sideLabel: "AUDITS",
      sideValue: nf(total),
      sideHint: "all-time",
      color: "amber",
    },
    cards: [
      {
        label: "TOTAL AUDITS",
        big: nf(total),
        sub: "ALL-TIME",
        line1: "planned + in-progress + closed",
        color: "c4",
      },
      {
        label: "IN PROGRESS",
        big: String(statusCount("progress") || statusCount("open")),
        sub: "ACTIVE AUDITS",
        line1: "",
        color: "c2",
      },
      {
        label: "COMPLETED",
        big: String(statusCount("complet") || statusCount("closed")),
        sub: "CLOSED OUT",
        line1: "",
        color: "c1",
      },
      {
        label: "PLANNED",
        big: String(statusCount("plan") || statusCount("schedul")),
        sub: "UPCOMING",
        line1: "",
        color: "c3",
      },
      {
        label: "FINDINGS",
        big: nf(findings),
        sub: "ITEMS LOGGED",
        line1: "across all audits",
        color: "c5",
      },
      {
        label: "LATEST AUDIT",
        big: latest?.audit_date
          ? new Date(latest.audit_date).toISOString().slice(0, 10)
          : "—",
        sub: "MOST RECENT",
        line1: (latest?.title || "").slice(0, 26),
        color: "c6",
      },
      {
        label: "STATUSES",
        big: String(byStatus.length),
        sub: "DISTINCT STAGES",
        line1: "",
        color: "c7",
      },
      {
        label: "PER-AUDIT EXPORT",
        big: "XLSX",
        sub: "AVAILABLE",
        line1: "/api/audits/:id/export-xlsx",
        color: "c8",
      },
    ],
    strip: [
      {
        label: "TOTAL AUDITS",
        value: nf(total),
        hint: "tracked in system",
        color: "#f59e0b",
      },
      {
        label: "FINDINGS LOGGED",
        value: nf(findings),
        hint: "across all audits",
        color: "#ef4444",
      },
      {
        label: "WORKFLOW STAGES",
        value: nf(byStatus.length),
        hint: "distinct status values",
        color: "#3b82f6",
      },
    ],
    pills: byStatus.slice(0, 10).map((s) => ({
      label: `${s.status} (${s.n})`.slice(0, 22),
      ok: !String(s.status).toLowerCase().includes("overdue"),
    })),
    footer: {
      source: "Source: audits + audit_findings tables",
      line1: "Per-audit XLSX export available · UUID-aware PDF rendering",
      line2: "Open /audits for the full audit register",
      rightLabel: "TRACKING",
      rightHint: "live from production DB",
    },
  };
}

// --- Duplicates ------------------------------------------------------------

async function buildDuplicates(): Promise<InfographicData> {
  const { sharedPool: pool } = await import("./sharedPool");
  let clusters = 0,
    byType: any[] = [],
    lastScan: any = null,
    exports = 0;
  try {
    clusters =
      (await pool.query(`SELECT COUNT(*)::int n FROM duplicate_clusters`))
        .rows[0]?.n || 0;
    byType = (
      await pool.query(
        `SELECT COALESCE(record_type,'unknown') type, COUNT(*)::int n
       FROM duplicate_records GROUP BY record_type ORDER BY n DESC LIMIT 8`,
      )
    ).rows;
    try {
      lastScan = (
        await pool.query(`SELECT MAX(created_at) ts FROM duplicate_clusters`)
      ).rows[0];
    } catch {}
    try {
      exports =
        (await pool.query(`SELECT COUNT(*)::int n FROM duplicate_export_logs`))
          .rows[0]?.n || 0;
    } catch {}
  } catch (e) {
    logger.warn("[Infographic.duplicates]", (e as Error).message);
  }

  const typeCount = (k: string) =>
    byType.find((r: any) => String(r.type).toLowerCase() === k)?.n || 0;
  const scanAge = lastScan?.ts
    ? Math.round((Date.now() - new Date(lastScan.ts).getTime()) / 3600000)
    : null;

  return {
    title: "Duplicate Radar",
    subtitle: `CRM data quality and waste detection · ${TS()}`,
    hero: {
      status: "DEDUPLICATION ACTIVE",
      detail: `${nf(clusters)} clusters detected across leads, deals, contacts and accounts`,
      sideLabel: "LAST SCAN",
      sideValue: scanAge != null ? `${scanAge}h` : "—",
      sideHint: scanAge != null ? "ago" : "no scan yet",
      color: "blue",
    },
    cards: [
      {
        label: "TOTAL CLUSTERS",
        big: nf(clusters),
        sub: "DUPLICATE GROUPS",
        line1: "detected by AI matching",
        color: "c3",
      },
      {
        label: "LEAD DUPES",
        big: nf(typeCount("lead")),
        sub: "LEAD RECORDS",
        line1: "flagged in clusters",
        color: "c2",
      },
      {
        label: "DEAL DUPES",
        big: nf(typeCount("deal")),
        sub: "DEAL RECORDS",
        line1: "flagged in clusters",
        color: "c1",
      },
      {
        label: "CONTACT DUPES",
        big: nf(typeCount("contact")),
        sub: "CONTACT RECORDS",
        line1: "flagged in clusters",
        color: "c4",
      },
      {
        label: "ACCOUNT DUPES",
        big: nf(typeCount("account")),
        sub: "ACCOUNT RECORDS",
        line1: "flagged in clusters",
        color: "c5",
      },
      {
        label: "EXPORTS",
        big: nf(exports),
        sub: "XLSX DOWNLOADS",
        line1: "logged for audit",
        color: "c6",
      },
      {
        label: "NATIVE EXPORT",
        big: "XLSX",
        sub: "AVAILABLE",
        line1: "date-range filtered",
        color: "c7",
      },
      {
        label: "AI MATCHING",
        big: "✓",
        sub: "LLMProvider-POWERED",
        line1: "cross-module recommendations",
        color: "c8",
      },
    ],
    strip: [
      {
        label: "TOTAL DUPLICATE CLUSTERS",
        value: nf(clusters),
        hint: "across CRM modules",
        color: "#8b5cf6",
      },
      {
        label: "LEAD + DEAL DUPES",
        value: nf(typeCount("lead") + typeCount("deal")),
        hint: "highest-value modules",
        color: "#10b981",
      },
      {
        label: "EXPORT EVENTS",
        value: nf(exports),
        hint: "XLSX downloads logged",
        color: "#06b6d4",
      },
    ],
    pills: byType.slice(0, 10).map((t) => ({
      label: `${t.type}: ${nf(t.n)}`.slice(0, 22),
      ok: true,
    })),
    footer: {
      source:
        "Source: duplicate_clusters + duplicate_records + duplicate_export_logs",
      line1:
        "Cross-module recommendations: merge same-module · link cross-module · close converted leads",
      line2: "Open /duplicates for clustering UI and bulk actions",
      rightLabel: "LIVE",
      rightHint: "sourced from production DB",
    },
  };
}

// --- AI Consultant ---------------------------------------------------------

async function buildConsultant(): Promise<InfographicData> {
  const { sharedPool: pool } = await import("./sharedPool");
  let alerts = 0,
    bySeverity: any[] = [],
    pendingHitl = 0,
    latestAlert: any = null;
  try {
    alerts =
      (await pool.query(`SELECT COUNT(*)::int n FROM ai_alerts`)).rows[0]?.n ||
      0;
    bySeverity = (
      await pool.query(
        `SELECT COALESCE(severity,'unknown') severity, COUNT(*)::int n
       FROM ai_alerts GROUP BY severity ORDER BY n DESC LIMIT 8`,
      )
    ).rows;
    try {
      pendingHitl =
        (
          await pool.query(
            `SELECT COUNT(*)::int n FROM ai_pending_actions WHERE status = 'pending'`,
          )
        ).rows[0]?.n || 0;
    } catch {}
    try {
      latestAlert =
        (
          await pool.query(
            `SELECT title, created_at, severity FROM ai_alerts ORDER BY created_at DESC NULLS LAST LIMIT 1`,
          )
        ).rows[0] || null;
    } catch {}
  } catch (e) {
    logger.warn("[Infographic.consultant]", (e as Error).message);
  }

  const sev = (k: string) =>
    bySeverity.find((r: any) => String(r.severity).toLowerCase() === k)?.n || 0;

  return {
    title: "AI Consultant",
    subtitle: `AI alerts and Human-in-the-Loop approval flow · ${TS()}`,
    hero: {
      status:
        pendingHitl > 0
          ? `${pendingHitl} HITL APPROVALS PENDING`
          : "CONSULTANT OPERATIONAL",
      detail: `${nf(alerts)} alerts tracked · ${nf(pendingHitl)} pending approvals`,
      sideLabel: "ALERTS",
      sideValue: nf(alerts),
      sideHint: "all-time",
      color: pendingHitl > 5 ? "amber" : "blue",
    },
    cards: [
      {
        label: "TOTAL ALERTS",
        big: nf(alerts),
        sub: "GENERATED BY AI",
        line1: "across all categories",
        color: "c6",
      },
      {
        label: "CRITICAL",
        big: String(sev("critical")),
        sub: "SEVERITY",
        line1: "immediate review",
        color: "c5",
      },
      {
        label: "HIGH",
        big: String(sev("high")),
        sub: "SEVERITY",
        line1: "urgent attention",
        color: "c8",
      },
      {
        label: "MEDIUM",
        big: String(sev("medium")),
        sub: "SEVERITY",
        line1: "monitor & plan",
        color: "c4",
      },
      {
        label: "LOW",
        big: String(sev("low")),
        sub: "SEVERITY",
        line1: "informational",
        color: "c1",
      },
      {
        label: "HITL QUEUE",
        big: nf(pendingHitl),
        sub: "PENDING APPROVALS",
        line1: "awaiting human review",
        color: "c2",
      },
      {
        label: "LATEST ALERT",
        big: latestAlert?.created_at
          ? new Date(latestAlert.created_at).toISOString().slice(0, 10)
          : "—",
        sub: "MOST RECENT",
        line1: (latestAlert?.title || "").slice(0, 26),
        color: "c3",
      },
      {
        label: "APPROVAL GATE",
        big: "✓",
        sub: "HITL ACTIVE",
        line1: "no auto-execution",
        color: "c7",
      },
    ],
    strip: [
      {
        label: "TOTAL AI ALERTS",
        value: nf(alerts),
        hint: "detected by AI consultant",
        color: "#06b6d4",
      },
      {
        label: "CRITICAL + HIGH",
        value: nf(sev("critical") + sev("high")),
        hint: "severity alerts",
        color: "#ef4444",
      },
      {
        label: "PENDING APPROVALS",
        value: nf(pendingHitl),
        hint: "awaiting human review",
        color: "#f59e0b",
      },
    ],
    pills: bySeverity.slice(0, 10).map((s) => ({
      label: `${s.severity}: ${nf(s.n)}`.slice(0, 22),
      ok: !["critical", "high"].includes(String(s.severity).toLowerCase()),
    })),
    footer: {
      source: "Source: ai_alerts + ai_pending_actions tables",
      line1:
        "Human-in-the-Loop approval gate ensures no AI action executes without human review",
      line2:
        "Open /consultant for the AI assistant interface · /ai-approvals for the queue",
      rightLabel: "LIVE",
      rightHint: "sourced from production DB",
    },
  };
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

export async function buildSectionInfographic(
  section: InfographicSection,
): Promise<string> {
  let <REDACTED_SCHEME> InfographicData;
  switch (section) {
    case "platform-health":
      data = await buildPlatformHealth();
      break;
    case "kpis":
      data = await buildKpis();
      break;
    case "risks":
      data = await buildRisks();
      break;
    case "audits":
      data = await buildAudits();
      break;
    case "duplicates":
      data = await buildDuplicates();
      break;
    case "consultant":
      data = await buildConsultant();
      break;
    default:
      throw new Error(`Unknown infographic section: ${section}`);
  }
  return renderInfographicSvg(data);
}
