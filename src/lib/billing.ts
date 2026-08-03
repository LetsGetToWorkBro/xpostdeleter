/**
 * Billing: pricing model + a dependency-free Stripe client.
 *
 * WHY THIS EXISTS
 * ---------------
 * X's rate limit (50 deletes / 15 min) is scoped to the authenticating *user*,
 * so running our own developer app buys exactly zero extra throughput. What it
 * does buy is removing the "go create a developer account" step — and it moves
 * the API bill from the user to us.
 *
 * That bill is per-delete and unbounded per user, so a flat subscription is
 * upside-down for exactly the people who need this tool most. Pricing here is
 * therefore per-post, quoted up front from an exact count we get for free by
 * parsing the archive in the browser.
 *
 * Everything below is deliberately one file so the unit economics can be read
 * in one sitting.
 */

import { HttpError, timingSafeEqual } from './http';
import { hmacHex } from './crypto';
import type { Env } from '../types';

/* -------------------------------------------------------------------------- */
/* Unit cost                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What X charges us per delete, in USD.
 *
 * X's published write table has no explicit "Post: Delete" row. The candidates
 * are "Interaction: Delete" ($0.010) and "Content: Manage" ($0.005). We plan
 * against the pessimistic figure until measured — see `docs/CALIBRATION.md` and
 * the /api/x/probe endpoint, which turns that into a two-minute experiment.
 *
 * Override with the X_DELETE_UNIT_COST_USD var once you have a real number;
 * halving this doubles the gross margin on every tier below.
 */
export const DEFAULT_DELETE_UNIT_COST_USD = 0.01;

export function deleteUnitCostUsd(env: Env): number {
  const override = Number(env.X_DELETE_UNIT_COST_USD);
  return Number.isFinite(override) && override >= 0 ? override : DEFAULT_DELETE_UNIT_COST_USD;
}

/* -------------------------------------------------------------------------- */
/* Price tiers                                                                 */
/* -------------------------------------------------------------------------- */

export interface PriceTier {
  /** Deletions included. */
  quota: number;
  priceCents: number;
  label: string;
}

/**
 * One-time packs. Priced at roughly 2x our cost at $0.01/delete, which lands
 * near 50% gross margin on the small packs and thins out at the top — deliberate,
 * because the top of the range is where the willingness-to-pay ceiling bites.
 */
export const PRICE_TIERS: PriceTier[] = [
  { quota: 1_000, priceCents: 1_900, label: 'Starter' },
  { quota: 3_000, priceCents: 4_900, label: 'Standard' },
  { quota: 8_000, priceCents: 9_900, label: 'Deep clean' },
];

/** Anything past the largest pack is metered at this rate. */
export const OVERAGE_CENTS_PER_DELETE = 2;

/** Never mint a Stripe session below this — card fees make it pointless. */
export const MIN_CHARGE_CENTS = 500;

export interface Quote {
  /** How many deletions the user asked for. */
  requested: number;
  /** How many they'd actually get (a pack may include more than requested). */
  quota: number;
  priceCents: number;
  tierLabel: string;
  metered: boolean;
  /** Our estimated X bill for the full quota, in cents. */
  estimatedCostCents: number;
  /** Gross margin at full utilisation, 0–1. */
  marginAtFullUse: number;
  unitCostUsd: number;
}

export function quoteFor(count: number, env: Env): Quote {
  const requested = Math.max(0, Math.floor(count));
  const unitCostUsd = deleteUnitCostUsd(env);

  const tier = PRICE_TIERS.find((t) => requested <= t.quota);
  let quota: number;
  let priceCents: number;
  let tierLabel: string;
  let metered: boolean;

  if (tier) {
    quota = tier.quota;
    priceCents = tier.priceCents;
    tierLabel = tier.label;
    metered = false;
  } else {
    quota = requested;
    priceCents = Math.max(MIN_CHARGE_CENTS, Math.ceil(requested * OVERAGE_CENTS_PER_DELETE));
    tierLabel = 'Metered';
    metered = true;
  }

  const estimatedCostCents = Math.ceil(quota * unitCostUsd * 100);
  return {
    requested,
    quota,
    priceCents,
    tierLabel,
    metered,
    estimatedCostCents,
    marginAtFullUse: priceCents > 0 ? Number(((priceCents - estimatedCostCents) / priceCents).toFixed(3)) : 0,
    unitCostUsd,
  };
}

/** The whole ladder, for the pricing table in the UI. */
export function priceLadder(env: Env) {
  const unitCostUsd = deleteUnitCostUsd(env);
  return {
    tiers: PRICE_TIERS.map((t) => ({
      ...t,
      estimatedCostCents: Math.ceil(t.quota * unitCostUsd * 100),
    })),
    overageCentsPerDelete: OVERAGE_CENTS_PER_DELETE,
    unitCostUsd,
  };
}

