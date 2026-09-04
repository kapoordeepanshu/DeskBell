# Compliance

**This is not legal advice.** It documents the mechanisms DeskBell gives you and
the decisions you have to make. Messaging law is jurisdictional and changes;
verify your obligations locally before you send to real customers.

The reason this document exists: every appointment-reminder template I could
find on GitHub ignores consent entirely. That is the difference between a demo
and something you can point at a real customer list.

---

## The one architectural guarantee

**Every outbound message goes through `deskbell/03 Message Dispatcher`.** No other
workflow talks to a provider directly. The consent gate, the opt-out footer, the
quiet-hours check and the WhatsApp session check all live in that one node, so
no future workflow can accidentally route around them.

If you add a channel, add it inside the dispatcher. Do not add an HTTP node that
sends a message anywhere else.

---

## Opt-out (STOP)

Handled in `deskbell/04 Inbound Handler`, and matched **before every other
intent**.

```js
// lib/core.js — classifyIntent()
const stop = keywordHit(c.stopKeywords);
if (stop) return { intent: INTENTS.STOP, confidence: 1, matched: stop };
```

This ordering is deliberate. *"Yes I'll be there but STOP texting me"* opts the
customer out. A classifier that read the "yes" first would confirm the
appointment and keep messaging them — which is the violation.

Defaults, configurable per deployment:

| Config key | Default |
|---|---|
| `compliance.stopKeywords` | `STOP`, `UNSUBSCRIBE`, `CANCEL ALL`, `OPTOUT`, `OPT OUT` |
| `compliance.startKeywords` | `START`, `SUBSCRIBE`, `UNSTOP` |
| `compliance.helpKeywords` | `HELP`, `INFO` |

On STOP: `contacts.opted_out` is set, `opted_out_at` is stamped, and an
`opted_out` event is written. Every later send is refused by `consentGate()` —
transactional messages included. The opt-out is permanent until the customer
sends START themselves.

> **US carriers require STOP and HELP handling** on A2P 10DLC traffic. Twilio
> implements STOP at carrier level too, but DeskBell handling it means your
> database also knows, so you stop *scheduling* messages rather than paying to
> have them silently blocked.

## Two kinds of consent

DeskBell distinguishes them because the law does:

| Kind | Requires | Examples |
|---|---|---|
| **Transactional** | `contacts.consent_at` — they booked with you | Reminders, confirmations, cancellations, waitlist offers |
| **Marketing** | `contacts.marketing_consent = true` — explicit opt-in | Recall campaigns, review requests |

```js
// lib/core.js — consentGate()
const promotional = kind === 'marketing' || kind === 'recall' || kind === 'review';
if (promotional && contact.marketingConsent !== true) {
  return { allowed: false, reason: 'no_marketing_consent' };
}
```

A recall message ("you're due for a check-up") is **marketing**, not a reminder,
even though it looks similar. DeskBell will not send it to someone who only
consented to transactional messages. Workflow 07 filters on
`marketing_consent = true` in SQL as well, so those contacts never even get an
idempotency key claimed.

Setting `compliance.requireExplicitConsent: true` tightens this further and
blocks transactional sends to contacts with no `consent_at` recorded at all.

## Quiet hours

`quietHours` prevents sends during local night. Enforced in
`evaluateReminders()` and in `shouldEscalateToVoice()`.

```jsonc
"quietHours": { "enabled": true, "start": "21:00", "end": "08:00", "strategy": "defer" }
```

- `defer` — hold the message until the window opens. If deferring would push it
  past the appointment, DeskBell drops it instead of sending something useless.
- `drop` — skip the stage entirely.

Evaluated in `business.timezone`, not server time, using `Intl` — so it stays
correct across DST transitions. There is a regression test for the US
spring-forward night, where a naive implementation sends at 09:00 instead of
08:00.

> **TCPA** restricts calls and texts to 8am–9pm in the **recipient's** local
> time. DeskBell uses one business timezone. If you serve customers across
> timezones, that is a gap you need to close — see the roadmap.

## WhatsApp: the 24-hour rule

Meta only allows free-form messages within 24 hours of the customer's last
message. Outside that window you must use a **pre-approved template**.

DeskBell tracks `contacts.last_inbound_at` and checks it before every WhatsApp
send:

```js
// lib/core.js — pickChannel()
const open = whatsappSessionOpen(contact.lastInboundAt, now, config);
if (!open && !options.templateApproved) {
  attempts.push({ channel, ok: false, reason: 'whatsapp_session_closed_no_template' });
  continue;   // falls through to SMS
}
```

**What you must do:** submit your reminder copy as a template in Meta Business
Manager and get it approved. Until then, either accept that WhatsApp reminders
fall through to SMS, or set `whatsapp.enabled: false` and use SMS only.

Sending free-form outside the window does not just fail — it risks your WhatsApp
Business number's quality rating and eventually the number itself.

## Opt-out footer

`compliance.includeOptOutFooter` appends "Reply STOP to opt out." to SMS and
WhatsApp. It is appended **once** — `withOptOutFooter()` checks whether the body
already mentions STOP, so a template that includes its own instruction does not
get a duplicate. It is not added to email or voice, where it does not apply.

