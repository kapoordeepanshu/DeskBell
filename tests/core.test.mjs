import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../lib/core.js');
const dental = require('../config/presets/dental.json');
const salon = require('../config/presets/salon.json');

const cfg = (over = {}) => S.normalizeConfig({ ...structuredClone(dental), ...over });

/* ------------------------------------------------------------------ *
 * Quiet hours
 * ------------------------------------------------------------------ */

test('quiet hours: wrapping window is detected on both sides of midnight', () => {
  const q = { enabled: true, start: '21:00', end: '08:00' };
  const tz = 'UTC';
  assert.equal(S.inQuietHours('2026-03-10T22:30:00Z', q, tz), true, '22:30 is inside');
  assert.equal(S.inQuietHours('2026-03-10T03:00:00Z', q, tz), true, '03:00 is inside');
  assert.equal(S.inQuietHours('2026-03-10T08:00:00Z', q, tz), false, 'end is exclusive');
  assert.equal(S.inQuietHours('2026-03-10T20:59:00Z', q, tz), false, 'just before start');
  assert.equal(S.inQuietHours('2026-03-10T21:00:00Z', q, tz), true, 'start is inclusive');
});

test('quiet hours: same-day (non-wrapping) window works too', () => {
  const q = { enabled: true, start: '13:00', end: '14:00' };
  assert.equal(S.inQuietHours('2026-03-10T13:30:00Z', q, 'UTC'), true);
  assert.equal(S.inQuietHours('2026-03-10T12:30:00Z', q, 'UTC'), false);
});

test('quiet hours: evaluated in the business timezone, not UTC', () => {
  const q = { enabled: true, start: '21:00', end: '08:00' };
  // 17:00 UTC is 22:30 in Kolkata -> quiet there, awake in UTC.
  assert.equal(S.inQuietHours('2026-03-10T17:00:00Z', q, 'Asia/Kolkata'), true);
  assert.equal(S.inQuietHours('2026-03-10T17:00:00Z', q, 'UTC'), false);
});

test('quiet hours: disabled config never blocks', () => {
  assert.equal(S.inQuietHours('2026-03-10T03:00:00Z', { enabled: false, start: '21:00', end: '08:00' }, 'UTC'), false);
});

test('nextOpenWindow lands exactly on the end of quiet hours', () => {
  const q = { enabled: true, start: '21:00', end: '08:00' };
  const out = S.nextOpenWindow('2026-03-10T23:15:00Z', q, 'UTC');
  assert.equal(out.toISOString(), '2026-03-11T08:00:00.000Z');
  assert.equal(S.inQuietHours(out, q, 'UTC'), false);
});

test('nextOpenWindow is a no-op outside quiet hours', () => {
  const q = { enabled: true, start: '21:00', end: '08:00' };
  const d = '2026-03-10T12:00:00Z';
  assert.equal(S.nextOpenWindow(d, q, 'UTC').toISOString(), new Date(d).toISOString());
});

test('nextOpenWindow survives a DST spring-forward night', () => {
  // US DST starts 2026-03-08. 02:00 local does not exist that morning.
  const q = { enabled: true, start: '21:00', end: '08:00' };
  const tz = 'America/New_York';
  const out = S.nextOpenWindow('2026-03-08T04:00:00Z', q, tz);
  assert.equal(S.inQuietHours(out, q, tz), false, 'result must be outside quiet hours');
  assert.equal(S.zonedParts(out, tz).hour, 8, 'must be 08:00 local, not 07:00 or 09:00');
});

/* ------------------------------------------------------------------ *
 * Idempotency
 * ------------------------------------------------------------------ */

test('idempotency key is stable and readable', () => {
  assert.equal(S.idempotencyKey('appt_1', 'T-24h'), 'appt_1|T-24h');
  assert.equal(S.idempotencyKey('appt_1', 'T-24h'), S.idempotencyKey('appt_1', 'T-24h'));
});

test('idempotency key separates stages and appointments', () => {
  assert.notEqual(S.idempotencyKey('a', 'T-24h'), S.idempotencyKey('a', 'T-3h'));
  assert.notEqual(S.idempotencyKey('a', 'T-24h'), S.idempotencyKey('b', 'T-24h'));
});

test('idempotency key is injection-safe against separator collisions', () => {
  // Without escaping, ("a|b","c") and ("a","b|c") would collide.
  assert.notEqual(S.idempotencyKey('a|b', 'c'), S.idempotencyKey('a', 'b|c'));
});

