/**
 * CS TEAM ROSTER — the maintained list of Customer Success members
 * (Sarah 2026-07-21).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The platform had no CS roster at all: the only trace of a CS person was the
 * per-deal "CS Owner Name" field in Zoho. So "who are the CS owners?" could only
 * be answered by scraping whatever names happened to be typed on deals — which
 * misses anyone with no deals yet, and silently includes typos and people who
 * have left. Sarah supplied the authoritative list, so it lives here as the
 * single source of truth.
 *
 * WHAT IT IS AND IS NOT
 * ---------------------
 * This is the ESTABLISHMENT list (who is on the team). It is NOT the assignment
 * data — `getCsOwners()` still derives per-person deal counts from live Zoho
 * records. Cross-referencing the two is the point: it surfaces
 *   - roster members with ZERO deals (nobody assigned / new joiner), and
 *   - owner names on deals that are NOT on the roster (typo, ex-employee, or a
 *     sales rep mistakenly typed into the CS Owner field).
 *
 * MAINTENANCE
 * -----------
 * When someone joins or leaves, edit MEMBERS below (or set the env override).
 * Add any spelling the CRM actually contains to `aliases` — Zoho holds a free
 * text display name, so Arabic spellings and "Al X" / "Al-X" / "AlX" variants
 * all occur. Matching is Arabic-aware and punctuation-insensitive, so most
 * variants resolve without an explicit alias.
 *
 * ENV OVERRIDE: CS_TEAM_MEMBERS accepts "Name <email>, Name <email>, …" and
 * REPLACES the built-in list, so a roster change needs no deploy.
 */
import { normalizePersonName } from "./duplicateMergePlanner";

export interface CsTeamMember {
  /** Display name as supplied by the business. */
  name: string;
  /** WalaPlus mailbox — the stable identity when names are re-spelled. */
  email: string;
  /** Extra spellings seen (or expected) in the CRM's CS Owner Name field. */
  aliases?: string[];
}

/** The 13 CS members Sarah confirmed on 2026-07-21. */
const MEMBERS: CsTeamMember[] = [
  { name: "Saleh Alhamddi", email: "saleh@walaplus.com", aliases: ["صالح الحمدي", "Saleh Alhamdi", "Saleh Al Hamddi"] },
  { name: "abdulmalik Alfaleh", email: "abdulmalik@walaplus.com", aliases: ["Abdulmalik Alfaleh", "Abdulmalik Al Faleh", "عبدالملك الفالح"] },
  { name: "Salman Al-Issa", email: "s.alissa@walaplus.com", aliases: ["Salman Alissa", "Salman Al Issa", "سلمان العيسى"] },
  { name: "Zeina Alsoudi", email: "z.alsoudi@walaplus.com", aliases: ["Zeina Al Soudi", "Zeina Al-Soudi", "زينة السودي"] },
  { name: "Alhanouf Aldarwish", email: "a.aldarwish@walaplus.com", aliases: ["Alhanouf Al Darwish", "AlHanouf Aldarwish", "الهنوف الدرويش"] },
  { name: "Feras Alarfaj", email: "f.alarfaj@walaplus.com", aliases: ["Feras Al Arfaj", "Firas Alarfaj", "فراس العرفج"] },
  { name: "Basem Al Anazi", email: "b.alanazi@walaplus.com", aliases: ["Basem Alanazi", "Basem Al-Anazi", "باسم العنزي"] },
  { name: "تغريد الجاسر", email: "taghreed@walaplus.com", aliases: ["Taghreed Aljasser", "Taghreed Al Jasser", "Taghreed"] },
  { name: "Basmah Raddah", email: "b.raddah@walaplus.com", aliases: ["Basmah Raddah", "Basma Raddah", "بسمة ردة"] },
  { name: "Abdullah Al Jarrah", email: "a.aljarrah@walaplus.com", aliases: ["Abdullah Aljarrah", "Abdullah Al-Jarrah", "عبدالله الجراح"] },
  { name: "Abdulaziz Al Humoud", email: "a.alhumoud@walaplus.com", aliases: ["Abdulaziz Alhumoud", "Abdulaziz Al-Humoud", "عبدالعزيز الحمود"] },
  { name: "Mohammed Alhumoudi", email: "m.alhumoudi@walaplus.com", aliases: ["Mohammed Al Humoudi", "Mohammad Alhumoudi", "محمد الحمودي"] },
  { name: "faisal alzughaiby", email: "f.alzughaiby@walaplus.com", aliases: ["Faisal Alzughaiby", "Faisal Al Zughaiby", "فيصل الزغيبي"] },
];

/** Parse the CS_TEAM_MEMBERS env override: "Name <email>, Name <email>". */
function parseEnvRoster(raw: string): CsTeamMember[] {
  const out: CsTeamMember[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(.*?)\s*<\s*([^>]+?)\s*>$/);
    if (m && m[1] && m[2]) out.push({ name: m[1].trim(), email: m[2].trim().toLowerCase() });
    else if (s.includes("@")) out.push({ name: s, email: s.toLowerCase() });
  }
  return out;
}

let _roster: CsTeamMember[] | null = null;
export function getCsTeamMembers(): CsTeamMember[] {
  if (_roster) return _roster;
  const env = (process.env.CS_TEAM_MEMBERS || "").trim();
  const list = env ? parseEnvRoster(env) : MEMBERS;
  _roster = list.length > 0 ? list : MEMBERS;
  return _roster;
}

/**
 * Comparison key: Arabic-aware normalisation (NFKC, diacritics/tatweel stripped,
 * alef/yaa/taa-marbuta folded, lowercased) PLUS removal of every non-alphanumeric
 * character, so "Salman Al-Issa" / "Salman Al Issa" / "SalmanAlissa" collapse to
 * one key. Latin and Arabic letters are both kept.
 */
function nameKey(s: string | null | undefined): string {
  return normalizePersonName(s).replace(/[^\p{L}\p{N}]+/gu, "");
}

let _index: Map<string, CsTeamMember> | null = null;
function getIndex(): Map<string, CsTeamMember> {
  if (_index) return _index;
  const idx = new Map<string, CsTeamMember>();
  for (const m of getCsTeamMembers()) {
    const add = (v: string | null | undefined) => {
      const k = nameKey(v);
      if (k && !idx.has(k)) idx.set(k, m);
    };
    add(m.name);
    for (const a of m.aliases || []) add(a);
    // Email + its local part ("s.alissa") so a CS Owner field holding a mailbox
    // (or the login handle) still resolves to the person.
    const em = (m.email || "").trim().toLowerCase();
    if (em) {
      if (!idx.has(em)) idx.set(em, m);
      add(em.split("@")[0]);
    }
  }
  _index = idx;
  return idx;
}

/**
 * Resolve a raw "CS Owner Name" (or email) to a roster member. Returns null when
 * the value is not on the roster — which is itself a finding: an ex-employee, a
 * typo, or a non-CS person typed into the CS Owner field.
 */
export function matchCsTeamMember(raw: string | null | undefined): CsTeamMember | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const idx = getIndex();
  const direct = idx.get(s.toLowerCase());
  if (direct) return direct;
  return idx.get(nameKey(s)) ?? null;
}

/** Test seam — drop the memoised roster/index after an env change. */
export function _resetCsTeamCache(): void {
  _roster = null;
  _index = null;
}
