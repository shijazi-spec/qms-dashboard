/**
 * Tech Requests Tracker — the platform version of the "Tech Requests" sheet.
 *
 * A request is raised on behalf of a client/product, emailed in full to whoever
 * it is assigned to, and that person responds via secure one-click links in the
 * email (no platform login needed — most assignees are outside the GRQ team).
 *
 * Their response writes straight back onto the board, which is what replaces the
 * manual follow-up chasing the sheet requires today.
 */
import { randomBytes } from "crypto";
import { pool } from "./kpiDatabase";
import { logger } from "./logger";

export type TechRequestStatus = "sent" | "accepted" | "info_needed" | "done";

export interface TechRequest {
  id?: number;
  product?: string | null;
  client_name?: string | null;
  contact_email?: string | null;
  request_text: string;
  assignee_name?: string | null;
  assignee_email: string;
  due_date?: string | null;
  status?: TechRequestStatus;
  response_note?: string | null;
  responded_at?: Date | null;
  follow_up_at?: Date | null;
  action_token?: string;
  created_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

export async function initTechRequestTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tech_requests (
      id SERIAL PRIMARY KEY,
      product VARCHAR(60),
      client_name VARCHAR(200),
      contact_email VARCHAR(200),
      request_text TEXT NOT NULL,
      assignee_name VARCHAR(200),
      assignee_email VARCHAR(200) NOT NULL,
      due_date DATE,
      status VARCHAR(20) DEFAULT 'sent',
      response_note TEXT,
      responded_at TIMESTAMP,
      follow_up_at TIMESTAMP,
      action_token VARCHAR(80) NOT NULL,
      created_by VARCHAR(200),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tech_requests_token ON tech_requests(action_token)`,
  );
  logger.info("✅ [TechRequests] tech_requests table ready");
}

export async function listRequests(): Promise<TechRequest[]> {
  const res = await pool.query(
    `SELECT * FROM tech_requests
      ORDER BY (status = 'done') ASC, due_date NULLS LAST, created_at DESC`,
  );
  return res.rows;
}

export async function createRequest(r: TechRequest): Promise<TechRequest> {
  // 256-bit unguessable token — the only thing standing between a public URL and
  // someone else's request, so it must not be sequential or derived from the id.
  const token = randomBytes(32).toString("hex");
  const res = await pool.query(
    `INSERT INTO tech_requests
       (product, client_name, contact_email, request_text, assignee_name,
        assignee_email, due_date, status, action_token, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'sent',$8,$9) RETURNING *`,
    [
      r.product || null,
      r.client_name || null,
      r.contact_email || null,
      (r.request_text || "").trim(),
      r.assignee_name || null,
      (r.assignee_email || "").trim(),
      r.due_date || null,
      token,
      r.created_by || "system",
    ],
  );
  return res.rows[0];
}

export async function getByToken(token: string): Promise<TechRequest | null> {
  if (!token || token.length < 32) return null; // never probe the table with junk
  const res = await pool.query(
    `SELECT * FROM tech_requests WHERE action_token = $1`,
    [token],
  );
  return res.rows[0] || null;
}

export async function getRequest(id: number): Promise<TechRequest | null> {
  const res = await pool.query(`SELECT * FROM tech_requests WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

/**
 * Record the assignee's response. Called from the public token endpoint, so it
 * only ever accepts the three safe outcomes and never trusts an arbitrary status.
 */
export async function recordResponse(
  token: string,
  action: "accept" | "done" | "info",
  note?: string,
): Promise<TechRequest | null> {
  const req = await getByToken(token);
  if (!req) return null;
  const status: TechRequestStatus =
    action === "accept" ? "accepted" : action === "done" ? "done" : "info_needed";
  const res = await pool.query(
    `UPDATE tech_requests
        SET status = $2, response_note = COALESCE($3, response_note),
            responded_at = NOW(), follow_up_at = NOW(), updated_at = NOW()
      WHERE action_token = $1 RETURNING *`,
    [token, status, note?.trim() || null],
  );
  return res.rows[0] || null;
}

/** Internal-side status change (from the board, not the email). */
export async function setStatus(
  id: number,
  status: TechRequestStatus,
  note?: string,
): Promise<TechRequest | null> {
  const res = await pool.query(
    `UPDATE tech_requests
        SET status = $2, response_note = COALESCE($3, response_note),
            follow_up_at = NOW(), updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, status, note?.trim() || null],
  );
  return res.rows[0] || null;
}
