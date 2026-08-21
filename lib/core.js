/**
 * deskbell — core engine logic.
 *
 * Every function here is pure: same inputs, same outputs, no I/O, no clock reads.
 * `now` is always passed in. That is what makes the engine unit-testable, and it
 * is the main reason this project is not just another workflow dump.
 *
 * This file is inlined verbatim into the n8n Code nodes by
 * `scripts/build-workflows.mjs`. Do not add imports or top-level side effects.
 */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const STATES = Object.freeze({
  SCHEDULED: 'scheduled',
  REMINDED: 'reminded',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  RESCHEDULED: 'rescheduled',
  COMPLETED: 'completed',
  NO_SHOW: 'no_show',
});

/** States from which no further reminder is ever sent. */
const TERMINAL_STATES = Object.freeze([
  STATES.CANCELLED,
  STATES.RESCHEDULED,
  STATES.COMPLETED,
  STATES.NO_SHOW,
]);

const INTENTS = Object.freeze({
  CONFIRM: 'confirm',
  CANCEL: 'cancel',
  RESCHEDULE: 'reschedule',
  STOP: 'stop',
  START: 'start',
  HELP: 'help',
  RATING: 'rating',
  UNKNOWN: 'unknown',
});

/* ------------------------------------------------------------------ *
 * Time helpers (timezone-correct, DST-safe via Intl)
 * ------------------------------------------------------------------ */

/** "21:30" -> 1290 minutes since local midnight. */
function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Wall-clock parts of `date` in `timeZone`.
 * Intl is used rather than manual offset maths so DST transitions are correct.
 */
