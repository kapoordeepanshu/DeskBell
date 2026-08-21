#!/usr/bin/env node
/**
 * Emits workflows/*.json from lib/core.js plus the definitions in this file.
 *
 * Why generated: the engine logic is unit-tested in lib/core.js, and every Code
 * node that needs it gets the *same* tested copy inlined. Hand-editing logic
 * inside twelve JSON blobs is how template repos end up with three subtly
 * different quiet-hours implementations.
 *
 * The emitted JSON is committed and is what you import into n8n. CI re-runs this
 * and fails if the committed files drift (`npm run verify`).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Workflow, jsCode, webhookIn, sql, callWorkflow, ifBool, switchOn,
  everyMinutes, everyHour, dailyAt,
} from './n8n-builder.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'workflows');

/** The tested engine, inlined into every Code node that needs it. */
const CORE = readFileSync(join(ROOT, 'lib', 'core.js'), 'utf8')
  .replace(/^\/\*\*[\s\S]*?\*\/\n/, '') // drop the file header; each node re-states it
  .trim();

const HEADER = (what) => `// ${what}
// Engine functions below are inlined from lib/core.js by scripts/build-workflows.mjs.
// Do not edit them here — edit lib/core.js and run \`npm run build\`.
${CORE}
// ---------------------------------------------------------------- node logic

`;

/**
 * Sub-workflow references. The import script rewrites these placeholders with
 * the real ids n8n assigns on import (see scripts/import-workflows.sh).
 */
const WF = {
  config: '__DESKBELL_WF_00_CONFIG__',
  dispatcher: '__DESKBELL_WF_03_DISPATCHER__',
  voice: '__DESKBELL_WF_06_VOICE__',
  waitlist: '__DESKBELL_WF_08_WAITLIST__',
  errors: '__DESKBELL_WF_09_ERRORS__',
};

const PG = { postgres: { id: '__DESKBELL_PG_CRED__', name: 'deskbell postgres' } };
const withPg = { credentials: PG };

/** Every workflow points its failures at 09-error-handler. */
const META = { errorWorkflow: WF.errors };

const workflows = [];
const define = (fn) => workflows.push(fn());

/* ================================================================== *
 * 00 — Config provider
 * ================================================================== */

define(() => {
  const w = new Workflow('deskbell/00 Config', { tags: [{ name: 'deskbell' }] });

  // Your own config/config.json wins over the shipped example, so `npm run build`
  // followed by `npm run import` upgrades the workflows without discarding your
  // settings. config/config.json is gitignored — it holds your business details.
  let source = join(ROOT, 'config', 'config.json');
  try {
    readFileSync(source);
  } catch {
    source = join(ROOT, 'config', 'config.example.json');
  }
  console.log(`  (config baked in from ${source.slice(ROOT.length + 1)})`);
  const defaults = readFileSync(source, 'utf8').trim();

  w.add('execTrigger', 'When Called', {});
  w.add('code', 'Load Config', jsCode(`${HEADER('deskbell/00 — the single source of configuration truth')}
// Edit THIS object to configure deskbell, or set the DESKBELL_CONFIG environment
// variable to a JSON string and it wins. One place, not twelve.
const INLINE_CONFIG = ${defaults};

let raw = INLINE_CONFIG;
try {
  // $env access is blocked on some n8n installs; the inline object is the fallback.
  if (typeof $env !== 'undefined' && $env.DESKBELL_CONFIG) raw = $env.DESKBELL_CONFIG;
} catch (e) { /* env locked down — use the inline config */ }

const config = normalizeConfig(raw);

// Fail loudly at config load rather than silently sending nothing all week.
const problems = [];
if (!config.reminders.length) problems.push('no reminder stages configured');
if (!config.business.timezone) problems.push('business.timezone is required');
for (const stage of config.reminders) {
  if (!(stage.offsetHours > 0)) problems.push(\`stage \${stage.stage}: offsetHours must be > 0\`);
  for (const ch of stage.channels || []) {
    if (!config.channels[ch]) problems.push(\`stage \${stage.stage}: unknown channel "\${ch}"\`);
  }
}
const offsets = config.reminders.map(r => r.offsetHours);
if (new Set(offsets).size !== offsets.length) problems.push('duplicate reminder offsetHours');
if (problems.length) throw new Error('deskbell config invalid: ' + problems.join('; '));

return [{ json: { config } }];`));

  w.chain('When Called', 'Load Config');
  w.note(
    '## deskbell — configuration\n\nEvery other workflow calls this one to get its settings.\n\n**To configure deskbell, edit the `INLINE_CONFIG` object in the "Load Config" node** — or set the `DESKBELL_CONFIG` env var to override it.\n\nPresets for other business types live in `config/presets/`.',
    [240, 0], [520, 240],
  );
  return w;
});

/* ================================================================== *
 * 01 — Appointment sync
 * ================================================================== */

define(() => {
  const w = new Workflow('deskbell/01 Appointment Sync', META);

  w.add('schedule', 'Every 15 Minutes', everyMinutes(15), { pos: [260, 200] });
  w.add('webhook', 'Booking Webhook', webhookIn('deskbell/appointments'), { pos: [260, 460], webhookId: true });
  w.add('execWorkflow', 'Get Config', callWorkflow(WF.config), { pos: [480, 300] });
  w.add('gcal', 'Fetch Calendar Events', {
    operation: 'getAll',
    calendar: { __rl: true, value: 'primary', mode: 'list' },
    returnAll: true,
    timeMin: '={{ $now.toISO() }}',
    timeMax: '={{ $now.plus(14, "days").toISO() }}',
    options: { singleEvents: true },
  }, { pos: [700, 200], continueOnFail: true, alwaysOutputData: true });

  w.add('code', 'Normalize Appointments', jsCode(`${HEADER('deskbell/01 — fold every booking source into one shape')}
const config = $('Get Config').first().json.config;

// The webhook branch and the calendar branch both land here. Anything with a
// start time and a phone number can be a source; adding one means adding a
// branch above, never touching the engine.
const rows = $input.all().map(i => i.json);
const out = [];
const rejected = [];

for (const row of rows) {
  // Google Calendar shape -> flat row. Attendee phone is read from the event
  // description as "phone: +1555..." which is what front-desk staff actually type.
  let flat = row;
  if (row.start && (row.start.dateTime || row.start.date)) {
    const desc = String(row.description || '');
    const phone = (desc.match(/(?:phone|mobile|tel)\\s*[:=]\\s*(\\+?[\\d\\s().-]{7,})/i) || [])[1];
    const email = (row.attendees || []).map(a => a.email).find(Boolean) ||
      (desc.match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/) || [])[0];
    const value = Number((desc.match(/value\\s*[:=]\\s*([\\d.]+)/i) || [])[1]) || null;
    flat = {
      id: row.id,
      externalId: row.id,
      startAt: row.start.dateTime || row.start.date,
      endAt: row.end && (row.end.dateTime || row.end.date),
      serviceName: row.summary || 'appointment',
      name: (row.attendees || []).map(a => a.displayName).find(Boolean) || row.summary || '',
      phone, email, value,
      status: row.status === 'cancelled' ? 'cancelled' : undefined,
      source: 'google_calendar',
    };
  }

  const appt = normalizeAppointment(flat);
  appt.source = flat.source || 'webhook';

  // A booking with no start time or no reachable address cannot be reminded.
  // Surface it rather than dropping it: silent skips are how a clinic discovers
  // in month three that 200 patients were never in the system.
  if (!appt.id) { rejected.push({ row: flat, reason: 'missing_id' }); continue; }
  if (!appt.startAt) { rejected.push({ row: flat, reason: 'missing_start_time' }); continue; }
  if (!appt.contact.phone && !appt.contact.email) {
    rejected.push({ row: flat, reason: 'no_contact_address' });
    continue;
  }
  appt.value = appt.value ?? config.business.avgAppointmentValue ?? null;
  out.push({ json: { appointment: appt, rejected: false } });
}

for (const r of rejected) out.push({ json: { rejected: true, reason: r.reason, row: r.row } });
return out;`), { pos: [920, 300] });

  w.add('filter', 'Valid Only', {
    conditions: {
      options: { caseSensitive: true, typeValidation: 'loose', version: 2 },
      conditions: [{
        id: 'valid', leftValue: '={{ $json.rejected }}', rightValue: '',
        operator: { type: 'boolean', operation: 'false', singleValue: true },
      }],
      combinator: 'and',
    },
    looseTypeValidation: true,
  }, { pos: [1140, 220] });

  w.add('postgres', 'Upsert Contact', sql(
    `INSERT INTO deskbell.contacts (external_id, first_name, name, phone, whatsapp, email, meta)
VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)
ON CONFLICT (phone) DO UPDATE SET
  first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), deskbell.contacts.first_name),
  name       = COALESCE(NULLIF(EXCLUDED.name, ''), deskbell.contacts.name),
  email      = COALESCE(EXCLUDED.email, deskbell.contacts.email),
  whatsapp   = COALESCE(EXCLUDED.whatsapp, deskbell.contacts.whatsapp),
  updated_at = now()
RETURNING id, phone, opted_out;`,
    '={{ $json.appointment.contact.id }},{{ $json.appointment.contact.firstName }},{{ $json.appointment.contact.name }},{{ $json.appointment.contact.phone }},{{ $json.appointment.contact.whatsapp }},{{ $json.appointment.contact.email }}',
  ), { pos: [1360, 220], ...withPg });

  w.add('postgres', 'Upsert Appointment', sql(
    `INSERT INTO deskbell.appointments
  (external_id, source, contact_id, start_at, end_at, service_name, value, status)
VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::numeric, $8)
ON CONFLICT (external_id) DO UPDATE SET
  start_at     = EXCLUDED.start_at,
  end_at       = EXCLUDED.end_at,
  service_name = EXCLUDED.service_name,
  value        = EXCLUDED.value,
  -- A source-side cancellation always wins. Otherwise keep the state the
  -- engine has built up locally: a customer's "YES" must survive a resync.
  status = CASE WHEN EXCLUDED.status = 'cancelled' THEN 'cancelled'
                ELSE deskbell.appointments.status END,
  -- A moved appointment is a new reminder cycle. Without this reset, a booking
  -- pushed from Tuesday to Friday would never be reminded again.
  sent_stages = CASE WHEN EXCLUDED.start_at <> deskbell.appointments.start_at
                     THEN '{}'::text[] ELSE deskbell.appointments.sent_stages END,
  updated_at = now()
RETURNING id, external_id, start_at, status, (xmax = 0) AS inserted;`,
    '={{ $json.appointment.externalId || $json.appointment.id }},{{ $json.appointment.source }},{{ $("Upsert Contact").item.json.id }},{{ $json.appointment.startAt }},{{ $json.appointment.endAt }},{{ $json.appointment.serviceName }},{{ $json.appointment.value }},{{ $json.appointment.status || "scheduled" }}',
  ), { pos: [1580, 220], ...withPg });

  w.add('code', 'Sync Summary', jsCode(`${HEADER('deskbell/01 — report what the sync did')}
const rows = $input.all().map(i => i.json);
const rejected = $('Normalize Appointments').all().map(i => i.json).filter(r => r.rejected);
const summary = {
  syncedAt: new Date().toISOString(),
  upserted: rows.length,
  created: rows.filter(r => r.inserted).length,
  updated: rows.filter(r => !r.inserted).length,
  rejected: rejected.length,
  rejectionReasons: rejected.reduce((a, r) => ({ ...a, [r.reason]: (a[r.reason] || 0) + 1 }), {}),
};
if (summary.rejected) console.warn('deskbell/01 rejected rows:', JSON.stringify(summary.rejectionReasons));
return [{ json: summary }];`), { pos: [1800, 220] });

  w.add('respond', 'Ack Webhook', {
    respondWith: 'json',
    responseBody: '={{ JSON.stringify({ ok: true, received: $json.upserted ?? 0 }) }}',
  }, { pos: [2020, 400] });

  w.chain('Every 15 Minutes', 'Get Config', 'Fetch Calendar Events', 'Normalize Appointments');
  w.link('Booking Webhook', 'Get Config');
  w.chain('Normalize Appointments', 'Valid Only', 'Upsert Contact', 'Upsert Appointment', 'Sync Summary');
  w.link('Sync Summary', 'Ack Webhook');

  w.note(
    '## 01 — Appointment sync\n\nPulls bookings into `deskbell.appointments` from **either** Google Calendar (polled) **or** any booking system that can POST to the webhook.\n\n**Adding a source** = add a branch into "Normalize Appointments". The engine never changes.\n\nTwo behaviours worth knowing:\n- A cancellation at the source always wins.\n- Moving an appointment **resets its reminder stages**, so the customer is reminded about the new time.',
    [900, -80], [560, 300],
  );
  return w;
});

