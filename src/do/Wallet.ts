/**
 * Wallet — one Durable Object per X account, holding purchased deletion quota.
 *
 * Why a DO and not KV: this is money. KV is eventually consistent, so two
 * concurrent jobs could each read the same balance and both "afford" it. A DO
 * gives us a single-threaded actor per account, which makes reserve/settle
 * genuinely atomic without any locking of our own.
 *
 * The flow is reserve-then-settle, not pay-as-you-go:
 *
 *   job created ──▶ reserve(jobId, N)      balance -= N, held against the job
 *   job runs    ──▶ (DO counts real DELETE calls it makes)
 *   job ends    ──▶ settle(jobId, used)    balance += (N - used)
 *
 * That means a job can never outspend what was paid for even if it runs for
 * four days across a dozen restarts, and an abandoned or cancelled job gives
 * the unused quota straight back.
 *
 * Keyed by X account id rather than by session, so clearing cookies doesn't
 * strand someone's purchase.
 */

import type { Env } from '../types';

export interface LedgerEntry {
  at: number;
  kind: 'credit' | 'reserve' | 'settle' | 'refund';
  amount: number;
  balanceAfter: number;
  ref?: string;
  note?: string;
}

export interface WalletState {
  accountId: string;
  /** Deletions available to spend right now. */
  balance: number;
  /** Currently held against running jobs. */
  reservations: Record<string, number>;
  lifetimePurchased: number;
  lifetimeUsed: number;
  lifetimePaidCents: number;
  /** Stripe checkout session ids already credited — the idempotency guard. */
  processedPayments: string[];
  ledger: LedgerEntry[];
  createdAt: number;
  updatedAt: number;
}

const LEDGER_LIMIT = 200;
const PAYMENT_MEMORY = 500;