/* ------------------------------------------------------------------ *
 * Reminder evaluation — the core decision
 * ------------------------------------------------------------------ */

const appt = (over = {}) => ({
  id: 'appt_1',
  startAt: '2026-03-12T10:00:00Z',
  status: 'scheduled',
  sentStages: [],
  value: 180,
  ...over,
});

const dueStages = (decisions) => decisions.filter((d) => d.due).map((d) => d.stage);
const reasonFor = (decisions, stage) => decisions.find((d) => d.stage === stage)?.reason;

test('fires T-24h inside its window and nothing else', () => {
  const now = '2026-03-11T12:00:00Z'; // 22h before
  const d = S.evaluateReminders(appt(), cfg(), now);
  assert.deepEqual(dueStages(d), ['T-24h']);
  assert.equal(reasonFor(d, 'T-7d'), 'window_missed');
  assert.equal(reasonFor(d, 'T-3h'), 'not_yet_due');
});

test('does not fire a superseded wide stage when a sync ran late', () => {
  // This is the classic bug: at T-2h a naive `hoursOut <= 168` check fires the
  // 7-day reminder and texts "see you in a week" two hours before arrival.
  // Afternoon appointment so the T-3h window sits outside the 21:00-08:00 quiet block.
  const now = '2026-03-12T11:30:00Z'; // 2.5h before, inside the T-3h window
  const d = S.evaluateReminders(appt({ startAt: '2026-03-12T14:00:00Z' }), cfg(), now);
  assert.equal(reasonFor(d, 'T-7d'), 'window_missed');
  assert.equal(reasonFor(d, 'T-24h'), 'window_missed');
  assert.deepEqual(dueStages(d), ['T-3h']);
});

test('never re-sends a stage already recorded as sent', () => {
  const now = '2026-03-11T12:00:00Z';
  const d = S.evaluateReminders(appt({ sentStages: ['T-24h'] }), cfg(), now);
  assert.deepEqual(dueStages(d), []);
  assert.equal(reasonFor(d, 'T-24h'), 'already_sent');
});

test('terminal states stop all reminders', () => {
  for (const status of ['cancelled', 'completed', 'no_show', 'rescheduled']) {
    const d = S.evaluateReminders(appt({ status }), cfg(), '2026-03-11T12:00:00Z');
    assert.deepEqual(dueStages(d), [], `${status} must send nothing`);
    assert.match(reasonFor(d, 'T-24h'), /^terminal_state:/);
  }
});

test('opted-out contacts are never messaged', () => {
  const d = S.evaluateReminders(appt({ optedOut: true }), cfg(), '2026-03-11T12:00:00Z');
  assert.deepEqual(dueStages(d), []);
  assert.equal(reasonFor(d, 'T-24h'), 'opted_out');
});

test('onlyIfUnconfirmed stages are skipped once confirmed', () => {
  const now = '2026-03-12T11:30:00Z'; // 2.5h out, inside T-3h and outside quiet hours
  const later = { startAt: '2026-03-12T14:00:00Z' };
  const unconfirmed = S.evaluateReminders(appt(later), cfg(), now);
  assert.deepEqual(dueStages(unconfirmed), ['T-3h']);

  const confirmed = S.evaluateReminders(appt({ ...later, status: 'confirmed' }), cfg(), now);
  assert.deepEqual(dueStages(confirmed), []);
  assert.equal(reasonFor(confirmed, 'T-3h'), 'already_confirmed');
});

test('appointments inside the minimum lead time are left alone', () => {
  const d = S.evaluateReminders(appt(), cfg(), '2026-03-12T09:30:00Z'); // 30m out, minLead 2h
  assert.deepEqual(dueStages(d), []);
  assert.equal(reasonFor(d, 'T-3h'), 'too_late');
});

test('past appointments are never messaged', () => {
  const d = S.evaluateReminders(appt(), cfg(), '2026-03-13T10:00:00Z');
  assert.deepEqual(dueStages(d), []);
});

test('quiet hours defer the send instead of dropping it', () => {
  const c = cfg();
  c.business.timezone = 'UTC';
  c.quietHours = { enabled: true, start: '21:00', end: '08:00', strategy: 'defer' };
  const d = S.evaluateReminders(appt({ startAt: '2026-03-13T12:00:00Z' }), c, '2026-03-12T22:00:00Z');
  const t24 = d.find((x) => x.stage === 'T-24h');
  assert.equal(t24.due, true);
  assert.equal(t24.reason, 'quiet_hours_deferred');
  assert.equal(t24.sendAt, '2026-03-13T08:00:00.000Z');
});