/* ================================================================== *
 * 02 — Reminder scheduler
 * ================================================================== */

define(() => {
  const w = new Workflow('deskbell/02 Reminder Scheduler', META);

  w.add('schedule', 'Every 15 Minutes', everyMinutes(15), { pos: [260, 300] });
  w.add('execWorkflow', 'Get Config', callWorkflow(WF.config), { pos: [480, 300] });

  w.add('postgres', 'Load Active Appointments', sql(
    `SELECT a.id, a.external_id, a.start_at, a.status, a.confirmed_at, a.value,
       a.voice_attempts, a.sent_stages, a.service_name,
       c.id AS contact_id, c.first_name, c.name, c.phone, c.whatsapp, c.email,
       c.opted_out, c.consent_at, c.marketing_consent, c.last_inbound_at, c.pet_name
FROM deskbell.appointments a
JOIN deskbell.contacts c ON c.id = a.contact_id
WHERE a.start_at > now()
  AND a.start_at < now() + interval '8 days'
  AND a.status NOT IN ('cancelled', 'completed', 'no_show', 'rescheduled')
  AND c.opted_out = false
ORDER BY a.start_at ASC
LIMIT 2000;`,
  ), { pos: [700, 300], ...withPg });

  w.add('code', 'Evaluate Reminder Ladder', jsCode(`${HEADER('deskbell/02 — decide what is due right now')}
const config = $('Get Config').first().json.config;
const now = new Date();
const tasks = [];
const skipped = [];

for (const item of $input.all()) {
  const appt = normalizeAppointment(item.json);
  appt.contact.id = item.json.contact_id;

  for (const decision of evaluateReminders(appt, config, now)) {
    if (!decision.due) { skipped.push({ id: appt.id, stage: decision.stage, reason: decision.reason }); continue; }

    // A deferred send is claimed now but dispatched later; the scheduler tick
    // that fires after sendAt will pick it up. Claiming early would burn the
    // idempotency key before the message exists.
    if (new Date(decision.sendAt) > now) {
      skipped.push({ id: appt.id, stage: decision.stage, reason: 'deferred_until_' + decision.sendAt });
      continue;
    }

    const stageConfig = config.reminders.find(r => r.stage === decision.stage) || {};
    const templateKey = stageConfig.requiresConfirmation ? 'reminder' : 'reminderNoConfirm';

    tasks.push({
      json: {
        kind: 'reminder',
        idempotencyKey: decision.idempotencyKey,
        appointmentId: appt.id,
        contactId: appt.contact.id,
        stage: decision.stage,
        channels: decision.channels,
        templateKey,
        contact: appt.contact,
        vars: {
          firstName: appt.contact.firstName || 'there',
          name: appt.contact.name,
          petName: appt.contact.petName || '',
          serviceName: appt.serviceName,
          businessName: config.business.name,
          bookingUrl: config.business.bookingUrl,
          supportPhone: config.business.supportPhone,
          appointmentDate: new Intl.DateTimeFormat(config.business.locale || 'en', {
            timeZone: config.business.timezone, weekday: 'long', day: 'numeric', month: 'long',
          }).format(new Date(appt.startAt)),
          appointmentTime: new Intl.DateTimeFormat(config.business.locale || 'en', {
            timeZone: config.business.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
          }).format(new Date(appt.startAt)),
        },
      },
    });
  }

  // Separately, decide whether this appointment has earned a voice call.
  const voice = shouldEscalateToVoice(appt, config, now);
  if (voice.escalate) {
    tasks.push({
      json: {
        kind: 'voice_escalation',
        idempotencyKey: idempotencyKey(appt.id, 'voice', String(appt.voiceAttempts + 1)),
        appointmentId: appt.id,
        contactId: appt.contact.id,
        stage: 'voice',
        channels: ['voice'],
        contact: appt.contact,
        vars: { firstName: appt.contact.firstName, serviceName: appt.serviceName, businessName: config.business.name },
      },
    });
  }
}

console.log(\`deskbell/02: \${tasks.length} due, \${skipped.length} skipped\`);
return tasks;`), { pos: [920, 300] });

  w.add('postgres', 'Claim Send Slot', sql(
    `-- The idempotency chokepoint. A UNIQUE index on idempotency_key means a
-- concurrent or repeated run inserts nothing and returns nothing, so the
-- send below simply does not happen twice. This is the whole no-double-text
-- guarantee, enforced by the database rather than by hoping.
INSERT INTO deskbell.message_log
  (idempotency_key, appointment_id, contact_id, stage, kind, direction, status, attempt)
VALUES ($1, $2::bigint, $3::bigint, $4, $5, 'outbound', 'claimed', 1)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id, idempotency_key;`,
    '={{ $json.idempotencyKey }},{{ $json.appointmentId }},{{ $json.contactId }},{{ $json.stage }},{{ $json.kind }}',
  ), { pos: [1140, 300], ...withPg, alwaysOutputData: false });

  w.add('code', 'Attach Claim', jsCode(`${HEADER('deskbell/02 — keep only tasks that won the claim')}
// Rows returned by the claim are the ones this run owns. Anything not returned
// was already claimed by another run and must not be sent again.
const claimed = new Map($input.all().map(i => [i.json.idempotency_key, i.json.id]));
const tasks = $('Evaluate Reminder Ladder').all().map(i => i.json);
const won = tasks.filter(t => claimed.has(t.idempotencyKey));

if (won.length !== tasks.length) {
  console.log(\`deskbell/02: \${tasks.length - won.length} task(s) already claimed elsewhere — not resending\`);
}
return won.map(t => ({ json: { ...t, messageLogId: claimed.get(t.idempotencyKey) } }));`),
    { pos: [1360, 300], alwaysOutputData: true });

  w.add('loop', 'For Each Message', { batchSize: 1, options: { reset: false } }, { pos: [1580, 300] });
  w.add('execWorkflow', 'Send via Dispatcher', callWorkflow(WF.dispatcher), { pos: [1800, 400], continueOnFail: true });

  w.add('code', 'Record Outcome', jsCode(`${HEADER('deskbell/02 — settle the claim and advance state')}
const result = $input.first().json || {};
const task = $('For Each Message').first().json;
return [{
  json: {
    messageLogId: task.messageLogId,
    idempotencyKey: task.idempotencyKey,
    appointmentId: task.appointmentId,
    stage: task.stage,
    kind: task.kind,
    sent: result.sent === true,
    channel: result.channel || null,
    providerMessageId: result.providerMessageId || null,
    body: result.body || null,
    errorMessage: result.error || null,
    cost: result.cost || 0,
  },
}];`), { pos: [2020, 400] });

  w.add('postgres', 'Settle Message Log', sql(
    `UPDATE deskbell.message_log
SET status = CASE WHEN $2::boolean THEN 'sent' ELSE 'failed' END,
    channel = $3, provider_message_id = $4, body = $5, error_message = $6,
    cost = $7::numeric, sent_at = CASE WHEN $2::boolean THEN now() ELSE NULL END,
    settled_at = now()
WHERE id = $1::bigint;`,
    '={{ $json.messageLogId }},{{ $json.sent }},{{ $json.channel }},{{ $json.providerMessageId }},{{ $json.body }},{{ $json.errorMessage }},{{ $json.cost }}',
  ), { pos: [2240, 400], ...withPg });

  w.add('postgres', 'Advance Appointment', sql(
    `-- Only a genuinely sent reminder marks the stage done. A failed send leaves
-- sent_stages untouched so the next tick retries it on the next channel.
UPDATE deskbell.appointments
SET sent_stages = CASE WHEN $2::boolean AND $3 <> 'voice'
                       THEN array_append(sent_stages, $3) ELSE sent_stages END,
    voice_attempts = CASE WHEN $3 = 'voice' THEN voice_attempts + 1 ELSE voice_attempts END,
    status = CASE WHEN $2::boolean AND status = 'scheduled' THEN 'reminded' ELSE status END,
    updated_at = now()
WHERE id = $1::bigint;`,
    '={{ $json.appointmentId }},{{ $json.sent }},{{ $json.stage }}',
  ), { pos: [2460, 400], ...withPg });

  w.add('postgres', 'Log ROI Event', sql(
    `INSERT INTO deskbell.events (type, appointment_id, channel, payload)
VALUES (CASE WHEN $2::boolean THEN 'reminder_sent' ELSE 'reminder_failed' END,
        $1::bigint, $3, $4::jsonb);`,
    '={{ $json.appointmentId }},{{ $json.sent }},{{ $json.channel }},{{ JSON.stringify({ stage: $json.stage, kind: $json.kind }) }}',
  ), { pos: [2680, 400], ...withPg });

  w.add('noOp', 'Done', {}, { pos: [1800, 180] });

  w.chain('Every 15 Minutes', 'Get Config', 'Load Active Appointments', 'Evaluate Reminder Ladder',
    'Claim Send Slot', 'Attach Claim', 'For Each Message');
  w.link('For Each Message', 'Done', 0);            // loop finished
  w.link('For Each Message', 'Send via Dispatcher', 1); // each item
  w.chain('Send via Dispatcher', 'Record Outcome', 'Settle Message Log', 'Advance Appointment', 'Log ROI Event');
  w.link('Log ROI Event', 'For Each Message');      // next item

  w.note(
    '## 02 — Reminder scheduler\n\nRuns every 15 min. For each upcoming appointment it asks `evaluateReminders()` which stages are due, then **claims** each send in Postgres before dispatching it.\n\n### The double-send guarantee\n"Claim Send Slot" does an `INSERT ... ON CONFLICT DO NOTHING`. If this workflow runs twice — manual re-run, overlapping schedule, restart mid-execution — the second insert returns **no rows**, so nothing is sent.\n\nA **failed** send does not mark the stage done, so the next tick retries it on the next channel in the ladder.',
    [900, -140], [620, 380],
  );
  return w;
});

/* ================================================================== *
 * 03 — Message dispatcher (the only place a message leaves the system)
 * ================================================================== */

