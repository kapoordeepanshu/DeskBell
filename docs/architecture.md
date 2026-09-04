# Architecture

How DeskBell is put together and why, including the decisions that would be easy
to get wrong.

---

## Shape of the system

```
                       ┌──────────────────────────┐
                       │  deskbell/00 Config        │
                       │  one source of truth     │
                       └────────────┬─────────────┘
                                    │ every workflow calls it
      ┌─────────────────────────────┼──────────────────────────────┐
      │                             │                              │
┌─────▼──────┐   ┌──────────────────▼─────┐   ┌────────────────────▼───┐
│ 01 Sync    │──▶│ 02 Reminder Scheduler  │──▶│ 03 Message Dispatcher  │──▶ providers
│ (15 min)   │   │ (15 min)               │   │ THE ONLY EXIT POINT    │
└────────────┘   └────────────────────────┘   └────────▲───────────────┘
                                                       │
┌────────────┐   ┌────────────────────────┐            │
│ 05 Missed  │──▶│ 04 Inbound Handler     │────────────┤
│    Call    │   │ (webhook)              │            │
└────────────┘   └───────┬────────────────┘            │
                         │ on cancellation             │
                 ┌───────▼────────────────┐            │
                 │ 08 Waitlist Gap-fill   │────────────┤
                 └────────────────────────┘            │
                 ┌────────────────────────┐            │
                 │ 07 Follow-up & Recall  │────────────┘
                 └────────────────────────┘
                 ┌────────────────────────┐   ┌────────────────────────┐
                 │ 06 Voice Agent (VAPI)  │   │ 10 Daily Digest        │
                 └────────────────────────┘   └────────────────────────┘
                 ┌────────────────────────┐
                 │ 09 Error Handler       │◀── error workflow for all of the above
                 └────────────────────────┘
                 ┌────────────────────────┐
                 │ 11 Delivery Receipts   │──▶ writes back to message_log
                 │ (webhook + from 04)    │    what actually reached the phone
                 └────────────────────────┘
```

Two rules hold this together:

1. **One config workflow.** Nothing hardcodes a timezone, a template or a
   threshold. Changing behaviour means editing one node.
2. **One exit point.** Every message leaves through workflow 03. That is what
   makes the consent gate unbypassable rather than merely present.

## Where the logic lives

Almost all of it is in [`lib/core.js`](../lib/core.js) as pure functions, and it
is inlined into the n8n Code nodes at build time by
`scripts/build-workflows.mjs`.

This is unusual for an n8n project and it is the most important decision in the
repo:

| | Logic in the node graph | Logic in `lib/core.js` |
|---|---|---|
| Reviewable in a PR | A 40-node diff nobody reads | A readable function diff |
| Testable | Only by running the workflow | 78 unit tests, `npm test` |
| Consistent across workflows | Three drifting copies of the quiet-hours check | One implementation, inlined everywhere |
| Portable across n8n versions | Node parameter schemas change | Plain JavaScript |

Every function is pure — `now` is always a parameter, never `new Date()` inside.
That is what makes DST and quiet-hours behaviour testable at all.

```bash
npm test       # 78 tests against the engine
npm run build  # regenerate the workflows from it
npm run verify # build + validate + test + fail if generated files drifted
```

CI runs `verify`, so a workflow JSON edited by hand without updating the source
fails the build.

## The state machine

```
                  ┌──────────────┐
                  │  scheduled   │
                  └──────┬───────┘
                reminder_sent
                         ▼
                  ┌──────────────┐   reply_confirm    ┌─────────────┐
                  │   reminded   │───────────────────▶│  confirmed  │
                  └──────┬───────┘                    └──────┬──────┘
                         │                                   │
       reply_cancel      │  reply_reschedule                 │ marked_attended
            ┌────────────┴──────────┐                        ▼
            ▼                       ▼                 ┌─────────────┐
     ┌─────────────┐         ┌──────────────┐         │  completed  │
     │  cancelled  │         │ rescheduled  │         └─────────────┘
     └──────┬──────┘         └──────────────┘
            │ reply_confirm                     marked_no_show
            └──────────▶ confirmed              └──▶ ┌─────────────┐
                                                     │   no_show   │
                                                     └─────────────┘
```

Two transitions are worth pointing at:

- **`confirmed --reminder_sent--> confirmed`.** A later reminder must not
  un-confirm someone. Without this explicit self-transition, a T-3h reminder
  would knock a confirmed appointment back to `reminded` and the digest would
  under-report confirmations.
- **`cancelled --reply_confirm--> confirmed`.** People change their minds. The
  path back exists.

Invalid transitions are **refused, not thrown**. A stray "yes" on a completed
appointment is normal traffic, not an error worth paging anyone about.

## The double-send guarantee

This is the thing that separates DeskBell from a template.

Each `(appointment, stage)` pair produces a stable key:

```js
idempotencyKey('appt_412', 'T-24h')  // -> "appt_412|T-24h"
```

Before any provider is contacted, workflow 02 claims it:

```sql
INSERT INTO deskbell.message_log (idempotency_key, ...)
VALUES ($1, ...)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id, idempotency_key;
```

Only tasks whose key comes back in `RETURNING` proceed to send. A second run —
a manual re-execution, two overlapping schedule ticks, a restart mid-flight —
inserts nothing, receives nothing, and sends nothing.

The guarantee is a `UNIQUE` constraint in Postgres, not application logic that
can be bypassed by a different code path.

**Why not a hash?** Because when a customer complains about a duplicate text,
you want to read the key in the log and immediately know which appointment and
which stage produced it. Uniqueness is the requirement; opacity is not.

### Failure is not success

A failed send deliberately does **not** append to `sent_stages`:

```sql
sent_stages = CASE WHEN $2::boolean AND $3 <> 'voice' AND NOT ($3 = ANY(sent_stages))
                   THEN array_append(sent_stages, $3) ELSE sent_stages END
```

The dispatcher walks the whole channel ladder inside a single execution, so most
failures are already recovered by the time workflow 02 sees a result. What is
left over — every channel refused, or the message accepted and then never
delivered — needs a *later* attempt, and that is where the guarantee and the
retry pull against each other: the first attempt already holds
`appt_412|T-24h`, so a naive retry hits `ON CONFLICT DO NOTHING` and dies
without a word.

So a retry claims a key of its own:

```js
idempotencyKey('appt_412', 'T-24h', 'r1')   // -> "appt_412|T-24h|r1"
```

The discriminator is the number of attempts already logged for that stage, which
makes the key both unique and readable, and caps the retries at
`reliability.maxRedeliveryAttempts` without needing a counter anywhere.

## Sent is not delivered

`sent` is a claim about a provider: Twilio or Meta accepted the payload and
returned an id. It says nothing about whether a handset ever showed the message.

Conflating the two is the failure this system can least afford. DeskBell exists
to tell **"she read it and didn't reply"** apart from **"it never arrived"** —
and in a log where both are `sent` with no reply recorded, they are the same
row. The T-3h reminder fires identically for both. So does the digest's
unconfirmed list. So does every judgement either of them supports.

So `message_log.status` carries the whole lifecycle:

| Status | Means |
|---|---|
| `claimed` | The row exists, no provider has been contacted |
| `sent` | A provider accepted it and gave us an id |
| `delivered` | A receipt says it reached the handset |
| `read` | A receipt says it was opened (WhatsApp only) |
| `undelivered` | A receipt says it did not arrive |
| `failed` | The provider refused it |
| `blocked` | The consent gate stopped it before any provider saw it |

and three separate timestamps that are routinely confused for one another:
`sent_at` (a provider took it), `delivered_at` (a receipt says it landed) and
`settled_at` (the dispatcher finished with the row).

### Receipts arrive out of order

Providers do not order their callbacks. Twilio's `sent` and `delivered` webhooks
routinely arrive the wrong way round, callbacks are retried, and one message can
produce four of them.

Every status write — in workflow 11, and in every settle in 02, 05, 07 and 08 —
goes through the same comparison:

```sql
WHERE deskbell.delivery_rank($2) > deskbell.delivery_rank(status)
```

`delivery_rank()` orders the statuses by how much they tell us, so the write is
monotonic: a late `sent` cannot undo a `delivered`, a duplicate updates nothing,
and a settle that lands after a receipt leaves the receipt alone. Failures rank
above `sent` because they are newer information, and below `delivered` because a
message that reached the handset stays reached.

The same ordering exists twice on purpose — `DELIVERY_RANK` in `lib/core.js` and
`deskbell.delivery_rank()` in SQL — because both the engine and the database need
it and neither can call the other. They are commented as a pair; change both or
neither.

### What a receipt is for

Recording delivery would be a reporting nicety if nothing acted on it. Three
things do:

1. **An `undelivered` stage is retried on a different channel.** Without this,
   "the provider took it" is treated as "she got it", `sent_stages` records the
   stage as done, and a dead number silently swallows the entire ladder.
2. **The daily digest splits its unconfirmed list.** *Reached, no reply* is a
   customer to chase. *Never reached* is a wrong number in the booking system,
   and chasing it harder achieves nothing.
3. **`deskbell.v_undelivered` becomes an operational fault list** — the numbers
   to fix at the source.

### What it cannot tell you

Channels differ in what they report. Twilio SMS gives `delivered` and
`undelivered`; WhatsApp adds `read`; email reports nothing at all.

A message on a channel with no receipts stays `sent` forever, and `sent` means
**unknown** everywhere it is read — not "delivered", and not "failed".
`deliveryOutcome()` returns `unknown` for it, the digest leaves it in the plain
unconfirmed list, and no retry is triggered. Pretending otherwise would trade
one wrong answer for a different one.

## The reminder window

The subtle bug in every reminder implementation I looked at:

```js
if (hoursUntilAppointment <= stage.offsetHours) send(stage);   // wrong
```