test('quiet hours with strategy=drop skip the stage', () => {
  const c = cfg();
  c.business.timezone = 'UTC';
  c.quietHours = { enabled: true, start: '21:00', end: '08:00', strategy: 'drop' };
  const d = S.evaluateReminders(appt({ startAt: '2026-03-13T10:00:00Z' }), c, '2026-03-12T22:00:00Z');
  assert.equal(reasonFor(d, 'T-24h'), 'quiet_hours_drop');
});

test('a deferred send that would land after the appointment is dropped', () => {
  const c = cfg();
  c.business.timezone = 'UTC';
  c.quietHours = { enabled: true, start: '21:00', end: '08:00', strategy: 'defer' };
  // Appointment at 06:00; deferring to 08:00 would be too late to be useful.
  const d = S.evaluateReminders(appt({ startAt: '2026-03-13T06:00:00Z' }), c, '2026-03-13T03:00:00Z');
  assert.equal(reasonFor(d, 'T-3h'), 'quiet_hours_would_expire');
});

test('every decision carries an explicit reason', () => {
  const d = S.evaluateReminders(appt(), cfg(), '2026-03-11T12:00:00Z');
  assert.equal(d.length, cfg().reminders.length);
  for (const x of d) assert.ok(x.reason && x.reason.length, `stage ${x.stage} has no reason`);
});

test('a different vertical produces a different ladder from the same engine', () => {
  const now = '2026-03-12T08:30:00Z'; // 1.5h before
  const salonCfg = S.normalizeConfig(structuredClone(salon));
  const d = S.evaluateReminders(appt({ value: 60 }), salonCfg, now);
  // Salon has no T-3h stage; its tight stage is T-2h and 1.5h out is inside it.
  assert.deepEqual(dueStages(d), ['T-2h']);
});

/* ------------------------------------------------------------------ *
 * Voice escalation
 * ------------------------------------------------------------------ */

test('voice escalates only for unconfirmed, valuable, in-window appointments', () => {
  const now = '2026-03-12T09:00:00Z'; // 1h before, threshold is 6h, outside quiet hours
  assert.equal(S.shouldEscalateToVoice(appt(), cfg(), now).escalate, true);
  assert.equal(S.shouldEscalateToVoice(appt({ status: 'confirmed' }), cfg(), now).reason, 'already_confirmed');
  assert.equal(S.shouldEscalateToVoice(appt({ value: 10 }), cfg(), now).reason, 'below_value_threshold');
  assert.equal(S.shouldEscalateToVoice(appt({ voiceAttempts: 1 }), cfg(), now).reason, 'max_attempts_reached');
});

test('voice never fires for a vertical with it disabled', () => {
  const salonCfg = S.normalizeConfig(structuredClone(salon));
  const r = S.shouldEscalateToVoice(appt(), salonCfg, '2026-03-12T09:00:00Z');
  assert.equal(r.escalate, false);
  assert.equal(r.reason, 'voice_disabled');
});

test('voice is suppressed during quiet hours', () => {
  const c = cfg();
  c.business.timezone = 'UTC';
  c.quietHours = { enabled: true, start: '21:00', end: '08:00', strategy: 'defer' };
  const r = S.shouldEscalateToVoice(appt({ startAt: '2026-03-13T06:00:00Z' }), c, '2026-03-13T02:00:00Z');
  assert.equal(r.escalate, false);
  assert.equal(r.reason, 'quiet_hours');
});

/* ------------------------------------------------------------------ *
 * Channel selection
 * ------------------------------------------------------------------ */

const contact = (over = {}) => ({
  phone: '+15550001111',
  whatsapp: '+15550001111',
  email: 'a@example.com',
  lastInboundAt: '2026-03-11T11:00:00Z',
  ...over,
});

test('picks the first viable channel in order', () => {
  const r = S.pickChannel(['whatsapp', 'sms'], contact(), cfg(), { now: '2026-03-11T12:00:00Z' });
  assert.equal(r.channel, 'whatsapp');
  assert.equal(r.mode, 'freeform');
});

test('falls through to the next channel when the first already failed', () => {
  const r = S.pickChannel(['whatsapp', 'sms'], contact(), cfg(), {
    now: '2026-03-11T12:00:00Z',
    failedChannels: ['whatsapp'],
  });
  assert.equal(r.channel, 'sms');
  assert.equal(r.attempts.find((a) => a.channel === 'whatsapp').reason, 'already_failed');
});

