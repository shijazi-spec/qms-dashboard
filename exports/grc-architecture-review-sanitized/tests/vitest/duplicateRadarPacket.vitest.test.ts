/**
 * Unit tests for the per-owner Remediation Packet (R2) helpers — the
 * deterministic builders that wrap the playbook output into a 4-sheet
 * stakeholder workbook.
 *
 * Run: npx vitest run tests/vitest/duplicateRadarPacket.vitest.test.ts
 */
import { describe, expect, test } from "vitest";
import {
  packetDueDate,
  packetFilename,
  buildPacketSheets,
} from "../../src/utils/duplicateRadarPacket";
import type {
  OwnerAccountability,
  PacketSettings,
} from "../../src/utils/duplicateRadarDatabase";

const owner: OwnerAccountability = {
  owner_name: "Sample User",
  owner_email: "<REDACTED_EMAIL>",
  // `team` was added to OwnerAccountability so coaching reports can group
  // owners by squad (MP / WO Sales / CS / MGMT / Unassigned). The packet
  // builders don't actually read this field — but the test fixture has to
  // satisfy the interface or `npm run check:tests` fails CI.
  team: "MP",
  total_records: 120,
  duplicate_records: 18,
  duplicate_rate: 15,
  clusters_involved: 6,
  high_confidence_duplicates: 7,
  estimated_waste_value: 24500,
  rag_status: "red",
};

const settings: PacketSettings = {
  escalation_contact_name: "Data Quality Lead",
  escalation_contact_email: "<REDACTED_EMAIL>",
  dispute_path: "Reply to the packet email",
};

const fixedNow = new Date("2026-05-01T00:00:00.000Z");

describe("packetDueDate", () => {
  test("any high-confidence cluster → +7 days", () => {
    expect(packetDueDate([95, 70, 50], fixedNow)).toBe("2026-05-08");
  });
  test("medium but no high → +14 days", () => {
    expect(packetDueDate([75, 60, 30], fixedNow)).toBe("2026-05-15");
  });
  test("all low → +30 days", () => {
    expect(packetDueDate([10, 30, 55], fixedNow)).toBe("2026-05-31");
  });
  test("empty list falls back to low-tier SLA", () => {
    expect(packetDueDate([], fixedNow)).toBe("2026-05-31");
  });
});

describe("packetFilename", () => {
  test("ascii name", () => {
    expect(packetFilename("Lina Sample User")).toBe(
      "duplicate-radar-packet-Lina_Khaled.xlsx",
    );
  });
  test("strips filesystem-hostile chars", () => {
    expect(packetFilename("a/b:c*?d")).toBe(
      "duplicate-radar-packet-a_b_c_d.xlsx",
    );
  });
  test("empty / whitespace falls back to 'owner'", () => {
    expect(packetFilename("")).toBe("duplicate-radar-packet-owner.xlsx");
    expect(packetFilename("   ")).toBe("duplicate-radar-packet-owner.xlsx");
  });
  // Server slug must agree with the dashboard fallback (ASCII-only). If we
  // emitted Arabic chars from the server but the client stripped them, the
  // streaming-download tray would show a different name than what landed
  // on disk — confusing for the operator.
  test("non-ASCII (Arabic) name produces ASCII slug matching the client", () => {
    const slug = packetFilename("Sample User");
    expect(slug).toMatch(/^duplicate-radar-packet-[a-zA-Z0-9_-]+\.xlsx$/);
  });
});

