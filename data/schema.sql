-- deskbell — Postgres schema
--
-- Applied automatically by docker-compose on first boot. To apply by hand:
--   psql "$DATABASE_URL" -f data/schema.sql
--
-- Design notes worth reading before changing anything:
--   * message_log.idempotency_key is UNIQUE. That single constraint is what
--     makes duplicate sends impossible; every send claims a row before any
--     provider is contacted. Do not drop it.
--   * appointments.external_id is UNIQUE so re-syncing a booking source is
--     idempotent rather than creating duplicates every 15 minutes.
--   * State lives in `status`, driven by the state machine in lib/core.js.
--     Do not write arbitrary values into it.
--   * message_log.status separates `sent` (a provider accepted the payload)
--     from `delivered`/`read` (a receipt says it reached the handset) and
--     `undelivered` (a receipt says it did not). Those are different facts and
--     the whole product depends on telling them apart. Receipts arrive out of
--     order, so every update goes through deskbell.delivery_rank().
--
-- Re-running this file on an existing database is safe and is how you upgrade;
-- the ALTERs below carry older installs forward. CI applies it twice to prove it.

CREATE SCHEMA IF NOT EXISTS deskbell;
SET search_path TO deskbell, public;

-- ------------------------------------------------------------ delivery rank
--
-- How much a message status tells us, lowest to highest certainty. Providers
-- do not order their callbacks: Twilio's `sent` and `delivered` webhooks
-- routinely arrive the wrong way round. Every status write compares ranks, so
-- a late receipt can never walk a message backwards.
--
-- A failure ranks above `sent` (it is newer information) but below `delivered`
-- (a message that reached the handset stays reached).
--
-- Mirrors DELIVERY_RANK in lib/core.js. Change both or neither.
CREATE OR REPLACE FUNCTION deskbell.delivery_rank(status TEXT)
RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(coalesce(status, ''))
    WHEN 'read'        THEN 4
    WHEN 'delivered'   THEN 3
    WHEN 'undelivered' THEN 2
    WHEN 'failed'      THEN 2
    WHEN 'sent'        THEN 1
    ELSE 0
  END;
$$;

-- ---------------------------------------------------------------- contacts

CREATE TABLE IF NOT EXISTS deskbell.contacts (
  id                BIGSERIAL PRIMARY KEY,
  external_id       TEXT,
  first_name        TEXT NOT NULL DEFAULT '',
  name              TEXT NOT NULL DEFAULT '',
  -- Phone is the natural key: it is what every messaging provider addresses and
  -- what a caller presents. NULL is allowed for email-only contacts, and
  -- Postgres treats multiple NULLs as distinct, which is what we want.
  phone             TEXT UNIQUE,
  whatsapp          TEXT,
  email             TEXT,
  pet_name          TEXT,
  locale            TEXT,
  -- consent_at records transactional consent (they booked with us).
  -- marketing_consent is a separate, explicit opt-in for recall and reviews.
  consent_at        TIMESTAMPTZ,
  marketing_consent BOOLEAN NOT NULL DEFAULT false,
  opted_out         BOOLEAN NOT NULL DEFAULT false,
  opted_out_at      TIMESTAMPTZ,
  -- Drives the WhatsApp 24-hour free-form window.
  last_inbound_at   TIMESTAMPTZ,
  meta              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contacts_whatsapp_idx     ON deskbell.contacts (whatsapp);
CREATE INDEX IF NOT EXISTS contacts_email_idx        ON deskbell.contacts (email);
CREATE INDEX IF NOT EXISTS contacts_opted_out_idx    ON deskbell.contacts (opted_out) WHERE opted_out = false;

-- ------------------------------------------------------------ appointments

CREATE TABLE IF NOT EXISTS deskbell.appointments (
  id               BIGSERIAL PRIMARY KEY,
  -- The booking system's own id. UNIQUE so a resync updates rather than duplicates.
  external_id      TEXT UNIQUE NOT NULL,
  source           TEXT NOT NULL DEFAULT 'webhook',
  contact_id       BIGINT NOT NULL REFERENCES deskbell.contacts(id) ON DELETE CASCADE,
  start_at         TIMESTAMPTZ NOT NULL,
  end_at           TIMESTAMPTZ,
  service_name     TEXT NOT NULL DEFAULT 'appointment',
  value            NUMERIC(12,2),
  status           TEXT NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled','reminded','confirmed','cancelled',
                                       'rescheduled','completed','no_show')),
  confirmed_at     TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  -- Which reminder stages have actually been sent. Reset when the time moves.
  sent_stages      TEXT[] NOT NULL DEFAULT '{}',
  voice_attempts   INT NOT NULL DEFAULT 0,
  rating           INT CHECK (rating BETWEEN 1 AND 5),
  followup_sent_at TIMESTAMPTZ,
  meta             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The scheduler's hot path: upcoming, still-actionable appointments.
