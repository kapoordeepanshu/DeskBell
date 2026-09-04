#!/usr/bin/env node
/**
 * Generates config/presets/*.json from one shared base plus per-vertical overrides.
 *
 * Why a generator instead of seven hand-written files: presets drift. When a new
 * config key is added, every preset must gain it or the dispatcher falls back to a
 * default nobody chose. Keeping the base in one place makes that impossible.
 *
 * Adding a vertical = add one entry to VERTICALS below and run `npm run presets`.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'config', 'presets');

/** Every key the engine reads. Verticals override subsets of this. */
const BASE = {
  $schema: '../config.schema.json',
  version: 1,

  business: {
    name: 'Your Business',
    vertical: 'default',
    timezone: 'UTC',
    locale: 'en',
    currency: 'USD',
    // Used by the ROI digest to price a recovered slot. Set this honestly.
    avgAppointmentValue: 100,
    bookingUrl: 'https://example.com/book',
    reviewUrl: 'https://g.page/r/example/review',
    supportPhone: '+10000000000',
    ownerEmail: 'owner@example.com',
    // Appointments closer than this are never messaged (no time to act on it).
    minLeadTimeHours: 1,
  },

  channels: {
    // Order is the fallback ladder: try [0], on hard failure try [1], and so on.
    priority: ['whatsapp', 'sms', 'email'],
    whatsapp: { enabled: true, provider: 'meta-cloud', costPerMessage: 0.005 },
    sms: { enabled: true, provider: 'twilio', costPerMessage: 0.04 },
    email: { enabled: true, provider: 'smtp', costPerMessage: 0.0 },
    voice: { enabled: false, provider: 'vapi', costPerMessage: 0.15 },
  },

  reminders: [
    { stage: 'T-72h', offsetHours: 72, channels: ['whatsapp', 'email'], requiresConfirmation: false, onlyIfUnconfirmed: false },
    { stage: 'T-24h', offsetHours: 24, channels: ['whatsapp', 'sms'], requiresConfirmation: true, onlyIfUnconfirmed: false },
    { stage: 'T-3h', offsetHours: 3, channels: ['sms'], requiresConfirmation: false, onlyIfUnconfirmed: true },
  ],

  quietHours: {
    enabled: true,
    start: '21:00',
    end: '08:00',
    // What to do with a reminder that comes due inside quiet hours.
    // 'defer' sends at the next open window; 'drop' skips the stage entirely.
    strategy: 'defer',
  },

  escalation: {
    // Place a voice call when a confirmation-required stage got no reply.
    voiceEnabled: false,
    voiceCallIfUnconfirmedHours: 6,
    // Do not spend a voice call on a low-value slot.
    minValueForVoiceCall: 0,
    maxVoiceAttempts: 1,
  },

  missedCall: {
    enabled: true,
    // Speed is the entire product here. 78% of buyers pick whoever replies first.
    replyDelaySeconds: 15,
    channels: ['sms'],
    // Outside business hours the copy changes; see templates.missedCallAfterHours.
    createLead: true,
  },

  waitlist: {
    enabled: true,
    // On cancellation, offer the freed slot to this many people at once.
    // 1 = strict queue (polite, slow). >1 = race (fills faster, some disappointment).
    offerBatchSize: 3,
    offerExpiryMinutes: 45,
    maxRounds: 3,
  },

  followUp: {
    enabled: true,
    delayHoursAfterAppointment: 3,
    askForRating: true,
    // Ratings at or above this go to the public review link; below it go to
    // private feedback routed to the owner. Never gate reviews where prohibited.
    publicReviewThreshold: 4,
  },

  recall: {
    enabled: false,
    intervalDays: 180,
    channels: ['whatsapp', 'sms'],
  },

  compliance: {
    // Keywords are matched case-insensitively against the whole inbound message.
    stopKeywords: ['STOP', 'UNSUBSCRIBE', 'CANCEL ALL', 'OPTOUT', 'OPT OUT'],
    startKeywords: ['START', 'SUBSCRIBE', 'UNSTOP'],
    helpKeywords: ['HELP', 'INFO'],
    // Refuse to send to anyone with no recorded consent. Turning this off is
    // a legal decision you are making, not a technical convenience.
    requireExplicitConsent: true,
    includeOptOutFooter: true,
    // WhatsApp only allows free-form messages within 24h of the user's last
    // message; outside that window an approved template is required.
    whatsappSessionWindowHours: 24,
  },

  reliability: {
    maxSendAttempts: 3,
    retryBackoffSeconds: [30, 300, 1800],
    deadLetterAfterAttempts: 3,
    alertChannel: 'email',
    // How many times a reminder stage may be re-sent after the last attempt is
    // known not to have reached the customer — the provider refused it, or a
    // delivery receipt said it never arrived. The retry goes out on a different
    // channel. Set to 0 to never retry a stage; above 1 you are mostly paying
    // to learn the same thing about a number that is simply wrong.
    maxRedeliveryAttempts: 1,
  },

  ai: {
    // Optional. Regex handles the common replies; AI only sees what regex could
    // not classify, which keeps cost near zero.
    enabled: false,
    provider: 'anthropic',
    model: 'claude-opus-5',
    maxTokens: 1024,
    // Free-form replies the classifier is unsure about go to a human instead
    // of being guessed at.
    escalateBelowConfidence: 0.7,
  },

  templates: {
    reminder:
      'Hi {{firstName}}, this is a reminder of your {{serviceName}} appointment at {{businessName}} on {{appointmentDate}} at {{appointmentTime}}. Reply YES to confirm or NO to cancel.',
    reminderNoConfirm:
      'Hi {{firstName}}, see you on {{appointmentDate}} at {{appointmentTime}} for your {{serviceName}} at {{businessName}}.',
    confirmed:
      'Thanks {{firstName}}, you are confirmed for {{appointmentDate}} at {{appointmentTime}}. See you then.',
    cancelled:
      'Your appointment on {{appointmentDate}} at {{appointmentTime}} has been cancelled. Rebook any time: {{bookingUrl}}',
    reschedulePrompt:
      'No problem {{firstName}} — pick a new time here: {{bookingUrl}}',
    missedCall:
      'Hi, this is {{businessName}} — sorry we missed your call. Reply here and we will help, or book directly: {{bookingUrl}}',
    missedCallAfterHours:
      'Hi, this is {{businessName}}. We are closed right now but saw your call. Reply here and we will get back to you first thing, or book online: {{bookingUrl}}',
    waitlistOffer:
      'Hi {{firstName}}, a {{serviceName}} slot just opened on {{appointmentDate}} at {{appointmentTime}}. Reply YES within {{expiryMinutes}} minutes to claim it.',
    followUpRating:
      'Thanks for visiting {{businessName}} today, {{firstName}}. How did we do, 1 to 5?',
    reviewRequest:
      'That is great to hear. Would you mind leaving us a quick review? {{reviewUrl}}',
    privateFeedback:
      'Sorry to hear that. Could you tell us what went wrong? Your reply goes straight to the owner.',
    recall:
      'Hi {{firstName}}, it has been {{intervalDays}} days since your last {{serviceName}} at {{businessName}}. Ready to book again? {{bookingUrl}}',
    optOutFooter: ' Reply STOP to opt out.',
    helpReply:
      '{{businessName}}: reply YES to confirm an appointment, NO to cancel, or STOP to opt out. Call us on {{supportPhone}}.',
  },
};