When a sync runs late, or the server was down, or someone books 90 minutes
ahead, this fires **every** stage at once — the customer gets "see you in a
week!" two hours before arriving.

DeskBell gives each stage a floor, which is the next tighter stage's offset:

```js
const floor = i + 1 < stages.length ? stages[i + 1].offsetHours : minLead;
if (hoursOut > stage.offsetHours) return 'not_yet_due';
if (hoursOut < floor)             return 'window_missed';
```

So T-7d only fires between 7 days and 24 hours out; T-24h only between 24 and 3
hours. A missed window is missed, not fired late.

Every decision returns an explicit **reason** — `already_sent`, `too_late`,
`quiet_hours_deferred`, `window_missed`, `attempt_in_flight`,
`redelivery_exhausted`, `below_value_threshold`. Nothing is silently dropped,
which is what makes "why didn't Mrs Kaur get her reminder?" answerable by
looking at one node's output.

That includes decisions the *database* would refuse. A stage whose claim is
still held by an unsettled attempt reports `attempt_in_flight` rather than
`due`, because a `due` the claim then silently overrules is a log that lies.

## The channel ladder

`pickChannel()` walks the configured order and skips a channel when it is
disabled, already failed this attempt, has no address for this contact, has been
refused consent, or — for WhatsApp — has no open session and no approved
template.

The dispatcher builds the whole ladder up front, then loops through it, stopping
at the first success **or** at a permanent recipient failure:

```js
stopLadder: sent || (failure && failure.category === 'permanent_recipient')
```

That second condition matters commercially. If the number is a landline, trying
SMS then voice on the *same* number just burns money to learn the same thing
three times.

Cost awareness is why the order is configurable per vertical. A tutoring session
worth $45 never justifies a $0.15 voice call; a $350 auto-repair bay does.

## Data model

| Table | Holds | Notable |
|---|---|---|
| `contacts` | People | `phone` UNIQUE — the natural key across every provider |
| `appointments` | Bookings | `external_id` UNIQUE; `sent_stages[]` resets when the time moves |
| `message_log` | Every send attempt | `idempotency_key` UNIQUE — the guarantee; `status` carries `claimed` → `sent` → `delivered`/`undelivered` |
| `inbound_messages` | Every reply | With classified intent and confidence |
| `events` | Append-only ROI feed | Never updated in place |
| `leads` | Missed callers | Deduped to one per caller per hour |
| `waitlist` / `waitlist_offers` | Gap-fill | Offers are unique per (entry, slot) |
| `human_tasks` | Things AI would not guess at | Open tasks appear in the digest |
| `dead_letters` | Classified failures | Retryable vs permanent |
| `call_logs` | Voice outcomes | Structured data from VAPI |

Four views ship for operations: `v_today`, `v_no_show_rate`, `v_stuck_sends` and
`v_undelivered`. The last two answer different questions and are easy to
confuse: `v_stuck_sends` finds sends *our dispatcher* abandoned mid-flight,
`v_undelivered` finds sends a *provider* told us never arrived.

One function ships too — `deskbell.delivery_rank(text)`, which every status
write compares against.

### Why Postgres and not Google Sheets

Sheets is the obvious choice for a small clinic and it is the wrong one for this
system. There is no `UNIQUE` constraint and no atomic compare-and-set, so the
claim step becomes read-then-write — and two overlapping runs both read "not
sent" and both send. The double-text problem is exactly what DeskBell exists to
prevent, so the storage layer has to be able to prevent it.

Sheets remains fine as a *booking source* (workflow 01) or as a reporting
export. It is not fine as the state store.

## Regex before AI

`classifyIntent()` handles "yes", "no", "cancel", "reschedule", STOP, HELP and
1–5 ratings with word-boundary regex, at zero cost and zero latency. That is
~95% of replies.

Only genuinely ambiguous text reaches Claude, and only when `ai.enabled` is
true. The call uses structured outputs so the response is guaranteed-valid JSON:

```jsonc
"output_config": {
  "effort": "low",
  "format": { "type": "json_schema", "schema": { /* intent, confidence, needs_human, ... */ } }
}
```

And the result is only trusted under conditions:

```js
const trust = ai.confidence >= 0.8 && !ai.needs_human && actionable.includes(ai.intent);
```

If the API is down, the response is unparseable, or the model is unsure, the
message becomes a **human task**. DeskBell never guesses at a cancellation —
wrongly cancelling a booking is far more expensive than a receptionist reading
one message.

## Extending it

| To add | Do this |
|---|---|
| A booking source | Add a branch into "Normalize Appointments" in workflow 01 |
| A channel | Add a case to `pickChannel()`, a route in the dispatcher's Switch, and a send node |
| A vertical | Add an entry to `VERTICALS` in `scripts/build-presets.mjs`, run `npm run presets` |
| A reminder stage | Add it to `reminders[]` in your config — offsets must be unique |
| An intent | Add a pattern to `classifyIntent()`, a test, and a route in workflow 04 |

Whatever you change in `lib/core.js`, run `npm run build` and commit the
regenerated workflows. CI fails if you forget.
