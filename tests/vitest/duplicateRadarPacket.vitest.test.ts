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
import type { OwnerAccountability, PacketSettings } from "../../src/utils/duplicateRadarDatabase";

const owner: OwnerAccountability = {
  owner_name: "Lina Khaled",
  owner_email: "lina@walaplus.com",
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
  escalation_contact_email: "data-quality@walaplus.com",
  dispute_path: "Reply to the packet email",
};

const fixedNow = new Date("2026-05-01T00:00:00.000Z");

describe("packetDueDate", () => {
  test("any high-confidence cluster → +7 days", () => {
    const due = packetDueDate([95, 70, 50], fixedNow);
    expect(due).toBe("2026-05-08");
  });
  test("medium but no high → +14 days", () => {
    const due = packetDueDate([75, 60, 30], fixedNow);
    expect(due).toBe("2026-05-15");
  });
  test("all low → +30 days", () => {
    const due = packetDueDate([10, 30, 55], fixedNow);
    expect(due).toBe("2026-05-31");
  });
  test("empty list falls back to low-tier SLA", () => {
    const due = packetDueDate([], fixedNow);
    expect(due).toBe("2026-05-31");
  });
});

describe("packetFilename", () => {
  test("ascii name", () => {
    expect(packetFilename("Lina Khaled")).toBe("duplicate-radar-packet-Lina_Khaled.xlsx");
  });
  test("strips filesystem-hostile chars", () => {
    expect(packetFilename("a/b:c*?d")).toBe("duplicate-radar-packet-a_b_c_d.xlsx");
  });
  test("empty / whitespace falls back to 'owner'", () => {
    expect(packetFilename("")).toBe("duplicate-radar-packet-owner.xlsx");
    expect(packetFilename("   ")).toBe("duplicate-radar-packet-owner.xlsx");
  });
});

describe("buildPacketSheets", () => {
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

  test("Cover sheet exposes owner metrics, packet SLA, dispute path, escalation contact", () => {
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
    expect(String(byField["Escalation contact"])).toContain(
      "data-quality@walaplus.com",
    );
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
        record_name: "ACME Co",
        record_type: "account",
        zoho_record_id: "Z1",
        domain: "acme.com",
        email: "a@acme.com",
        cluster_confidence_score: 95,
        cluster_total_records: 2,
        owner_name: owner.owner_name,
        owner_email: owner.owner_email,
        ai_recommendation: null,
      },
      {
        cluster_id: 1,
        is_primary: false,
        record_name: "Acme Company",
        record_type: "account",
        zoho_record_id: "Z2",
        domain: "acme.com",
        email: "b@acme.com",
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
    expect(action[1].recommended_action).toBe('Merge into "ACME Co"');
  });
});