define(() => {
  const w = new Workflow('deskbell/03 Message Dispatcher', META);

  w.add('execTrigger', 'When Called', {}, { pos: [260, 300] });
  w.add('execWorkflow', 'Get Config', callWorkflow(WF.config), { pos: [480, 300] });

  w.add('code', 'Consent Gate & Plan Attempts', jsCode(`${HEADER('deskbell/03 — the compliance chokepoint every message passes through')}
const config = $('Get Config').first().json.config;
const task = $('When Called').first().json;
const now = new Date();
const contact = task.contact || {};

// ---- 1. Consent. Nothing routes around this node, which is exactly the point.
const gate = consentGate(contact, config, task.kind === 'reminder' ? 'transactional' : (task.kind || 'transactional'));
if (!gate.allowed) {
  return [{ json: { allowed: false, blockedReason: gate.reason, sent: false, idempotencyKey: task.idempotencyKey } }];
}

// ---- 2. Body. Rendered once, reused for every channel attempt so a fallback
// SMS says the same thing the WhatsApp message would have.
const template = config.templates[task.templateKey] || task.body || config.templates.reminder;
const vars = { ...task.vars, businessName: config.business.name, bookingUrl: config.business.bookingUrl,
               supportPhone: config.business.supportPhone, reviewUrl: config.business.reviewUrl };
const rendered = renderTemplate(template, vars);

// ---- 3. Channel ladder. Each rung is a full attempt plan; the loop below tries
// them in order and stops at the first success.
const ladder = [];
const failed = [];
for (let i = 0; i < 4; i++) {
  const pick = pickChannel(task.channels, contact, config, { now, failedChannels: failed, templateApproved: true });
  if (!pick.channel) break;
  ladder.push({
    channel: pick.channel,
    address: pick.address,
    mode: pick.mode,
    body: withOptOutFooter(rendered, config, pick.channel),
    cost: config.channels[pick.channel]?.costPerMessage || 0,
  });
  failed.push(pick.channel);
}

if (!ladder.length) {
  return [{ json: { allowed: false, blockedReason: 'no_channel_available', sent: false, idempotencyKey: task.idempotencyKey } }];
}

return ladder.map((rung, index) => ({
  json: { allowed: true, attemptIndex: index, isLast: index === ladder.length - 1,
          idempotencyKey: task.idempotencyKey, kind: task.kind, ...rung, vars },
}));`), { pos: [700, 300] });

  w.add('if', 'Allowed?', ifBool('={{ $json.allowed }}'), { pos: [920, 300] });
  w.add('loop', 'Try Each Channel', { batchSize: 1, options: { reset: false } }, { pos: [1140, 220] });
  w.add('switch', 'Route Channel', switchOn('={{ $json.channel }}', ['whatsapp', 'sms', 'email', 'voice']), { pos: [1360, 320] });

  w.add('http', 'Send WhatsApp', {
    method: 'POST',
    url: '=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_NUMBER_ID }}/messages',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: $json.address.replace("+",""), type: "text", text: { preview_url: true, body: $json.body } }) }}',
    options: { timeout: 15000, response: { response: { neverError: true, fullResponse: true } } },
  }, { pos: [1580, 120], continueOnFail: true, retryOnFail: true });

  w.add('http', 'Send SMS (Twilio)', {
    method: 'POST',
    url: '=https://api.twilio.com/2010-04-01/Accounts/{{ $env.TWILIO_ACCOUNT_SID }}/Messages.json',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpBasicAuth',
    sendBody: true,
    contentType: 'form-urlencoded',
    bodyParameters: {
      parameters: [
        { name: 'To', value: '={{ $json.address }}' },
        { name: 'From', value: '={{ $env.TWILIO_FROM_NUMBER }}' },
        { name: 'Body', value: '={{ $json.body }}' },
        { name: 'StatusCallback', value: '={{ $env.DESKBELL_BASE_URL }}/webhook/deskbell/message-status' },
      ],
    },
    options: { timeout: 15000, response: { response: { neverError: true, fullResponse: true } } },
  }, { pos: [1580, 260], continueOnFail: true, retryOnFail: true });

  w.add('email', 'Send Email', {
    fromEmail: '={{ $env.DESKBELL_FROM_EMAIL }}',
    toEmail: '={{ $json.address }}',
    subject: '={{ $json.vars.businessName }} — your appointment',
    emailFormat: 'text',
    text: '={{ $json.body }}',
    options: {},
  }, { pos: [1580, 400], continueOnFail: true });

  w.add('execWorkflow', 'Place Voice Call', callWorkflow(WF.voice), { pos: [1580, 540], continueOnFail: true });

  w.add('merge', 'Collect Attempt', { numberInputs: 4 }, { pos: [1800, 320] });

  w.add('code', 'Evaluate Attempt', jsCode(`${HEADER('deskbell/03 — did the attempt actually land?')}
const attempt = $('Try Each Channel').first().json;
const raw = $input.first().json || {};

// Providers disagree about what success looks like. Normalize before deciding,
// and treat "no recognisable success marker" as failure rather than as success.
const status = Number(raw.statusCode ?? raw.status ?? 0);
const payload = raw.body ?? raw;
const providerId =
  payload?.messages?.[0]?.id ||   // WhatsApp Cloud
  payload?.sid ||                 // Twilio
  payload?.messageId ||           // SMTP node
  raw.callId || null;             // VAPI

const twilioFailed = payload?.error_code || ['failed', 'undelivered'].includes(payload?.status);
const httpOk = status === 0 ? Boolean(providerId) : status >= 200 && status < 300;
const sent = Boolean(httpOk && providerId && !twilioFailed);

const errorMessage = sent ? null
  : (payload?.error?.message || payload?.message || raw.error || \`http_\${status || 'unknown'}\`);
const failure = sent ? null : classifyFailure(status, errorMessage);

return [{
  json: {
    ...attempt,
    sent,
    providerMessageId: providerId,
    statusCode: status,
    error: errorMessage,
    retryable: failure ? failure.retryable : false,
    failureCategory: failure ? failure.category : null,
    // Stop the ladder on success, and also on a permanent recipient failure —
    // if the number is not a mobile, the next channel using the same number
    // will fail identically. Burning three attempts to learn that is waste.
    stopLadder: sent || (failure && failure.category === 'permanent_recipient'),
  },
}];`), { pos: [2020, 320] });

  w.add('if', 'Stop Ladder?', ifBool('={{ $json.stopLadder }}'), { pos: [2240, 320] });
  w.add('noOp', 'Attempt Failed — Next Channel', {}, { pos: [2240, 520] });

  w.add('code', 'Return Result', jsCode(`${HEADER('deskbell/03 — single, uniform result for the caller')}
// Reached either by a stopped ladder (success or permanent failure) or by the
// loop running out of channels. Report the best attempt either way.
const attempts = $('Evaluate Attempt').all().map(i => i.json);
const success = attempts.find(a => a.sent);
const last = attempts[attempts.length - 1] || {};

return [{
  json: {
    sent: Boolean(success),
    channel: (success || last).channel || null,
    providerMessageId: (success || last).providerMessageId || null,
    body: (success || last).body || null,
    cost: success ? (success.cost || 0) : 0,
    attempts: attempts.length,
    channelsTried: attempts.map(a => a.channel),
    error: success ? null : (last.error || 'all_channels_failed'),
    failureCategory: success ? null : (last.failureCategory || null),
    idempotencyKey: (success || last).idempotencyKey || null,
  },
}];`), { pos: [2460, 220] });

  w.add('code', 'Return Blocked', jsCode(`${HEADER('deskbell/03 — blocked before any provider was contacted')}
const b = $input.first().json;
console.log('deskbell/03 blocked:', b.blockedReason);
return [{ json: { sent: false, blocked: true, error: b.blockedReason, channel: null,
                  attempts: 0, cost: 0, idempotencyKey: b.idempotencyKey || null } }];`),
    { pos: [1140, 520] });

  w.chain('When Called', 'Get Config', 'Consent Gate & Plan Attempts', 'Allowed?');
  w.link('Allowed?', 'Try Each Channel', 0);
  w.link('Allowed?', 'Return Blocked', 1);
  w.link('Try Each Channel', 'Return Result', 0);  // ladder exhausted
  w.link('Try Each Channel', 'Route Channel', 1);  // next rung
  w.link('Route Channel', 'Send WhatsApp', 0);
  w.link('Route Channel', 'Send SMS (Twilio)', 1);
  w.link('Route Channel', 'Send Email', 2);
  w.link('Route Channel', 'Place Voice Call', 3);
  w.link('Send WhatsApp', 'Collect Attempt', 0);
  w.link('Send SMS (Twilio)', 'Collect Attempt', 0);
  w.link('Send Email', 'Collect Attempt', 0);
  w.link('Place Voice Call', 'Collect Attempt', 0);
  w.chain('Collect Attempt', 'Evaluate Attempt', 'Stop Ladder?');
  w.link('Stop Ladder?', 'Return Result', 0);
  w.link('Stop Ladder?', 'Attempt Failed — Next Channel', 1);
  w.link('Attempt Failed — Next Channel', 'Try Each Channel');

  w.note(
    '## 03 — Message dispatcher\n\n**Every outbound message in deskbell goes through this workflow.** That is deliberate: the consent gate, the opt-out footer and the quiet-hours-aware channel choice live here, so no other workflow can accidentally route around them.\n\n### Fallback ladder\n"Consent Gate & Plan Attempts" builds an ordered list of viable channels. The loop tries them in order and stops at the first success — or at a permanent recipient failure, because a bad number will fail the same way on the next channel.\n\n### WhatsApp 24-hour rule\n`pickChannel()` will not send free-form WhatsApp outside the customer\'s 24h session window; it downgrades to template mode or falls through to SMS.',
    [640, -180], [640, 420],
  );
  return w;
});

/* ================================================================== *
 * 04 — Inbound handler
 * ================================================================== */

