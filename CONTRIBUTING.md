# Contributing

## The highest-value contribution

**A vertical preset.** If you run DeskBell for a business type not in
`config/presets/`, send the preset. That is what makes this project general
rather than another dental-only demo.

Add an entry to `VERTICALS` in [`scripts/build-presets.mjs`](scripts/build-presets.mjs):

```js
'dog-grooming': {
  business: { name: 'Example Grooming', avgAppointmentValue: 55, minLeadTimeHours: 2 },
  reminders: [
    { stage: 'T-48h', offsetHours: 48, channels: ['whatsapp'], requiresConfirmation: true, onlyIfUnconfirmed: false },
    { stage: 'T-3h',  offsetHours: 3,  channels: ['sms'], requiresConfirmation: false, onlyIfUnconfirmed: true },
  ],
  recall: { enabled: true, intervalDays: 56, channels: ['whatsapp'] },
},
```

Then `npm run presets && npm test`. The preset test suite checks every shipped
preset for undeclared channels, duplicate offsets and missing templates, so it
will tell you if something is off.

In the PR, say **why** the cadence is what it is. "Groomers book 6–8 weeks out
and no-shows cluster on rainy days" is the useful part — that reasoning is what
someone else adapts.

## Setup

```bash
git clone https://github.com/kapoordeepanshu/DeskBell.git
cd DeskBell
npm test          # no dependencies to install — Node 20+ only
```

There are no runtime dependencies and there will not be any. This has to run on
whatever n8n box someone already has.

## The rule that matters

**Engine logic goes in `lib/core.js`, never directly into a workflow JSON.**

The JSON files are generated. `lib/core.js` is inlined into the Code nodes at
build time, so editing a workflow by hand gets silently overwritten on the next
build — and CI will fail your PR.

```bash
# after changing lib/core.js
npm run build     # regenerate presets + workflows
npm run validate  # structure + SQL/schema cross-check
npm test          # unit tests
```

Or all of it at once:

```bash
npm run verify    # also fails if generated files drifted from source
```

Commit the regenerated `workflows/*.json` and `config/presets/*.json` along with
your source change.

## Testing

Every function in `lib/core.js` is pure, takes `now` as a parameter, and has
tests. Keep it that way — `new Date()` inside a function makes DST behaviour
untestable, and DST is where reminder systems actually break.

New behaviour needs a test. Bug fixes need a test that fails before the fix.

Useful things to test against, from experience:

- A DST transition in both directions
- A quiet-hours window that wraps midnight
- An appointment inside `minLeadTimeHours`
- A stage whose window was missed because a sync ran late
- A contact with no address for the first channel in the ladder

## Adding a channel

1. Handle the address lookup in `addressFor()` in `lib/core.js`.
2. Add any policy constraint to `pickChannel()` (like the WhatsApp 24h window).
3. Add a route to the Switch in workflow 03 and a send node behind it.
4. Add a cost entry to the config so the ROI report stays honest.
5. Test that the fallback ladder skips it correctly when it is unavailable.

Send nodes go **in the dispatcher only**. Anything that sends from elsewhere
bypasses the consent gate and will not be merged.

## Pull requests

- One thing per PR.
- Run `npm run verify` before pushing.
- If it changes what a customer receives, say so explicitly in the description.
- If it touches consent, quiet hours, opt-out or the idempotency key, expect a
  slow review. Those are the parts that get a real business in trouble.

## Reporting bugs

The one to report immediately, with everything you have:

> **A customer received the same message twice.**

Include the two rows from `deskbell.message_log` and the executions from n8n. That
should be structurally impossible, so if it happens the guarantee is broken and
it takes priority over everything else.

For everything else, include your config (redacted), the relevant node output —
especially the `reason` fields from "Evaluate Reminder Ladder" — and what you
expected instead.

## Scope

**In scope:** anything that reduces no-shows, recovers missed contact, or makes
the engine safer and more honest about what it did.

**Out of scope:** becoming a booking system, a CRM, or a full patient-management
platform. DeskBell sits next to those and talks to them. There are good
open-source projects for all three; this one does the messaging layer properly.

## License

MIT. Contributions are accepted under the same terms.