function zonedParts(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError('zonedParts: invalid date');
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  });
  const parts = {};
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
  // en-CA renders midnight as "24" in some runtimes; normalize to 0.
  const hour = Number(parts.hour) % 24;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
    minutesOfDay: hour * 60 + Number(parts.minute),
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Hours from `from` to `to`. Negative when `to` is in the past. */
function hoursBetween(from, to) {
  return (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000;
}

/**
 * Is `date` inside the configured quiet window in the business timezone?
 * Handles windows that wrap midnight (21:00 -> 08:00), which is the normal case.
 */
function inQuietHours(date, quietHours, timeZone) {
  if (!quietHours || quietHours.enabled === false) return false;
  const start = parseHHMM(quietHours.start);
  const end = parseHHMM(quietHours.end);
  if (start === null || end === null || start === end) return false;
  const nowMin = zonedParts(date, timeZone).minutesOfDay;
  return start > end
    ? nowMin >= start || nowMin < end // wraps midnight
    : nowMin >= start && nowMin < end; // same-day window
}

/**
 * The first instant at or after `date` whose local wall clock equals the end of
 * quiet hours.
 *
 * A naive "add N minutes of UTC" lands an hour off across a DST boundary — on a
 * spring-forward night the local day is only 23 hours long, so the jump
 * overshoots to 09:00. Instead we make a first guess and then converge on the
 * target wall-clock time, which is correct under both DST directions.
 */
function nextOpenWindow(date, quietHours, timeZone) {
  const d = new Date(date);
  if (!inQuietHours(d, quietHours, timeZone)) return d;
  const end = parseHHMM(quietHours.end);

  let deltaMin = end - zonedParts(d, timeZone).minutesOfDay;
  if (deltaMin <= 0) deltaMin += 1440;
  let candidate = new Date(d.getTime() + deltaMin * 60_000);

  // Converge on local `end`. Two passes suffice for any real offset; the third
  // is insurance against a half-hour-offset zone landing on a DST edge.
  for (let i = 0; i < 3; i++) {
    let diff = end - zonedParts(candidate, timeZone).minutesOfDay;
    if (diff === 0) break;
    // Take the shorter way round so we correct by minutes, not by a whole day.
    if (diff > 720) diff -= 1440;
    if (diff < -720) diff += 1440;
    candidate = new Date(candidate.getTime() + diff * 60_000);
  }
  // Correcting backwards must never produce a send in the past.
  if (candidate <= d) candidate = new Date(candidate.getTime() + 1440 * 60_000);
  return candidate;
}

/* ------------------------------------------------------------------ *
 * Idempotency
 * ------------------------------------------------------------------ */

/**
 * Deterministic, human-readable send key.
 *
 * Deliberately not a hash: when a customer complains about a duplicate text you
 * want to read the key in the log and know exactly which appointment and stage
 * produced it. Uniqueness is what matters, not opacity.
 */
function idempotencyKey(appointmentId, stage, discriminator) {
  const safe = (v) => String(v ?? '').trim().replace(/[|\s]+/g, '_');
  const base = `${safe(appointmentId)}|${safe(stage)}`;
  return discriminator ? `${base}|${safe(discriminator)}` : base;
}

/* ------------------------------------------------------------------ *
 * Reminder scheduling — the core decision
 * ------------------------------------------------------------------ */

/**
 * Decide which reminder stages are due for one appointment right now.
 *
 * Returns one decision object per configured stage, each carrying an explicit
 * `reason`. Nothing is silently dropped — an unsent reminder always has a
 * recorded cause, which is what makes support calls answerable.
 *
 * @param {object} appointment {id, startAt, status, confirmedAt, value, sentStages[], optedOut}
 * @param {object} config      normalized deskbell config
 * @param {Date|string} now
 * @returns {Array<{stage,due,reason,sendAt,idempotencyKey,channels}>}
 */
function evaluateReminders(appointment, config, now) {
  const nowDate = new Date(now);
  const stages = [...(config.reminders || [])].sort((a, b) => b.offsetHours - a.offsetHours);
  const sent = new Set(appointment.sentStages || []);
  const status = appointment.status || STATES.SCHEDULED;
  const hoursOut = hoursBetween(nowDate, appointment.startAt);
  const minLead = config.business?.minLeadTimeHours ?? 0;
  const decisions = [];

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    // The floor of this stage's window is the next (tighter) stage's offset.
    // Without it, a T-7d reminder fires at T-2h whenever a sync ran late and
    // the customer gets a "see you in a week" text two hours before arriving.
    const floor = i + 1 < stages.length ? stages[i + 1].offsetHours : minLead;
    const key = idempotencyKey(appointment.id, stage.stage);
    const decide = (due, reason, sendAt) =>
      decisions.push({
        stage: stage.stage,
        due,
        reason,
        sendAt: (sendAt || nowDate).toISOString(),
        idempotencyKey: key,
        channels: stage.channels || config.channels?.priority || [],
        requiresConfirmation: !!stage.requiresConfirmation,
      });

    if (sent.has(stage.stage)) { decide(false, 'already_sent'); continue; }
    if (appointment.optedOut) { decide(false, 'opted_out'); continue; }
    if (TERMINAL_STATES.includes(status)) { decide(false, `terminal_state:${status}`); continue; }
    if (hoursOut <= minLead) { decide(false, 'too_late'); continue; }
    if (hoursOut > stage.offsetHours) { decide(false, 'not_yet_due'); continue; }
    if (hoursOut < floor) { decide(false, 'window_missed'); continue; }
    if (stage.onlyIfUnconfirmed && status === STATES.CONFIRMED) { decide(false, 'already_confirmed'); continue; }

    if (inQuietHours(nowDate, config.quietHours, config.business?.timezone)) {
      if (config.quietHours?.strategy === 'drop') { decide(false, 'quiet_hours_drop'); continue; }
      const sendAt = nextOpenWindow(nowDate, config.quietHours, config.business?.timezone);
      // Deferring past the appointment itself is pointless — drop instead.
      if (hoursBetween(sendAt, appointment.startAt) <= minLead) { decide(false, 'quiet_hours_would_expire'); continue; }
      decide(true, 'quiet_hours_deferred', sendAt);
      continue;
    }
    decide(true, 'due');
  }
  return decisions;
}

/**
 * Should this unconfirmed appointment get a voice call?
 * Gated on ticket value so the engine never spends more on the call than the
 * slot is worth.
 */