/** Per-vertical overrides. Deep-merged over BASE. */
const VERTICALS = {
  default: {},

  dental: {
    business: { name: 'Bright Smile Dental', vertical: 'dental', avgAppointmentValue: 180, minLeadTimeHours: 2 },
    reminders: [
      { stage: 'T-7d', offsetHours: 168, channels: ['whatsapp', 'email'], requiresConfirmation: false, onlyIfUnconfirmed: false },
      { stage: 'T-24h', offsetHours: 24, channels: ['whatsapp', 'sms'], requiresConfirmation: true, onlyIfUnconfirmed: false },
      { stage: 'T-3h', offsetHours: 3, channels: ['sms'], requiresConfirmation: false, onlyIfUnconfirmed: true },
    ],
    // High-value chairs justify a voice call, and hygiene recall is the whole
    // retention model for a practice.
    escalation: { voiceEnabled: true, voiceCallIfUnconfirmedHours: 6, minValueForVoiceCall: 120, maxVoiceAttempts: 1 },
    channels: { voice: { enabled: true, provider: 'vapi', costPerMessage: 0.15 } },
    recall: { enabled: true, intervalDays: 180, channels: ['whatsapp', 'sms'] },
    templates: {
      reminder:
        'Hi {{firstName}}, reminder of your {{serviceName}} appointment at {{businessName}} on {{appointmentDate}} at {{appointmentTime}}. Reply YES to confirm or NO to cancel.',
      recall:
        'Hi {{firstName}}, you are due for your 6-month check-up and clean at {{businessName}}. Book here: {{bookingUrl}}',
    },
  },

  salon: {
    business: { name: 'Studio Cut', vertical: 'salon', avgAppointmentValue: 60, minLeadTimeHours: 1 },
    // Short booking horizon: a 7-day reminder is noise for a haircut.
    reminders: [
      { stage: 'T-24h', offsetHours: 24, channels: ['whatsapp', 'sms'], requiresConfirmation: true, onlyIfUnconfirmed: false },
      { stage: 'T-2h', offsetHours: 2, channels: ['sms'], requiresConfirmation: false, onlyIfUnconfirmed: true },
    ],
    waitlist: { enabled: true, offerBatchSize: 5, offerExpiryMinutes: 20, maxRounds: 3 },
    recall: { enabled: true, intervalDays: 35, channels: ['whatsapp'] },
    followUp: { enabled: true, delayHoursAfterAppointment: 2, askForRating: true, publicReviewThreshold: 4 },
    templates: {
      recall: 'Hi {{firstName}}, it has been about a month — time for a trim? Book with us: {{bookingUrl}}',
    },
  },

  physio: {
    business: { name: 'Motion Physiotherapy', vertical: 'physio', avgAppointmentValue: 90, minLeadTimeHours: 2 },
    // Course-of-treatment model: missing one session breaks the programme,
    // so confirmation matters more than message economy.
    reminders: [
      { stage: 'T-48h', offsetHours: 48, channels: ['whatsapp', 'email'], requiresConfirmation: false, onlyIfUnconfirmed: false },
      { stage: 'T-24h', offsetHours: 24, channels: ['whatsapp', 'sms'], requiresConfirmation: true, onlyIfUnconfirmed: false },
      { stage: 'T-3h', offsetHours: 3, channels: ['sms'], requiresConfirmation: false, onlyIfUnconfirmed: true },
    ],
    escalation: { voiceEnabled: true, voiceCallIfUnconfirmedHours: 8, minValueForVoiceCall: 60, maxVoiceAttempts: 1 },
    channels: { voice: { enabled: true, provider: 'vapi', costPerMessage: 0.15 } },
    recall: { enabled: true, intervalDays: 90, channels: ['whatsapp', 'sms'] },
  },

  veterinary: {
    business: { name: 'Paws & Claws Vet', vertical: 'veterinary', avgAppointmentValue: 120, minLeadTimeHours: 2 },
    reminders: [
      { stage: 'T-7d', offsetHours: 168, channels: ['whatsapp', 'email'], requiresConfirmation: false, onlyIfUnconfirmed: false },
      { stage: 'T-24h', offsetHours: 24, channels: ['whatsapp', 'sms'], requiresConfirmation: true, onlyIfUnconfirmed: false },
    ],
    // Vaccination recall is the highest-yield message a vet clinic sends.
    recall: { enabled: true, intervalDays: 365, channels: ['whatsapp', 'sms', 'email'] },
    templates: {
      reminder:
        'Hi {{firstName}}, reminder: {{petName}} has a {{serviceName}} appointment at {{businessName}} on {{appointmentDate}} at {{appointmentTime}}. Reply YES to confirm.',
      recall:
        'Hi {{firstName}}, {{petName}} is due for annual vaccinations at {{businessName}}. Book here: {{bookingUrl}}',
    },
  },

  'auto-repair': {
    business: { name: 'Northside Auto', vertical: 'auto-repair', avgAppointmentValue: 350, minLeadTimeHours: 4 },
    reminders: [
      { stage: 'T-48h', offsetHours: 48, channels: ['sms', 'email'], requiresConfirmation: true, onlyIfUnconfirmed: false },
      { stage: 'T-4h', offsetHours: 4, channels: ['sms'], requiresConfirmation: false, onlyIfUnconfirmed: true },
    ],
    // A bay sitting empty is expensive; a voice call is cheap by comparison.
    escalation: { voiceEnabled: true, voiceCallIfUnconfirmedHours: 12, minValueForVoiceCall: 200, maxVoiceAttempts: 2 },
    channels: { priority: ['sms', 'whatsapp', 'email'], voice: { enabled: true, provider: 'vapi', costPerMessage: 0.15 } },
    recall: { enabled: true, intervalDays: 180, channels: ['sms'] },
    templates: {
      recall: 'Hi {{firstName}}, your vehicle is due for a service at {{businessName}}. Book a slot: {{bookingUrl}}',
    },
  },

  'home-services': {
    business: { name: 'Reliable Plumbing', vertical: 'home-services', avgAppointmentValue: 220, minLeadTimeHours: 2 },
    reminders: [
      { stage: 'T-24h', offsetHours: 24, channels: ['sms'], requiresConfirmation: true, onlyIfUnconfirmed: false },
      { stage: 'T-2h', offsetHours: 2, channels: ['sms'], requiresConfirmation: false, onlyIfUnconfirmed: false },
    ],
    // For trades, the missed call IS the business. Reply as fast as the API allows.
    missedCall: { enabled: true, replyDelaySeconds: 5, channels: ['sms'], createLead: true },
    channels: { priority: ['sms', 'whatsapp', 'email'] },
    followUp: { enabled: true, delayHoursAfterAppointment: 4, askForRating: true, publicReviewThreshold: 4 },
    templates: {
      reminderNoConfirm:
        'Hi {{firstName}}, {{businessName}} here — our technician is scheduled for {{appointmentDate}} between {{appointmentTime}}. Reply if anything has changed.',
    },
  },

  tutoring: {
    business: { name: 'Bright Minds Tutoring', vertical: 'tutoring', avgAppointmentValue: 45, minLeadTimeHours: 1 },
    reminders: [
      { stage: 'T-24h', offsetHours: 24, channels: ['whatsapp'], requiresConfirmation: true, onlyIfUnconfirmed: false },
      { stage: 'T-1h', offsetHours: 1, channels: ['whatsapp', 'sms'], requiresConfirmation: false, onlyIfUnconfirmed: false },
    ],
    // Low ticket value: a voice call costs more than the session is worth.
    escalation: { voiceEnabled: false, voiceCallIfUnconfirmedHours: 0, minValueForVoiceCall: 999999, maxVoiceAttempts: 0 },
    waitlist: { enabled: true, offerBatchSize: 5, offerExpiryMinutes: 30, maxRounds: 2 },
    recall: { enabled: false, intervalDays: 0, channels: [] },
  },
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge; arrays replace wholesale so a vertical can shorten the ladder. */
function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? merge(base[k], v) : v;
  }
  return out;
}

mkdirSync(OUT, { recursive: true });

let count = 0;
for (const [name, overrides] of Object.entries(VERTICALS)) {
  const cfg = merge(BASE, overrides);
  cfg.business.vertical = name;
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(cfg, null, 2) + '\n');
  console.log(`  wrote config/presets/${name}.json`);
  count++;
}

// The example config is the neutral default, minus the schema pointer indirection.
writeFileSync(join(ROOT, 'config', 'config.example.json'), JSON.stringify(merge(BASE, VERTICALS.default), null, 2) + '\n');
console.log(`  wrote config/config.example.json`);
console.log(`${count} presets generated.`);