CREATE INDEX IF NOT EXISTS appointments_due_idx ON deskbell.appointments (start_at)
  WHERE status IN ('scheduled','reminded','confirmed');
CREATE INDEX IF NOT EXISTS appointments_contact_idx ON deskbell.appointments (contact_id, start_at DESC);
CREATE INDEX IF NOT EXISTS appointments_followup_idx ON deskbell.appointments (completed_at)
  WHERE status = 'completed' AND followup_sent_at IS NULL;

-- ------------------------------------------------------------- message log

CREATE TABLE IF NOT EXISTS deskbell.message_log (
  id                  BIGSERIAL PRIMARY KEY,
  -- THE guarantee. A repeated or concurrent run collides here and sends nothing.
  idempotency_key     TEXT NOT NULL UNIQUE,
  appointment_id      BIGINT REFERENCES deskbell.appointments(id) ON DELETE SET NULL,
  contact_id          BIGINT REFERENCES deskbell.contacts(id) ON DELETE SET NULL,
  stage               TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'transactional',
  channel             TEXT,
  direction           TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  status              TEXT NOT NULL DEFAULT 'claimed',
  body                TEXT,
  -- The provider's handle for this message. It is the only thing a delivery
  -- receipt arrives carrying, so every send must record it or the receipt has
  -- nothing to match against.
  provider_message_id TEXT,
  -- The provider's own word for the last receipt, kept verbatim next to our
  -- normalized status so an unfamiliar vocabulary is debuggable rather than lost.
  provider_status     TEXT,
  provider_status_at  TIMESTAMPTZ,
  error_code          TEXT,
  error_message       TEXT,
  attempt             INT NOT NULL DEFAULT 1,
  cost                NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- sent_at: a provider accepted it. delivered_at: a receipt says it landed.
  -- settled_at: the dispatcher finished with the row. Three different facts.
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  settled_at          TIMESTAMPTZ,
  CONSTRAINT message_log_status_check CHECK (
    status IN ('claimed','sent','delivered','read','undelivered','failed','blocked')
  )
);

-- Upgrade path for databases created before delivery receipts existed. Named
-- explicitly so the drop-and-recreate below is idempotent on every run.
ALTER TABLE deskbell.message_log ADD COLUMN IF NOT EXISTS provider_status    TEXT;
ALTER TABLE deskbell.message_log ADD COLUMN IF NOT EXISTS provider_status_at TIMESTAMPTZ;
ALTER TABLE deskbell.message_log ADD COLUMN IF NOT EXISTS delivered_at       TIMESTAMPTZ;
ALTER TABLE deskbell.message_log DROP CONSTRAINT IF EXISTS message_log_status_check;
ALTER TABLE deskbell.message_log ADD  CONSTRAINT message_log_status_check CHECK (
  status IN ('claimed','sent','delivered','read','undelivered','failed','blocked')
);

CREATE INDEX IF NOT EXISTS message_log_appointment_idx ON deskbell.message_log (appointment_id);
CREATE INDEX IF NOT EXISTS message_log_contact_stage_idx ON deskbell.message_log (contact_id, stage, created_at DESC);
-- Finds sends that were claimed but never settled (a crash mid-dispatch).
CREATE INDEX IF NOT EXISTS message_log_stuck_idx ON deskbell.message_log (created_at)
  WHERE status = 'claimed';
