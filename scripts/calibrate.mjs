#!/usr/bin/env node
/**
 * Runs experiment 1 from docs/CALIBRATION.md: delete exactly one post and
 * report everything measurable, so you can diff your X credit balance either
 * side of it and learn the real per-delete price.
 *
 * Usage:
 *   node scripts/calibrate.mjs --base https://your-worker.dev \
 *                              --cookie "pc_session=..." \
 *                              --post 1234567890123456789
 *
 * Get the cookie from your browser devtools (Application → Cookies) after
 * connecting the account you want to calibrate.
 */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1]]);
    return acc;
  }, []),
);

const base = (args.base ?? process.env.DELETE1999_BASE ?? '').replace(/\/+$/, '');
const cookie = args.cookie ?? process.env.DELETE1999_COOKIE ?? '';
const postId = args.post ?? args.postId;

if (!base || !cookie || !postId) {
  console.error(`
Missing arguments.

  node scripts/calibrate.mjs --base <url> --cookie <pc_session=...> --post <post id>

Before running:
  1. Post a throwaway tweet from the account you're calibrating.
  2. Open the X developer console billing page and note your credit balance.
  3. Run this.
  4. Refresh the billing page. The difference is your true per-delete cost.
`);
  process.exit(1);
}

if (!/^\d{5,25}$/.test(String(postId))) {
  console.error('--post must be the numeric id from the post URL, e.g. 1234567890123456789');
  process.exit(1);
}

console.log(`\n⚠️  This permanently deletes post ${postId}. That is the point — an undeleted post isn't billed.\n`);
console.log('Credit balance BEFORE (from the X developer console): ______\n');

const res = await fetch(`${base}/api/x/probe`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie, origin: base },
  body: JSON.stringify({ postId: String(postId), confirm: 'PROBE' }),
});

const data = await res.json();
if (!res.ok) {
  console.error(`Probe failed (HTTP ${res.status}):`, data?.error?.message ?? data);
  process.exit(1);
}

const p = data.probe;
console.log('─'.repeat(70));
console.log(`Account          @${data.account.username}`);
console.log(`HTTP status      ${p.status}${p.alreadyGone ? '  (already deleted — no charge, try another post)' : ''}`);
console.log(`Round trip       ${p.durationMs} ms`);
console.log(`Deleted          ${p.ok ? 'yes' : 'no'}`);
if (p.error) console.log(`Error            ${p.error}`);
console.log('─'.repeat(70));

console.log('\nRate-limit headers returned by X:');
const headers = Object.entries(p.rateHeaders);
if (!headers.length) console.log('  (none — unusual; X normally returns x-rate-limit-*)');
for (const [k, v] of headers) console.log(`  ${k.padEnd(28)} ${v}`);

const limit = p.rate?.limit;
if (limit != null) {
  console.log(
    `\n  x-rate-limit-limit is ${limit}. Documented per-user delete limit is ${data.perUserLimit.limit}.` +
      (limit === data.perUserLimit.limit
        ? ' Matches — no sign of a lower app-level ceiling from this call.'
        : '  ⚠️  DOES NOT MATCH. Something other than the per-user rule is binding — see experiment 2.'),
  );
}

console.log('\nCredit balance AFTER (refresh the X developer console): ______');
console.log(`\nBEFORE minus AFTER = your true per-delete unit cost.`);
console.log(`  $0.005 → bills as "Content: Manage"`);
console.log(`  $0.010 → bills as "Interaction: Delete"   (what the code currently assumes)`);
console.log(`\nCurrently configured: $${data.assumedUnitCostUsd}`);
console.log(`Set the measured value as X_DELETE_UNIT_COST_USD in wrangler.toml — every`);
console.log(`price tier and margin figure recalculates from it.\n`);

console.log('Experiment 2 (per-app cap) needs sustained volume, not one call. Once real');
console.log('jobs have run:  curl -H "x-admin-token: $ADMIN_TOKEN" <base>/api/admin/appmeter\n');
