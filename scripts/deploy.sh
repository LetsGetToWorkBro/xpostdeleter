#!/usr/bin/env bash
#
# One-shot deploy for PostCleaner.
#
#   ./scripts/deploy.sh
#
# Idempotent: safe to re-run. Generates the two required secrets on first run
# only, and never prints them. Everything else (KV ids, DO migrations, assets)
# is already declared in wrangler.toml.
#
# Requires CLOUDFLARE_API_TOKEN with:
#   Account → Workers Scripts       → Edit
#   Account → Workers KV Storage    → Edit
#   Account → Account Settings      → Read
#   User    → Memberships           → Read      (optional, silences a warning)

set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/4  Checking authentication"
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "✘ wrangler cannot authenticate. Set CLOUDFLARE_API_TOKEN and try again." >&2
  exit 1
fi
npx wrangler whoami 2>/dev/null | grep -E '│' || true

say "2/4  Verifying the token can actually write Workers"
# `whoami` succeeds on a read-only token, so probe the endpoint that matters.
if ! npx wrangler deploy --dry-run >/dev/null 2>&1; then
  echo "✘ Build failed. Run 'npx wrangler deploy --dry-run' to see why." >&2
  exit 1
fi

say "3/4  Setting required secrets (first run only)"
existing="$(npx wrangler secret list 2>/dev/null || echo '[]')"

put_secret_if_missing() {
  local name="$1" generator="$2"
  if grep -q "\"$name\"" <<<"$existing"; then
    echo "  • $name already set — leaving it alone"
  else
    echo "  • generating and setting $name"
    # Piped in, never echoed, never written to disk.
    eval "$generator" | npx wrangler secret put "$name" >/dev/null
  fi
}

# Rotating TOKEN_ENCRYPTION_KEY invalidates every stored OAuth token, so it is
# generated once and then never touched again.
put_secret_if_missing SESSION_SECRET       "openssl rand -hex 32"
put_secret_if_missing TOKEN_ENCRYPTION_KEY "openssl rand -base64 32"

say "4/4  Deploying"
npx wrangler deploy

cat <<'EOF'

Deployed. Optional extras, none of which block testing:

  X managed mode     npx wrangler secret put X_CLIENT_ID
                     npx wrangler secret put X_CLIENT_SECRET
  Stripe             npx wrangler secret put STRIPE_SECRET_KEY
                     npx wrangler secret put STRIPE_WEBHOOK_SECRET
  Admin endpoints    npx wrangler secret put ADMIN_TOKEN
  Facebook Pages     npx wrangler secret put FACEBOOK_APP_ID
                     npx wrangler secret put FACEBOOK_APP_SECRET
  Threads            npx wrangler secret put THREADS_APP_ID
                     npx wrangler secret put THREADS_APP_SECRET

Without X_CLIENT_ID + STRIPE_SECRET_KEY the app runs bring-your-own-app only,
which is a complete, working product — and the fastest way to test it.

Check it is alive:   curl https://<your-worker-url>/api/health
EOF