-- Delivery receipts arrive keyed on the provider's id and nothing else. Every
-- receipt is one lookup on this index; without it they are a sequential scan
-- of every message ever sent, several times per outbound message.
CREATE INDEX IF NOT EXISTS message_log_provider_msg_idx
  ON deskbell.message_log (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
-- Drives the scheduler's per-stage delivery lookup and the digest's split of
-- "never reached" out of "unconfirmed".
CREATE INDEX IF NOT EXISTS message_log_appointment_stage_idx
  ON deskbell.message_log (appointment_id, stage)
  WHERE direction = 'outbound';

-- --------------------------------------------------------- inbound messages

CREATE TABLE IF NOT EXISTS deskbell.inbound_messages (
  id                  BIGSERIAL PRIMARY KEY,
  contact_id          BIGINT REFERENCES deskbell.contacts(id) ON DELETE SET NULL,
  channel             TEXT,
  from_address        TEXT,
  body                TEXT,
  intent              TEXT,
  confidence          NUMERIC(4,3),
  provider_message_id TEXT,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbound_contact_idx ON deskbell.inbound_messages (contact_id, received_at DESC);

-- ------------------------------------------------------------------- leads

CREATE TABLE IF NOT EXISTS deskbell.leads (
  id               BIGSERIAL PRIMARY KEY,
  contact_id       BIGINT REFERENCES deskbell.contacts(id) ON DELETE SET NULL,
  source           TEXT NOT NULL DEFAULT 'missed_call',
  phone            TEXT,
  status           TEXT NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','contacted','contact_failed','converted','lost')),
  call_sid         TEXT,
  first_contact_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  contacted_at     TIMESTAMPTZ,
  converted_at     TIMESTAMPTZ,
  meta             JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Supports the "one lead per caller per hour" dedupe in workflow 05.
CREATE INDEX IF NOT EXISTS leads_phone_recent_idx ON deskbell.leads (phone, first_contact_at DESC);

-- ---------------------------------------------------------------- waitlist

CREATE TABLE IF NOT EXISTS deskbell.waitlist (
  id           BIGSERIAL PRIMARY KEY,
  contact_id   BIGINT NOT NULL REFERENCES deskbell.contacts(id) ON DELETE CASCADE,
  service_name TEXT,
  -- NULL means "any time". Otherwise the slot must fall inside this window.
  earliest     TIMESTAMPTZ,
  latest       TIMESTAMPTZ,
  priority     INT NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'waiting'
                 CHECK (status IN ('waiting','offered','booked','expired','removed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS waitlist_ready_idx ON deskbell.waitlist (priority DESC, created_at)
  WHERE status = 'waiting';

CREATE TABLE IF NOT EXISTS deskbell.waitlist_offers (
  id             BIGSERIAL PRIMARY KEY,
  waitlist_id    BIGINT NOT NULL REFERENCES deskbell.waitlist(id) ON DELETE CASCADE,
  appointment_id BIGINT REFERENCES deskbell.appointments(id) ON DELETE SET NULL,
  contact_id     BIGINT REFERENCES deskbell.contacts(id) ON DELETE SET NULL,
  message_log_id BIGINT REFERENCES deskbell.message_log(id) ON DELETE SET NULL,
  offered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'offered'
                   CHECK (status IN ('offered','accepted','declined','expired')),
  -- Never offer the same freed slot to the same waitlist entry twice.
  UNIQUE (waitlist_id, appointment_id)
);

-- ------------------------------------------------------------- human tasks

CREATE TABLE IF NOT EXISTS deskbell.human_tasks (
  id              BIGSERIAL PRIMARY KEY,
  contact_id      BIGINT REFERENCES deskbell.contacts(id) ON DELETE SET NULL,
  appointment_id  BIGINT REFERENCES deskbell.appointments(id) ON DELETE SET NULL,
  channel         TEXT,
  from_address    TEXT,
  body            TEXT,
  ai_summary      TEXT,
  suggested_reply TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS human_tasks_open_idx ON deskbell.human_tasks (created_at)
  WHERE resolved_at IS NULL;

-- --------------------------------------------------------------- call logs

CREATE TABLE IF NOT EXISTS deskbell.call_logs (
  id               BIGSERIAL PRIMARY KEY,
  appointment_id   BIGINT REFERENCES deskbell.appointments(id) ON DELETE SET NULL,
  provider_call_id TEXT UNIQUE,
  outcome          TEXT,
  customer_spoke   BOOLEAN,
  wants_human      BOOLEAN,
  notes            TEXT,
  summary          TEXT,
  transcript       TEXT,
  duration_seconds INT,
  cost             NUMERIC(10,4),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ events

-- The append-only feed the ROI report is computed from. Never updated in place.
CREATE TABLE IF NOT EXISTS deskbell.events (
  id             BIGSERIAL PRIMARY KEY,
  type           TEXT NOT NULL,
  appointment_id BIGINT REFERENCES deskbell.appointments(id) ON DELETE SET NULL,
  contact_id     BIGINT REFERENCES deskbell.contacts(id) ON DELETE SET NULL,
  channel        TEXT,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_recent_idx ON deskbell.events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_type_idx   ON deskbell.events (type, occurred_at DESC);

-- ------------------------------------------------------------ dead letters

CREATE TABLE IF NOT EXISTS deskbell.dead_letters (
  id            BIGSERIAL PRIMARY KEY,
  workflow_name TEXT,
  workflow_id   TEXT,
  execution_id  TEXT,
  node_name     TEXT,
  error_message TEXT,
  status_code   INT,
  retryable     BOOLEAN,
  category      TEXT,
  severity      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS dead_letters_recent_idx ON deskbell.dead_letters (workflow_name, created_at DESC);

-- ----------------------------------------------------------- daily metrics

CREATE TABLE IF NOT EXISTS deskbell.daily_metrics (
  day     DATE PRIMARY KEY,
  metrics JSONB NOT NULL
);

-- ------------------------------------------------------------------- views

-- What the front desk should look at each morning.
CREATE OR REPLACE VIEW deskbell.v_today AS
SELECT a.id, a.start_at, a.status, a.service_name, a.value,
       c.name, c.first_name, c.phone,
       (a.status = 'confirmed') AS confirmed
FROM deskbell.appointments a
JOIN deskbell.contacts c ON c.id = a.contact_id
WHERE a.start_at >= date_trunc('day', now())
  AND a.start_at <  date_trunc('day', now()) + interval '1 day'
  AND a.status NOT IN ('cancelled','rescheduled')
ORDER BY a.start_at;

-- Rolling no-show rate. This is the number the whole product is judged on.
CREATE OR REPLACE VIEW deskbell.v_no_show_rate AS
SELECT date_trunc('week', start_at)::date AS week,
       count(*)                                    AS total,
       count(*) FILTER (WHERE status = 'no_show')  AS no_shows,
       round(100.0 * count(*) FILTER (WHERE status = 'no_show') / NULLIF(count(*), 0), 1) AS no_show_pct,
       coalesce(sum(value) FILTER (WHERE status = 'no_show'), 0) AS lost_value
FROM deskbell.appointments
WHERE start_at < now() AND status IN ('completed','no_show')
GROUP BY 1 ORDER BY 1 DESC;

-- Sends that were claimed but never settled: a crash happened mid-dispatch.
-- Anything here older than an hour needs manual review.
CREATE OR REPLACE VIEW deskbell.v_stuck_sends AS
SELECT id, idempotency_key, appointment_id, stage, created_at,
       now() - created_at AS stuck_for
FROM deskbell.message_log
WHERE status = 'claimed' AND created_at < now() - interval '1 hour'
ORDER BY created_at;

-- Messages a provider accepted and then told us never arrived. This is an
-- operational fault list, not a customer list: a number that keeps appearing
-- here is wrong in the booking system and no amount of resending will fix it.
CREATE OR REPLACE VIEW deskbell.v_undelivered AS
SELECT m.id, m.appointment_id, m.contact_id, m.stage, m.channel,
       m.provider_status, m.error_code, m.error_message,
       m.provider_status_at, c.phone, c.name
FROM deskbell.message_log m
LEFT JOIN deskbell.contacts c ON c.id = m.contact_id
WHERE m.direction = 'outbound' AND m.status = 'undelivered'
ORDER BY m.provider_status_at DESC NULLS LAST;