function shouldEscalateToVoice(appointment, config, now) {
  const esc = config.escalation || {};
  if (!esc.voiceEnabled || config.channels?.voice?.enabled === false) {
    return { escalate: false, reason: 'voice_disabled' };
  }
  const status = appointment.status || STATES.SCHEDULED;
  if (status === STATES.CONFIRMED) return { escalate: false, reason: 'already_confirmed' };
  if (TERMINAL_STATES.includes(status)) return { escalate: false, reason: `terminal_state:${status}` };
  if (appointment.optedOut) return { escalate: false, reason: 'opted_out' };
  if ((appointment.voiceAttempts || 0) >= (esc.maxVoiceAttempts ?? 1)) {
    return { escalate: false, reason: 'max_attempts_reached' };
  }
  const value = Number(appointment.value ?? config.business?.avgAppointmentValue ?? 0);
  if (value < (esc.minValueForVoiceCall ?? 0)) return { escalate: false, reason: 'below_value_threshold' };

  const hoursOut = hoursBetween(now, appointment.startAt);
  if (hoursOut <= 0) return { escalate: false, reason: 'in_the_past' };
  if (hoursOut > (esc.voiceCallIfUnconfirmedHours ?? 6)) return { escalate: false, reason: 'not_yet_due' };
  if (inQuietHours(now, config.quietHours, config.business?.timezone)) {
    return { escalate: false, reason: 'quiet_hours' };
  }
  return { escalate: true, reason: 'unconfirmed_and_valuable' };
}

/* ------------------------------------------------------------------ *
 * Channel selection
 * ------------------------------------------------------------------ */

/**
 * Pick the next channel to try.
 *
 * Order comes from the stage, falling back to the global ladder. A channel is
 * skipped when it is disabled, already failed this attempt, or the contact has
 * no address for it. WhatsApp additionally needs either an open 24h session or
 * an approved template — sending outside that window is a policy violation, not
 * just a failed send.
 */
function pickChannel(candidates, contact, config, opts) {
  const options = opts || {};
  const failed = new Set(options.failedChannels || []);
  const order = (candidates && candidates.length ? candidates : config.channels?.priority) || [];
  const attempts = [];

  for (const channel of order) {
    const conf = config.channels?.[channel];
    if (!conf || conf.enabled === false) { attempts.push({ channel, ok: false, reason: 'channel_disabled' }); continue; }
    if (failed.has(channel)) { attempts.push({ channel, ok: false, reason: 'already_failed' }); continue; }

    const address = addressFor(channel, contact);
    if (!address) { attempts.push({ channel, ok: false, reason: 'no_address' }); continue; }
    if (contact.consent && contact.consent[channel] === false) {
      attempts.push({ channel, ok: false, reason: 'no_consent_for_channel' });
      continue;
    }
    if (channel === 'whatsapp') {
      const open = whatsappSessionOpen(contact.lastInboundAt, options.now || new Date(), config);
      if (!open && !options.templateApproved) {
        attempts.push({ channel, ok: false, reason: 'whatsapp_session_closed_no_template' });
        continue;
      }
      return { channel, address, mode: open ? 'freeform' : 'template', attempts };
    }
    return { channel, address, mode: 'direct', attempts };
  }
  return { channel: null, address: null, mode: null, attempts, reason: 'no_channel_available' };
}

function addressFor(channel, contact) {
  if (!contact) return null;
  if (channel === 'email') return contact.email || null;
  if (channel === 'whatsapp') return contact.whatsapp || contact.phone || null;
  return contact.phone || null; // sms, voice
}

/** WhatsApp free-form messaging is only allowed inside the 24h customer window. */
function whatsappSessionOpen(lastInboundAt, now, config) {
  if (!lastInboundAt) return false;
  const windowHours = config.compliance?.whatsappSessionWindowHours ?? 24;
  const elapsed = hoursBetween(lastInboundAt, now);
  return elapsed >= 0 && elapsed < windowHours;
}

/* ------------------------------------------------------------------ *
 * Consent gate — checked before every outbound message
 * ------------------------------------------------------------------ */

/**
 * The single chokepoint every send passes through.
 *
 * Transactional messages about an appointment the customer actually booked are
 * allowed without marketing consent; anything promotional (recall, reviews) is
 * not. `requireExplicitConsent` tightens even the transactional path.
 */
function consentGate(contact, config, kind) {
  const c = config.compliance || {};
  if (!contact) return { allowed: false, reason: 'no_contact' };
  if (contact.optedOut) return { allowed: false, reason: 'opted_out' };

  const promotional = kind === 'marketing' || kind === 'recall' || kind === 'review';
  if (promotional && contact.marketingConsent !== true) {
    return { allowed: false, reason: 'no_marketing_consent' };
  }
  if (c.requireExplicitConsent && contact.consentAt == null && !promotional) {
    return { allowed: false, reason: 'no_recorded_consent' };
  }
  return { allowed: true, reason: promotional ? 'marketing_consent_present' : 'transactional' };
}

/* ------------------------------------------------------------------ *
 * Templating
 * ------------------------------------------------------------------ */