describe("buildPacketSheets — English (default)", () => {
  test("returns exactly 4 sheets in the documented order", () => {
    const sheets = buildPacketSheets({
      owner,
      settings,
      records: [],
      clusterConfidences: [95],
      now: fixedNow,
    });
    expect(sheets.map((s) => s.name)).toEqual([
      "Cover",
      "Action Items",
      "Raw Records",
      "FAQ",
    ]);
  });

  test("Cover sheet exposes owner metrics, packet SLA, dispute path, escalation contact + email rows", () => {
    const sheets = buildPacketSheets({
      owner,
      settings,
      records: [],
      clusterConfidences: [95],
      now: fixedNow,
    });
    const cover = sheets[0];
    const byField = Object.fromEntries(
      (cover.rows as Array<{ field: string; value: unknown }>).map((r) => [
        r.field,
        r.value,
      ]),
    );
    expect(byField["Owner"]).toBe(owner.owner_name);
    expect(byField["Duplicate rate"]).toBe("15%");
    expect(byField["RAG status"]).toMatch(/Red/);
    expect(byField["Packet due by"]).toBe("2026-05-08");
    // Escalation is now two separate rows so Excel doesn't auto-linkify
    // a `Name <email>` pattern.
    expect(byField["Escalation contact"]).toBe(settings.escalation_contact_name);
    expect(byField["Escalation email"]).toBe(settings.escalation_contact_email);
    expect(byField["Dispute path"]).toBe(settings.dispute_path);
  });

  test("FAQ sheet contains exactly 7 Q&A entries", () => {
    const sheets = buildPacketSheets({
      owner,
      settings,
      records: [],
      clusterConfidences: [95],
      now: fixedNow,
    });
    const faq = sheets[3];
    expect(faq.rows.length).toBe(7);
    for (const r of faq.rows as Array<{ q: string; a: string }>) {
      expect(r.q).toBeTruthy();
      expect(r.a).toBeTruthy();
    }
  });

  test("Action Items threads playbook state — non-primary row shows 'Merge into <primary>'", () => {
    const records = [
      {
        cluster_id: 1,
        is_primary: true,
        record_name: "Example Organization Co",
        record_type: "account",
        CRMProvider_record_id: "Z1",
        domain: "<REDACTED_HOST>",
        email: "<REDACTED_EMAIL>",
        cluster_confidence_score: 95,
        cluster_total_records: 2,
        owner_name: owner.owner_name,
        owner_email: owner.owner_email,
        ai_recommendation: null,
      },
      {
        cluster_id: 1,
        is_primary: false,
        record_name: "Example Organization",
        record_type: "account",
        CRMProvider_record_id: "Z2",
        domain: "<REDACTED_HOST>",
        email: "<REDACTED_EMAIL>",
        cluster_confidence_score: 95,
        cluster_total_records: 2,
        owner_name: owner.owner_name,
        owner_email: owner.owner_email,
        ai_recommendation: null,
      },
    ];
    const sheets = buildPacketSheets({
      owner,
      settings,
      records,
      clusterConfidences: [95],
      now: fixedNow,
    });
    const action = sheets[1].rows as Array<{
      recommended_action: string;
      is_primary_label: string;
    }>;
    expect(action[0].is_primary_label).toBe("Yes");
    expect(action[0].recommended_action).toBe("Keep — primary record");
    expect(action[1].is_primary_label).toBe("No");
    expect(action[1].recommended_action).toBe('Merge into "Example Organization Co"');
  });

  test("empty-owner contract: no records, no cluster confidences — packet still builds and Action Items / Raw Records are empty arrays", () => {
    const sheets = buildPacketSheets({
      owner,
      settings,
      records: [],
      clusterConfidences: [],
      now: fixedNow,
    });
    expect(sheets).toHaveLength(4);
    expect(sheets[1].rows).toEqual([]); // Action Items
    expect(sheets[2].rows).toEqual([]); // Raw Records
    // Packet due-by falls back to low-tier SLA when no clusters are known.
    const cover = sheets[0];
    const byField = Object.fromEntries(
      (cover.rows as Array<{ field: string; value: unknown }>).map((r) => [
        r.field,
        r.value,
      ]),
    );
    expect(byField["Packet due by"]).toBe("2026-05-31");
  });

  test("English sheets are NOT marked right-to-left", () => {
    const sheets = buildPacketSheets({
      owner,
      settings,
      records: [],
      clusterConfidences: [95],
      now: fixedNow,
      lang: "en",
    });
    for (const s of sheets) {
      expect((s as any).rightToLeft).toBeFalsy();
    }
  });
});

describe("buildPacketSheets — Arabic", () => {
  test("sheet names are Arabic", () => {
    const sheets = buildPacketSheets({
      owner,
      settings,
      records: [],
      clusterConfidences: [95],
      now: fixedNow,
      lang: "ar",
    });
    expect(sheets.map((s) => s.name)).toEqual([
      "الغلاف",
      "خطوات المعالجة",
      "السجلات الأصلية",
      "الأسئلة الشائعة",
    ]);
  });

  test("every Arabic sheet is marked rightToLeft so Excel mirrors column order", () => {
    const sheets = buildPacketSheets({
      owner,
      settings,
      records: [],
      clusterConfidences: [95],
      now: fixedNow,
      lang: "ar",
    });
    for (const s of sheets) {
      expect((s as any).rightToLeft).toBe(true);
    }
  });

  test("Cover sheet uses Arabic field labels + RAG descriptor", () => {
    const sheets = buildPacketSheets({
      owner,
      settings,
      records: [],
      clusterConfidences: [95],
      now: fixedNow,
      lang: "ar",
    });
    const cover = sheets[0];
    const byField = Object.fromEntries(
      (cover.rows as Array<{ field: string; value: unknown }>).map((r) => [
        r.field,
        r.value,
      ]),
    );
    expect(byField["المالك"]).toBe(owner.owner_name);
    expect(byField["نسبة التكرار"]).toBe("15%");
    expect(String(byField["الحالة (RAG)"])).toMatch(/أحمر/);
    expect(byField["تاريخ استحقاق الحزمة"]).toBe("2026-05-08");
  });

  test("FAQ in Arabic has 7 entries and no English residue", () => {
    const sheets = buildPacketSheets({
      owner,
      settings,
      records: [],
      clusterConfidences: [95],
      now: fixedNow,
      lang: "ar",
    });
    const faq = sheets[3];
    expect(faq.rows.length).toBe(7);
    for (const r of faq.rows as Array<{ q: string; a: string }>) {
      // Sanity: question + answer should contain Arabic codepoints
      // (U+0600..U+06FF). Catches a future PR that forgets to add an
      // AR FAQ row and silently falls back to English.
      expect(r.q).toMatch(/[؀-ۿ]/);
      expect(r.a).toMatch(/[؀-ۿ]/);
    }
  });

  test("Action Items in Arabic shows is_primary label as نعم / لا", () => {
    const records = [
      {
        cluster_id: 1,
        is_primary: true,
        record_name: "Example Organization Co",
        record_type: "account",
        CRMProvider_record_id: "Z1",
        cluster_confidence_score: 95,
        cluster_total_records: 1,
      },
    ];
    const sheets = buildPacketSheets({
      owner,
      settings,
      records,
      clusterConfidences: [95],
      now: fixedNow,
      lang: "ar",
    });
    const action = sheets[1].rows as Array<{ is_primary_label: string }>;
    expect(action[0].is_primary_label).toBe("نعم");
  });

  test("unknown lang falls back to English (defensive)", () => {
    const sheets = buildPacketSheets({
      owner,
      settings,
      records: [],
      clusterConfidences: [95],
      now: fixedNow,
      lang: "xx" as any,
    });
    expect(sheets[0].name).toBe("Cover");
  });
});
