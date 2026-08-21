# Setup

From nothing to a running reminder engine. Budget about 30 minutes for the first
run, most of it waiting on provider approvals.

---

## 1. Start the stack

```bash
git clone https://github.com/kapoordeepanshu/DeskBell.git
cd DeskBell
cp .env.example .env
```

Edit `.env`. The three you cannot skip:

```bash
POSTGRES_PASSWORD=...                 # anything long
N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)
N8N_BASIC_AUTH_PASSWORD=...
```

Then:

```bash
docker compose up -d
```

n8n is on <http://localhost:5678>. Postgres comes up with `data/schema.sql`
already applied.

> **Not using Docker?** Point `DB_POSTGRESDB_*` at your own Postgres and apply
> the schema by hand: `psql "$DATABASE_URL" -f data/schema.sql`.

## 2. Make webhooks reachable

Twilio and WhatsApp cannot post to `localhost`. For local testing:

```bash
cloudflared tunnel --url http://localhost:5678
```

Put the public URL in `.env` as `DESKBELL_BASE_URL`, then `docker compose up -d`
again. In production this is your real domain behind HTTPS.

## 3. Import the workflows

Create an API key in n8n (**Settings → API → Create an API key**), add it to
`.env` as `N8N_API_KEY`, then:

```bash
npm run import
```

This creates all 11 workflows and wires the sub-workflow references between
them. Re-running it later updates them in place without touching your
credentials.

> Importing the JSON by hand through the UI also works, but then you must
> replace the `__DESKBELL_WF_*__` placeholders yourself — each "Execute Workflow"
> node needs the real id of the workflow it calls. The script exists to save you
> that.

## 4. Create the Postgres credential

**n8n → Credentials → New → Postgres.** The name must be exactly
`deskbell postgres` — the import script looks it up by name.

| Field | Value |
|---|---|
| Host | `postgres` (or `localhost` if n8n is not in Docker) |
| Database | `deskbell` |
| User | `deskbell` |
| Password | your `POSTGRES_PASSWORD` |
| Port | `5432` |

Run `npm run import` once more and it attaches the credential to all 34 database
nodes automatically.

## 5. Choose your vertical

```bash
cp config/presets/dental.json config/config.json
```

Available: `dental`, `salon`, `physio`, `veterinary`, `auto-repair`,
`home-services`, `tutoring`, `default`.

Open **deskbell/00 Config** in n8n and paste your config into the `INLINE_CONFIG`
object in the "Load Config" node. At minimum change:

```jsonc
"business": {
  "name": "Your Business",
  "timezone": "Europe/Zurich",        // IANA name — drives quiet hours
  "currency": "CHF",
  "avgAppointmentValue": 180,          // set this honestly; it drives the ROI report
  "bookingUrl": "https://...",
  "ownerEmail": "you@yourbusiness.com"
}
```

The config node validates itself on load and throws if a reminder stage
references a channel you have not declared, so a typo fails immediately rather
than silently sending nothing.

## 6. Connect a messaging channel

You need at least one. Start with whichever you already have.

### Twilio SMS

**n8n → Credentials → New → Header Auth** is *not* what you want here. Create a
**Basic Auth** credential:

| Field | Value |
|---|---|
| Name | `deskbell twilio` |
| User | your Account SID |
| Password | your Auth Token |

Attach it to the "Send SMS (Twilio)" node in **deskbell/03 Message Dispatcher**.
Put your Account SID and sending number in `.env` as `TWILIO_ACCOUNT_SID` and
`TWILIO_FROM_NUMBER`.

In the Twilio console, on your number:

| Setting | URL |
|---|---|
| **A message comes in** | `{DESKBELL_BASE_URL}/webhook/deskbell/inbound` |
| **Call status changes** | `{DESKBELL_BASE_URL}/webhook/deskbell/call-status` |

The second one is what powers missed-call recovery.

### WhatsApp Business Cloud API

Create a **Header Auth** credential named `deskbell whatsapp`:

- Name: `Authorization`
- Value: `Bearer EAAG...` (your permanent access token)

Attach it to the "Send WhatsApp" node. Set `WHATSAPP_PHONE_NUMBER_ID` in `.env`.

In Meta's dashboard, subscribe the webhook to
`{DESKBELL_BASE_URL}/webhook/deskbell/inbound` using your `WHATSAPP_VERIFY_TOKEN`.

> **The 24-hour rule.** WhatsApp only allows free-form messages within 24 hours
> of the customer's last message. Outside that window you need a
> **pre-approved template**. DeskBell detects this and falls through to SMS rather
> than failing, but you should submit templates for your reminder copy — see
> [`compliance.md`](compliance.md).