test('skips a channel the contact has no address for', () => {
  const r = S.pickChannel(['email', 'sms'], contact({ email: null }), cfg(), { now: '2026-03-11T12:00:00Z' });
  assert.equal(r.channel, 'sms');
  assert.equal(r.attempts[0].reason, 'no_address');
});

test('WhatsApp outside the 24h window requires an approved template', () => {
  const stale = contact({ lastInboundAt: '2026-03-09T12:00:00Z' }); // 48h earlier
  const now = '2026-03-11T12:00:00Z';

  const blocked = S.pickChannel(['whatsapp'], stale, cfg(), { now });
  assert.equal(blocked.channel, null);
  assert.equal(blocked.attempts[0].reason, 'whatsapp_session_closed_no_template');

  const allowed = S.pickChannel(['whatsapp'], stale, cfg(), { now, templateApproved: true });
  assert.equal(allowed.channel, 'whatsapp');
  assert.equal(allowed.mode, 'template', 'must send as a template, not free-form');
});

test('per-channel consent refusal is honoured', () => {
  const r = S.pickChannel(['sms', 'email'], contact({ consent: { sms: false } }), cfg(), { now: '2026-03-11T12:00:00Z' });
  assert.equal(r.channel, 'email');
});

test('returns no channel rather than guessing when everything is exhausted', () => {
  const r = S.pickChannel(['sms'], contact({ phone: null }), cfg(), { now: '2026-03-11T12:00:00Z' });
  assert.equal(r.channel, null);
  assert.equal(r.reason, 'no_channel_available');
});

/* ------------------------------------------------------------------ *
 * Consent gate
 * ------------------------------------------------------------------ */

test('opted-out contacts are blocked for every message kind', () => {
  for (const kind of ['transactional', 'marketing', 'recall', 'review']) {
    assert.equal(S.consentGate({ optedOut: true }, cfg(), kind).allowed, false);
  }
});

test('transactional passes with recorded consent; marketing needs its own opt-in', () => {
  const c = { consentAt: '2026-01-01T00:00:00Z', marketingConsent: false };
  assert.equal(S.consentGate(c, cfg(), 'transactional').allowed, true);
  assert.equal(S.consentGate(c, cfg(), 'recall').allowed, false);
  assert.equal(S.consentGate({ ...c, marketingConsent: true }, cfg(), 'recall').allowed, true);
});

test('requireExplicitConsent blocks transactional sends with no consent record', () => {
  const c = cfg();
  c.compliance.requireExplicitConsent = true;
  assert.equal(S.consentGate({ consentAt: null }, c, 'transactional').reason, 'no_recorded_consent');
});

/* ------------------------------------------------------------------ *
 * Templating
 * ------------------------------------------------------------------ */

test('renders placeholders including dotted paths', () => {
  const out = S.renderTemplate('Hi {{firstName}}, {{ appt.time }} at {{businessName}}', {
    firstName: 'Sam', appt: { time: '10:00' }, businessName: 'Clinic',
  });
  assert.equal(out, 'Hi Sam, 10:00 at Clinic');
});

test('unknown placeholders never leak raw braces to a customer', () => {
  assert.equal(S.renderTemplate('Hi {{missing}}!', {}), 'Hi !');
});

test('opt-out footer is appended once and not duplicated', () => {
  const c = cfg();
  const once = S.withOptOutFooter('Your appointment is tomorrow.', c, 'sms');
  assert.match(once, /Reply STOP to opt out\./);
  assert.equal(S.withOptOutFooter(once, c, 'sms'), once, 'must not append twice');
});

test('opt-out footer is not added to email or voice', () => {
  const body = 'Your appointment is tomorrow.';
  assert.equal(S.withOptOutFooter(body, cfg(), 'email'), body);
  assert.equal(S.withOptOutFooter(body, cfg(), 'voice'), body);
});

/* ------------------------------------------------------------------ *
 * Intent classification
 * ------------------------------------------------------------------ */

test('confirmations are recognised across common phrasings', () => {
  for (const t of ['yes', 'Y', 'yep', 'Confirm', 'ok', 'sure', "I'll be there", 'YES']) {
    assert.equal(S.classifyIntent(t, cfg()).intent, 'confirm', `"${t}" should confirm`);
  }
});

