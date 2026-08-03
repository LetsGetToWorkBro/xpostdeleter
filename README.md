# PostCleaner

Mass-delete your own posts on **X (Twitter)**, **Threads** and **Facebook Pages** — using
official APIs only, on a single Cloudflare Worker.

Jobs run server-side in Durable Objects, so a 40,000-post cleanup that takes four days keeps
going after you close the tab, reboot your laptop, or lose your connection.

---

## Table of contents

- [What this does — and what it honestly can't](#what-this-does--and-what-it-honestly-cant)
- [Quick start](#quick-start)
- [Two ways to connect X](#two-ways-to-connect-x)
- [Setting up your X developer app](#setting-up-your-x-developer-app)
- [Rate limits and costs (read this)](#rate-limits-and-costs-read-this)
- [Pricing the managed tier](#pricing-the-managed-tier)
- [Stripe setup](#stripe-setup)
- [The Facebook reality](#the-facebook-reality)
- [Threads setup](#threads-setup)
- [Environment variables](#environment-variables)
- [Architecture](#architecture)
- [Security model](#security-model)
- [Local development](#local-development)
- [Troubleshooting](#troubleshooting)

---

## What this does — and what it honestly can't

| Platform | Posts | Comments | Likes | How |
|---|---|---|---|---|
| **X (Twitter)** | ✅ Fully automated | n/a | ✅ Un-like in bulk | API v2, `DELETE /2/tweets/:id` |
| **Threads** | ✅ Fully automated | — | — | Threads API, `threads_delete` |
| **Facebook Pages** | ✅ Fully automated | ✅ Page's own comments | — | Graph API v23.0 |
| **Facebook personal timeline** | ❌ **Not possible via any API** | ❌ | ❌ | Guided walkthrough + offline export analyser |

That last row is not a limitation of this tool. Meta removed `publish_actions` in Graph API v3.0
(2018) and never replaced it; `user_posts` is read-only, and `DELETE` on a personal post id is
refused. Any product claiming to bulk-delete your personal Facebook timeline "via the API" is
either driving your logged-in browser session or calling private endpoints. Both break Facebook's
Terms of Service and are a common cause of account locks, so PostCleaner does neither. See
[The Facebook reality](#the-facebook-reality) for what it does instead.

### Design commitments

- **Official, documented endpoints only.** No scraping, no private endpoints, no browser-session
  automation, no password ever requested.
- **Dry run first.** Every flow defaults to a dry run that calls no delete endpoint and produces
  the exact list that *would* go. Export it, read it, then flip the switch.
- **Your archive never leaves your browser.** X and Facebook exports contain DMs, your phone
  number, your email and your IP history. PostCleaner parses them in the tab with a hand-rolled
  ZIP reader and uploads nothing but post IDs plus a 160-character excerpt for the audit log.
- **Rate limits are respected, not fought.** The window is persisted in the Durable Object, so a
  redeploy or a restart can't cause a burst.
- **Everything is resumable.** Pause, cancel, close the tab, come back in three days.

---

## Quick start

Requires a Cloudflare account (the free plan is enough) and Node 18+.

```bash
git clone https://github.com/letsgettoworkbro/xpostdeleter.git
cd xpostdeleter
npm install

# 1. Create the KV namespaces for sessions, then paste the ids into wrangler.toml
npx wrangler kv namespace create SESSIONS
npx wrangler kv namespace create SESSIONS --preview

# 2. Set the two required secrets
openssl rand -hex 32    | npx wrangler secret put SESSION_SECRET
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY

# 3. Ship it
./scripts/deploy.sh          # generates + sets the secrets, then deploys
```

`scripts/deploy.sh` is idempotent — re-run it any time. It only generates the
two required secrets on first run and never prints them.

**No terminal?** See **[docs/DEPLOY-FROM-PHONE.md](docs/DEPLOY-FROM-PHONE.md)** —
deploy entirely from a phone browser, either through Cloudflare Workers Builds
(no API token needed at all) or the GitHub Actions workflow in this repo.

### Cloudflare API token permissions

`wrangler whoami` succeeds on a read-only token, so it is not proof you can
deploy. The token needs:

| Scope | Level | Why |
|---|---|---|
| Account → Workers Scripts | **Edit** | Deploy the Worker, its Durable Objects and secrets |
| Account → Workers KV Storage | **Edit** | Create and bind the SESSIONS namespace |
| Account → Account Settings | Read | Account resolution |
| User → Memberships | Read | Optional — silences a wrangler warning |

Create one at **dash.cloudflare.com → My Profile → API Tokens → Create Token**.
The "Edit Cloudflare Workers" template covers the first two.

A token missing these fails with `Authentication error [code: 10000]` on deploy
while `whoami` still works, which is a confusing pair of symptoms.

`wrangler deploy` prints your URL, e.g. `https://xpostdeleter.<subdomain>.workers.dev`.

Optionally set `PUBLIC_BASE_URL` in `wrangler.toml` to that URL. Leave it empty and the origin is
derived from the incoming request, which is correct for almost every setup but not if you sit
behind a rewriting proxy.

> **Durable Objects on the free plan.** This project uses `new_sqlite_classes`, the SQLite-backed
> storage class, which is available on the Workers free plan. No paid plan required.

Nothing else is mandatory. X works immediately with users bringing their own developer app;
Facebook and Threads light up once you add their app credentials.

---

## Two ways to connect X

The single most important fact about this product: **X's 50-deletes-per-15-minutes
limit is scoped to the authenticating _user_, not the app.** Running deletions on
our own developer app buys exactly zero extra throughput. Every account is capped
at 200/hour no matter whose credentials are used.

So the choice between the two doors is about *setup friction and who pays X*,
never about speed:

| | **Instant (managed)** | **Bring your own app** |
|---|---|---|
| Setup | Click connect. Nothing else. | ~3 minutes in the X developer portal |
| Who pays X | We do | You do, directly |
| What you pay us | Per post deleted, quoted up front | Nothing |
| Speed | Identical | Identical |
| Dry runs | Free | Free |

Note that bring-your-own is no longer *free* in absolute terms either — X retired
its standalone free tier in February 2026, so a BYO user buys credits from X. The
honest framing is **at cost with no markup (BYO)** versus **we handle everything
(managed)**.

Managed mode only appears if the operator has configured both `X_CLIENT_ID` and
`STRIPE_SECRET_KEY`. Otherwise the app is bring-your-own-app only, and says so.

### Trying to beat the rate limit

Don't. Rotating several apps to multiply one user's budget is prohibited twice
over by the [X Developer Policy](https://docs.x.com/developer-terms/policy) — you
may not "exceed or circumvent rate limits", and you may not "register multiple
applications for a single use case, or substantially similar or overlapping use
cases". The penalty is losing the app and the users' accounts. The only
legitimate lever is an Enterprise agreement, which is not a realistic path for
this use case.

PostCleaner treats the limit as a fixed constraint and engineers around the
*consequence* instead: a job that survives four days of waiting. That is the
actual moat — a browser extension needs the tab open.

## Setting up your X developer app

X requires every tool to authenticate through a developer app. PostCleaner is built around
**bring-your-own-app**: each user pastes their own Client ID, so rate limits and any usage charges
sit on *their* developer account rather than yours. The app walks through this on screen; here it
is in full.

1. **Create the app.** Go to [developer.x.com](https://developer.x.com/en/portal/dashboard), sign
   in **with the account you want to clean**, and create a project and an app.

2. **Enable user authentication.** In the app, open **User authentication settings → Set up**:
   - **App permissions:** `Read and write` — read-only cannot delete.
   - **Type of App:** `Web App, Automated App or Bot` (this is the OAuth 2.0 flow).

3. **Set the callback URL.** Paste this *exactly*, including the scheme and with no trailing slash:

   ```
   https://<your-worker-url>/auth/x/callback
   ```

   The app shows the exact string with a copy button — use that. A single character of drift and X
   rejects the sign-in with a generic error.

   **Website URL** can be any URL you control.

4. **Copy the credentials.** From **Keys and tokens**, copy the **OAuth 2.0 Client ID**. Copy the
   **Client Secret** *only* if your app type is Confidential — public apps use PKCE alone and
   should leave the secret field empty.

5. **Paste them into PostCleaner** and click *Connect with X*.

Requested scopes: `tweet.read`, `tweet.write`, `users.read`, `like.read`, `like.write`,
`offline.access`. The last one is what lets a multi-day job refresh its own token.

Revoke any time at [x.com → Settings → Connected apps](https://x.com/settings/connected_apps).

### Getting your X archive (strongly recommended)

On x.com: **Settings → Your account → Download an archive of your data**. X emails a link, usually
within 24 hours. Upload the `.zip` exactly as it arrives — PostCleaner finds `data/tweets.js`
inside, including multi-part and Zip64 archives.

**Why bother?** `GET /2/users/:id/tweets` only reaches roughly your **most recent 3,200 posts**.
That is a hard platform ceiling, not a paging limit. If you have a decade of history, the archive
is the only complete list of your post IDs — and reading it costs nothing and consumes no rate
limit. The API scan path exists for convenience on small accounts; the archive is the real answer.

**Keep the .zip.** Once posts are deleted, it is the only record you have.

### Running as a shared app instead

If you'd rather your users didn't create their own apps, set `X_CLIENT_ID` / `X_CLIENT_SECRET` as
secrets. The UI then offers a one-click connect. Be aware that every user's deletions then count
against *your* app's usage and billing; X's per-user rate limits still apply per user.

---

## Rate limits and costs (read this)

### The numbers that shape everything

| Operation | Limit | Source |
|---|---|---|
| `DELETE /2/tweets/:id` | **50 per 15 minutes, per user** | X API v2 |
| `DELETE /2/users/:id/likes/:id` | 50 per 15 minutes, per user | X API v2 |
| `GET /2/users/:id/tweets` | 900 per 15 minutes, per user (≈3,200 posts reachable) | X API v2 |
| Threads delete | **100 per profile per 24 hours** | Threads API |
| Facebook Pages | No published per-endpoint limit; PostCleaner self-paces at 180/hour | Graph API |

50 deletions per 15 minutes is 200/hour. In practice:

| Posts | Roughly how long |
|---|---|
| 1,000 | 5 hours |
| 5,000 | ~1 day |
| 20,000 | ~4 days |
| 50,000 | ~10.5 days |

This is the platform's limit, not a throttle PostCleaner adds. A tool that promises to delete
20,000 posts in an hour is not using the public API. The job survives the wait: it persists its
rate window, sleeps between batches with Durable Object alarms, and resumes on its own.

### Costs

X moved new developers to **pay-per-use credit pricing in February 2026**; the standalone free
tier was discontinued and Basic/Pro are legacy-only for existing subscribers. Indicative list
prices used for the in-app estimate:

- Post read: **$0.005** (so a full 3,200-post API scan ≈ **$16**)
- User read: **$0.010**
- Write operation: **$0.015**

The estimator is clearly labelled as indicative, and the constants live in one place
(`X_PRICING` in `src/providers/x.ts`) so you can correct them for your account. **Your developer
dashboard is the source of truth** — check it before starting a large job.

This is another argument for the archive path: it enumerates your entire history for **$0** and
zero API reads. Threads and Facebook Pages do not charge per call for these endpoints.

### Account safety

Bulk deletion is legitimate use of your own account, but sustained automated activity can trigger
a temporary lock or a challenge. To stay on the right side of it:

- **Don't run two jobs against one account at once.** The rate window is per job.
- **Don't lower the pacing constants.** They exist because X's limit is a ceiling, not a target.
- If X starts returning 429s, PostCleaner reads the `x-rate-limit-reset` header and sleeps exactly
  that long. Let it.
- If your token is revoked mid-job, the job pauses with a clear message rather than burning the
  rate budget on doomed calls. Reconnect and resume.

---

## Pricing the managed tier

Managed mode costs us real money per delete, and that cost is **unbounded per
user** — a 40,000-post history is a 40,000-unit bill. A flat subscription is
therefore upside-down for exactly the people who most want the tool. Pricing is
per-post, one-time, and quoted before anything runs.

| Pack | Deletions | Price | Our cost @ $0.01 | Margin |
|---|---|---|---|---|
| Starter | 1,000 | $19 | $10 | 47% |
| Standard | 3,000 | $49 | $30 | 39% |
| Deep clean | 8,000 | $99 | $80 | 19% |
| Metered | beyond 8,000 | $0.02/post | $0.01/post | 50% |

Tiers live in `PRICE_TIERS` in `src/lib/billing.ts`. Margins are computed from
`X_DELETE_UNIT_COST_USD` — change that one var and every figure recalculates.

**The unfair advantage:** because the archive is parsed in the browser, we know
the exact post count for **$0** before making a single API call. The user sees
"12,480 posts — $X" up front. No competitor can quote that cleanly, and the app
says plainly *why* it costs what it does.

### How quota is enforced

Money code, so the accounting is deliberately conservative:

- Quota lives in a **`Wallet` Durable Object keyed by X account id**, not KV.
  KV is eventually consistent and two concurrent jobs could both "afford" the
  same balance.
- **Reserve up front, settle at the end.** Creating a job deducts the full
  amount; the job cannot spend past its reservation no matter how long it runs
  or how many times it restarts; finishing or cancelling returns the unused
  remainder immediately.
- **Attempts are billed, not successes** — a 404 still costs X a request. A
  *rejected* request (429, 401, 403) performs no work and is not charged.
- **Dry runs are always free**, even on a managed connection.
- Purchases are **idempotent on the Stripe session id**, so the browser's return
  from checkout and the webhook can both credit without double-crediting.
- Running out mid-job **pauses** rather than fails. Top up, press Resume, and it
  continues from the exact same item.
- Quota follows the **X account**, not the cookie, so clearing cookies doesn't
  strand a purchase.

## Stripe setup

Only needed for managed mode. Everything else works without it.

1. Get your secret key from the Stripe dashboard (`sk_live_…` or `sk_test_…`).
2. Add a webhook endpoint pointing at `https://<your-worker>/api/billing/webhook`,
   subscribed to `checkout.session.completed` and
   `checkout.session.async_payment_succeeded`. Copy the signing secret (`whsec_…`).
3. Set the secrets:

   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   npx wrangler secret put ADMIN_TOKEN        # guards /api/admin/*
   ```

No products or prices need to exist in your Stripe catalog — checkout sessions
are created with inline `price_data`, so the tier table in code is the single
source of truth.

Webhook signatures are verified against the **raw** request body with
HMAC-SHA-256 and a 5-minute replay window, and that route is deliberately
excluded from session and same-origin handling.

To exercise the whole billing path locally without touching Stripe, set
`STRIPE_API_BASE` to a stub or [`stripe-mock`](https://github.com/stripe/stripe-mock).

## The Facebook reality

**There is no supported way to delete personal-timeline posts through an API.** Not with
`user_posts`, not with any permission Meta currently grants. PostCleaner will not pretend
otherwise, and will not ship a browser extension that clicks the buttons for you.

What it does provide:

### 1. Facebook Pages — fully automated

If you administer a Page, the Graph API supports deletion properly. PostCleaner lists your Pages,
enumerates `/{page-id}/posts` (posts published *by* the Page — not other people's posts on it),
applies your filters, and deletes via `DELETE /{object-id}`. It can also remove comments the Page
left on its own posts.

Permissions requested, and why:

| Scope | Why |
|---|---|
| `pages_show_list` | See which Pages you administer |
| `pages_read_engagement` | Read those Pages' posts so they can be listed and filtered |
| `pages_manage_posts` | Delete Page posts |
| `pages_manage_engagement` | Delete comments on those Pages |

No personal-timeline, friends, messages or photo permissions are requested — and Meta would not
grant them if they were.

Note: Page content is deleted **immediately and permanently**. Unlike personal posts, it does not
go to a 30-day bin.

### 2. Offline analysis of your export

Request **Settings & privacy → Accounts Center → Your information and permissions → Download your
information**, choose **JSON** (not HTML), include **Posts** and **Comments**, full date range.

Drop the `.zip` into PostCleaner. It parses locally — the file never leaves your browser — and
produces a year-by-year breakdown of how many posts and comments you have, how many 50-item
batches that translates to, and a CSV checklist for tracking which years you've cleared. It also
repairs Meta's well-known UTF-8 mojibake in exported text.

This is read-only by design. It tells you exactly what you're facing before you start.

### 3. A proper Manage Activity walkthrough

Facebook's own bulk tool is the only method that will not put your account at risk. The app
includes a step-by-step guide: filter by year (oldest first), filter to Public posts first, select
in batches of **50** (Facebook's cap), bin or archive, repeat, then empty the bin. Deleted items
sit in the bin for **30 days** — that's your undo window, and it means nothing is truly gone until
it expires.

### Facebook app setup (only needed for the Pages flow)

1. Create an app at [developers.facebook.com](https://developers.facebook.com/apps) — type
   **Business**.
2. Add the **Facebook Login** product.
3. Under **Facebook Login → Settings**, add the Valid OAuth Redirect URI:
   `https://<your-worker-url>/auth/facebook/callback`
4. Set `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET` as Worker secrets.
5. For use beyond your own account, the Page permissions require Meta App Review and Business
   Verification. While the app is in development mode, only users with a role on it can connect.

---

## Threads setup

Threads is the one Meta surface with a real deletion API, added March 2025.

1. In your Meta app, add the **Threads API** use case.
2. Enable the `threads_basic` and `threads_delete` permissions.
3. Add the redirect URI: `https://<your-worker-url>/auth/threads/callback`
4. Set `THREADS_APP_ID` and `THREADS_APP_SECRET` (a *different* app id from the Facebook one).

Meta caps deletion at **100 per profile per 24 hours**, so a 1,000-post profile takes about ten
days. The job handles that fine — it sleeps between daily windows and resumes itself.

---

## Environment variables

Set secrets with `npx wrangler secret put NAME`. For local development, copy `.dev.vars.example`
to `.dev.vars` (git-ignored).

### Required

| Name | What it is |
|---|---|
| `SESSION_SECRET` | HMAC key that signs the session cookie. Any long random string: `openssl rand -hex 32` |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for encrypting OAuth tokens at rest. **Must decode to exactly 32 bytes**: `openssl rand -base64 32` |

Rotating `TOKEN_ENCRYPTION_KEY` invalidates every stored token. The app degrades cleanly rather
than erroring: `/api/session` still lists connections, starting a job returns a 401 telling the
user to reconnect, running jobs stop with "credentials no longer available", and disconnect still
works so they can recover. Nothing retries a decryption that can never succeed.

### Do these need storing anywhere?

Cloudflare secrets are **write-only** — you cannot read them back, only overwrite them. That
sounds alarming and mostly isn't:

| Secret | Keep a copy? | Why |
|---|---|---|
| `SESSION_SECRET` | **No** | If it's ever lost, set a new one. Everyone gets a fresh session cookie; nothing else breaks. |
| `TOKEN_ENCRYPTION_KEY` | **No** | Same: set a new one and users reconnect. A copy in a notes app is strictly worse security than no copy at all. |
| `ADMIN_TOKEN` | **Yes** | You need to send it to call `/api/admin/*`. Password manager. |
| `X_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `FACEBOOK_APP_SECRET`, `THREADS_APP_SECRET` | **No** | The provider's dashboard is the source of truth — view or regenerate there. |
| `CLOUDFLARE_API_TOKEN` | **No** | Regenerate it in the Cloudflare dashboard if you need it again. |

The only genuine reason to keep `TOKEN_ENCRYPTION_KEY` is migrating to a different Worker or
account while keeping existing sessions and in-flight jobs alive. If that matters to you, put it
in a password manager — never in the repo, a note, or a chat message.

Never copy production secret values into `.dev.vars`. Local development should use its own
throwaway values; the file is git-ignored, but the point is that a laptop is not Cloudflare.

### Optional

| Name | Enables |
|---|---|
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | A shared X app, so users don't need their own |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | The Facebook Pages flow |
| `THREADS_APP_ID`, `THREADS_APP_SECRET` | The Threads flow |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Job history that outlives the 30-day session |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | The paid managed X tier |
| `ADMIN_TOKEN` | `/api/admin/appmeter` and `/api/admin/grant` |
| `STRIPE_API_BASE` | Point Stripe calls at a stub for testing |

### Vars (in `wrangler.toml`, not secrets)

| Name | Default | Meaning |
|---|---|---|
| `APP_NAME` | `PostCleaner` | Shown in `/api/health` |
| `PUBLIC_BASE_URL` | *(empty)* | Force the origin used to build OAuth redirect URIs |
| `X_DELETE_UNIT_COST_USD` | `0.01` | What X charges us per delete. **Measure it** — see [docs/CALIBRATION.md](docs/CALIBRATION.md). Drives every price and margin. |

### Supabase is genuinely optional

The app is fully functional without it — jobs live in Durable Objects either way. If you set both
Supabase variables, `supabase/schema.sql` creates two small tables that mirror **job counters and
status only**. No tokens, no post text, no post IDs. If that database leaks, nobody learns what
anyone deleted. Every write is fire-and-forget: a Supabase outage cannot slow or break a job.

---

## Architecture

```
Browser (vanilla JS SPA, no build step)
   │  archive parsing happens here — nothing uploaded but IDs
   ▼
Cloudflare Worker  ── /auth/*  OAuth start + callback (X, Facebook, Threads)
   │                 ── /api/*   JSON API, session-cookie authenticated
   │                 ── /*       static assets from ./public
   ├── KV "SESSIONS"      sealed tokens + per-session job index (30-day TTL)
   └── Durable Object     one per job: queue, rate window, audit log, tokens
        └── alarm() ──▶ work a batch ──▶ setAlarm(next window) ──▶ repeat
```

### Why Durable Objects

A Worker request cannot run for four days. The DO owns the job state and drives itself with
alarms: each tick does as much as the rate window allows, then schedules the next tick for
whenever the window reopens. Consequences that matter:

- Closing the tab does nothing. The job continues.
- The rate window is persisted, so a redeploy can't cause a burst past the platform limit.
- Progress, the audit log and the sealed tokens live together and are deleted together.
- Post IDs are stored in 200-item chunks, so a 500,000-item job doesn't need a huge value.

### Live progress

The DO accepts hibernatable WebSockets and pushes a snapshot on every state change. The browser
falls back to 2.5-second polling if the socket can't open (some corporate proxies still break WS),
and drops to a 15-second heartbeat while the socket is healthy.

### Project layout

```
src/
  index.ts                  Worker entry + router
  types.ts                  Shared types
  lib/
    crypto.ts               AES-GCM seal/unseal, HMAC, PKCE
    session.ts              Cookie sessions in KV, job ownership index
    http.ts                 JSON/error helpers, cookies, security headers
    filters.ts              Filter compilation — the server-side safety boundary
    billing.ts              Price tiers + dependency-free Stripe client
    appmeter.ts             App-wide throughput measurement (per-app cap probe)
    supabase.ts             Optional mirror (fire-and-forget)
  providers/
    x.ts                    X API v2 client, rate + pricing constants
    meta.ts                 Graph API (Pages) + Threads API
  routes/
    auth.ts                 OAuth for all three providers
    jobs.ts                 Job CRUD, control, CSV/JSON log export, estimator
    billing.ts              Quote, checkout, webhook, wallet, operator grants
    calibration.ts          The two measurements (see docs/CALIBRATION.md)
  do/
    DeletionJob.ts          The engine
    Wallet.ts               Atomic purchased-quota ledger, one per X account
public/
  index.html  styles.css  app.js  archive.js  favicon.svg
supabase/
  schema.sql                Optional, and it says so at the top
docs/
  CALIBRATION.md            How to measure the two open unknowns
  DEPLOY-FROM-PHONE.md      Deploying with no terminal
scripts/
  calibrate.mjs             Runs the per-delete cost experiment
  deploy.sh                 Idempotent deploy + first-run secret generation
.github/workflows/
  deploy.yml                Push-to-main / one-tap deploy
```

---

## Security model

- **No passwords, ever.** OAuth only. X uses Authorization Code + PKCE; the code verifier never
  leaves the server.
- **Tokens encrypted at rest.** Every access token, refresh token, Page token and user-supplied
  client secret is sealed with AES-256-GCM before it touches KV or Durable Object storage. A
  storage dump is not a credential dump.
- **Tokens are never logged.** Error paths surface platform messages, never bearer values. Job
  credentials are deleted from the DO the moment a job is cancelled.
- **The cookie is opaque.** `<random-id>.<hmac>`, HttpOnly, Secure, SameSite=Lax. It carries no
  data. State-changing requests additionally require a same-origin `Origin` header.
- **Jobs are ownership-checked.** Every job endpoint verifies the job belongs to the calling
  session before touching the Durable Object.
- **Filters are re-applied server-side.** Client-side filtering exists only for the instant
  preview. The Durable Object recompiles and re-evaluates every filter before deleting anything,
  so a bug in the browser can only show you the wrong list, never delete the wrong thing.
- **Nothing extra is uploaded.** The archive parser sends post IDs, a timestamp and a
  160-character excerpt for the audit log. Not the post body, not DMs, not your contact info.

**Revoking access:**
[X](https://x.com/settings/connected_apps) ·
[Facebook](https://www.facebook.com/settings?tab=applications) ·
[Threads](https://www.threads.net/settings/account).
Disconnecting inside PostCleaner also calls X's revoke endpoint and drops the local copy.

---

## Local development

```bash
cp .dev.vars.example .dev.vars     # then fill in the two required values
npx wrangler dev
```

Opens on `http://localhost:8787`. KV and Durable Objects are simulated locally and persist in
`.wrangler/state`.

To test a real OAuth flow locally you need a public URL, since X and Meta reject `localhost` for
some app types. Use a tunnel (`cloudflared tunnel --url http://localhost:8787`) and register the
tunnel URL as the callback.

```bash
npm run typecheck    # tsc --noEmit
npm run tail         # live logs from the deployed Worker
```

The dry-run path calls no external API, which makes it the fastest way to exercise the whole
engine — job creation, chunked item upload, filtering, the alarm loop, the audit log and CSV
export — without touching a real account.

---

## Troubleshooting

**"Something went wrong" immediately after clicking Connect with X**
The callback URL in your X app doesn't match. It must be exactly
`https://<your-worker-url>/auth/x/callback` — same scheme, no trailing slash. Copy it from the app.

**403 on every delete: "X refused this action"**
Your app has Read-only permissions. Set **App permissions → Read and write** in User authentication
settings, then **regenerate your tokens and reconnect** — existing tokens keep the old scope.

**The job paused itself with an error**
That's deliberate. When 15 items in a row fail, or the platform returns 401/403, the job stops
rather than burning your rate budget on calls that cannot succeed. Fix the cause (usually
reconnect, or fix app permissions) and hit Resume — it picks up at the exact same item.

**Only ~3,200 posts were found by the API scan**
Working as intended; that's X's ceiling for the timeline endpoint. Use the archive.

**"Could not find tweets.js inside that archive"**
You selected the wrong `.zip`, or an old-format archive. The right file is the one X emailed you
and contains a `data/` folder. You can also extract `data/tweets.js` and upload just that.

**The progress bar isn't moving but the job says running**
During a rate-limit sleep there is genuinely nothing happening — check "Finishes" for the next
window. The job is fine; you can close the tab.

**`TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes`**
Use `openssl rand -base64 32`. A hex string or a passphrase won't work.

**Deployment fails on the KV binding**
Replace both placeholder ids in `wrangler.toml` with the values from
`npx wrangler kv namespace create SESSIONS` (and `--preview`).

---

## Licence

MIT. Use it, fork it, host it for your friends.

This tool deletes things permanently. Run a dry run first, keep your archive, and read the rate
limit table before you start something that takes four days.