define(() => {
  const w = new Workflow('deskbell/04 Inbound Handler', META);

  w.add('webhook', 'Inbound Message', webhookIn('deskbell/inbound'), { pos: [260, 300], webhookId: true });
  w.add('respond', 'Ack Provider', { respondWith: 'text', responseBody: 'OK', options: {} }, { pos: [480, 160] });
  w.add('execWorkflow', 'Get Config', callWorkflow(WF.config), { pos: [480, 380] });

  w.add('code', 'Normalize Inbound', jsCode(`${HEADER('deskbell/04 — one shape from every messaging provider')}
const raw = $('Inbound Message').first().json;
const body = raw.body || raw;

let from = null, text = null, channel = null, providerMessageId = null;

// Twilio posts form-encoded fields.
if (body.From && body.Body !== undefined) {
  from = String(body.From).replace('whatsapp:', '');
  text = body.Body;
  channel = String(body.From).startsWith('whatsapp:') ? 'whatsapp' : 'sms';
  providerMessageId = body.MessageSid || body.SmsMessageSid || null;
}

// WhatsApp Cloud API posts a nested change feed.
const change = body.entry?.[0]?.changes?.[0]?.value;
if (change?.messages?.length) {
  const m = change.messages[0];
  from = '+' + String(m.from).replace(/\\D/g, '');
  text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? '';
  channel = 'whatsapp';
  providerMessageId = m.id;
}

// Delivery-status callbacks are not customer replies. Acknowledge and stop.
if (!text && (body.MessageStatus || change?.statuses)) {
  return [{ json: { skip: true, reason: 'status_callback' } }];
}
if (!from || text == null) {
  return [{ json: { skip: true, reason: 'unrecognized_payload' } }];
}

return [{ json: { skip: false, from: normalizePhone(from), text: String(text).trim(), channel, providerMessageId } }];`),
    { pos: [700, 380] });

  w.add('if', 'Is A Reply?', ifBool('={{ !$json.skip }}'), { pos: [920, 380] });
  w.add('noOp', 'Ignore', {}, { pos: [1140, 560] });

  w.add('postgres', 'Find Contact & Appointment', sql(
    `SELECT c.id AS contact_id, c.first_name, c.name, c.phone, c.whatsapp, c.email,
       c.opted_out, c.consent_at, c.marketing_consent,
       a.id AS appointment_id, a.status, a.start_at, a.service_name, a.value
FROM deskbell.contacts c
LEFT JOIN LATERAL (
  -- The appointment a reply is "about" is the next upcoming one; if none is
  -- upcoming, the one that just happened (so post-visit ratings still attach).
  SELECT * FROM deskbell.appointments
  WHERE contact_id = c.id AND status NOT IN ('cancelled', 'rescheduled')
  ORDER BY (start_at > now()) DESC, abs(extract(epoch FROM (start_at - now()))) ASC
  LIMIT 1
) a ON true
WHERE c.phone = $1 OR c.whatsapp = $1
LIMIT 1;`,
    '={{ $json.from }}',
  ), { pos: [1140, 380], ...withPg, alwaysOutputData: true });

  w.add('code', 'Classify Intent', jsCode(`${HEADER('deskbell/04 — what did the customer actually mean?')}
const config = $('Get Config').first().json.config;
const inbound = $('Normalize Inbound').first().json;
const match = $input.first().json || {};

const result = classifyIntent(inbound.text, config);
const threshold = config.ai?.escalateBelowConfidence ?? 0.7;

return [{
  json: {
    ...inbound,
    contactId: match.contact_id || null,
    appointmentId: match.appointment_id || null,
    currentStatus: match.status || null,
    known: Boolean(match.contact_id),
    intent: result.intent,
    confidence: result.confidence,
    rating: result.rating ?? null,
    matched: result.matched,
    // Regex is deliberately conservative. Anything it is unsure about goes to
    // AI (if enabled) or to a human — never to a guess that cancels someone's
    // appointment.
    needsAI: result.intent === 'unknown' || result.confidence < threshold,
    aiEnabled: Boolean(config.ai?.enabled),
    vars: {
      firstName: match.first_name || 'there',
      businessName: config.business.name,
      bookingUrl: config.business.bookingUrl,
      reviewUrl: config.business.reviewUrl,
      supportPhone: config.business.supportPhone,
      serviceName: match.service_name || 'appointment',
    },
  },
}];`), { pos: [1360, 380] });

  w.add('postgres', 'Log Inbound', sql(
    `INSERT INTO deskbell.inbound_messages
  (contact_id, channel, from_address, body, intent, confidence, provider_message_id)
VALUES ($1::bigint, $2, $3, $4, $5, $6::numeric, $7);
UPDATE deskbell.contacts SET last_inbound_at = now() WHERE id = $1::bigint;`,
    '={{ $json.contactId }},{{ $json.channel }},{{ $json.from }},{{ $json.text }},{{ $json.intent }},{{ $json.confidence }},{{ $json.providerMessageId }}',
  ), { pos: [1580, 380], ...withPg, continueOnFail: true });

  w.add('if', 'Needs AI?', ifBool('={{ $json.needsAI && $json.aiEnabled }}'), { pos: [1800, 380] });

  w.add('http', 'Classify with Claude', {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'x-api-key', value: '={{ $env.ANTHROPIC_API_KEY }}' },
        { name: 'anthropic-version', value: '2023-06-01' },
        { name: 'content-type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    // output_config.format guarantees the first text block is valid JSON, so no
    // prompt-level "reply only with JSON" pleading and no parsing fallbacks.
    jsonBody: `={{ JSON.stringify({
  model: "claude-opus-5",
  max_tokens: 1024,
  output_config: {
    effort: "low",
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          intent: { type: "string", enum: ["confirm","cancel","reschedule","question","complaint","other"] },
          confidence: { type: "number" },
          needs_human: { type: "boolean" },
          suggested_reply: { type: "string" },
          summary: { type: "string" }
        },
        required: ["intent","confidence","needs_human","suggested_reply","summary"],
        additionalProperties: false
      }
    }
  },
  system: "You classify replies to appointment reminders for " + $json.vars.businessName + ". Decide what the customer wants. Set needs_human to true for anything involving a complaint, a medical or clinical question, a payment dispute, or anything you are not confident about — a wrong cancellation is far more costly than an unnecessary handover. suggested_reply must be one or two short sentences a receptionist could send unedited, and must never promise a specific appointment time.",
  messages: [{ role: "user", content: "Customer message: " + JSON.stringify($json.text) }]
}) }}`,
    options: { timeout: 30000, response: { response: { neverError: true, fullResponse: true } } },
  }, { pos: [2020, 260], continueOnFail: true, retryOnFail: true, maxTries: 2 });

  w.add('code', 'Merge AI Verdict', jsCode(`${HEADER('deskbell/04 — fold the AI verdict back in, safely')}
const base = $('Classify Intent').first().json;
const raw = $input.first().json || {};

let ai = null;
try {
  const payload = raw.body ?? raw;
  const textBlock = (payload.content || []).find(b => b.type === 'text');
  if (textBlock) ai = JSON.parse(textBlock.text);
} catch (e) {
  console.warn('deskbell/04: could not parse AI response —', e.message);
}

// If the AI call failed or came back unusable, hand to a human. Never fall back
// to acting on a low-confidence regex guess.
if (!ai) return [{ json: { ...base, intent: 'unknown', needsHuman: true, aiError: true } }];

const actionable = ['confirm', 'cancel', 'reschedule'];
const trust = ai.confidence >= 0.8 && !ai.needs_human && actionable.includes(ai.intent);

return [{
  json: {
    ...base,
    intent: trust ? ai.intent : 'unknown',
    confidence: ai.confidence,
    needsHuman: !trust,
    aiSummary: ai.summary,
    aiSuggestedReply: ai.suggested_reply,
  },
}];`), { pos: [2240, 260] });

  w.add('switch', 'Route Intent',
    switchOn('={{ $json.intent }}', ['stop', 'start', 'help', 'confirm', 'cancel', 'reschedule', 'rating']),
    { pos: [2460, 380] });

  // --- terminal branches
  w.add('postgres', 'Opt Out Contact', sql(
    `UPDATE deskbell.contacts SET opted_out = true, opted_out_at = now(), updated_at = now()
WHERE id = $1::bigint;
INSERT INTO deskbell.events (type, contact_id, payload) VALUES ('opted_out', $1::bigint, '{}'::jsonb);`,
    '={{ $json.contactId }}',
  ), { pos: [2680, 60], ...withPg });

  w.add('postgres', 'Opt In Contact', sql(
    `UPDATE deskbell.contacts SET opted_out = false, opted_out_at = NULL, consent_at = COALESCE(consent_at, now()),
   updated_at = now() WHERE id = $1::bigint;`,
    '={{ $json.contactId }}',
  ), { pos: [2680, 160], ...withPg });

  w.add('code', 'Apply State Change', jsCode(`${HEADER('deskbell/04 — drive the appointment state machine')}
const item = $input.first().json;
const config = $('Get Config').first().json.config;

const event = INTENT_TO_EVENT[item.intent];
const transition = nextState(item.currentStatus || 'scheduled', event);

// An invalid transition is normal traffic, not an error: people reply "yes" to
// reminders for appointments that already happened.
if (!transition.changed) {
  console.log('deskbell/04 ignoring reply:', transition.reason);
}

const replyKey = { confirm: 'confirmed', cancel: 'cancelled', reschedule: 'reschedulePrompt' }[item.intent];

return [{
  json: {
    ...item,
    newStatus: transition.state,
    changed: transition.changed,
    transitionReason: transition.reason,
    freedSlot: item.intent === 'cancel' && transition.changed,
    reply: {
      kind: 'transactional',
      idempotencyKey: idempotencyKey(item.appointmentId || item.from, 'reply-' + item.intent, item.providerMessageId),
      appointmentId: item.appointmentId,
      contactId: item.contactId,
      stage: 'reply-' + item.intent,
      channels: [item.channel],
      templateKey: replyKey,
      contact: { phone: item.from, whatsapp: item.from, firstName: item.vars.firstName,
                 lastInboundAt: new Date().toISOString(), consentAt: new Date().toISOString(),
                 marketingConsent: true, optedOut: false },
      vars: item.vars,
    },
  },
}];`), { pos: [2680, 300] });

  w.add('postgres', 'Persist New State', sql(
    `UPDATE deskbell.appointments
SET status = $2,
    confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() ELSE confirmed_at END,
    updated_at = now()
WHERE id = $1::bigint AND $3::boolean;
INSERT INTO deskbell.events (type, appointment_id, contact_id, payload)
SELECT CASE WHEN $2 = 'confirmed' THEN 'confirmed_after_reminder' ELSE 'cancelled_early' END,
       $1::bigint, $4::bigint, jsonb_build_object('intent', $5)
WHERE $3::boolean AND $2 IN ('confirmed','cancelled');`,
    '={{ $json.appointmentId }},{{ $json.newStatus }},{{ $json.changed }},{{ $json.contactId }},{{ $json.intent }}',
  ), { pos: [2900, 300], ...withPg });

  w.add('code', 'Build Reply Task', jsCode(`${HEADER('deskbell/04 — hand the acknowledgement to the dispatcher')}
return [{ json: $('Apply State Change').first().json.reply }];`), { pos: [3120, 300] });

  w.add('execWorkflow', 'Send Reply', callWorkflow(WF.dispatcher), { pos: [3340, 300], continueOnFail: true });

  w.add('if', 'Slot Freed?', ifBool('={{ $("Apply State Change").first().json.freedSlot }}'), { pos: [3560, 300] });
  w.add('execWorkflow', 'Offer To Waitlist', callWorkflow(WF.waitlist), { pos: [3780, 220], continueOnFail: true });

  w.add('code', 'Handle Rating', jsCode(`${HEADER('deskbell/04 — route a rating to public review or private feedback')}
const item = $input.first().json;
const config = $('Get Config').first().json.config;
const threshold = config.followUp?.publicReviewThreshold ?? 4;
const happy = Number(item.rating) >= threshold;

// Unhappy customers are never pushed to a public review page; their feedback
// goes straight to the owner. Some jurisdictions and platforms prohibit
// review-gating outright — check docs/compliance.md before enabling this.
return [{
  json: {
    kind: 'transactional',
    idempotencyKey: idempotencyKey(item.appointmentId || item.from, 'rating-reply', String(item.rating)),
    appointmentId: item.appointmentId,
    contactId: item.contactId,
    stage: 'rating-reply',
    channels: [item.channel],
    templateKey: happy ? 'reviewRequest' : 'privateFeedback',
    escalateToOwner: !happy,
    rating: item.rating,
    contact: { phone: item.from, whatsapp: item.from, firstName: item.vars.firstName,
               lastInboundAt: new Date().toISOString(), consentAt: new Date().toISOString(),
               marketingConsent: true, optedOut: false },
    vars: item.vars,
  },
}];`), { pos: [2680, 440] });

  w.add('postgres', 'Store Rating', sql(
    `UPDATE deskbell.appointments SET rating = $2::int, updated_at = now() WHERE id = $1::bigint;
INSERT INTO deskbell.events (type, appointment_id, payload)
VALUES ('rating_received', $1::bigint, jsonb_build_object('rating', $2::int));`,
    '={{ $json.appointmentId }},{{ $json.rating }}',
  ), { pos: [2900, 440], ...withPg, continueOnFail: true });

  w.add('code', 'Build Help Reply', jsCode(`${HEADER('deskbell/04 — HELP is a carrier obligation, answer it properly')}
const item = $input.first().json;
return [{ json: {
  kind: 'transactional',
  idempotencyKey: idempotencyKey(item.from, 'help', item.providerMessageId),
  contactId: item.contactId,
  stage: 'help',
  channels: [item.channel],
  templateKey: 'helpReply',
  contact: { phone: item.from, whatsapp: item.from, lastInboundAt: new Date().toISOString(),
             consentAt: new Date().toISOString(), optedOut: false },
  vars: item.vars,
} }];`), { pos: [2680, 540] });

  w.add('code', 'Escalate To Human', jsCode(`${HEADER('deskbell/04 — anything unclear becomes a human task, not a guess')}
const item = $input.first().json;
return [{ json: {
  needsHuman: true,
  from: item.from,
  channel: item.channel,
  text: item.text,
  contactId: item.contactId,
  appointmentId: item.appointmentId,
  aiSummary: item.aiSummary || null,
  suggestedReply: item.aiSuggestedReply || null,
  receivedAt: new Date().toISOString(),
} }];`), { pos: [2680, 660] });

  w.add('postgres', 'Queue For Staff', sql(
    `INSERT INTO deskbell.human_tasks (contact_id, appointment_id, channel, from_address, body, ai_summary, suggested_reply)
VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6, $7);`,
    '={{ $json.contactId }},{{ $json.appointmentId }},{{ $json.channel }},{{ $json.from }},{{ $json.text }},{{ $json.aiSummary }},{{ $json.suggestedReply }}',
  ), { pos: [2900, 660], ...withPg });

  w.add('execWorkflow', 'Send Simple Reply', callWorkflow(WF.dispatcher), { pos: [3120, 500], continueOnFail: true });
  w.add('noOp', 'Complete', {}, { pos: [4000, 300] });

  w.link('Inbound Message', 'Ack Provider');
  w.link('Inbound Message', 'Get Config');
  w.chain('Get Config', 'Normalize Inbound', 'Is A Reply?');
  w.link('Is A Reply?', 'Find Contact & Appointment', 0);
  w.link('Is A Reply?', 'Ignore', 1);
  w.chain('Find Contact & Appointment', 'Classify Intent', 'Log Inbound', 'Needs AI?');
  w.link('Needs AI?', 'Classify with Claude', 0);
  w.link('Needs AI?', 'Route Intent', 1);
  w.chain('Classify with Claude', 'Merge AI Verdict', 'Route Intent');
  w.link('Route Intent', 'Opt Out Contact', 0);
  w.link('Route Intent', 'Opt In Contact', 1);
  w.link('Route Intent', 'Build Help Reply', 2);
  w.link('Route Intent', 'Apply State Change', 3);
  w.link('Route Intent', 'Apply State Change', 4);
  w.link('Route Intent', 'Apply State Change', 5);
  w.link('Route Intent', 'Handle Rating', 6);
  w.link('Route Intent', 'Escalate To Human', 7); // fallback output
  w.chain('Apply State Change', 'Persist New State', 'Build Reply Task', 'Send Reply', 'Slot Freed?');
  w.link('Slot Freed?', 'Offer To Waitlist', 0);
  w.link('Slot Freed?', 'Complete', 1);
  w.link('Offer To Waitlist', 'Complete');
  w.chain('Handle Rating', 'Store Rating', 'Send Simple Reply');
  w.link('Build Help Reply', 'Send Simple Reply');
  w.chain('Escalate To Human', 'Queue For Staff');
  w.link('Send Simple Reply', 'Complete');
  w.link('Queue For Staff', 'Complete');
  w.link('Opt Out Contact', 'Complete');
  w.link('Opt In Contact', 'Complete');

  w.note(
    '## 04 — Inbound handler\n\nOne webhook for Twilio **and** WhatsApp Cloud. Point both providers here.\n\n### Order matters\nSTOP / START / HELP are matched **before** anything else and are absolute — "yes I\'ll be there but STOP texting me" opts the customer out.\n\n### Regex first, AI second\n`classifyIntent()` handles the ~95% of replies that are "yes", "no" or "cancel" at zero cost. Only genuinely ambiguous text reaches Claude, and only if `ai.enabled` is on.\n\nIf the AI is unavailable or unsure, the message becomes a **human task**. deskbell never guesses at a cancellation.',
    [2400, -220], [640, 460],
  );
  return w;
});

