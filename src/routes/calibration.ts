/**
 * Calibration — the two measurements this product's economics depend on.
 *
 * EXPERIMENT 1: what does X actually charge per delete?
 *   X publishes no "Post: Delete" price. The candidates are "Interaction:
 *   Delete" ($0.010) and "Content: Manage" ($0.005) — a 2x swing in gross
 *   margin on every tier. `POST /api/x/probe` deletes exactly one post and
 *   tells you precisely what to compare in the developer console.
 *
 * EXPERIMENT 2: is there a per-app delete cap?
 *   Post creation has one (10,000/24h) on top of its per-user limit. If deletes
 *   do too, managed mode is capped for *all* customers combined, not per user.
 *   `GET /api/admin/appmeter` aggregates real production throughput and the
 *   tell-tale signal: 429s arriving while the user's own window still had room.
 */

import type { Env } from '../types';
import { badRequest, json, readJson, unauthorized } from '../lib/http';
import { unseal } from '../lib/crypto';
import type { SessionContext } from '../lib/session';
import { probeDelete, X_RATE_LIMITS } from '../providers/x';
import { interpret, readDays } from '../lib/appmeter';
import { assertAdmin } from './billing';
import { deleteUnitCostUsd } from '../lib/billing';

/**
 * Delete one specified post of your own and report every measurable detail.
 *
 * Destructive by design — that is the whole point, since a delete that doesn't
 * happen doesn't get billed. The caller must name the exact post id and confirm.
 */
export async function postProbe(request: Request, env: Env, session: SessionContext): Promise<Response> {
  const conn = session.data.connections.x;
  if (!conn) throw unauthorized('Connect the X account you want to calibrate against.');

  const body = await readJson<{ postId?: string; confirm?: string }>(request);
  const postId = (body.postId ?? '').trim();

  if (!/^\d{5,25}$/.test(postId)) {
    throw badRequest('postId must be the numeric id of one of your own posts (the long number in its URL).');
  }
  if (body.confirm !== 'PROBE') {
    throw badRequest('Set confirm to "PROBE" to acknowledge that this permanently deletes that one post.');
  }

  const tokens = await unseal<{ accessToken: string }>(conn.sealedTokens, env.TOKEN_ENCRYPTION_KEY);
  const before = Date.now();
  const result = await probeDelete(tokens.accessToken, postId);

  return json({
    probe: result,
    account: { username: conn.username, accountId: conn.accountId },
    startedAt: before,
    assumedUnitCostUsd: deleteUnitCostUsd(env),
    perUserLimit: X_RATE_LIMITS.deleteTweet,
    howToReadThis: [
      'EXPERIMENT 1 — unit cost. Open the X developer console billing page and note your credit balance immediately BEFORE and AFTER this call. The difference is the true per-delete price. If it is $0.005 the delete bills as "Content: Manage"; if $0.010 it bills as "Interaction: Delete". Put the result in X_DELETE_UNIT_COST_USD — every price tier and margin figure recalculates from that one var.',
      'EXPERIMENT 2 — headers. rateHeaders shows every x-rate-* header X returned. x-rate-limit-limit should read 50 for the per-user delete window. Any additional header scoped to the app (rather than the user) is direct evidence of an app-level cap; a limit lower than 50 here means something other than the per-user rule is binding.',
      'The population-level answer to experiment 2 comes from GET /api/admin/appmeter once real jobs have run. A single probe cannot show an app cap — only sustained volume can.',
    ],
  });
}

/** Aggregated evidence for experiment 2. Operator only. */
export async function getAppMeter(request: Request, env: Env): Promise<Response> {
  assertAdmin(request, env);
  const url = new URL(request.url);
  const days = Math.min(45, Math.max(1, Number(url.searchParams.get('days') ?? '14') || 14));

  const history = await readDays(env.SESSIONS, days);
  const verdict = interpret(history);

  return json({
    days: history,
    ...verdict,
    perUserLimit: X_RATE_LIMITS.deleteTweet,
    documentedAppCapForPostCreation: { limit: 10_000, windowHours: 24 },
    whatWouldProveACap:
      'A 429 while the job had spent fewer than 50 deletes in its own 15-minute window. Per-user limits cannot produce that, so it means something app-wide is binding. Those are counted as earlyThrottles.',
  });
}
