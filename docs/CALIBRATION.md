# Calibration: the two numbers the business rests on

Two facts are not publicly documented, and both change what PostCleaner should
charge — or whether the paid tier should exist at all. Neither can be settled by
reading; both have to be measured against a real X account.

This document is the procedure. The instrumentation is already built.

---

## Why these two, and not others

Running our own X app buys **zero extra throughput** — the 50-deletes-per-15-min
limit is scoped to the authenticating *user*, so it applies identically whether
the credentials are ours or theirs. What a shared app buys is removing the
"go create a developer account" step, and what it costs is that every delete
lands on our bill instead of theirs.

That makes the paid tier's viability turn entirely on:

1. **What does X actually charge per delete?** ($0.005 vs $0.010 is a 2× swing in
   gross margin on every tier.)
2. **Is there a per-app delete cap?** (If yes, managed mode is capped for *all
   customers combined*, not per user — which would make it unsellable.)

---

## Experiment 1 — the real per-delete price

### Why it's open

X's published [write-operations table](https://docs.x.com/x-api/getting-started/pricing)
has **no row for deleting a post**. The plausible candidates:

| Table row | Price | Would mean |
|---|---|---|
| `Content: Manage` | $0.005 | ~74% margin on the Starter pack |
| `Interaction: Delete` | $0.010 | ~47% margin on the Starter pack |
| `Post: Create` | $0.015 | Does **not** apply — that is the create price |

Third-party reporting since the February 2026 change consistently describes
$0.01/delete, so the code plans against that. But "consistently reported" is not
"measured", and the difference is the whole margin.

### Procedure (about two minutes)

1. Post a throwaway tweet from the account you'll calibrate against. Copy its
   numeric id from the URL — `https://x.com/you/status/1234567890123456789`.
2. Connect that account in PostCleaner with **write** permissions.
3. Open the X developer console billing page. **Note the exact credit balance.**
4. Fire the probe:

   ```bash
   curl -s https://<your-worker>/api/x/probe \
     -H 'content-type: application/json' \
     -b 'pc_session=<your session cookie>' \
     -d '{"postId":"1234567890123456789","confirm":"PROBE"}' | jq
   ```

   Or use `scripts/calibrate.mjs`, which does the same thing and prints the
   comparison for you.
5. Refresh the billing page. **Note the balance again.** The difference is the
   true per-delete unit cost.

### Recording the result

Set it once, everywhere recalculates:

```toml
# wrangler.toml
[vars]
X_DELETE_UNIT_COST_USD = "0.005"   # or whatever you measured
```

That single var drives the in-app cost estimate, every margin figure in
`/api/billing/pricing`, and the quote shown to users. If it comes in at $0.005,
revisit `PRICE_TIERS` in `src/lib/billing.ts` — you could cut prices ~30% and
still hold the same margin, which is a real competitive lever.

### What the probe response also gives you

`rateHeaders` is every `x-rate-*` header X returned, verbatim — including any we
don't currently model. Check that `x-rate-limit-limit` reads **50**. If it reads
lower, something other than the documented per-user rule is binding, which is
your first hint about experiment 2.

---

## Experiment 2 — is there a per-app delete cap?

### Why it's open

Post *creation* has a documented app-level ceiling (10,000 per 24h) sitting on
top of its per-user limit. Nothing published says whether deletes have an
equivalent. If they do:

- Managed mode's ceiling is shared by **every customer at once**, not per user.
- At 10,000/day that is roughly **two heavy users per day, total**.
- The paid tier cannot scale past that, and the honest product becomes
  bring-your-own-app only.

This cannot be settled with one call. It needs volume.

### The signal

A `429` arriving **while the user's own 15-minute window still had budget left.**

Per-user limits cannot produce that. If we've made 12 deletes in a window whose
limit is 50 and X throttles us anyway, something app-wide is binding.

`DeletionJob` detects exactly that condition and counts it as
`appThrottleEvents`; `src/lib/appmeter.ts` aggregates across every job, sharded
per job per day so concurrent Durable Objects can't lose counts to a
read-modify-write race.

### Procedure

1. Set `ADMIN_TOKEN` as a secret.
2. Run managed jobs normally. The measurement is passive — no special mode.
3. Check the verdict:

   ```bash
   curl -s 'https://<your-worker>/api/admin/appmeter?days=14' \
     -H "x-admin-token: $ADMIN_TOKEN" | jq
   ```

### Reading the verdict

| `verdict` | Meaning | What to do |
|---|---|---|
| `insufficient_data` | No early throttles, but app-wide throughput has never approached 10,000/day. | Inconclusive. Don't scale spend on managed mode yet. |
| `no_evidence` | Cleared 10,000+ deletes in a day with no early throttling. | No app cap at this volume. Managed mode scales. |
| `app_cap_suspected` | Saw ≥1 throttle with per-user budge to spare. | Treat that day's volume as the working ceiling. Do not grow managed mode past it without talking to X. |

**Deliberately conservative:** `insufficient_data` is reported until a day
actually clears ~10,000 deletes, because "we never hit a cap" means nothing if
you never pushed hard enough to find one.

---

## What to do with the answers

| Outcome | Consequence |
|---|---|
| $0.005/delete, no app cap | Best case. Cut prices ~30% at the same margin, or keep prices and take ~74%. Managed mode is the main product. |
| $0.010/delete, no app cap | The shipped assumption. Tiers as priced, ~47% margin on Starter thinning at the top. Managed mode works, positioned prosumer. |
| App cap around 10k/day | Managed mode has a hard company-wide ceiling. Keep it as a small premium tier with a waitlist, and make bring-your-own-app the headline. |
| $0.010 **and** an app cap | Don't build the paid tier. Ship BYO only and compete on the job engine — nobody else survives a four-day resumable job. |

Until experiment 2 returns `no_evidence`, treat managed mode as a paid beta with
a volume cap you control, not an open funnel.
