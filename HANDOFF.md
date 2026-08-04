# HANDOFF

Context for picking this project up cold. Written at commit `9ba3b40`.

`README.md` is the reference manual. **This file is the state of play**: what is
real, what is unproven, what was decided and why, and where the traps are.

---

## 1. What this is

**DELETE.1999** — bulk-deletes your own posts on X, Threads and Facebook Pages,
using official APIs only. One Cloudflare Worker serving both a dependency-free
SPA and a JSON API, with Durable Objects running jobs that can take days.

- **Repo:** `LetsGetToWorkBro/xpostdeleter`, branch `main`
- **Live:** https://xpostdeleter.nameless-forest-17dc.workers.dev
- **Intended home:** https://delete.1999loc.com — a Custom Domain on the same
  Cloudflare account as the LOC.1999 counter. Until that is added in the
  dashboard, the canonical tag and the counter's footer link both point at a
  host that does not resolve. Adding it is the one outstanding step.
- ~7,900 lines. No build step for the frontend, no runtime dependencies at all.

**The frontend is in the 1999LOC house style.** Black on white, Times New Roman,
1px borders, no icons, no dark mode. That is deliberate and it is shared with
the counter at 1999loc.com — the two are meant to read as one site.

The restyle repainted rather than rebuilt: `app.js` queries and regenerates this
markup using a fixed vocabulary of class names (`card`, `notice`, `stat`,
`meter`, `choice`, `badge`, `btn`, `guide-step`, `toast`, …), and every one of
them is styled in `styles.css`. **Renaming a class means editing JavaScript.**
Restyle in the stylesheet instead. Two consequences worth knowing:

- `icon()` in `app.js` is a no-op returning `''`. The SVG sprite is gone, and
  `svg { display: none }` catches anything that slips through.
- There is no theme toggle. Any stored `delete1999:theme` value is ignored.

---

## 2. Deployment state (all verified live)

| | |
|---|---|
| Worker name | `xpostdeleter` — **must match `name` in wrangler.toml** |
| Cloudflare account | `5287039626b37f029d384eac4847b6da` (Info@labyrinth.vision) |
| KV `SESSIONS` | `330de6ba50f94f9d9a258e8d44d665fd` |
| KV preview | `6a0ced124d2647babd20aee281cd1d1f` |
| Durable Objects | `DeletionJob`, `Wallet` (both `new_sqlite_classes`, free-plan OK) |
| Deploy method | Cloudflare **Workers Builds**, auto-deploys on push to `main` |
| Secrets set | `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` — **only these two** |

`/api/health` returns `configured: true`. All capabilities are currently
`false`, which is correct and expected — see §4.

There is also a GitHub Actions workflow (`.github/workflows/deploy.yml`) as an
alternative deploy path. It has **never run** — Workers Builds got there first.
It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets.

---

## 3. ⚠️ What is NOT proven

**No post has ever been deleted through this app.** Every layer is verified
independently — the job engine, filters, rate limiter, archive parser, billing,
the full browser flow — but the first real `DELETE /2/tweets/:id` against a live
X account has not happened. Treat the first run as a genuine test, and use the
dry run.

Also unproven:

- **The two calibration experiments** (§6). Both need a real X developer account
  with credits. Neither can be answered by reading docs.
- **The GitHub Actions workflow** — syntax and shell validated, never executed.
- **Facebook Pages and Threads flows** — code is complete and typechecked, but
  never run against real Meta credentials.
- **Stripe** — the entire billing loop is verified against a local stub
  (checkout fields, credit, idempotency, webhook signature, reserve/settle), but
  never against real Stripe.

---

## 4. Why everything is "not configured"

Only the two required secrets are set, so the app runs **bring-your-own-app
only**. That is a complete, working product, not a degraded one — each user
pastes their own X Client ID and X bills them directly.

Everything else degrades with an explanatory message (verified in a browser, no
console errors):