/**
 * Render {{placeholders}}. Unknown keys resolve to '' rather than leaking a raw
 * "{{firstName}}" into a customer's inbox.
 */
function renderTemplate(template, vars) {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const value = path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), vars);
    return value == null ? '' : String(value);
  });
}

/** Append the opt-out footer once, and only where policy needs it. */
function withOptOutFooter(body, config, channel) {
  const c = config.compliance || {};
  if (!c.includeOptOutFooter) return body;
  if (channel === 'email' || channel === 'voice') return body;
  const footer = (config.templates?.optOutFooter || ' Reply STOP to opt out.').trim();
  return body.toUpperCase().includes('STOP') ? body : `${body.trim()} ${footer}`;
}

/* ------------------------------------------------------------------ *
 * Inbound intent classification
 * ------------------------------------------------------------------ */

/**
 * Classify an inbound reply without an LLM.
 *
 * Compliance keywords are matched first and are absolute: "STOP" must opt the
 * customer out even if the rest of the message is chatty. Everything else is
 * word-boundary matched so "notebook" is never read as "no".
 *
 * Returns confidence so the caller can route low-confidence text to AI or a human.
 */
function classifyIntent(text, config) {
  const raw = String(text ?? '').trim();
  if (!raw) return { intent: INTENTS.UNKNOWN, confidence: 0, matched: null };
  const upper = raw.toUpperCase();
  const c = config.compliance || {};

  const keywordHit = (list) =>
    (list || []).find((k) => new RegExp(`\\b${escapeRegex(String(k).toUpperCase())}\\b`).test(upper));

  const stop = keywordHit(c.stopKeywords);
  if (stop) return { intent: INTENTS.STOP, confidence: 1, matched: stop };
  const start = keywordHit(c.startKeywords);
  if (start) return { intent: INTENTS.START, confidence: 1, matched: start };
  const help = keywordHit(c.helpKeywords);
  if (help) return { intent: INTENTS.HELP, confidence: 1, matched: help };

  // A bare 1-5 is a rating reply to the post-visit survey.
  const rating = /^([1-5])(\s*\/\s*5)?$/.exec(raw);
  if (rating) return { intent: INTENTS.RATING, confidence: 1, rating: Number(rating[1]), matched: rating[0] };

  const patterns = [
    [INTENTS.RESCHEDULE, /\b(reschedul\w*|change|move|shift|postpone|another time|different time|new time)\b/i, 0.9],
    [INTENTS.CANCEL, /\b(cancel|can'?t make it|cannot make it|not coming|won'?t be able|unable to come)\b/i, 0.95],
    [INTENTS.CONFIRM, /\b(yes|y|yep|yeah|yup|confirm\w*|ok|okay|sure|coming|i'?ll be there|see you)\b/i, 0.9],
    [INTENTS.CANCEL, /\b(no|n|nope|nah)\b/i, 0.75],
  ];
  for (const [intent, re, confidence] of patterns) {
    const m = re.exec(raw);
    // A long message that merely contains "yes" is not a reliable confirmation.
    if (m) return { intent, confidence: raw.length > 60 ? confidence - 0.25 : confidence, matched: m[0] };
  }
  return { intent: INTENTS.UNKNOWN, confidence: 0, matched: null };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ *
 * State machine
 * ------------------------------------------------------------------ */

const TRANSITIONS = Object.freeze({
  [STATES.SCHEDULED]: {
    reminder_sent: STATES.REMINDED,
    reply_confirm: STATES.CONFIRMED,
    reply_cancel: STATES.CANCELLED,
    reply_reschedule: STATES.RESCHEDULED,
    marked_attended: STATES.COMPLETED,
    marked_no_show: STATES.NO_SHOW,
  },
  [STATES.REMINDED]: {
    reminder_sent: STATES.REMINDED,
    reply_confirm: STATES.CONFIRMED,
    reply_cancel: STATES.CANCELLED,
    reply_reschedule: STATES.RESCHEDULED,
    marked_attended: STATES.COMPLETED,
    marked_no_show: STATES.NO_SHOW,
  },
  [STATES.CONFIRMED]: {
    reminder_sent: STATES.CONFIRMED, // a later reminder must not undo a confirmation
    reply_cancel: STATES.CANCELLED,
    reply_reschedule: STATES.RESCHEDULED,
    marked_attended: STATES.COMPLETED,
    marked_no_show: STATES.NO_SHOW,
  },
  [STATES.CANCELLED]: { reply_confirm: STATES.CONFIRMED }, // customer changed their mind
  [STATES.RESCHEDULED]: {},
  [STATES.COMPLETED]: {},
  [STATES.NO_SHOW]: {},
});

/**
 * Apply an event to an appointment state.
 * Invalid transitions are refused, not thrown — a stray inbound "yes" on a
 * completed appointment should be ignored, not page anyone.
 */
function nextState(current, event) {
  const from = current || STATES.SCHEDULED;
  const to = TRANSITIONS[from]?.[event];
  if (!to) return { state: from, changed: false, reason: `invalid_transition:${from}->${event}` };
  return { state: to, changed: to !== from, reason: `${from}->${to}` };
}

const INTENT_TO_EVENT = Object.freeze({
  [INTENTS.CONFIRM]: 'reply_confirm',
  [INTENTS.CANCEL]: 'reply_cancel',
  [INTENTS.RESCHEDULE]: 'reply_reschedule',
});

/* ------------------------------------------------------------------ *
 * Retry policy
 * ------------------------------------------------------------------ */

/** Split provider failures into retry-worthy and permanent. */
function classifyFailure(statusCode, errorMessage) {
  const code = Number(statusCode) || 0;
  const msg = String(errorMessage || '').toLowerCase();
  if (/invalid|not a valid|unsubscrib|blacklist|opted out|landline|unreachable destination/.test(msg)) {
    return { retryable: false, category: 'permanent_recipient' };
  }
  if (code === 429) return { retryable: true, category: 'rate_limited' };
  if (code >= 500) return { retryable: true, category: 'provider_error' };
  if (code === 408 || code === 0) return { retryable: true, category: 'network' };
  if (code >= 400) return { retryable: false, category: 'bad_request' };
  return { retryable: false, category: 'unknown' };
}

/** Backoff for `attempt` (1-based), clamped to the configured ladder. */
function retryDelaySeconds(attempt, config) {
  const ladder = config.reliability?.retryBackoffSeconds || [30, 300, 1800];
  return ladder[Math.min(Math.max(attempt, 1) - 1, ladder.length - 1)];
}

/* ------------------------------------------------------------------ *
 * ROI — the number that keeps this switched on
 * ------------------------------------------------------------------ */

/**
 * Turn the message log into currency.
 *
 * `protectedRevenue` counts only appointments that were unconfirmed, then
 * confirmed after a deskbell reminder — the ones plausibly saved. It deliberately
 * does not claim credit for everything that happened to show up.
 */
function computeRoi(events, config, options) {
  const opts = options || {};
  const avg = Number(config.business?.avgAppointmentValue || 0);
  const noShowRate = Number(opts.baselineNoShowRate ?? 0.2);

  let remindersSent = 0, confirmations = 0, cancellationsRecovered = 0;
  let missedCallsRecovered = 0, messageCost = 0, slotsRefilled = 0;

  for (const e of events || []) {
    if (e.type === 'reminder_sent') {
      remindersSent++;
      messageCost += Number(config.channels?.[e.channel]?.costPerMessage || 0);
    } else if (e.type === 'confirmed_after_reminder') confirmations++;
    else if (e.type === 'cancelled_early') cancellationsRecovered++;
    else if (e.type === 'waitlist_filled') slotsRefilled++;
    else if (e.type === 'missed_call_recovered') missedCallsRecovered++;
    else if (e.type === 'message_sent') messageCost += Number(config.channels?.[e.channel]?.costPerMessage || 0);
  }

  // Each confirmation removes roughly one baseline no-show's worth of risk.
  const protectedRevenue = confirmations * avg * noShowRate;
  const refilledRevenue = slotsRefilled * avg;
  const recoveredCallRevenue = missedCallsRecovered * avg;
  const grossValue = protectedRevenue + refilledRevenue + recoveredCallRevenue;

  return {
    currency: config.business?.currency || 'USD',
    remindersSent,
    confirmations,
    confirmationRate: remindersSent ? round2(confirmations / remindersSent) : 0,
    cancellationsRecovered,
    slotsRefilled,
    missedCallsRecovered,
    messageCost: round2(messageCost),
    protectedRevenue: round2(protectedRevenue),
    refilledRevenue: round2(refilledRevenue),
    recoveredCallRevenue: round2(recoveredCallRevenue),
    netValue: round2(grossValue - messageCost),
    roiMultiple: messageCost > 0 ? round2(grossValue / messageCost) : null,
  };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

/** Coerce an appointment row from any source into the engine's shape. */
function normalizeAppointment(row) {
  const r = row || {};
  const startAt = r.startAt || r.start_at || r.start || r.startTime;
  return {
    id: String(r.id || r.appointmentId || r.appointment_id || r.uid || ''),
    externalId: r.externalId || r.external_id || null,
    startAt: startAt ? new Date(startAt).toISOString() : null,
    endAt: r.endAt || r.end_at ? new Date(r.endAt || r.end_at).toISOString() : null,
    status: r.status || STATES.SCHEDULED,
    confirmedAt: r.confirmedAt || r.confirmed_at || null,
    serviceName: r.serviceName || r.service_name || r.service || r.summary || 'appointment',
    value: r.value != null ? Number(r.value) : null,
    voiceAttempts: Number(r.voiceAttempts || r.voice_attempts || 0),
    sentStages: parseList(r.sentStages ?? r.sent_stages),
    optedOut: r.optedOut === true || r.opted_out === true || String(r.opted_out).toLowerCase() === 'true',
    contact: {
      id: String(r.contactId || r.contact_id || r.phone || ''),
      firstName: r.firstName || r.first_name || (r.name ? String(r.name).split(' ')[0] : '') || '',
      name: r.name || r.customerName || r.customer_name || '',
      phone: normalizePhone(r.phone || r.contactPhone || r.contact_phone),
      whatsapp: normalizePhone(r.whatsapp || r.phone || r.contactPhone),
      email: r.email || r.contactEmail || r.contact_email || null,
      petName: r.petName || r.pet_name || null,
      lastInboundAt: r.lastInboundAt || r.last_inbound_at || null,
      consentAt: r.consentAt || r.consent_at || null,
      marketingConsent: r.marketingConsent === true || r.marketing_consent === true ||
        String(r.marketing_consent).toLowerCase() === 'true',
      optedOut: r.optedOut === true || r.opted_out === true || String(r.opted_out).toLowerCase() === 'true',
    },
  };
}

function parseList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (v == null || v === '') return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/** E.164-ish normalization. Keeps a leading +, strips everything else. */
function normalizePhone(value) {
  if (!value) return null;
  const s = String(value).trim();
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  return plus ? `+${digits}` : digits;
}

/** Fill in every key the engine reads so no node has to guard for undefined. */
function normalizeConfig(raw) {
  const cfg = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  cfg.business = cfg.business || {};
  cfg.business.timezone = cfg.business.timezone || 'UTC';
  cfg.business.currency = cfg.business.currency || 'USD';
  cfg.business.minLeadTimeHours = cfg.business.minLeadTimeHours ?? 1;
  cfg.channels = cfg.channels || {};
  cfg.channels.priority = cfg.channels.priority || ['sms'];
  cfg.reminders = Array.isArray(cfg.reminders) ? cfg.reminders : [];
  cfg.quietHours = cfg.quietHours || { enabled: false };
  cfg.escalation = cfg.escalation || {};
  cfg.compliance = cfg.compliance || {};
  cfg.compliance.stopKeywords = cfg.compliance.stopKeywords || ['STOP'];
  cfg.compliance.startKeywords = cfg.compliance.startKeywords || ['START'];
  cfg.compliance.helpKeywords = cfg.compliance.helpKeywords || ['HELP'];
  cfg.reliability = cfg.reliability || {};
  cfg.templates = cfg.templates || {};
  return cfg;
}

/* ------------------------------------------------------------------ *
 * Exports — Node for tests, globals when inlined into an n8n Code node
 * ------------------------------------------------------------------ */

const DESKBELL = {
  STATES, TERMINAL_STATES, INTENTS, TRANSITIONS, INTENT_TO_EVENT,
  parseHHMM, zonedParts, hoursBetween, inQuietHours, nextOpenWindow,
  idempotencyKey, evaluateReminders, shouldEscalateToVoice,
  pickChannel, addressFor, whatsappSessionOpen, consentGate,
  renderTemplate, withOptOutFooter, classifyIntent, nextState,
  classifyFailure, retryDelaySeconds, computeRoi,
  normalizeAppointment, normalizeConfig, normalizePhone,
};

if (typeof module !== 'undefined' && module.exports) module.exports = DESKBELL;
