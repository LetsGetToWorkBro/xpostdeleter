# Deploying from a phone

No terminal, no laptop. Two routes — pick one.

| | **Cloudflare Workers Builds** | **GitHub Actions** |
|---|---|---|
| API token needed | **None** | Yes, you create one |
| Setup taps | ~10 | ~15 |
| Where you work | Cloudflare dashboard | GitHub + Cloudflare |
| Deploys on push to `main` | Yes | Yes |
| Manual "deploy now" button | Yes | Yes |

**Route A is easier** — Cloudflare connects to GitHub itself, so there is no
token to create or paste. Use Route B if you want the build logs, typecheck and
health check living in the repo.

Use a **mobile browser** (Safari/Chrome), not the GitHub app — the app can't
trigger workflows or edit settings. Request the desktop site if a control is
hard to hit.

---

## Route A — Cloudflare Workers Builds (recommended)

Everything happens at **dash.cloudflare.com**.

1. **Compute (Workers) → Create → Import a repository.**
2. Connect GitHub, authorise Cloudflare for `LetsGetToWorkBro/xpostdeleter`,
   and pick that repo.
3. Configure the build:
   - **Branch:** `main`
   - **Build command:** `npm ci`
   - **Deploy command:** `npx wrangler deploy`
   - **Root directory:** leave blank
4. **Create and deploy.** The first build takes a couple of minutes.

The KV namespace, both Durable Objects and the static assets are all declared in
`wrangler.toml`, so nothing else needs configuring.

5. **Add the two required secrets.** Open the new Worker →
   **Settings → Variables and Secrets → Add**, type **Secret** (not plaintext):

   | Name | Value |
   |---|---|
   | `SESSION_SECRET` | any long random string, 32+ chars |
   | `TOKEN_ENCRYPTION_KEY` | **base64 of exactly 32 bytes** |

   Generating these on a phone is the one fiddly bit. `TOKEN_ENCRYPTION_KEY` is
   strict — it must decode to exactly 32 bytes or the app refuses to start.
   Easiest source: open <https://generate.plus/en/base64> and generate **32
   bytes**, or ask Claude for one. `SESSION_SECRET` is not fussy — any long
   random string works.

6. **Deploy again** so the secrets are picked up: Worker → **Deployments →
   Retry / Redeploy**.

7. **Check it:** visit `https://postcleaner.<your-subdomain>.workers.dev/api/health`.
   You want `"configured": true`.

**To deploy later:** push to `main` (editing any file in the GitHub web UI counts),
or hit **Retry deployment** in the Cloudflare dashboard.

---

## Route B — GitHub Actions

The workflow is already committed at `.github/workflows/deploy.yml`. It
typechecks, builds, deploys, generates the two required secrets on first run,
and health-checks the result.

### One-time setup

**1. Create a Cloudflare API token.**

dash.cloudflare.com → **My Profile → API Tokens → Create Token** → use the
**"Edit Cloudflare Workers"** template. Confirm it grants:

- Account → **Workers Scripts → Edit**
- Account → **Workers KV Storage → Edit**

Copy the token — Cloudflare shows it once.

> A token without these still passes `wrangler whoami`, then fails deploy with
> `Authentication error [code: 10000]`. Confusing pair of symptoms; check the
> scopes rather than the login.

**2. Grab your account ID.** It's in the Cloudflare dashboard URL:
`dash.cloudflare.com/`**`<this-long-hex-string>`**`/...`

For this account it is `5287039626b37f029d384eac4847b6da`.

**3. Add both to GitHub.**

github.com/LetsGetToWorkBro/xpostdeleter → **Settings → Secrets and variables →
Actions → New repository secret**:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | `5287039626b37f029d384eac4847b6da` |

### Deploying

**Actions** tab → **Deploy to Cloudflare** → **Run workflow** → **Run workflow**.

Or just push to `main` — it fires automatically.

The run summary shows the deployed URL and the health-check result. First run
generates `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` inside Cloudflare and
never logs them; later runs leave them alone, because rotating
`TOKEN_ENCRYPTION_KEY` would invalidate every stored OAuth token and stop every
running job.

---

## Do I need to save these secrets anywhere?

Almost certainly **no**.

Cloudflare secrets are write-only — you can set them and overwrite them, but you
can never read them back. That is a feature, not a problem, because nothing in
this app ever needs you to recall those values:

- **`SESSION_SECRET`** — if it's ever gone, set a new one. Everyone gets a fresh
  session cookie. That's the entire consequence.
- **`TOKEN_ENCRYPTION_KEY`** — set a new one and users reconnect their accounts.
  In-flight jobs stop with a "reconnect" message rather than breaking oddly.

Writing either into a notes app on your phone is *worse* security than having no
copy at all. Leave them in Cloudflare.

Two exceptions:

- **`ADMIN_TOKEN`** — you have to send this to use `/api/admin/*`, so keep it in
  a password manager.
- Anything from a provider (**X**, **Stripe**, **Facebook**, **Threads**, and
  your **Cloudflare API token**) — don't store it here either, because the
  provider's own dashboard is the source of truth. View or regenerate it there.

The one scenario where keeping `TOKEN_ENCRYPTION_KEY` matters: moving to a
different Worker or Cloudflare account and wanting existing logins and running
jobs to survive the move. If that's a real possibility, put it in a password
manager — never in the repo, a note, or a chat message.

---

## Once it's live

You need nothing else to test the full X flow. Without `X_CLIENT_ID` and
`STRIPE_SECRET_KEY` the app runs bring-your-own-app only, which is a complete
working product and the fastest path to a real deletion.

1. Open the Worker URL on your phone. The UI is built for it.
2. On x.com request your archive: **Settings → Your account → Download an
   archive of your data**. X emails a link within ~24 hours.
3. Create an X developer app ([developer.x.com](https://developer.x.com/en/portal/dashboard)),
   set permissions to **Read and write**, and set the callback URL to
   `https://<your-worker-url>/auth/x/callback` — the app shows the exact string
   with a copy button.
4. Paste the Client ID, connect, upload the archive, **run a dry run first**.

### Adding optional secrets later

Cloudflare dashboard → your Worker → **Settings → Variables and Secrets**. Same
place for both routes.

| Secret | Enables |
|---|---|
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | Instant-connect (managed) X mode |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Paid tier — needed alongside `X_CLIENT_ID` for managed mode to appear |
| `ADMIN_TOKEN` | `/api/admin/appmeter` and `/api/admin/grant` |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | Facebook Pages cleanup |
| `THREADS_APP_ID`, `THREADS_APP_SECRET` | Threads cleanup |

---

## If something goes wrong

**`Authentication error [code: 10000]`** — the API token is missing Workers
Scripts → Edit and/or Workers KV Storage → Edit. Recreate it with the "Edit
Cloudflare Workers" template.

**`/api/health` says `"configured": false`** — one of the two required secrets is
missing or empty. Add them and redeploy.

**`TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes`** — the value isn't
base64 of 32 bytes. A hex string or a passphrase will not work.

**Build fails on `wrangler deploy`** — check the KV namespace ids in
`wrangler.toml` still exist on the account.

**Workers Builds can't see the repo** — the Cloudflare GitHub app needs access
granted to that specific repository, not just the account.
