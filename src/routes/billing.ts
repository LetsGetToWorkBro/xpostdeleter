/**
 * Billing routes: quote → checkout → credit → spend.
 *
 * The quote is the interesting part. Because the archive is parsed in the
 * browser, we know the exact number of posts *before* a single API call is
 * made, for free. So we can show a real price for a real number up front
 * instead of a subscription that hopes for the best.
 */

import type { Env } from '../types';
import { HttpError, badRequest, baseUrl, json, readJson, unauthorized } from '../lib/http';
import type { SessionContext } from '../lib/session';
import {
  billingEnabled,
  createCheckoutSession,
  deleteUnitCostUsd,
  priceLadder,
  quoteFor,
  retrieveCheckoutSession,
  verifyStripeSignature,
} from '../lib/billing';
import { creditWallet, getBalance, grantQuota } from '../do/Wallet';

/** The X account a purchase is attached to. Quota follows the account, not the cookie. */
function billingAccount(session: SessionContext): { id: string; username: string } {
  const conn = session.data.connections.x;
  if (!conn) throw unauthorized('Connect your X account before buying deletions.');
  return { id: conn.accountId, username: conn.username };
}

/* -------------------------------------------------------------------------- */
/* Quote + wallet                                                              */
/* -------------------------------------------------------------------------- */

export async function getPricing(_request: Request, env: Env, _session: SessionContext): Promise<Response> {
  return json({
    enabled: billingEnabled(env),
    ...priceLadder(env),
  });
}

export async function postQuote(request: Request, env: Env, _session: SessionContext): Promise<Response> {
  const body = await readJson<{ count?: number }>(request);
  const count = Math.max(0, Math.floor(Number(body.count) || 0));
  if (count > 1_000_000) throw badRequest('That is more posts than X has ever let one account create.');
  return json({ quote: quoteFor(count, env), enabled: billingEnabled(env) });
}

export async function getWallet(_request: Request, env: Env, session: SessionContext): Promise<Response> {
  const conn = session.data.connections.x;
  if (!conn) return json({ connected: false, balance: 0, reserved: 0 });
  const wallet = await getBalance(env, conn.accountId);
  return json({ connected: true, ...wallet, unitCostUsd: deleteUnitCostUsd(env) });
}

/* -------------------------------------------------------------------------- */
/* Checkout                                                                    */
/* -------------------------------------------------------------------------- */

export async function postCheckout(request: Request, env: Env, session: SessionContext): Promise<Response> {
  if (!billingEnabled(env)) {
    throw new HttpError(
      503,
      'billing_disabled',
      'Payments are not configured on this deployment. You can still use the bring-your-own-app path, which is free for us and billed to you by X directly.',
    );
  }
  const account = billingAccount(session);
  const body = await readJson<{ count?: number }>(request);
  const count = Math.max(1, Math.floor(Number(body.count) || 0));
  if (count > 1_000_000) throw badRequest('That count is not plausible.');

  const quote = quoteFor(count, env);
  const base = baseUrl(request, env.PUBLIC_BASE_URL);

  const checkout = await createCheckoutSession(env, {
    quote,
    accountId: account.id,
    accountLabel: account.username,
    sessionId: session.data.id,
    successUrl: `${base}/#billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/#billing=cancelled`,
  });

  return json({ url: checkout.url, id: checkout.id, quote });
}

/**
 * Credit a completed checkout.
 *
 * Called twice by design: once by the browser the instant it returns from
 * Stripe (so the balance is there before the page finishes loading), and once
 * by the webhook (so it still lands if the browser never comes back). The
 * wallet dedupes on the Stripe session id, so whichever arrives second is a
 * no-op.
 */
async function creditFromSession(env: Env, checkoutId: string): Promise<{ credited: number; duplicate: boolean }> {
  const checkout = await retrieveCheckoutSession(env, checkoutId);
  if (checkout.payment_status !== 'paid') {
    throw new HttpError(402, 'payment_incomplete', 'That payment has not completed yet.');
  }

  const quota = Number(checkout.metadata?.quota ?? 0);
  const accountId = checkout.metadata?.x_account_id ?? checkout.client_reference_id;
  if (!quota || !accountId) {
    throw new HttpError(500, 'checkout_malformed', 'That payment is missing the information needed to credit it.');
  }

  const result = await creditWallet(env, accountId, {
    amount: quota,
    paymentId: checkout.id,
    amountPaidCents: checkout.amount_total ?? 0,
    note: `Stripe ${checkout.id}`,
  });
  return { credited: quota, duplicate: result.duplicate };
}

export async function postConfirm(request: Request, env: Env, session: SessionContext): Promise<Response> {
  const body = await readJson<{ sessionId?: string }>(request);
  if (!body.sessionId) throw badRequest('sessionId is required.');
  const result = await creditFromSession(env, body.sessionId);

  const conn = session.data.connections.x;
  const wallet = conn ? await getBalance(env, conn.accountId) : null;
  return json({ ok: true, ...result, wallet });
}

/**
 * Stripe webhook. No cookie, no Origin — verified purely by HMAC over the raw
 * body, so it must be routed before any session handling.
 */
export async function postWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: 'webhook_not_configured' }, { status: 503 });
  }
  const raw = await request.text();
  const ok = await verifyStripeSignature(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) {
    // Do not leak why. A failed verification is either a misconfigured secret
    // or someone probing; neither deserves detail.
    return json({ error: 'invalid_signature' }, { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'invalid_payload' }, { status: 400 });
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const checkoutId = event.data?.object?.id;
      if (checkoutId) await creditFromSession(env, checkoutId);
    }
  } catch (err) {
    // Return 500 so Stripe retries — this is the backstop path and it must be
    // allowed to fail loudly.
    console.error('webhook handling failed', err instanceof Error ? err.message : err);
    return json({ error: 'handler_failed' }, { status: 500 });
  }

  return json({ received: true });
}

/* -------------------------------------------------------------------------- */
/* Operator endpoints                                                          */
/* -------------------------------------------------------------------------- */

export function assertAdmin(request: Request, env: Env): void {
  if (!env.ADMIN_TOKEN) throw new HttpError(503, 'admin_disabled', 'ADMIN_TOKEN is not set on this deployment.');
  const provided = request.headers.get('x-admin-token') ?? '';
  if (provided !== env.ADMIN_TOKEN) throw unauthorized('Bad admin token.');
}

/** Comp someone, or claw back. Positive or negative. */
export async function postGrant(request: Request, env: Env): Promise<Response> {
  assertAdmin(request, env);
  const body = await readJson<{ accountId?: string; amount?: number; note?: string }>(request);
  if (!body.accountId || !Number.isFinite(body.amount)) {
    throw badRequest('accountId and amount are required.');
  }
  const wallet = await grantQuota(env, body.accountId, Math.floor(body.amount!), body.note);
  return json({ ok: true, wallet });
}