export class Wallet implements DurableObject {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
  }

  private async load(accountId = 'unknown'): Promise<WalletState> {
    const existing = await this.ctx.storage.get<WalletState>('wallet');
    if (existing) return existing;
    const now = Date.now();
    return {
      accountId,
      balance: 0,
      reservations: {},
      lifetimePurchased: 0,
      lifetimeUsed: 0,
      lifetimePaidCents: 0,
      processedPayments: [],
      ledger: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async save(state: WalletState): Promise<void> {
    state.updatedAt = Date.now();
    if (state.ledger.length > LEDGER_LIMIT) state.ledger = state.ledger.slice(-LEDGER_LIMIT);
    if (state.processedPayments.length > PAYMENT_MEMORY) {
      state.processedPayments = state.processedPayments.slice(-PAYMENT_MEMORY);
    }
    await this.ctx.storage.put('wallet', state);
  }

  private record(state: WalletState, entry: Omit<LedgerEntry, 'at' | 'balanceAfter'>): void {
    state.ledger.push({ ...entry, at: Date.now(), balanceAfter: state.balance });
  }

  /** Public view — safe to hand straight to the browser. */
  private view(state: WalletState) {
    return {
      accountId: state.accountId,
      balance: state.balance,
      reserved: Object.values(state.reservations).reduce((a, b) => a + b, 0),
      lifetimePurchased: state.lifetimePurchased,
      lifetimeUsed: state.lifetimeUsed,
      lifetimePaidCents: state.lifetimePaidCents,
      ledger: state.ledger.slice(-25).reverse(),
      updatedAt: state.updatedAt,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body: any = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const state = await this.load(body.accountId ?? url.searchParams.get('accountId') ?? undefined);

    switch (url.pathname) {
      /* --------------------------- read ---------------------------- */
      case '/balance':
        return this.json(this.view(state));

      /* -------------------------- credit --------------------------- */
      case '/credit': {
        const amount = Math.max(0, Math.floor(Number(body.amount) || 0));
        const paymentId = String(body.paymentId ?? '');
        if (!amount || !paymentId) {
          return this.json({ ok: false, error: 'amount and paymentId are required' }, 400);
        }
        // Webhook and the browser's return-from-checkout both land here. First
        // one wins; the second is a no-op rather than a double credit.
        if (state.processedPayments.includes(paymentId)) {
          return this.json({ ok: true, duplicate: true, ...this.view(state) });
        }

        state.accountId = body.accountId ?? state.accountId;
        state.balance += amount;
        state.lifetimePurchased += amount;
        state.lifetimePaidCents += Math.max(0, Math.floor(Number(body.amountPaidCents) || 0));
        state.processedPayments.push(paymentId);
        this.record(state, { kind: 'credit', amount, ref: paymentId, note: body.note });
        await this.save(state);
        return this.json({ ok: true, duplicate: false, ...this.view(state) });
      }

      /* -------------------------- reserve -------------------------- */
      case '/reserve': {
        const amount = Math.max(0, Math.floor(Number(body.amount) || 0));
        const jobId = String(body.jobId ?? '');
        if (!amount || !jobId) return this.json({ ok: false, error: 'amount and jobId are required' }, 400);

        // Re-reserving the same job is idempotent — a retried job creation
        // must not double-charge.
        if (state.reservations[jobId] !== undefined) {
          return this.json({ ...this.view(state), ok: true, reserved: state.reservations[jobId] });
        }
        if (state.balance < amount) {
          return this.json({
            ok: false,
            error: 'insufficient_quota',
            shortfall: amount - state.balance,
            ...this.view(state),
          });
        }

        state.balance -= amount;
        state.reservations[jobId] = amount;
        this.record(state, { kind: 'reserve', amount: -amount, ref: jobId });
        await this.save(state);
        return this.json({ ...this.view(state), ok: true, reserved: amount });
      }

      /* -------------------------- settle --------------------------- */
      case '/settle': {
        const jobId = String(body.jobId ?? '');
        const used = Math.max(0, Math.floor(Number(body.used) || 0));
        const held = state.reservations[jobId];
        if (held === undefined) {
          // Already settled, or never reserved (a BYO job). Either way: no-op.
          return this.json({ ok: true, alreadySettled: true, ...this.view(state) });
        }

        const spent = Math.min(used, held);
        const refund = held - spent;
        delete state.reservations[jobId];
        state.balance += refund;
        state.lifetimeUsed += spent;
        this.record(state, { kind: 'settle', amount: spent, ref: jobId });
        if (refund > 0) this.record(state, { kind: 'refund', amount: refund, ref: jobId });
        await this.save(state);
        return this.json({ ok: true, spent, refunded: refund, ...this.view(state) });
      }

      /* -------------------- operator adjustment -------------------- */
      case '/grant': {
        // Support credits / goodwill. Guarded by ADMIN_TOKEN at the route.
        const amount = Math.floor(Number(body.amount) || 0);
        if (!amount) return this.json({ ok: false, error: 'amount is required' }, 400);
        state.balance = Math.max(0, state.balance + amount);
        if (amount > 0) state.lifetimePurchased += amount;
        this.record(state, { kind: 'credit', amount, ref: 'manual', note: body.note ?? 'operator grant' });
        await this.save(state);
        return this.json({ ok: true, ...this.view(state) });
      }

      default:
        return new Response('Not found', { status: 404 });
    }
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  }
}

/* -------------------------------------------------------------------------- */
/* Client helpers — used by the Worker and by DeletionJob                      */
/* -------------------------------------------------------------------------- */

export function walletStub(env: Env, accountId: string): DurableObjectStub {
  return env.WALLET.get(env.WALLET.idFromName(`x:${accountId}`));
}

async function call<T>(env: Env, accountId: string, path: string, body?: unknown): Promise<T> {
  const res = await walletStub(env, accountId).fetch(`https://wallet${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}

export interface WalletView {
  accountId: string;
  balance: number;
  reserved: number;
  lifetimePurchased: number;
  lifetimeUsed: number;
  lifetimePaidCents: number;
  ledger: LedgerEntry[];
  updatedAt: number;
}

export const getBalance = (env: Env, accountId: string) =>
  call<WalletView>(env, accountId, `/balance?accountId=${encodeURIComponent(accountId)}`);

export const creditWallet = (
  env: Env,
  accountId: string,
  payload: { amount: number; paymentId: string; amountPaidCents?: number; note?: string },
) => call<WalletView & { ok: boolean; duplicate: boolean }>(env, accountId, '/credit', { accountId, ...payload });

export const reserveQuota = (env: Env, accountId: string, jobId: string, amount: number) =>
  call<WalletView & { ok: boolean; error?: string; shortfall?: number; reserved?: number }>(
    env,
    accountId,
    '/reserve',
    { accountId, jobId, amount },
  );

export const settleQuota = (env: Env, accountId: string, jobId: string, used: number) =>
  call<WalletView & { ok: boolean; spent?: number; refunded?: number }>(env, accountId, '/settle', {
    accountId,
    jobId,
    used,
  });

export const grantQuota = (env: Env, accountId: string, amount: number, note?: string) =>
  call<WalletView & { ok: boolean }>(env, accountId, '/grant', { accountId, amount, note });