/* -------------------------------------------------------------------------- */
/* Stripe (REST, no SDK — the official one is heavy and awkward on Workers)     */
/* -------------------------------------------------------------------------- */

export function billingEnabled(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

/** Flatten a nested object into Stripe's bracketed form-encoding. */
function encodeForm(data: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    const field = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((entry, i) => {
        if (entry !== null && typeof entry === 'object') encodeForm(entry as Record<string, unknown>, `${field}[${i}]`, out);
        else out.append(`${field}[${i}]`, String(entry));
      });
    } else if (typeof value === 'object') {
      encodeForm(value as Record<string, unknown>, field, out);
    } else {
      out.append(field, String(value));
    }
  }
  return out;
}

async function stripeRequest<T>(
  env: Env,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; idempotencyKey?: string } = {},
): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) {
    throw new HttpError(503, 'billing_disabled', 'Payments are not configured on this deployment.');
  }
  const headers = new Headers({
    authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'stripe-version': '2024-06-20',
  });
  if (init.body) headers.set('content-type', 'application/x-www-form-urlencoded');
  if (init.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);

  // Overridable so the billing path can be exercised against `stripe-mock`
  // (Stripe's own local test server) instead of only in production.
  const apiBase = (env.STRIPE_API_BASE || 'https://api.stripe.com/v1').replace(/\/+$/, '');
  const res = await fetch(`${apiBase}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers,
    body: init.body ? encodeForm(init.body).toString() : undefined,
  });

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Stripe's own message is user-appropriate ("Your card was declined") far
    // more often than not, so pass it through rather than flattening it.
    const message = data?.error?.message ?? `Stripe returned HTTP ${res.status}.`;
    console.error('stripe error', res.status, data?.error?.type, data?.error?.code);
    throw new HttpError(res.status === 402 ? 402 : 502, 'stripe_error', message);
  }
  return data as T;
}

export interface CheckoutSession {
  id: string;
  url: string;
  payment_status?: string;
  status?: string;
  amount_total?: number;
  currency?: string;
  metadata?: Record<string, string>;
  client_reference_id?: string;
}

export async function createCheckoutSession(
  env: Env,
  params: {
    quote: Quote;
    accountId: string;
    accountLabel: string;
    sessionId: string;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<CheckoutSession> {
  const { quote } = params;
  const name = `PostCleaner — ${quote.quota.toLocaleString('en-US')} X deletions`;
  const description = quote.metered
    ? `Metered pack for @${params.accountLabel}. Covers ${quote.quota.toLocaleString('en-US')} post deletions.`
    : `${quote.tierLabel} pack for @${params.accountLabel}. Covers up to ${quote.quota.toLocaleString('en-US')} post deletions.`;

  return stripeRequest<CheckoutSession>(env, '/checkout/sessions', {
    body: {
      mode: 'payment',
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      client_reference_id: params.accountId,
      // Unused quota is refundable, so we need a way to reach the buyer.
      customer_creation: 'always',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: quote.priceCents,
            product_data: { name, description },
          },
        },
      ],
      metadata: {
        quota: String(quote.quota),
        requested: String(quote.requested),
        x_account_id: params.accountId,
        x_username: params.accountLabel,
        pc_session: params.sessionId,
      },
    },
    // Same account asking for the same pack twice in a row is a double-click,
    // not two purchases.
    idempotencyKey: `pc_${params.accountId}_${quote.quota}_${Math.floor(Date.now() / 60_000)}`,
  });
}

export async function retrieveCheckoutSession(env: Env, id: string): Promise<CheckoutSession> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) throw new HttpError(400, 'bad_request', 'Not a valid checkout session id.');
  return stripeRequest<CheckoutSession>(env, `/checkout/sessions/${id}`, { method: 'GET' });
}

/* -------------------------------------------------------------------------- */
/* Webhook signature verification                                              */
/* -------------------------------------------------------------------------- */

const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Verify Stripe's `Stripe-Signature` header against the raw request body.
 *
 * Must be given the *raw* body string — re-serialising the parsed JSON changes
 * the bytes and the signature will never match.
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;

  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k?.trim() === 't') timestamp = v?.trim() ?? '';
    else if (k?.trim() === 'v1' && v) signatures.push(v.trim());
  }
  if (!timestamp || !signatures.length) return false;

  // Replay window.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const expected = await hmacHex(`${timestamp}.${rawBody}`, secret);
  return signatures.some((sig) => timingSafeEqual(sig, expected));
}