### Email

Create an **SMTP** credential and attach it to the three email nodes
(dispatcher, error handler, daily digest). Set `DESKBELL_FROM_EMAIL` in `.env`.

Skipping email means no daily digest and **no error alerts** — you will not
notice when DeskBell stops working. Do not skip it.

## 7. Connect a booking source

**Option A — Google Calendar.** Connect a Google Calendar credential to the
"Fetch Calendar Events" node in **deskbell/01 Appointment Sync**. DeskBell reads the
customer's phone from the event description:

```
phone: +41791234567
value: 180
```

**Option B — push from your booking system.** POST to
`{DESKBELL_BASE_URL}/webhook/deskbell/appointments`:

```json
{
  "id": "booking_12345",
  "startAt": "2026-09-02T14:30:00Z",
  "endAt": "2026-09-02T15:00:00Z",
  "serviceName": "Cleaning",
  "name": "Alex Meyer",
  "phone": "+41791234567",
  "email": "alex@example.com",
  "value": 180
}
```

`id` must be stable — it is the deduplication key. Sending the same `id` with a
new `startAt` reschedules the appointment and resets its reminder stages.

## 8. Test before going live

**Do not activate workflow 02 yet.** Test with your own phone number first.

1. Insert a test appointment 25 hours out:

   ```sql
   INSERT INTO deskbell.contacts (first_name, name, phone, whatsapp, consent_at)
   VALUES ('Test', 'Test Person', '+41790000000', '+41790000000', now())
   RETURNING id;

   INSERT INTO deskbell.appointments (external_id, contact_id, start_at, end_at, service_name, value)
   VALUES ('test_1', <that id>, now() + interval '25 hours', now() + interval '26 hours', 'Test', 100);
   ```

2. Open **deskbell/02 Reminder Scheduler** and click **Execute Workflow**.
3. Inspect the "Evaluate Reminder Ladder" node output. Every stage carries a
   `reason` — `not_yet_due` at 25 hours is correct, since the T-24h window has
   not opened.
4. Move the appointment to 23 hours out and run again. You should get one due
   stage and one text.
5. Reply `YES` and confirm the state flips:

   ```sql
   SELECT status, confirmed_at FROM deskbell.appointments WHERE external_id = 'test_1';
   ```

6. Run the scheduler again. Nothing should send — the stage is recorded in
   `sent_stages` and the idempotency key is claimed. **This is the check that
   matters most.** If it sends twice, stop and open an issue.

## 9. Go live

Activate in this order:

1. **09 Error Handler** — first, so failures are visible from the start.
2. **00 Config**, **03 Dispatcher**, **06 Voice**, **08 Waitlist** — sub-workflows.
3. **01 Appointment Sync** — let it run once and check the data looks right.
4. **04 Inbound Handler** — so replies are captured.
5. **02 Reminder Scheduler** — this is the one that starts messaging customers.
6. **07 Follow-up**, **10 Daily Digest** — once the core is proven.

Watch the first morning's digest. If `avgAppointmentValue` is set honestly, the
"revenue protected" line tells you within a week whether this is worth running.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing sends, no errors | Workflow 02 inactive, or every stage reports `not_yet_due`. Check the "Evaluate Reminder Ladder" output — each stage states its reason. |
| `deskbell config invalid: ...` | A reminder stage references an undeclared channel, or two stages share an `offsetHours`. The message names the problem. |
| Messages send twice | Should be impossible. Check `data/schema.sql` actually applied the UNIQUE index on `message_log.idempotency_key`: `\d deskbell.message_log`. |
| Replies not recognised | Look in `deskbell.inbound_messages` — if `intent` is `unknown`, the wording is not in the regex. Add it to `lib/core.js`, run `npm run build`, re-import. |
| WhatsApp fails, SMS works | Almost always the 24-hour window. Check the dispatcher's "Consent Gate & Plan Attempts" output for `whatsapp_session_closed_no_template`. |
| Sends stuck in `claimed` | A crash mid-dispatch. `SELECT * FROM deskbell.v_stuck_sends;` shows them. |

## Upgrading

```bash
git pull
npm run build      # regenerate workflows from lib/core.js
npm run import     # push them into n8n
```

`npm run build` bakes `config/config.json` into workflow 00 if that file exists,
falling back to `config.example.json` otherwise. So keep your real settings in
`config/config.json` (it is gitignored) and upgrades will never discard them.

If you would rather not keep config in a file at all, set the `DESKBELL_CONFIG`
environment variable to a JSON string — it overrides whatever is baked in.