## Review gating — read this before enabling it

Workflow 07 asks for a 1–5 rating. Workflow 04 routes 4–5 to your public review
link and 1–3 to a private feedback channel.

**This practice is restricted or prohibited in several places.** Google's
policies prohibit review gating. The US FTC has acted against businesses that
solicit reviews only from customers known to be happy. Some jurisdictions treat
it as deceptive advertising.

To disable gating and ask everyone equally:

```jsonc
"followUp": { "askForRating": false }
```

That sends the review request to every customer regardless of sentiment. It is
the safe default if you are unsure, and DeskBell ships with the gate documented
rather than hidden precisely so this is a decision you make consciously.

## Healthcare data

If you are a dental, medical, veterinary or physiotherapy practice, appointment
data is health data.

- **HIPAA (US)**: SMS and WhatsApp are not covered channels by default. You need
  a **BAA** with every processor — Twilio and Meta both offer one, but it is not
  automatic and it constrains which products you may use. Keep clinical detail
  out of message bodies; "your appointment" is safe, the procedure name may not
  be.
- **GDPR (EU/UK/CH)**: health data is a special category under Article 9.
  Self-hosting helps — the data never leaves your infrastructure — but you still
  need a lawful basis, a retention policy and a way to honour erasure requests.

DeskBell helps by keeping everything in **your** Postgres, and by defaulting
message templates to `{{serviceName}}` rather than clinical detail. Whether your
`serviceName` values are themselves sensitive is your call.

### Data subject requests

Erasure — `ON DELETE CASCADE` removes appointments and waitlist entries; message
logs are retained with a null contact for audit:

```sql
DELETE FROM deskbell.contacts WHERE phone = '+41791234567';
```

Export:

```sql
SELECT to_jsonb(c) AS contact,
       (SELECT jsonb_agg(a) FROM deskbell.appointments a WHERE a.contact_id = c.id) AS appointments,
       (SELECT jsonb_agg(m) FROM deskbell.message_log m WHERE m.contact_id = c.id) AS messages,
       (SELECT jsonb_agg(i) FROM deskbell.inbound_messages i WHERE i.contact_id = c.id) AS inbound
FROM deskbell.contacts c WHERE c.phone = '+41791234567';
```

Retention — DeskBell does not prune business data automatically, because the right
period is jurisdictional. Add a scheduled job if you need one:

```sql
DELETE FROM deskbell.message_log     WHERE created_at  < now() - interval '2 years';
DELETE FROM deskbell.inbound_messages WHERE received_at < now() - interval '2 years';
```

## Voice calls

Voice is off by default in every preset except `dental`, `physio` and
`auto-repair`, and gated on ticket value.

Additional obligations that are **not** automated for you:

- Many jurisdictions require automated calls to **identify themselves as
  automated** at the start. The default first message says "this is an automated
  reminder" — do not remove that.
- Call recording consent varies from one-party to all-party. VAPI records and
  transcribes by default; `call_logs.transcript` stores it. Check your local law
  and disable recording in VAPI if needed.
- Robocall rules (US TCPA, and equivalents elsewhere) can apply to automated
  voice even for transactional purposes.

The assistant prompt in workflow 06 deliberately forbids quoting prices,
offering alternative times, or giving clinical advice — a voice agent told to
"help with anything" will invent availability and book slots that do not exist.

## Audit trail

Everything is recorded, which is what lets you answer a complaint:

| Table | Answers |
|---|---|
| `message_log` | Every send attempt, its idempotency key, channel, body, cost, and outcome — including whether a provider receipt says it reached the handset |
| `inbound_messages` | Every reply, with the classified intent and confidence |
| `events` | Consent changes, confirmations, cancellations, opt-outs |
| `contacts.opted_out_at` | Exactly when someone opted out |
| `dead_letters` | Every failure, classified |

"Why did my patient get a text at 11pm?" is answerable in one query. That is the
point. So is "you never told me about the appointment" — `message_log.status`
and `delivered_at` record whether the provider says it arrived, rather than only
that you asked it to be sent.

Delivery receipts themselves carry no message content: a provider id, a status
word, and an error code when there is one. They are stored on the row that
already exists for that message, so they add nothing to erase that erasure did
not already cover.

---

## Pre-launch checklist

- [ ] `business.timezone` is the IANA name for where your **customers** are
- [ ] Quiet hours match your jurisdiction's restrictions
- [ ] Existing contacts have `consent_at` populated — do not import a cold list
- [ ] `marketing_consent` is `false` unless the customer explicitly opted in
- [ ] STOP tested end-to-end from a real handset
- [ ] HELP returns something useful with a real phone number in it
- [ ] WhatsApp templates submitted and approved, or WhatsApp disabled
- [ ] Twilio A2P 10DLC registration complete (US)
- [ ] BAA signed with every processor, if you handle health data
- [ ] Review gating decision made consciously
- [ ] Retention policy decided and scheduled
- [ ] `DESKBELL_BASE_URL` is HTTPS in production