/* ================================================================== *
 * 05 — Missed call recovery
 * ================================================================== */

define(() => {
  const w = new Workflow('deskbell/05 Missed Call Recovery', META);

  w.add('webhook', 'Twilio Call Status', webhookIn('deskbell/call-status'), { pos: [260, 300], webhookId: true });
  w.add('respond', 'Ack Twilio', { respondWith: 'text', responseBody: 'OK', options: {} }, { pos: [480, 160] });
  w.add('execWorkflow', 'Get Config', callWorkflow(WF.config), { pos: [480, 380] });

  w.add('code', 'Detect Missed Call', jsCode(`${HEADER('deskbell/05 — was this a call we actually lost?')}
const config = $('Get Config').first().json.config;
const body = $('Twilio Call Status').first().json.body || $('Twilio Call Status').first().json;

const status = String(body.CallStatus || body.DialCallStatus || '').toLowerCase();
const direction = String(body.Direction || 'inbound').toLowerCase();
const from = normalizePhone(body.From);
const duration = Number(body.CallDuration || body.DialCallDuration || 0);

// Only inbound calls that nobody answered count. An outbound call we placed,
// or an answered call, is not a lost customer.
const missedStatuses = ['no-answer', 'busy', 'failed', 'canceled'];
const missed = direction.startsWith('inbound') && (missedStatuses.includes(status) ||
  (status === 'completed' && duration < (config.missedCall?.minAnsweredSeconds ?? 5)));

if (!missed || !from) {
  return [{ json: { act: false, reason: missed ? 'no_caller_id' : \`status_\${status || 'unknown'}\` } }];
}

// Business hours drive the copy: promising a call back "first thing" at 2pm on
// a Tuesday reads as incompetence.
const tz = config.business.timezone;
const parts = zonedParts(new Date(), tz);
const openMin = parseHHMM(config.business.openTime || '09:00');
const closeMin = parseHHMM(config.business.closeTime || '18:00');
const weekend = ['Sat', 'Sun'].includes(parts.weekday);
const open = !weekend && parts.minutesOfDay >= openMin && parts.minutesOfDay < closeMin;

return [{
  json: {
    act: true,
    from,
    callSid: body.CallSid,
    status,
    duringBusinessHours: open,
    templateKey: open ? 'missedCall' : 'missedCallAfterHours',
    delaySeconds: config.missedCall?.replyDelaySeconds ?? 15,
  },
}];`), { pos: [700, 380] });

  w.add('if', 'Missed?', ifBool('={{ $json.act }}'), { pos: [920, 380] });
  w.add('noOp', 'Not A Missed Call', {}, { pos: [1140, 540] });

  w.add('postgres', 'Upsert Caller & Lead', sql(
    `WITH c AS (
  INSERT INTO deskbell.contacts (phone, whatsapp, first_name, consent_at)
  VALUES ($1, $1, '', now())
  ON CONFLICT (phone) DO UPDATE SET last_inbound_at = now(), updated_at = now()
  RETURNING id, opted_out
), l AS (
  -- One lead per caller per hour. Someone redialling four times is one lost
  -- customer, not four, and must not receive four text-backs.
  INSERT INTO deskbell.leads (contact_id, source, phone, status, first_contact_at, call_sid)
  SELECT c.id, 'missed_call', $1, 'new', now(), $2 FROM c
  WHERE NOT EXISTS (
    SELECT 1 FROM deskbell.leads
    WHERE phone = $1 AND first_contact_at > now() - interval '1 hour'
  )
  RETURNING id
)
SELECT c.id AS contact_id, c.opted_out, (SELECT id FROM l) AS lead_id FROM c;`,
    '={{ $json.from }},{{ $json.callSid }}',
  ), { pos: [1140, 380], ...withPg });

  w.add('code', 'Build Text Back', jsCode(`${HEADER('deskbell/05 — speed is the entire product here')}
const config = $('Get Config').first().json.config;
const call = $('Detect Missed Call').first().json;
const row = $input.first().json;

// No lead row means we already texted this caller within the hour.
if (!row.lead_id) return [{ json: { skip: true, reason: 'duplicate_within_hour' } }];
if (row.opted_out) return [{ json: { skip: true, reason: 'opted_out' } }];

return [{
  json: {
    skip: false,
    kind: 'transactional',
    idempotencyKey: idempotencyKey('lead_' + row.lead_id, 'missed-call'),
    contactId: row.contact_id,
    leadId: row.lead_id,
    stage: 'missed-call',
    channels: config.missedCall?.channels || ['sms'],
    templateKey: call.templateKey,
    contact: {
      phone: call.from, whatsapp: call.from, firstName: '',
      // The caller just rang us, which opens the WhatsApp 24h window.
      lastInboundAt: new Date().toISOString(),
      consentAt: new Date().toISOString(), marketingConsent: false, optedOut: false,
    },
    vars: {
      businessName: config.business.name,
      bookingUrl: config.business.bookingUrl,
      supportPhone: config.business.supportPhone,
    },
  },
}];`), { pos: [1360, 380] });

  w.add('if', 'Should Text Back?', ifBool('={{ !$json.skip }}'), { pos: [1580, 380] });
  w.add('noOp', 'Already Handled', {}, { pos: [1800, 540] });
  w.add('execWorkflow', 'Send Text Back', callWorkflow(WF.dispatcher), { pos: [1800, 380], continueOnFail: true });

  w.add('postgres', 'Record Recovery', sql(
    `UPDATE deskbell.leads SET status = CASE WHEN $2::boolean THEN 'contacted' ELSE 'contact_failed' END,
   contacted_at = now() WHERE id = $1::bigint;
INSERT INTO deskbell.events (type, contact_id, channel, payload)
VALUES ('missed_call_texted', $3::bigint, $4, jsonb_build_object('leadId', $1::bigint, 'sent', $2::boolean));`,
    '={{ $("Build Text Back").first().json.leadId }},{{ $json.sent }},{{ $("Build Text Back").first().json.contactId }},{{ $json.channel }}',
  ), { pos: [2020, 380], ...withPg });

  w.link('Twilio Call Status', 'Ack Twilio');
  w.link('Twilio Call Status', 'Get Config');
  w.chain('Get Config', 'Detect Missed Call', 'Missed?');
  w.link('Missed?', 'Upsert Caller & Lead', 0);
  w.link('Missed?', 'Not A Missed Call', 1);
  w.chain('Upsert Caller & Lead', 'Build Text Back', 'Should Text Back?');
  w.link('Should Text Back?', 'Send Text Back', 0);
  w.link('Should Text Back?', 'Already Handled', 1);
  w.link('Send Text Back', 'Record Recovery');

  w.note(
    '## 05 — Missed call recovery\n\nPoint your Twilio number\'s **status callback** at `/webhook/deskbell/call-status`.\n\n78% of customers buy from whoever replies first, so this path is deliberately short: detect, dedupe, text back. Commercial tools charge $40–300/month for exactly this.\n\n**Dedupe:** one lead per caller per hour. A customer redialling four times is one lost customer, not four text messages.\n\n**After-hours copy differs** — see `missedCallAfterHours` in the config templates.',
    [640, -180], [560, 340],
  );
  return w;
});

/* ================================================================== *
 * 06 — VAPI voice agent
 * ================================================================== */