| Missing | Effect |
|---|---|
| `X_CLIENT_ID` **+** `STRIPE_SECRET_KEY` | Managed/instant mode hidden. Needs **both**. |
| `FACEBOOK_APP_ID`/`_SECRET` | Pages card shows "Not configured"; guides still render |
| `THREADS_APP_ID`/`_SECRET` | Threads tab shows "Not configured" |
| `ADMIN_TOKEN` | `/api/admin/*` returns 503 |
| `SUPABASE_*` | Job-history mirror silently off; app unaffected |

---

## 5. Decisions that should not be relitigated

These were researched, and reversing them means breaking something real.

**X's 50-deletes-per-15-min limit is per authenticating _user_, not per app.**
Running our own developer app buys *zero* extra throughput. It only removes
signup friction and moves the bill to us. Rotating apps to multiply a user's
budget is banned twice over by the X Developer Policy ("may not exceed or
circumvent rate limits"; "not permitted to register multiple applications for a
single use case"). Do not build it. The product's answer to the limit is a job
that survives four days of waiting — that *is* the moat.

**Facebook personal timelines cannot be bulk-deleted via any API.**
`publish_actions` was removed in Graph API v3.0 (2018) and never replaced;
`user_posts` is read-only. Anything claiming otherwise drives a logged-in
browser session or hits private endpoints. The app says so plainly and ships a
guided Activity Log flow plus an offline export analyser instead. Do not
"fix" this by adding automation.

**Dry run is the default.** In `createJob`, anything that isn't an explicit
`false` is a dry run. Keep it that way.

**Client-side filtering is a preview, never the safety boundary.** The Durable
Object recompiles and re-applies every filter before deleting. A frontend bug
must only ever show the wrong list, not delete the wrong thing.

**Archives are parsed in the browser.** X and Facebook exports contain DMs,
phone numbers, IP history. Only post IDs plus a 160-char excerpt are uploaded.
The ZIP reader is hand-rolled (Zip64 included, because big archives exceed 4 GB).
Do not move this server-side.

**Quota is a Durable Object, not KV.** KV is eventually consistent; two
concurrent jobs could both "afford" the same balance. Reserve-then-settle in
the `Wallet` DO makes it atomic.

**Pricing is per-post, not a subscription.** Cost is variable and unbounded per
user, so a flat fee is upside-down for exactly the people who need the tool
most. The archive gives an exact count for $0 before any API call, which is why
an exact price can be quoted up front — that's the differentiator.

---

## 6. The two open experiments

Both are documented in **`docs/CALIBRATION.md`** with runnable procedures. The
instruments are built; only the measurements are missing.

**Experiment 1 — what does a delete actually cost?**
X publishes no "Post: Delete" price. Candidates are `Content: Manage` ($0.005)
and `Interaction: Delete` ($0.010) — a 2× swing in gross margin on every tier.
Code assumes the pessimistic $0.010.
→ `POST /api/x/probe` deletes one named post and dumps every rate header.
Diff your credit balance either side. Put the answer in
`X_DELETE_UNIT_COST_USD`; every price and margin recalculates from it.
(`scripts/calibrate.mjs` wraps this.)

**Experiment 2 — is there a per-app delete cap?**
Post *creation* has one (10,000/24h) on top of its per-user limit. If deletes do
too, managed mode is capped for *all customers combined* — roughly two heavy
users a day — and the paid tier is not viable.
→ The signal is a 429 arriving while the user's own window still had budget.
`DeletionJob` counts those; `/api/admin/appmeter` aggregates and returns a
verdict that deliberately stays `insufficient_data` until a day clears ~10,000
deletes.

**Do not scale managed mode until experiment 2 returns `no_evidence`.**

---

## 7. Traps that already cost time

**Worker name must match.** Workers Builds names the Worker after the repo
(`xpostdeleter`). `wrangler.toml` said `delete1999`, so a build would have
deployed to a *second* Worker while the secrets sat on the first. Symptom
(secrets set, app unconfigured) points nowhere near the cause.

**`wrangler whoami` succeeds on a token that cannot deploy.** Deploy then fails
with `Authentication error [code: 10000]`. Check token *scopes*, not the login.
The token in the dev environment has **no** Workers or KV scope — it cannot
deploy. The Cloudflare MCP connector has separate OAuth and can create KV
namespaces, but its Workers tools are read-only.

**Sessions were never persisted on creation** (fixed in `9ba3b40`).
`getSession()` minted an id and cookie but only wrote to KV if a route called
`save()`. Every local test injected sessions straight into KV, so the create
path was never exercised — caught only by smoke-testing the live deployment.
*Lesson: test the paths your fixtures skip.*

**`[hidden]` loses to any class that sets `display`.** `.card-foot { display:
flex }` beat it. There is now a global `[hidden] { display: none !important }`.

**Delete cost was briefly wrong.** $0.015 is the *create* price, not delete.

---

## 8. Where things live

```
src/
  index.ts              Router. Stripe webhook is routed BEFORE session handling
                        (no cookie, no Origin — verified by HMAC over raw body).
  lib/crypto.ts         AES-GCM seal/unseal, HMAC, PKCE. SealedDataError marks
                        an unopenable payload (= key rotated) so callers say
                        "reconnect" instead of retrying forever.
  lib/session.ts        Cookie sessions in KV + job-ownership index.
  lib/filters.ts        THE safety boundary. Mirrored in public/app.js.
  lib/billing.ts        Price tiers + dependency-free Stripe client.
  lib/appmeter.ts       Experiment 2's measurement, sharded per job per day to
                        avoid lost-update races.
  providers/x.ts        X API v2 + rate/price constants + the calibration probe.
  providers/meta.ts     Graph API (Pages) + Threads. Read the header comment
                        before extending — it explains what Meta does not allow.
  do/DeletionJob.ts     The engine. Alarm-driven, resumable, rate-limit aware.
  do/Wallet.ts          Atomic quota ledger, one per X account.
public/
  archive.js            Hand-rolled ZIP + Zip64 reader, X and Facebook parsers.
  app.js                SPA. No framework.
docs/
  CALIBRATION.md        The two experiments.
  DEPLOY-FROM-PHONE.md  Deploying with no terminal.
```

---

## 9. Next steps, in order

0. **Add the Custom Domain** `delete.1999loc.com` in the Cloudflare dashboard:
   Workers → this Worker → Settings → Domains & Routes → Add → Custom Domain.
   Do this *before* the X app below, because the callback URL has to match the
   final origin character for character and changing it later means editing it
   in X's portal too.
1. **X developer app.** Signup was in progress at last contact under the account
   name "Postcleaner" — that is the name registered *with X*, from before this
   was called DELETE.1999, and it is left alone deliberately. Do not chase it. Needs: **Read and write** permissions, type **Web App**, and
   callback exactly `https://delete.1999loc.com/auth/x/callback` — or
   `https://xpostdeleter.nameless-forest-17dc.workers.dev/auth/x/callback` if
   step 0 is skipped. The redirect URI is derived from the request origin
   (`redirectUriFor` in `src/routes/auth.ts`), so it follows whichever host the
   user actually arrives on unless `PUBLIC_BASE_URL` is set to pin it.
2. **X archive.** Request at `x.com → Settings → Your account → Download an
   archive of your data`. Takes ~24h and is the only complete source of post IDs
   beyond the most recent ~3,200.
3. **Add credits to the X developer account.** The free tier ended Feb 2026.
   Dry runs are free; the first real delete will fail without credits, and that
   will look like a bug when it isn't.
4. **Dry run first.** Export the CSV, read it, then disable dry run.
5. **Experiment 1** once a real delete has happened.
6. **Experiment 2** only after sustained volume.
7. Managed mode + Stripe only if experiment 2 comes back clean.

---

## 10. Session/tooling notes

- The dev environment's `CLOUDFLARE_API_TOKEN` **cannot deploy** (no Workers or
  KV scope). Deploys happen via Workers Builds on push to `main`.
- The **Stripe MCP connector is not authorised**. It isn't needed — the Worker
  calls Stripe's REST API directly and uses inline `price_data`, so nothing has
  to pre-exist in the Stripe catalog.
- Local dev: `cp .dev.vars.example .dev.vars`, fill the two required values,
  `npx wrangler dev`. The **dry-run path calls no external API**, which makes it
  the fastest way to exercise the whole engine end to end.
- `npm run typecheck` is clean. Keep it that way.
