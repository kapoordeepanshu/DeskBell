<h1 align="center">&#128276; DeskBell</h1>

<p align="center">
  <b>The front desk that never sleeps.</b><br>
  Open-source no-show &amp; missed-call recovery, self-hosted on n8n.<br>
  Works for any business that books appointments.
</p>

<p align="center">
  <a href="#license"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="n8n" src="https://img.shields.io/badge/n8n-%3E%3D1.40-ea4b71">
  <img alt="status" src="https://img.shields.io/badge/status-beta-yellow">
  <img alt="tests" src="https://img.shields.io/badge/tests-63%20passing-brightgreen">
</p>

---

## The problem

Three leaks drain every appointment-based business, and all three are automatable:

| Leak | What it costs | Industry benchmark |
|---|---|---|
| **No-shows** | An empty chair earns nothing and cannot be resold | 10–30% of booked slots |
| **Missed calls** | The caller phones your competitor next | ~30% of SMB inbound calls go unanswered; **78% of customers buy from whoever replies first** |
| **Never rebooked** | A one-time customer instead of a recurring one | Recall and retention are almost always manual |

Commercial tools fix this for **$40–120/month** (Podium: **$300+/month**), per location, with your customer data on their servers.

`deskbell` is that engine, open-source, running on infrastructure you own. Your only cost is the messaging bill.

## What it actually does

```
   Booking source               DeskBell engine                  Channels
 ┌────────────────┐        ┌──────────────────────┐        ┌──────────────────┐
 │ Google Calendar│        │  Reminder ladder     │        │ WhatsApp Cloud   │
 │ Google Sheets  │───────▶│  T-7d → T-24h → T-3h │───────▶│ Twilio SMS       │
 │ Cal.com        │        │                      │        │ VAPI voice       │
 │ Webhook / API  │        │  Consent gate        │        │ Email (SMTP)     │
 └────────────────┘        │  Quiet hours         │        └──────────────────┘
                           │  Idempotency keys    │                 │
 ┌────────────────┐        │  State machine       │◀────────────────┘
 │ Missed call    │───────▶│  Fallback ladder     │   replies: CONFIRM / CANCEL
 │ (Twilio hook)  │        └──────────┬───────────┘             STOP / free text
 └────────────────┘                   │
                                      ▼
                      ┌────────────────────────────────┐
                      │ Waitlist gap-fill · Review     │
                      │ requests · Recall · ROI digest │
                      └────────────────────────────────┘
```

Eleven workflows, importable as JSON, driven by **one config file**.

## Why not just use an existing template?

I searched GitHub before building this. Here is the honest landscape:

| Project | Stars | What it is |
|---|---|---|
| `awesome-n8n-templates` | 24.8k | An unsorted dump of 280 JSON files |
| `n8n-workflow-templates` | 706 | A searchable dump of 2,053 JSON files |
| every appointment-reminder repo | **0–3** | A single-workflow demo, usually hardcoded to one clinic |

Template dumps get the stars; nobody ships a product. The demos all skip the seven things that decide whether this survives contact with a real business:

| | Typical template | `deskbell` |
|---|---|---|
| Duplicate sends on retry or rerun | ✗ resends | ✓ idempotency key per `(appointment, stage)` |
| State across restarts | ✗ in-memory or none | ✓ durable store, explicit state machine |
| STOP / consent / quiet hours | ✗ ignored | ✓ enforced before every single send |
| Channel fallback | ✗ one channel | ✓ WhatsApp → SMS → voice, cost-aware |
| Multi-vertical | ✗ hardcoded "dental" | ✓ config presets, zero workflow edits |
| Failure handling | ✗ silent | ✓ dead-letter queue + alerting |
| Proves its own value | ✗ nothing | ✓ ROI digest in currency |

**We are not competing with the template dumps. We are competing with Podium — and undercutting it to zero.**

## Verified, not just published

```
$ npm test
# tests 63
# pass 63
# fail 0

$ npm run validate
11 workflows, 150 nodes, 32 Code nodes validated — 0 error(s), 0 warning(s).
12 tables, 3 views in schema; 34 SQL nodes checked — 0 error(s).
```

The engine logic lives in [`lib/core.js`](lib/core.js) as pure functions with 63
unit tests — quiet hours across a DST transition, the reminder-window edge cases,
the state machine, consent, the channel ladder. It is inlined into the n8n Code
nodes at build time, so the tested code and the shipped code are the same code.
CI fails if they drift.

## Quickstart (about 10 minutes)

```bash
git clone https://github.com/kapoordeepanshu/DeskBell.git
cd DeskBell
cp .env.example .env      # fill in your provider keys
docker compose up -d      # n8n + Postgres on http://localhost:5678
npm run import            # create and cross-link all 11 workflows
```

Then:

1. Pick your vertical: `cp config/presets/dental.json config/config.json`
   (or `salon`, `physio`, `veterinary`, `auto-repair`, `home-services`, `tutoring`, `default`)