define(() => {
  const w = new Workflow('deskbell/06 Voice Agent (VAPI)', META);

  w.add('execTrigger', 'Place Call', {}, { pos: [260, 200] });
  w.add('execWorkflow', 'Get Config', callWorkflow(WF.config), { pos: [480, 200] });

  w.add('code', 'Build Call Request', jsCode(`${HEADER('deskbell/06 — brief the voice agent')}
const config = $('Get Config').first().json.config;
const task = $('Place Call').first().json;
const v = task.vars || {};

// The assistant is given one job and an explicit escape hatch. Voice agents that
// are told to "help with anything" invent availability and book ghost slots.
const prompt = [
  \`You are calling on behalf of \${config.business.name}.\`,
  \`You are speaking to \${v.firstName || 'the customer'} about their \${v.serviceName || 'appointment'}\`,
  \`on \${v.appointmentDate || 'the scheduled date'} at \${v.appointmentTime || 'the scheduled time'}.\`,
  'Your only goal is to find out whether they are still coming.',
  'Ask once, clearly. Accept their answer and end the call politely.',
  'Do NOT offer alternative times, quote prices, or give any clinical, legal or financial advice.',
  \`If they want to change the appointment, tell them to visit \${config.business.bookingUrl} or call \${config.business.supportPhone}, then end the call.\`,
  'If they sound distressed or ask for a person, apologise and say someone will call them back.',
  'Keep the whole call under 60 seconds.',
].join(' ');

return [{
  json: {
    phoneNumber: task.contact?.phone,
    appointmentId: task.appointmentId,
    idempotencyKey: task.idempotencyKey,
    payload: {
      assistantId: null, // set VAPI_ASSISTANT_ID to use a pre-built assistant
      phoneNumberId: null,
      customer: { number: task.contact?.phone },
      assistantOverrides: {
        firstMessage: \`Hello, this is an automated reminder from \${config.business.name}. Is now a good time?\`,
        model: { provider: 'anthropic', model: 'claude-opus-5', messages: [{ role: 'system', content: prompt }] },
        analysisPlan: {
          structuredDataSchema: {
            type: 'object',
            properties: {
              outcome: { type: 'string', enum: ['confirmed', 'cancelled', 'reschedule_requested', 'no_answer', 'unclear'] },
              customer_spoke: { type: 'boolean' },
              wants_human_callback: { type: 'boolean' },
              notes: { type: 'string' },
            },
            required: ['outcome', 'customer_spoke', 'wants_human_callback', 'notes'],
          },
        },
      },
      metadata: { deskbellAppointmentId: task.appointmentId, deskbellIdempotencyKey: task.idempotencyKey },
    },
  },
}];`), { pos: [700, 200] });

  w.add('http', 'VAPI Create Call', {
    method: 'POST',
    url: 'https://api.vapi.ai/call',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Authorization', value: '=Bearer {{ $env.VAPI_API_KEY }}' },
        { name: 'content-type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify(Object.assign({}, $json.payload, { assistantId: $env.VAPI_ASSISTANT_ID || $json.payload.assistantId, phoneNumberId: $env.VAPI_PHONE_NUMBER_ID || $json.payload.phoneNumberId })) }}',
    options: { timeout: 20000, response: { response: { neverError: true, fullResponse: true } } },
  }, { pos: [920, 200], continueOnFail: true, retryOnFail: true, maxTries: 2 });

  w.add('code', 'Return Call Result', jsCode(`${HEADER('deskbell/06 — uniform result for the dispatcher')}
const raw = $input.first().json || {};
const status = Number(raw.statusCode ?? 0);
const payload = raw.body ?? raw;
const ok = status >= 200 && status < 300 && payload?.id;
return [{ json: {
  sent: Boolean(ok),
  channel: 'voice',
  providerMessageId: payload?.id || null,
  callId: payload?.id || null,
  error: ok ? null : (payload?.message || \`http_\${status}\`),
  cost: 0, // settled by the post-call webhook, which knows the real duration
} }];`), { pos: [1140, 200] });

  // --- post-call webhook
  w.add('webhook', 'VAPI Post-Call', webhookIn('deskbell/vapi'), { pos: [260, 560], webhookId: true });
  w.add('respond', 'Ack VAPI', { respondWith: 'text', responseBody: 'OK', options: {} }, { pos: [480, 700] });

  w.add('code', 'Parse Call Report', jsCode(`${HEADER('deskbell/06 — turn the call report into a state change')}
const body = $('VAPI Post-Call').first().json.body || $('VAPI Post-Call').first().json;
const msg = body.message || body;

if (msg.type !== 'end-of-call-report') {
  return [{ json: { act: false, reason: 'not_end_of_call:' + (msg.type || 'unknown') } }];
}

const call = msg.call || {};
const analysis = msg.analysis || {};
const data = analysis.structuredData || {};
const appointmentId = call.metadata?.deskbellAppointmentId || null;

const map = { confirmed: 'reply_confirm', cancelled: 'reply_cancel', reschedule_requested: 'reply_reschedule' };
const event = map[data.outcome] || null;

return [{
  json: {
    act: Boolean(appointmentId),
    appointmentId,
    callId: call.id || null,
    outcome: data.outcome || 'unclear',
    event,
    customerSpoke: data.customer_spoke === true,
    wantsHuman: data.wants_human_callback === true,
    notes: data.notes || '',
    summary: analysis.summary || '',
    transcript: msg.transcript || '',
    durationSeconds: Math.round(Number(msg.durationSeconds || call.duration || 0)),
    cost: Number(msg.cost || 0),
  },
}];`), { pos: [700, 560] });

  w.add('if', 'Actionable Call?', ifBool('={{ $json.act }}'), { pos: [920, 560] });
  w.add('noOp', 'Ignore Event', {}, { pos: [1140, 720] });

  w.add('postgres', 'Log Call', sql(
    `INSERT INTO deskbell.call_logs
  (appointment_id, provider_call_id, outcome, customer_spoke, wants_human, notes, summary, transcript, duration_seconds, cost)
VALUES ($1::bigint, $2, $3, $4::boolean, $5::boolean, $6, $7, $8, $9::int, $10::numeric)
ON CONFLICT (provider_call_id) DO NOTHING;`,
    '={{ $json.appointmentId }},{{ $json.callId }},{{ $json.outcome }},{{ $json.customerSpoke }},{{ $json.wantsHuman }},{{ $json.notes }},{{ $json.summary }},{{ $json.transcript }},{{ $json.durationSeconds }},{{ $json.cost }}',
  ), { pos: [1140, 560], ...withPg });

  w.add('postgres', 'Load Appointment State', sql(
    `SELECT id, status FROM deskbell.appointments WHERE id = $1::bigint;`,
    '={{ $("Parse Call Report").first().json.appointmentId }}',
  ), { pos: [1360, 560], ...withPg, alwaysOutputData: true });

  w.add('code', 'Apply Call Outcome', jsCode(`${HEADER('deskbell/06 — same state machine as text replies')}
const call = $('Parse Call Report').first().json;
const current = $input.first().json?.status || 'scheduled';

if (!call.event) {
  return [{ json: { ...call, changed: false, newStatus: current, reason: 'no_actionable_outcome' } }];
}
const t = nextState(current, call.event);
return [{ json: { ...call, changed: t.changed, newStatus: t.state, reason: t.reason } }];`), { pos: [1580, 560] });

  w.add('postgres', 'Persist Call Outcome', sql(
    `UPDATE deskbell.appointments
SET status = $2, confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() ELSE confirmed_at END, updated_at = now()
WHERE id = $1::bigint AND $3::boolean;
INSERT INTO deskbell.events (type, appointment_id, channel, payload)
VALUES (CASE WHEN $2 = 'confirmed' THEN 'confirmed_after_reminder' ELSE 'voice_call_completed' END,
        $1::bigint, 'voice', jsonb_build_object('outcome', $4, 'cost', $5::numeric));`,
    '={{ $json.appointmentId }},{{ $json.newStatus }},{{ $json.changed }},{{ $json.outcome }},{{ $json.cost }}',
  ), { pos: [1800, 560], ...withPg });

  w.add('if', 'Wants A Human?', ifBool('={{ $json.wantsHuman }}'), { pos: [2020, 560] });
  w.add('postgres', 'Queue Callback', sql(
    `INSERT INTO deskbell.human_tasks (appointment_id, channel, from_address, body, ai_summary)
SELECT $1::bigint, 'voice', c.phone, $2, $3
FROM deskbell.appointments a JOIN deskbell.contacts c ON c.id = a.contact_id
WHERE a.id = $1::bigint;`,
    '={{ $json.appointmentId }},{{ $json.notes }},{{ $json.summary }}',
  ), { pos: [2240, 480], ...withPg });
  w.add('noOp', 'Call Handled', {}, { pos: [2460, 560] });

  w.chain('Place Call', 'Get Config', 'Build Call Request', 'VAPI Create Call', 'Return Call Result');
  w.link('VAPI Post-Call', 'Ack VAPI');
  w.chain('VAPI Post-Call', 'Parse Call Report', 'Actionable Call?');
  w.link('Actionable Call?', 'Log Call', 0);
  w.link('Actionable Call?', 'Ignore Event', 1);
  w.chain('Log Call', 'Load Appointment State', 'Apply Call Outcome', 'Persist Call Outcome', 'Wants A Human?');
  w.link('Wants A Human?', 'Queue Callback', 0);
  w.link('Wants A Human?', 'Call Handled', 1);
  w.link('Queue Callback', 'Call Handled');

  w.note(
    '## 06 — Voice agent (VAPI)\n\n**Top branch** places an outbound call — invoked by the dispatcher when the reminder ladder escalates to voice.\n\n**Bottom branch** receives VAPI\'s `end-of-call-report` and feeds the outcome through the *same* state machine that text replies use, so a phone confirmation and a "YES" text are indistinguishable downstream.\n\n### Guardrails\nThe assistant prompt deliberately forbids quoting prices, offering alternative times, or giving clinical advice — voice agents given open-ended instructions invent availability and book slots that do not exist.',
    [200, 860], [640, 320],
  );
  return w;
});

/* ================================================================== *
 * 07 — Post-visit follow-up and recall
 * ================================================================== */

define(() => {
  const w = new Workflow('deskbell/07 Follow-up & Recall', META);

  w.add('schedule', 'Hourly', everyHour(), { pos: [260, 300] });
  w.add('execWorkflow', 'Get Config', callWorkflow(WF.config), { pos: [480, 300] });

  w.add('postgres', 'Mark Attendance', sql(
    `-- Anything that ended without being cancelled is treated as attended unless
-- it was never confirmed and never replied to, which is the no-show signature.
UPDATE deskbell.appointments a
SET status = CASE
      WHEN a.confirmed_at IS NOT NULL THEN 'completed'
      WHEN EXISTS (SELECT 1 FROM deskbell.inbound_messages m
                   WHERE m.contact_id = a.contact_id AND m.received_at > a.start_at - interval '7 days')
        THEN 'completed'
      ELSE 'no_show' END,
    completed_at = now(), updated_at = now()
WHERE a.end_at < now() - interval '30 minutes'
  AND a.status IN ('scheduled', 'reminded', 'confirmed')
RETURNING a.id, a.status;`,
  ), { pos: [700, 300], ...withPg, alwaysOutputData: true });

  w.add('postgres', 'Find Follow-ups Due', sql(
    `SELECT a.id AS appointment_id, a.service_name, a.start_at, a.value,
       c.id AS contact_id, c.first_name, c.name, c.phone, c.whatsapp, c.email,
       c.opted_out, c.consent_at, c.marketing_consent, c.last_inbound_at,
       'followup' AS task_type
FROM deskbell.appointments a
JOIN deskbell.contacts c ON c.id = a.contact_id
WHERE a.status = 'completed'
  AND a.followup_sent_at IS NULL
  AND a.completed_at < now() - ($1 || ' hours')::interval
  AND a.completed_at > now() - interval '3 days'
  AND c.opted_out = false
LIMIT 200;`,
    '={{ $json.config ? $json.config.followUp.delayHoursAfterAppointment : $("Get Config").first().json.config.followUp.delayHoursAfterAppointment }}',
  ), { pos: [920, 200], ...withPg, alwaysOutputData: true });

  w.add('postgres', 'Find Recalls Due', sql(
    `-- One recall per contact per interval, based on their most recent visit.
SELECT DISTINCT ON (c.id)
       a.id AS appointment_id, a.service_name, a.value,
       c.id AS contact_id, c.first_name, c.name, c.phone, c.whatsapp, c.email,
       c.opted_out, c.consent_at, c.marketing_consent, c.last_inbound_at,
       'recall' AS task_type
FROM deskbell.contacts c
JOIN deskbell.appointments a ON a.contact_id = c.id AND a.status = 'completed'
WHERE c.opted_out = false
  AND c.marketing_consent = true
  AND NOT EXISTS (
    SELECT 1 FROM deskbell.appointments f
    WHERE f.contact_id = c.id AND f.start_at > now()
      AND f.status NOT IN ('cancelled', 'no_show')
  )
  AND NOT EXISTS (
    SELECT 1 FROM deskbell.message_log m
    WHERE m.contact_id = c.id AND m.stage = 'recall'
      AND m.created_at > now() - ($1 || ' days')::interval
  )
GROUP BY c.id, a.id
HAVING max(a.completed_at) < now() - ($1 || ' days')::interval
ORDER BY c.id, a.completed_at DESC
LIMIT 200;`,
    '={{ $("Get Config").first().json.config.recall.intervalDays }}',
  ), { pos: [920, 420], ...withPg, alwaysOutputData: true });

  w.add('merge', 'All Outreach', { numberInputs: 2 }, { pos: [1140, 300] });

  w.add('code', 'Build Outreach Tasks', jsCode(`${HEADER('deskbell/07 — build follow-up and recall messages')}
const config = $('Get Config').first().json.config;
const tasks = [];

for (const item of $input.all()) {
  const row = item.json;
  if (!row.contact_id) continue;

  const isRecall = row.task_type === 'recall';
  if (isRecall && !config.recall?.enabled) continue;
  if (!isRecall && !config.followUp?.enabled) continue;

  const appt = normalizeAppointment(row);
  appt.contact.id = row.contact_id;

  // Recall is marketing. The consent gate in the dispatcher enforces this too,
  // but filtering here avoids claiming idempotency keys that can never send.
  const gate = consentGate(appt.contact, config, isRecall ? 'recall' : 'transactional');
  if (!gate.allowed) continue;

  const stage = isRecall ? 'recall' : 'followup';
  tasks.push({
    json: {
      kind: isRecall ? 'recall' : 'transactional',
      idempotencyKey: idempotencyKey(isRecall ? 'contact_' + row.contact_id : appt.id, stage,
                                     isRecall ? new Date().toISOString().slice(0, 10) : ''),
      appointmentId: row.appointment_id,
      contactId: row.contact_id,
      stage,
      channels: isRecall ? (config.recall.channels || ['sms']) : (config.channels.priority || ['sms']),
      templateKey: isRecall ? 'recall' : (config.followUp.askForRating ? 'followUpRating' : 'reviewRequest'),
      contact: appt.contact,
      vars: {
        firstName: appt.contact.firstName || 'there',
        petName: appt.contact.petName || '',
        serviceName: row.service_name || 'appointment',
        businessName: config.business.name,
        bookingUrl: config.business.bookingUrl,
        reviewUrl: config.business.reviewUrl,
        intervalDays: config.recall?.intervalDays,
      },
    },
  });
}
console.log(\`deskbell/07: \${tasks.length} outreach task(s)\`);
return tasks;`), { pos: [1360, 300] });

  w.add('postgres', 'Claim Outreach', sql(
    `INSERT INTO deskbell.message_log
  (idempotency_key, appointment_id, contact_id, stage, kind, direction, status, attempt)
VALUES ($1, $2::bigint, $3::bigint, $4, $5, 'outbound', 'claimed', 1)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id, idempotency_key;`,
    '={{ $json.idempotencyKey }},{{ $json.appointmentId }},{{ $json.contactId }},{{ $json.stage }},{{ $json.kind }}',
  ), { pos: [1580, 300], ...withPg });

  w.add('code', 'Attach Claim', jsCode(`${HEADER('deskbell/07 — only send what this run claimed')}
const claimed = new Map($input.all().map(i => [i.json.idempotency_key, i.json.id]));
return $('Build Outreach Tasks').all().map(i => i.json)
  .filter(t => claimed.has(t.idempotencyKey))
  .map(t => ({ json: { ...t, messageLogId: claimed.get(t.idempotencyKey) } }));`),
    { pos: [1800, 300], alwaysOutputData: true });

  w.add('loop', 'For Each Outreach', { batchSize: 1, options: { reset: false } }, { pos: [2020, 300] });
  w.add('execWorkflow', 'Send Outreach', callWorkflow(WF.dispatcher), { pos: [2240, 400], continueOnFail: true });

  w.add('postgres', 'Settle Outreach', sql(
    `UPDATE deskbell.message_log
SET status = CASE WHEN $2::boolean THEN 'sent' ELSE 'failed' END,
    channel = $3, body = $4, error_message = $5, sent_at = CASE WHEN $2::boolean THEN now() END, settled_at = now()
WHERE id = $1::bigint;
UPDATE deskbell.appointments SET followup_sent_at = now()
WHERE id = $6::bigint AND $2::boolean AND $7 = 'followup';
INSERT INTO deskbell.events (type, appointment_id, contact_id, channel, payload)
VALUES ($7 || '_sent', $6::bigint, $8::bigint, $3, jsonb_build_object('sent', $2::boolean));`,
    '={{ $("For Each Outreach").first().json.messageLogId }},{{ $json.sent }},{{ $json.channel }},{{ $json.body }},{{ $json.error }},{{ $("For Each Outreach").first().json.appointmentId }},{{ $("For Each Outreach").first().json.stage }},{{ $("For Each Outreach").first().json.contactId }}',
  ), { pos: [2460, 400], ...withPg });

  w.add('noOp', 'Outreach Complete', {}, { pos: [2240, 160] });

  w.chain('Hourly', 'Get Config', 'Mark Attendance');
  w.link('Mark Attendance', 'Find Follow-ups Due');
  w.link('Mark Attendance', 'Find Recalls Due');
  w.link('Find Follow-ups Due', 'All Outreach', 0);
  w.link('Find Recalls Due', 'All Outreach', 1);
  w.chain('All Outreach', 'Build Outreach Tasks', 'Claim Outreach', 'Attach Claim', 'For Each Outreach');
  w.link('For Each Outreach', 'Outreach Complete', 0);
  w.link('For Each Outreach', 'Send Outreach', 1);
  w.chain('Send Outreach', 'Settle Outreach');
  w.link('Settle Outreach', 'For Each Outreach');

  w.note(
    '## 07 — Follow-up & recall\n\nThree jobs, hourly:\n\n1. **Mark attendance** — anything past its end time becomes `completed` or `no_show`. This is what feeds the no-show rate in the digest.\n2. **Follow-up** — asks for a 1–5 rating a few hours after the visit. Ratings route in workflow 04: happy customers get the public review link, unhappy ones get a private channel to the owner.\n3. **Recall** — brings customers back after `recall.intervalDays`. This is **marketing**, so it requires `marketing_consent`, not just transactional consent.',
    [900, -140], [600, 340],
  );
  return w;
});

/* ================================================================== *
 * 08 — Waitlist gap-fill
 * ================================================================== */

define(() => {
  const w = new Workflow('deskbell/08 Waitlist Gap-fill', META);

  w.add('execTrigger', 'Slot Freed', {}, { pos: [260, 300] });
  w.add('execWorkflow', 'Get Config', callWorkflow(WF.config), { pos: [480, 300] });

  w.add('postgres', 'Find Candidates', sql(
    `-- Longest-waiting, highest-priority first, and only people whose stated
-- window actually contains the freed slot.
SELECT wl.id AS waitlist_id, wl.priority, wl.service_name,
       c.id AS contact_id, c.first_name, c.name, c.phone, c.whatsapp, c.email,
       c.opted_out, c.consent_at, c.marketing_consent, c.last_inbound_at
FROM deskbell.waitlist wl
JOIN deskbell.contacts c ON c.id = wl.contact_id
WHERE wl.status = 'waiting'
  AND c.opted_out = false
  AND (wl.earliest IS NULL OR wl.earliest <= $1::timestamptz)
  AND (wl.latest   IS NULL OR wl.latest   >= $1::timestamptz)
  AND (wl.service_name IS NULL OR wl.service_name = $2)
  AND NOT EXISTS (
    -- Never double-offer the same slot to the same person.
    SELECT 1 FROM deskbell.waitlist_offers o
    WHERE o.waitlist_id = wl.id AND o.appointment_id = $3::bigint
  )
ORDER BY wl.priority DESC, wl.created_at ASC
LIMIT $4::int;`,
    '={{ $json.startAt }},{{ $json.serviceName }},{{ $json.appointmentId }},{{ $("Get Config").first().json.config.waitlist.offerBatchSize }}',
  ), { pos: [700, 300], ...withPg, alwaysOutputData: true });

  w.add('code', 'Build Offers', jsCode(`${HEADER('deskbell/08 — offer the freed slot')}
const config = $('Get Config').first().json.config;
const slot = $('Slot Freed').first().json;

if (!config.waitlist?.enabled) return [];

const rows = $input.all().map(i => i.json).filter(r => r.contact_id);
if (!rows.length) { console.log('deskbell/08: nobody on the waitlist matches this slot'); return []; }

const expiryMinutes = config.waitlist.offerExpiryMinutes ?? 45;
const expiresAt = new Date(Date.now() + expiryMinutes * 60_000).toISOString();

return rows.map(row => {
  const contact = normalizeAppointment(row).contact;
  contact.id = row.contact_id;
  return {
    json: {
      kind: 'transactional',
      // The freed appointment id is part of the key, so re-running gap-fill for
      // the same cancellation never texts the same person twice.
      idempotencyKey: idempotencyKey('slot_' + slot.appointmentId, 'waitlist-offer', 'wl_' + row.waitlist_id),
      waitlistId: row.waitlist_id,
      appointmentId: slot.appointmentId,
      contactId: row.contact_id,
      stage: 'waitlist-offer',
      channels: config.channels.priority,
      templateKey: 'waitlistOffer',
      expiresAt,
      contact,
      vars: {
        firstName: contact.firstName || 'there',
        serviceName: slot.serviceName || row.service_name || 'appointment',
        businessName: config.business.name,
        bookingUrl: config.business.bookingUrl,
        expiryMinutes,
        appointmentDate: new Intl.DateTimeFormat(config.business.locale || 'en', {
          timeZone: config.business.timezone, weekday: 'long', day: 'numeric', month: 'long',
        }).format(new Date(slot.startAt)),
        appointmentTime: new Intl.DateTimeFormat(config.business.locale || 'en', {
          timeZone: config.business.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date(slot.startAt)),
      },
    },
  };
});`), { pos: [920, 300] });

  w.add('postgres', 'Record Offer', sql(
    `WITH claim AS (
  INSERT INTO deskbell.message_log
    (idempotency_key, appointment_id, contact_id, stage, kind, direction, status, attempt)
  VALUES ($1, $2::bigint, $3::bigint, 'waitlist-offer', 'transactional', 'outbound', 'claimed', 1)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id
)
INSERT INTO deskbell.waitlist_offers (waitlist_id, appointment_id, contact_id, expires_at, status, message_log_id)
SELECT $4::bigint, $2::bigint, $3::bigint, $5::timestamptz, 'offered', claim.id FROM claim
RETURNING id AS offer_id, message_log_id;`,
    '={{ $json.idempotencyKey }},{{ $json.appointmentId }},{{ $json.contactId }},{{ $json.waitlistId }},{{ $json.expiresAt }}',
  ), { pos: [1140, 300], ...withPg });

  w.add('code', 'Offers To Send', jsCode(`${HEADER('deskbell/08 — send only the offers that were actually recorded')}
const recorded = $input.all().map(i => i.json).filter(r => r.offer_id);
const offers = $('Build Offers').all().map(i => i.json);
// Row order is preserved by the insert, so index alignment is safe here.
return recorded.map((r, i) => ({ json: { ...offers[i], offerId: r.offer_id, messageLogId: r.message_log_id } }));`),
    { pos: [1360, 300], alwaysOutputData: true });

  w.add('loop', 'For Each Offer', { batchSize: 1, options: { reset: false } }, { pos: [1580, 300] });
  w.add('execWorkflow', 'Send Offer', callWorkflow(WF.dispatcher), { pos: [1800, 400], continueOnFail: true });

  w.add('postgres', 'Settle Offer', sql(
    `UPDATE deskbell.message_log
SET status = CASE WHEN $2::boolean THEN 'sent' ELSE 'failed' END,
    channel = $3, body = $4, sent_at = CASE WHEN $2::boolean THEN now() END, settled_at = now()
WHERE id = $1::bigint;
UPDATE deskbell.waitlist SET status = CASE WHEN $2::boolean THEN 'offered' ELSE 'waiting' END
WHERE id = $5::bigint;`,
    '={{ $("For Each Offer").first().json.messageLogId }},{{ $json.sent }},{{ $json.channel }},{{ $json.body }},{{ $("For Each Offer").first().json.waitlistId }}',
  ), { pos: [2020, 400], ...withPg });

  w.add('code', 'Offers Complete', jsCode(`${HEADER('deskbell/08 — summarise')}
const offers = $('Offers To Send').all().map(i => i.json);
return [{ json: { offersSent: offers.length, appointmentId: offers[0]?.appointmentId || null,
                  expiresAt: offers[0]?.expiresAt || null } }];`), { pos: [1800, 160] });

  w.chain('Slot Freed', 'Get Config', 'Find Candidates', 'Build Offers', 'Record Offer', 'Offers To Send', 'For Each Offer');
  w.link('For Each Offer', 'Offers Complete', 0);
  w.link('For Each Offer', 'Send Offer', 1);
  w.chain('Send Offer', 'Settle Offer');
  w.link('Settle Offer', 'For Each Offer');

  w.note(
    '## 08 — Waitlist gap-fill\n\nCalled by workflow 04 the moment a cancellation is confirmed.\n\n`waitlist.offerBatchSize` is the real decision here:\n- **1** = a strict polite queue. Nobody is disappointed, but the slot often goes unfilled.\n- **3–5** = a race. Fills far more slots; some people reply to find it gone. Salons and clinics with same-day demand should race.\n\nThe offer expires after `offerExpiryMinutes`, and the same person is never offered the same slot twice.',
    [640, -140], [600, 320],
  );
  return w;
});

/* ================================================================== *
 * 09 — Error handler
 * ================================================================== */

define(() => {
  const w = new Workflow('deskbell/09 Error Handler', { tags: [{ name: 'deskbell' }] });

  w.add('errorTrigger', 'On Workflow Error', {}, { pos: [260, 300] });
  w.add('execWorkflow', 'Get Config', callWorkflow(WF.config), { pos: [480, 300] });

  w.add('code', 'Classify Error', jsCode(`${HEADER('deskbell/09 — turn a failure into something actionable')}
const config = $('Get Config').first().json.config;
const err = $('On Workflow Error').first().json;

const execution = err.execution || {};
const workflow = err.workflow || {};
const lastNode = execution.lastNodeExecuted || 'unknown';
const message = execution.error?.message || err.message || 'unknown error';
const statusCode = execution.error?.httpCode || execution.error?.statusCode || 0;

const failure = classifyFailure(statusCode, message);

// Config errors are not transient and will fail identically every 15 minutes.
// Flag them loudly instead of letting them fill the dead-letter table.
const isConfigError = /config invalid|credentials|unauthor|forbidden|not found/i.test(message);

return [{
  json: {
    workflowName: workflow.name || 'unknown',
    workflowId: workflow.id || null,
    executionId: execution.id || null,
    executionUrl: execution.url || null,
    node: lastNode,
    message,
    statusCode,
    retryable: failure.retryable && !isConfigError,
    category: isConfigError ? 'configuration' : failure.category,
    severity: isConfigError ? 'critical' : (failure.retryable ? 'warning' : 'error'),
    occurredAt: new Date().toISOString(),
    alertEmail: config.business.ownerEmail,
    businessName: config.business.name,
  },
}];`), { pos: [700, 300] });

  w.add('postgres', 'Dead Letter', sql(
    `INSERT INTO deskbell.dead_letters
  (workflow_name, workflow_id, execution_id, node_name, error_message, status_code, retryable, category, severity)
VALUES ($1, $2, $3, $4, $5, $6::int, $7::boolean, $8, $9)
RETURNING id;`,
    '={{ $json.workflowName }},{{ $json.workflowId }},{{ $json.executionId }},{{ $json.node }},{{ $json.message }},{{ $json.statusCode }},{{ $json.retryable }},{{ $json.category }},{{ $json.severity }}',
  ), { pos: [920, 300], ...withPg, continueOnFail: true });

  w.add('postgres', 'Check Alert Storm', sql(
    `-- Do not email the owner 200 times when a provider is down. One alert per
-- workflow per 30 minutes is enough to convey "this is broken".
SELECT count(*) AS recent
FROM deskbell.dead_letters
WHERE workflow_name = $1 AND created_at > now() - interval '30 minutes';`,
    '={{ $("Classify Error").first().json.workflowName }}',
  ), { pos: [1140, 300], ...withPg, alwaysOutputData: true });

  w.add('if', 'Should Alert?', ifBool(
    '={{ Number($json.recent) <= 1 || $("Classify Error").first().json.severity === "critical" }}',
  ), { pos: [1360, 300] });

  w.add('code', 'Compose Alert', jsCode(`${HEADER('deskbell/09 — an alert a non-technical owner can act on')}
const e = $('Classify Error').first().json;
const recent = Number($('Check Alert Storm').first().json.recent || 1);

const guidance = {
  configuration: 'Check the config in "deskbell/00 Config" and that all credentials are still connected.',
  rate_limited: 'Your messaging provider is throttling. Usually resolves itself; check your plan limits if it persists.',
  provider_error: 'The messaging provider returned an error. Usually transient — deskbell will retry.',
  permanent_recipient: 'A phone number or email address is invalid. Fix the customer record.',
  network: 'Network problem reaching a provider. Usually transient.',
  bad_request: 'deskbell sent something a provider rejected. This needs a developer.',
}[e.category] || 'Open the execution link for details.';

return [{ json: {
  ...e,
  subject: \`[deskbell] \${e.severity === 'critical' ? 'ACTION NEEDED' : 'Problem'}: \${e.workflowName}\`,
  text: [
    \`deskbell hit a problem in "\${e.workflowName}".\`,
    '',
    \`What broke: \${e.node}\`,
    \`Error: \${e.message}\`,
    \`Severity: \${e.severity}\`,
    \`Will it retry automatically? \${e.retryable ? 'Yes' : 'No — this needs attention'}\`,
    '',
    \`What to do: \${guidance}\`,
    '',
    recent > 1 ? \`Note: \${recent} failures in this workflow in the last 30 minutes.\` : '',
    e.executionUrl ? \`Execution: \${e.executionUrl}\` : '',
  ].filter(Boolean).join('\\n'),
} }];`), { pos: [1580, 220] });

  w.add('email', 'Email Owner', {
    fromEmail: '={{ $env.DESKBELL_FROM_EMAIL }}',
    toEmail: '={{ $json.alertEmail }}',
    subject: '={{ $json.subject }}',
    emailFormat: 'text',
    text: '={{ $json.text }}',
    options: {},
  }, { pos: [1800, 220], continueOnFail: true });

  w.add('noOp', 'Suppressed (Alert Storm)', {}, { pos: [1580, 420] });

  w.chain('On Workflow Error', 'Get Config', 'Classify Error', 'Dead Letter', 'Check Alert Storm', 'Should Alert?');
  w.link('Should Alert?', 'Compose Alert', 0);
  w.link('Should Alert?', 'Suppressed (Alert Storm)', 1);
  w.link('Compose Alert', 'Email Owner');

  w.note(
    '## 09 — Error handler\n\nSet as the **error workflow** on every other deskbell workflow, so nothing fails silently.\n\nThree things it does that a bare "send me an email on error" does not:\n\n1. **Classifies** the failure as retryable or permanent, so you know whether to act.\n2. **Dead-letters** every failure to `deskbell.dead_letters` for later inspection.\n3. **Suppresses alert storms** — one email per workflow per 30 minutes, unless the error is a configuration fault, which never fixes itself.',
    [640, -160], [600, 340],
  );
  return w;
});

/* ================================================================== *
 * 10 — Daily digest
 * ================================================================== */

define(() => {
  const w = new Workflow('deskbell/10 Daily Digest', META);

  w.add('schedule', 'Every Morning', dailyAt(7, 30), { pos: [260, 300] });
  w.add('execWorkflow', 'Get Config', callWorkflow(WF.config), { pos: [480, 300] });

  w.add('postgres', 'Today Schedule', sql(
    `SELECT a.id, a.start_at, a.status, a.service_name, a.value,
       c.first_name, c.name, c.phone
FROM deskbell.appointments a
JOIN deskbell.contacts c ON c.id = a.contact_id
WHERE a.start_at >= date_trunc('day', now())
  AND a.start_at <  date_trunc('day', now()) + interval '1 day'
  AND a.status NOT IN ('cancelled', 'rescheduled')
ORDER BY a.start_at;`,
  ), { pos: [700, 200], ...withPg, alwaysOutputData: true });

  w.add('postgres', 'Week Events', sql(
    `SELECT type, channel, count(*) AS n
FROM deskbell.events
WHERE occurred_at > now() - interval '7 days'
GROUP BY type, channel;`,
  ), { pos: [700, 340], ...withPg, alwaysOutputData: true });

  w.add('postgres', 'Week Outcomes', sql(
    `SELECT
  count(*) FILTER (WHERE status = 'completed')  AS completed,
  count(*) FILTER (WHERE status = 'no_show')    AS no_shows,
  count(*) FILTER (WHERE status = 'cancelled')  AS cancelled,
  count(*)                                       AS total,
  coalesce(sum(value) FILTER (WHERE status = 'no_show'), 0) AS lost_value,
  (SELECT count(*) FROM deskbell.human_tasks WHERE resolved_at IS NULL) AS open_tasks,
  (SELECT count(*) FROM deskbell.dead_letters WHERE created_at > now() - interval '1 day') AS errors_today,
  (SELECT count(*) FROM deskbell.leads WHERE first_contact_at > now() - interval '7 days') AS missed_calls
FROM deskbell.appointments
WHERE start_at > now() - interval '7 days' AND start_at < now();`,
  ), { pos: [700, 480], ...withPg, alwaysOutputData: true });

  w.add('merge', 'Combine', { numberInputs: 3, mode: 'combine', combineBy: 'combineAll', options: {} }, { pos: [920, 340] });

  w.add('code', 'Build Digest', jsCode(`${HEADER('deskbell/10 — the number that keeps deskbell switched on')}
const config = $('Get Config').first().json.config;
const today = $('Today Schedule').all().map(i => i.json).filter(r => r.id);
const eventRows = $('Week Events').all().map(i => i.json).filter(r => r.type);
const outcome = $('Week Outcomes').first().json || {};

// Expand the grouped counts back into the event list computeRoi() expects.
const events = [];
for (const row of eventRows) {
  const type = { reminder_sent: 'reminder_sent', confirmed_after_reminder: 'confirmed_after_reminder',
                 cancelled_early: 'cancelled_early', missed_call_texted: 'missed_call_recovered',
                 waitlist_filled: 'waitlist_filled' }[row.type];
  if (!type) continue;
  for (let i = 0; i < Number(row.n); i++) events.push({ type, channel: row.channel || 'sms' });
}

const total = Number(outcome.total || 0);
const noShows = Number(outcome.no_shows || 0);
const noShowRate = total ? noShows / total : 0;
const roi = computeRoi(events, config, { baselineNoShowRate: 0.2 });

const fmt = (n) => new Intl.NumberFormat(config.business.locale || 'en', {
  style: 'currency', currency: config.business.currency, maximumFractionDigits: 0,
}).format(Number(n) || 0);

const time = (iso) => new Intl.DateTimeFormat(config.business.locale || 'en', {
  timeZone: config.business.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(iso));

const unconfirmed = today.filter(a => a.status !== 'confirmed');

const lines = [
  \`Good morning. Here is \${config.business.name} today.\`,
  '',
  \`TODAY: \${today.length} appointment\${today.length === 1 ? '' : 's'}\`,
  \`  Confirmed:   \${today.length - unconfirmed.length}\`,
  \`  Unconfirmed: \${unconfirmed.length}\${unconfirmed.length ? '  <- worth a look' : ''}\`,
  '',
  ...(unconfirmed.length ? ['Not yet confirmed:',
    ...unconfirmed.slice(0, 12).map(a => \`  \${time(a.start_at)}  \${a.name || a.first_name || a.phone}  (\${a.service_name})\`),
    unconfirmed.length > 12 ? \`  ...and \${unconfirmed.length - 12} more\` : '', ''] : []),
  'LAST 7 DAYS',
  \`  Reminders sent:     \${roi.remindersSent}\`,
  \`  Confirmations:      \${roi.confirmations} (\${Math.round(roi.confirmationRate * 100)}%)\`,
  \`  No-show rate:       \${Math.round(noShowRate * 100)}% (\${noShows} of \${total})\`,
  \`  Missed calls texted:\${' '}\${Number(outcome.missed_calls || 0)}\`,
  \`  Slots refilled:     \${roi.slotsRefilled}\`,
  '',
  'WHAT IT WAS WORTH',
  \`  Revenue protected:  \${fmt(roi.protectedRevenue + roi.refilledRevenue + roi.recoveredCallRevenue)}\`,
  \`  Messaging cost:     \${fmt(roi.messageCost)}\`,
  \`  Net:                \${fmt(roi.netValue)}\${roi.roiMultiple ? \`  (\${roi.roiMultiple}x return)\` : ''}\`,
  \`  Still lost to no-shows: \${fmt(outcome.lost_value)}\`,
  '',
  ...(Number(outcome.open_tasks) ? [\`\${outcome.open_tasks} message\${outcome.open_tasks === 1 ? '' : 's'} waiting for a human reply.\`] : []),
  ...(Number(outcome.errors_today) ? [\`\${outcome.errors_today} technical error\${outcome.errors_today === 1 ? '' : 's'} in the last 24h — check deskbell/09.\`] : []),
];

return [{ json: {
  subject: \`\${config.business.name}: \${today.length} today, \${unconfirmed.length} unconfirmed\`,
  text: lines.filter(l => l !== undefined).join('\\n'),
  to: config.business.ownerEmail,
  metrics: { ...roi, noShowRate: Math.round(noShowRate * 100) / 100, todayCount: today.length,
             unconfirmedCount: unconfirmed.length },
} }];`), { pos: [1140, 340] });

  w.add('postgres', 'Store Metrics', sql(
    `INSERT INTO deskbell.daily_metrics (day, metrics) VALUES (current_date, $1::jsonb)
ON CONFLICT (day) DO UPDATE SET metrics = EXCLUDED.metrics;`,
    '={{ JSON.stringify($json.metrics) }}',
  ), { pos: [1360, 340], ...withPg, continueOnFail: true });

  w.add('email', 'Email Digest', {
    fromEmail: '={{ $env.DESKBELL_FROM_EMAIL }}',
    toEmail: '={{ $json.to }}',
    subject: '={{ $json.subject }}',
    emailFormat: 'text',
    text: '={{ $json.text }}',
    options: {},
  }, { pos: [1580, 340], continueOnFail: true });

  w.chain('Every Morning', 'Get Config');
  w.link('Get Config', 'Today Schedule');
  w.link('Get Config', 'Week Events');
  w.link('Get Config', 'Week Outcomes');
  w.link('Today Schedule', 'Combine', 0);
  w.link('Week Events', 'Combine', 1);
  w.link('Week Outcomes', 'Combine', 2);
  w.chain('Combine', 'Build Digest', 'Store Metrics', 'Email Digest');

  w.note(
    '## 10 — Daily digest\n\nThe most important workflow in deskbell, commercially.\n\nAn owner who cannot see what the automation is worth will switch it off within two months. This email leads with **today\'s unconfirmed list** (immediately actionable) and closes with **revenue protected vs messaging cost**.\n\n`avgAppointmentValue` in the config drives those numbers — set it honestly or the report is theatre.',
    [1080, 40], [560, 300],
  );
  return w;
});

/* ================================================================== *
 * Emit
 * ================================================================== */

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT).filter((f) => f.endsWith('.json'))) unlinkSync(join(OUT, f));

const slugs = [
  '00-config', '01-appointment-sync', '02-reminder-scheduler', '03-message-dispatcher',
  '04-inbound-handler', '05-missed-call-recovery', '06-voice-agent-vapi',
  '07-followup-recall', '08-waitlist-gapfill', '09-error-handler', '10-daily-digest',
];

if (slugs.length !== workflows.length) {
  throw new Error(`slug/workflow count mismatch: ${slugs.length} vs ${workflows.length}`);
}

let nodeTotal = 0;
workflows.forEach((wf, i) => {
  const json = wf.toJSON();
  nodeTotal += json.nodes.length;
  writeFileSync(join(OUT, `${slugs[i]}.json`), JSON.stringify(json, null, 2) + '\n');
  console.log(`  workflows/${slugs[i]}.json  (${json.nodes.length} nodes)`);
});
console.log(`${workflows.length} workflows, ${nodeTotal} nodes.`);
