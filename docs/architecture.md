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
| Testable | Only by running the workflow | 63 unit tests, `npm test` |
| Consistent across workflows | Three drifting copies of the quiet-hours check | One implementation, inlined everywhere |
| Portable across n8n versions | Node parameter schemas change | Plain JavaScript |

Every function is pure — `now` is always a parameter, never `new Date()` inside.
That is what makes DST and quiet-hours behaviour testable at all.

```bash
npm test       # 63 tests against the engine
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
sent_stages = CASE WHEN $2::boolean AND $3 <> 'voice'
                   THEN array_append(sent_stages, $3) ELSE sent_stages END
```

So the next 15-minute tick retries it — on the next channel in the ladder, since
the previous failure is recorded. The idempotency key is already consumed for
that attempt, which is why the dispatcher walks the whole ladder within a single
execution rather than relying on the retry.

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
`quiet_hours_deferred`, `window_missed`, `below_value_threshold`. Nothing is
silently dropped, which is what makes "why didn't Mrs Kaur get her reminder?"
answerable by looking at one node's output.

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
| `message_log` | Every send attempt | `idempotency_key` UNIQUE — the guarantee |
| `inbound_messages` | Every reply | With classified intent and confidence |
| `events` | Append-only ROI feed | Never updated in place |
| `leads` | Missed callers | Deduped to one per caller per hour |
| `waitlist` / `waitlist_offers` | Gap-fill | Offers are unique per (entry, slot) |
| `human_tasks` | Things AI would not guess at | Open tasks appear in the digest |
| `dead_letters` | Classified failures | Retryable vs permanent |
| `call_logs` | Voice outcomes | Structured data from VAPI |

Three views ship for operations: `v_today`, `v_no_show_rate`, `v_stuck_sends`.
The last one finds sends claimed but never settled — the signature of a crash
mid-dispatch.

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