2. Edit `config/config.json` — business name, timezone, currency, `avgAppointmentValue`, booking URL
3. `npm run build && npm run import` — bakes your config into the engine
4. Connect credentials (Postgres, then Twilio / WhatsApp / SMTP / Google)
5. Test against your own phone, then activate

Workflows import **inactive** on purpose. Activating the scheduler before the
config is right would start texting real customers.

Full walkthrough: [`docs/setup.md`](docs/setup.md).

## The workflows

| # | Workflow | Trigger | What it does |
|---|---|---|---|
| 01 | `appointment-sync` | Schedule (15 min) | Pulls bookings from Calendar/Sheets/Cal.com into the normalized store |
| 02 | `reminder-scheduler` | Schedule (15 min) | Decides which reminders are due; enforces quiet hours and consent |
| 03 | `message-dispatcher` | Sub-workflow | Channel router with fallback ladder, templating, idempotent send + logging |
| 04 | `inbound-handler` | Webhook | Parses replies (CONFIRM/CANCEL/RESCHEDULE/STOP), drives the state machine |
| 05 | `missed-call-recovery` | Webhook | Twilio no-answer → instant text-back with booking link → lead row |
| 06 | `voice-agent-vapi` | Webhook + sub-workflow | Outbound voice for non-responders; logs post-call structured data |
| 07 | `post-visit-followup` | Schedule (hourly) | Review request (rating-gated) + recall scheduling |
| 08 | `waitlist-gapfill` | Sub-workflow | Cancellation → offers the slot to the waitlist, first confirm wins |
| 09 | `error-handler` | Error trigger | Dead-letters failures, alerts the owner, classifies retryable vs fatal |
| 10 | `daily-digest` | Schedule (daily) | Morning ops report + **revenue protected this week** |

## Configuration, not forks

One engine. The vertical lives entirely in config:

```jsonc
{
  "business":  { "name": "Bright Smile Dental", "timezone": "Asia/Kolkata",
                 "currency": "INR", "avgAppointmentValue": 2500 },
  "reminders": [
    { "stage": "T-7d",  "offsetHours": 168, "channels": ["whatsapp", "email"] },
    { "stage": "T-24h", "offsetHours": 24,  "channels": ["whatsapp", "sms"], "requiresConfirmation": true },
    { "stage": "T-3h",  "offsetHours": 3,   "channels": ["sms"], "onlyIfUnconfirmed": true }
  ],
  "quietHours": { "start": "21:00", "end": "08:00" },
  "escalation": { "voiceCallIfUnconfirmedHours": 6, "minValueForVoiceCall": 1500 },
  "recall":    { "enabled": true, "intervalDays": 180 }
}
```

Switching from a dental clinic to a barbershop is a preset swap — the reminder ladder shortens, the copy changes, recall drops from 180 days to 30. **No workflow is edited.** See [`config/presets/`](config/presets/).

## Design principles

1. **Logic lives in Code nodes, not node graphs.** Diffable in git, unit-testable, portable across n8n versions. Hand-authored 40-node visual graphs are unreviewable.
2. **Every send is idempotent.** The key `appointment_id|stage` is claimed via `INSERT ... ON CONFLICT DO NOTHING` *before* any provider is contacted, and settled after. A rerun inserts nothing, so it sends nothing. The guarantee is a Postgres `UNIQUE` constraint, not hopeful application logic.
3. **The consent gate is not optional and not bypassable.** It lives inside the dispatcher, so no workflow can route around it.
4. **Storage is swappable.** Postgres by default, Google Sheets for zero-infra. One data-access sub-workflow to change.
5. **Prove value or get deleted.** The daily digest reports currency, not message counts.

## Documentation

| | |
|---|---|
| [`docs/setup.md`](docs/setup.md) | Install, connect providers, test safely, go live |
| [`docs/architecture.md`](docs/architecture.md) | State machine, idempotency, the reminder-window bug everyone ships |
| [`docs/compliance.md`](docs/compliance.md) | STOP, consent, quiet hours, WhatsApp 24h rule, health data |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to add a vertical, a channel, or an intent |

## Compliance

STOP/UNSUBSCRIBE handling, quiet hours, consent records, WhatsApp 24-hour session rules, and template-approval requirements are enforced in the dispatcher and documented in [`docs/compliance.md`](docs/compliance.md).

**This is not legal advice.** You are responsible for TCPA / GDPR / HIPAA / local telecom compliance in your jurisdiction. `deskbell` gives you the mechanisms and the audit trail; the policy decisions are yours.

## Roadmap

- [ ] Cal.com and Calendly native sync
- [ ] Two-way rescheduling ("reply 2 for Thursday 3pm")
- [ ] Deposit / no-show fee collection (Stripe)
- [ ] Multi-location tenancy
- [ ] Telegram and RCS channels
- [ ] Prometheus metrics endpoint

## Contributing

Vertical presets are the highest-value contribution — if you run this for a business type not in `config/presets/`, send the preset. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](LICENSE).
