-- Minimal schema required by the QMS integration tests in CI.
-- All tables are created with IF NOT EXISTS so the script is idempotent.
-- Column types are kept permissive (TEXT / JSONB / TIMESTAMPTZ) to avoid
-- enum-mismatch failures while still satisfying every INSERT / SELECT used
-- by qmsApiRoutes.test.ts and dashboardApiRoutes.test.ts.

CREATE SEQUENCE IF NOT EXISTS capa_number_seq;
CREATE SEQUENCE IF NOT EXISTS nc_number_seq;

CREATE TABLE IF NOT EXISTS evaluation_frameworks (
  framework_id   TEXT PRIMARY KEY,
  name           TEXT,
  version        TEXT,
  description    TEXT,
  standards      JSONB,
  dimensions     JSONB,
  is_active      BOOLEAN DEFAULT FALSE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deal_evaluations (
  id                 SERIAL PRIMARY KEY,
  deal_id            TEXT,
  deal_name          TEXT,
  framework_id       TEXT,
  overall_score      NUMERIC,
  dimension_scores   JSONB,
  criteria_scores    JSONB,
  findings_count     INTEGER DEFAULT 0,
  critical_findings  INTEGER DEFAULT 0,
  recommendations    JSONB,
  deal_data          JSONB,
  source             TEXT,
  evaluation_date    TIMESTAMPTZ DEFAULT NOW(),
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS capa_records (
  id                    SERIAL PRIMARY KEY,
  capa_number           TEXT UNIQUE,
  title                 TEXT NOT NULL,
  description           TEXT,
  capa_type             TEXT,
  source_type           TEXT,
  source_id             TEXT,
  source_reference      TEXT,
  severity              TEXT,
  status                TEXT DEFAULT 'open',
  priority              TEXT DEFAULT 'medium',
  assigned_to           TEXT,
  root_cause            TEXT,
  root_cause_method     TEXT,
  immediate_action      TEXT,
  corrective_action     TEXT,
  preventive_action     TEXT,
  verification_method   TEXT,
  effectiveness_criteria TEXT,
  target_date           TIMESTAMPTZ,
  completion_date       TIMESTAMPTZ,
  verification_date     TIMESTAMPTZ,
  related_criteria      JSONB,
  attachments           JSONB,
  metadata              JSONB,
  created_by            TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS capa_action_items (
  id              SERIAL PRIMARY KEY,
  capa_id         INTEGER REFERENCES capa_records(id) ON DELETE CASCADE,
  action_number   INTEGER,
  description     TEXT,
  action_type     TEXT,
  assigned_to     TEXT,
  due_date        TIMESTAMPTZ,
  completion_date TIMESTAMPTZ,
  status          TEXT DEFAULT 'pending',
  notes           TEXT,
  evidence        JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nonconformance_records (
  id                  SERIAL PRIMARY KEY,
  nc_number           TEXT UNIQUE,
  title               TEXT,
  description         TEXT,
  nc_type             TEXT,
  category            TEXT,
  source_type         TEXT,
  source_id           TEXT,
  source_reference    TEXT,
  severity            TEXT,
  status              TEXT DEFAULT 'open',
  disposition         TEXT,
  disposition_notes   TEXT,
  related_capa_id     INTEGER,
  detected_by         TEXT,
  detected_date       TIMESTAMPTZ,
  review_notes        TEXT,
  reviewed_by         TEXT,
  review_date         TIMESTAMPTZ,
  closed_by           TEXT,
  closed_date         TIMESTAMPTZ,
  criteria_violations JSONB,
  attachments         JSONB,
  metadata            JSONB,
  created_by          TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_records (
  id                  SERIAL PRIMARY KEY,
  training_id         TEXT UNIQUE,
  title               TEXT,
  description         TEXT,
  training_type       TEXT,
  category            TEXT,
  duration_hours      NUMERIC,
  provider            TEXT,
  materials           JSONB,
  assessment_required BOOLEAN DEFAULT FALSE,
  passing_score       NUMERIC,
  validity_months     INTEGER,
  is_mandatory        BOOLEAN DEFAULT FALSE,
  target_roles        TEXT[],
  metadata            JSONB,
  is_active           BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_assignments (
  id              SERIAL PRIMARY KEY,
  training_id     TEXT,
  employee_id     TEXT,
  employee_name   TEXT,
  employee_email  TEXT,
  employee_role   TEXT,
  due_date        TIMESTAMPTZ,
  status          TEXT DEFAULT 'assigned',
  assigned_by     TEXT,
  completed_date  TIMESTAMPTZ,
  score           NUMERIC,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