test('cancellations are recognised across common phrasings', () => {
  for (const t of ['no', 'NO', 'cancel', "can't make it", 'not coming', 'nope']) {
    assert.equal(S.classifyIntent(t, cfg()).intent, 'cancel', `"${t}" should cancel`);
  }
});

test('reschedule beats cancel when both could match', () => {
  assert.equal(S.classifyIntent('can we move it to another time?', cfg()).intent, 'reschedule');
});

test('STOP wins over everything else in the same message', () => {
  const r = S.classifyIntent('yes I will be there but STOP texting me', cfg());
  assert.equal(r.intent, 'stop');
  assert.equal(r.confidence, 1);
});

test('word boundaries prevent false positives', () => {
  // "notebook" contains "no"; "yesterday" contains "yes".
  assert.notEqual(S.classifyIntent('I left my notebook there', cfg()).intent, 'cancel');
  assert.notEqual(S.classifyIntent('I came yesterday already', cfg()).intent, 'confirm');
});

test('numeric survey replies are classified as ratings', () => {
  const r = S.classifyIntent('5', cfg());
  assert.equal(r.intent, 'rating');
  assert.equal(r.rating, 5);
  assert.equal(S.classifyIntent('3/5', cfg()).rating, 3);
  assert.notEqual(S.classifyIntent('7', cfg()).intent, 'rating', 'out of range');
});

test('long chatty messages get reduced confidence so they can be escalated', () => {
  const short = S.classifyIntent('yes', cfg());
  const long = S.classifyIntent(
    'yes so about the thing we discussed last week I wanted to ask whether the price includes everything',
    cfg(),
  );
  assert.ok(long.confidence < short.confidence, 'long text must be less certain');
  assert.ok(long.confidence < 0.7, 'must fall below the escalation threshold');
});

test('unparseable text returns unknown rather than a guess', () => {
  const r = S.classifyIntent('what is the address of the clinic', cfg());
  assert.equal(r.intent, 'unknown');
  assert.equal(r.confidence, 0);
});

test('empty input is safe', () => {
  assert.equal(S.classifyIntent('', cfg()).intent, 'unknown');
  assert.equal(S.classifyIntent(null, cfg()).intent, 'unknown');
});

/* ------------------------------------------------------------------ *
 * State machine
 * ------------------------------------------------------------------ */

test('the happy path walks scheduled -> reminded -> confirmed -> completed', () => {
  let s = 'scheduled';
  s = S.nextState(s, 'reminder_sent').state; assert.equal(s, 'reminded');
  s = S.nextState(s, 'reply_confirm').state; assert.equal(s, 'confirmed');
  s = S.nextState(s, 'marked_attended').state; assert.equal(s, 'completed');
});

test('a later reminder cannot silently un-confirm an appointment', () => {
  const r = S.nextState('confirmed', 'reminder_sent');
  assert.equal(r.state, 'confirmed');
  assert.equal(r.changed, false);
});

test('completed appointments ignore stray inbound replies', () => {
  const r = S.nextState('completed', 'reply_confirm');
  assert.equal(r.state, 'completed');
  assert.match(r.reason, /^invalid_transition:/);
});

test('a cancelled customer can re-confirm', () => {
  assert.equal(S.nextState('cancelled', 'reply_confirm').state, 'confirmed');
});

test('intent maps to the right state event', () => {
  assert.equal(S.nextState('reminded', S.INTENT_TO_EVENT[S.INTENTS.CANCEL]).state, 'cancelled');
  assert.equal(S.nextState('reminded', S.INTENT_TO_EVENT[S.INTENTS.RESCHEDULE]).state, 'rescheduled');
});

/* ------------------------------------------------------------------ *
 * Failure classification and retry
 * ------------------------------------------------------------------ */

test('server and rate-limit errors retry; client errors do not', () => {
  assert.equal(S.classifyFailure(500, 'internal').retryable, true);
  assert.equal(S.classifyFailure(429, 'slow down').retryable, true);
  assert.equal(S.classifyFailure(0, 'socket hang up').retryable, true);
  assert.equal(S.classifyFailure(400, 'bad request').retryable, false);
});

test('permanent recipient failures never retry regardless of status code', () => {
  const r = S.classifyFailure(500, 'The number +1555 is not a valid mobile number');
  assert.equal(r.retryable, false);
  assert.equal(r.category, 'permanent_recipient');
});

test('retry backoff escalates and then clamps', () => {
  const c = cfg();
  assert.equal(S.retryDelaySeconds(1, c), 30);
  assert.equal(S.retryDelaySeconds(2, c), 300);
  assert.equal(S.retryDelaySeconds(3, c), 1800);
  assert.equal(S.retryDelaySeconds(99, c), 1800, 'clamps at the last rung');
});

/* ------------------------------------------------------------------ *
 * ROI
 * ------------------------------------------------------------------ */

test('ROI converts activity into currency and nets off message cost', () => {
  const events = [
    ...Array.from({ length: 100 }, () => ({ type: 'reminder_sent', channel: 'whatsapp' })),
    ...Array.from({ length: 70 }, () => ({ type: 'confirmed_after_reminder' })),
    { type: 'waitlist_filled' },
    { type: 'missed_call_recovered' },
  ];
  const r = S.computeRoi(events, cfg(), { baselineNoShowRate: 0.2 });
  assert.equal(r.remindersSent, 100);
  assert.equal(r.confirmationRate, 0.7);
  assert.equal(r.protectedRevenue, 70 * 180 * 0.2); // 2520
  assert.equal(r.refilledRevenue, 180);
  assert.equal(r.currency, 'USD');
  assert.ok(r.netValue > 0);
  assert.ok(r.roiMultiple > 1);
});

test('ROI is safe with no activity at all', () => {
  const r = S.computeRoi([], cfg());
  assert.equal(r.netValue, 0);
  assert.equal(r.confirmationRate, 0);
  assert.equal(r.roiMultiple, null, 'no division by zero');
});

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

test('appointment rows normalize from snake_case and camelCase alike', () => {
  const a = S.normalizeAppointment({
    appointment_id: 'x1', start_at: '2026-03-12T10:00:00Z', first_name: 'Sam',
    phone: '(555) 000-1111', sent_stages: 'T-7d,T-24h', opted_out: 'false', marketing_consent: 'true',
  });
  assert.equal(a.id, 'x1');
  assert.equal(a.startAt, '2026-03-12T10:00:00.000Z');
  assert.deepEqual(a.sentStages, ['T-7d', 'T-24h']);
  assert.equal(a.optedOut, false);
  assert.equal(a.contact.marketingConsent, true);
  assert.equal(a.contact.firstName, 'Sam');
});

test('phone normalization preserves E.164 and strips formatting', () => {
  assert.equal(S.normalizePhone('+1 (555) 000-1111'), '+15550001111');
  assert.equal(S.normalizePhone('555.000.1111'), '5550001111');
  assert.equal(S.normalizePhone(''), null);
  assert.equal(S.normalizePhone(null), null);
});

test('normalizeConfig fills every key the nodes read', () => {
  const c = S.normalizeConfig({});
  assert.equal(c.business.timezone, 'UTC');
  assert.ok(Array.isArray(c.reminders));
  assert.ok(Array.isArray(c.channels.priority));
  assert.ok(Array.isArray(c.compliance.stopKeywords));
});

test('normalizeConfig accepts a JSON string, as n8n variables supply it', () => {
  const c = S.normalizeConfig(JSON.stringify({ business: { name: 'X' } }));
  assert.equal(c.business.name, 'X');
});

/* ------------------------------------------------------------------ *
 * Every shipped preset must be a valid engine config
 * ------------------------------------------------------------------ */

test('all presets load, normalize, and produce sane decisions', async () => {
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(new URL('../config/presets/', import.meta.url)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 8, 'expected the full preset set');

  for (const f of files) {
    const preset = S.normalizeConfig(require(`../config/presets/${f}`));
    assert.ok(preset.business.name, `${f}: missing business name`);
    assert.ok(preset.templates.reminder, `${f}: missing reminder template`);

    for (const stage of preset.reminders) {
      assert.ok(stage.offsetHours > 0, `${f}: stage ${stage.stage} has a non-positive offset`);
      assert.ok(stage.channels?.length, `${f}: stage ${stage.stage} has no channels`);
      for (const ch of stage.channels) {
        assert.ok(preset.channels[ch], `${f}: stage ${stage.stage} uses undeclared channel "${ch}"`);
      }
    }
    // Offsets must be strictly decreasing once sorted, or windows overlap.
    const offsets = preset.reminders.map((r) => r.offsetHours).sort((a, b) => b - a);
    assert.equal(new Set(offsets).size, offsets.length, `${f}: duplicate reminder offsets`);

    const d = S.evaluateReminders(appt(), preset, '2026-03-11T12:00:00Z');
    assert.equal(d.length, preset.reminders.length, `${f}: decision count mismatch`);
  }
});
