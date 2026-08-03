/**
 * DeletionJob — one Durable Object per job.
 *
 * This is the piece that makes "delete 40,000 posts" actually work on Workers.
 * A single request can't run for four days, so the DO owns the state and drives
 * itself forward with alarms:
 *
 *      start()  ──▶ alarm()  ──▶ do as much as the rate window allows
 *                     ▲                    │
 *                     └──── setAlarm(next window / +1s) ◀┘
 *
 * Consequences that matter:
 *   • Closing the browser tab does nothing. The job keeps going.
 *   • The rate-limit window survives restarts, so we never burst past the
 *     platform limit after a redeploy.
 *   • Progress, the audit log and the (sealed) tokens live together and are
 *     deleted together.
 */

import type {
  Env,
  JobFilters,
  JobItem,
  JobKind,
  JobLogEntry,
  JobSnapshot,
  JobSource,
  JobState,
  ItemOutcome,
} from '../types';
import { compileFilters, matchesFilters, sanitizeItem } from '../lib/filters';
import { seal, unseal, SealedDataError } from '../lib/crypto';
import { reserveQuota, settleQuota } from './Wallet';
import { recordShard } from '../lib/appmeter';
import {
  X_RATE_LIMITS,
  X_PRICING,
  XApiError,
  deleteTweet,
  fetchLikedPage,
  fetchTimelinePage,
  refreshTokens,
  unlikeTweet,
} from '../providers/x';
import {
  FB_PAGE_RATE_LIMIT,
  MetaApiError,
  THREADS_RATE_LIMIT,
  deleteGraphObject,
  deleteThreadsPost,
  fetchPageComments,
  fetchPagePosts,
  fetchThreadsPage,
  refreshThreadsToken,
} from '../providers/meta';

const CHUNK = 200;
const MAX_ITEMS = 500_000;
/** How long a single alarm invocation is allowed to keep working. */
const TICK_BUDGET_MS = 22_000;
/** Politeness delay between two delete calls. */
const PACE_MS = 150;
/** Keep the tail of the log hot for the UI. */
const RECENT_LOG_SIZE = 40;
/** Stop after this many failures in a row — something systemic is wrong. */
const MAX_CONSECUTIVE_FAILURES = 15;

export interface JobCredentials {
  provider: 'x' | 'threads' | 'facebook';
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  /** X bring-your-own-app. */
  clientId?: string;
  clientSecret?: string;
  /** Meta app secret, for appsecret_proof. */
  appSecret?: string;
  /** X user id (needed to unlike) or Threads user id. */
  userId?: string;
  /** Facebook page being cleaned + its page token. */
  pageId?: string;
  pageToken?: string;
}

export interface CreateJobInput {
  jobId: string;
  sessionId: string;
  kind: JobKind;
  source: JobSource;
  dryRun: boolean;
  filters: JobFilters;
  label?: string;
  maxItems?: number;
  credentials: JobCredentials;
  /** Set when the job spends purchased quota (managed X app). */
  metered?: boolean;
  billingAccountId?: string;
  allowance?: number;
}

function chunkKey(n: number) {
  return `chunk:${String(n).padStart(7, '0')}`;
}
function logKey(n: number) {
  return `log:${String(n).padStart(7, '0')}`;
}

function rateConfigFor(kind: JobKind): { limit: number; windowMs: number } {
  switch (kind) {
    case 'x_posts':
      return { ...X_RATE_LIMITS.deleteTweet };
    case 'x_likes':
      return { ...X_RATE_LIMITS.unlike };
    case 'threads_posts':
      return { ...THREADS_RATE_LIMIT };
    case 'facebook_page_posts':
    case 'facebook_page_comments':
      return { ...FB_PAGE_RATE_LIMIT };
  }
}

export class DeletionJob implements DurableObject {
  private ctx: DurableObjectState;
  private env: Env;
  /** Guards against two alarms overlapping after a restart. */
  private ticking = false;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  /* ------------------------------------------------------------------ */
  /* Storage helpers                                                     */
  /* ------------------------------------------------------------------ */

  private async getState(): Promise<JobState | null> {
    return (await this.ctx.storage.get<JobState>('state')) ?? null;
  }

  private async putState(state: JobState): Promise<void> {
    state.updatedAt = Date.now();
    await this.ctx.storage.put('state', state);
  }

  private async getCredentials(): Promise<JobCredentials | null> {
    const sealed = await this.ctx.storage.get<string>('cred');
    if (!sealed) return null;
    try {
      return await unseal<JobCredentials>(sealed, this.env.TOKEN_ENCRYPTION_KEY);
    } catch (err) {
      // The key rotated. Retrying can never succeed, so report it the same way
      // as missing credentials rather than burning the backoff ladder on it.
      if (err instanceof SealedDataError) return null;
      throw err;
    }
  }

  private async putCredentials(creds: JobCredentials): Promise<void> {
    await this.ctx.storage.put('cred', await seal(creds, this.env.TOKEN_ENCRYPTION_KEY));
  }

  private async readItems(from: number, count: number): Promise<JobItem[]> {
    const out: JobItem[] = [];
    let idx = from;
    while (out.length < count) {
      const chunkNo = Math.floor(idx / CHUNK);
      const chunk = (await this.ctx.storage.get<JobItem[]>(chunkKey(chunkNo))) ?? [];
      const offset = idx % CHUNK;
      if (offset >= chunk.length) break;
      const slice = chunk.slice(offset, offset + (count - out.length));
      out.push(...slice);
      idx += slice.length;
      if (slice.length === 0) break;
    }
    return out;
  }

  /** Append items, honouring the filters and de-duplicating against the tail. */
  private async appendItems(state: JobState, raw: unknown[]): Promise<number> {
    const compiled = compileFilters(state.filters);
    const seen = new Set<string>();
    const accepted: JobItem[] = [];

    for (const r of raw) {
      const item = sanitizeItem(r);
      if (!item) continue;
      if (seen.has(item.id)) continue;
      if (!matchesFilters(item, compiled)) continue;
      seen.add(item.id);
      accepted.push(item);
    }
    if (!accepted.length) return 0;

    let idx = state.total;
    const writes: Record<string, JobItem[]> = {};

    // Top up the current partial chunk first.
    let chunkNo = Math.floor(idx / CHUNK);
    let current = idx % CHUNK === 0 ? [] : ((await this.ctx.storage.get<JobItem[]>(chunkKey(chunkNo))) ?? []);

    for (const item of accepted) {
      if (idx >= MAX_ITEMS) break;
      if (current.length >= CHUNK) {
        writes[chunkKey(chunkNo)] = current;
        chunkNo += 1;
        current = [];
      }
      current.push(item);
      idx += 1;

      // Durable Object put() takes at most 128 keys at a time.
      if (Object.keys(writes).length >= 100) {
        await this.ctx.storage.put(writes);
        for (const k of Object.keys(writes)) delete writes[k];
      }
    }
    writes[chunkKey(chunkNo)] = current;
    await this.ctx.storage.put(writes);

    const added = idx - state.total;
    state.total = idx;
    return added;
  }

  private async appendLog(entries: JobLogEntry[]): Promise<void> {
    if (!entries.length) return;
    let count = (await this.ctx.storage.get<number>('logCount')) ?? 0;
    let chunkNo = Math.floor(count / CHUNK);
    let current = count % CHUNK === 0 ? [] : ((await this.ctx.storage.get<JobLogEntry[]>(logKey(chunkNo))) ?? []);
    const writes: Record<string, JobLogEntry[]> = {};

    for (const entry of entries) {
      if (current.length >= CHUNK) {
        writes[logKey(chunkNo)] = current;
        chunkNo += 1;
        current = [];
      }
      current.push(entry);
      count += 1;
    }
    writes[logKey(chunkNo)] = current;
    await this.ctx.storage.put(writes);
    await this.ctx.storage.put('logCount', count);
    await this.ctx.storage.put('recentLog', entries.slice(-RECENT_LOG_SIZE));
  }

  async readLog(offset = 0, limit = 1000): Promise<{ entries: JobLogEntry[]; total: number }> {
    const total = (await this.ctx.storage.get<number>('logCount')) ?? 0;
    const entries: JobLogEntry[] = [];
    let idx = offset;
    while (entries.length < limit && idx < total) {
      const chunkNo = Math.floor(idx / CHUNK);
      const chunk = (await this.ctx.storage.get<JobLogEntry[]>(logKey(chunkNo))) ?? [];
      const start = idx % CHUNK;
      const slice = chunk.slice(start, start + (limit - entries.length));
      if (!slice.length) break;
      entries.push(...slice);
      idx += slice.length;
    }
    return { entries, total };
  }

  /* ------------------------------------------------------------------ */
  /* Snapshot / progress                                                 */
  /* ------------------------------------------------------------------ */

  private estimateCompletion(state: JobState): number | undefined {
    const remaining = Math.max(0, state.total - state.cursor);
    if (!remaining) return undefined;
    if (!state.discovery.complete) return undefined; // total isn't final yet

    const { limit, windowMs, windowStart, used } = state.rate;
    const now = Date.now();
    const inWindow = now - windowStart < windowMs ? Math.max(0, limit - used) : limit;

    if (remaining <= inWindow) return now + remaining * (PACE_MS + 300);
    const afterFirst = remaining - inWindow;
    const fullWindows = Math.ceil(afterFirst / limit);
    const firstWindowEnds = now - windowStart < windowMs ? windowStart + windowMs : now;
    return firstWindowEnds + fullWindows * windowMs;
  }

  private async snapshot(): Promise<JobSnapshot | null> {
    const state = await this.getState();
    if (!state) return null;
    const recentLog = (await this.ctx.storage.get<JobLogEntry[]>('recentLog')) ?? [];
    const alarm = await this.ctx.storage.getAlarm();
    return {
      ...state,
      remaining: Math.max(0, state.total - state.cursor),
      ratePerHour: Math.round((state.rate.limit / state.rate.windowMs) * 3_600_000),
      nextRunAt: alarm ?? undefined,
      etaMs: this.estimateCompletion(state),
      recentLog,
    };
  }

  private async broadcast(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const snap = await this.snapshot();
    if (!snap) return;
    const payload = JSON.stringify({ type: 'progress', job: snap });
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        /* socket already gone; hibernation will clean it up */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Token freshness                                                     */
  /* ------------------------------------------------------------------ */

  private async ensureFreshToken(creds: JobCredentials): Promise<JobCredentials> {
    const skew = 5 * 60 * 1000;
    if (creds.expiresAt - skew > Date.now()) return creds;

    if (creds.provider === 'x') {
      if (!creds.refreshToken || !creds.clientId) {
        throw new Error(
          'Your X authorisation expired and no refresh token is available. Reconnect X and start a new job — the remaining items are preserved in the export log.',
        );
      }
      const tokens = await refreshTokens(creds.refreshToken, {
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
      });
      const next: JobCredentials = {
        ...creds,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? creds.refreshToken,
        expiresAt: tokens.expiresAt,
      };
      await this.putCredentials(next);
      return next;
    }

    if (creds.provider === 'threads') {
      const tokens = await refreshThreadsToken(creds.accessToken);
      const next: JobCredentials = { ...creds, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
      await this.putCredentials(next);
      return next;
    }

    // Facebook page tokens derived from a long-lived user token do not expire
    // on a fixed schedule; if Meta rejects it we surface a reconnect prompt.
    return creds;
  }

  /* ------------------------------------------------------------------ */
  /* Discovery                                                           */
  /* ------------------------------------------------------------------ */

  private async discoverPage(
    state: JobState,
    creds: JobCredentials,
  ): Promise<{ items: unknown[]; next?: string; reads: number }> {
    const token = creds.accessToken;
    switch (state.kind) {
      case 'x_posts': {
        const page = await fetchTimelinePage(token, creds.userId!, state.discovery.nextToken, {
          startTime: state.filters.from ? `${state.filters.from}T00:00:00Z` : undefined,
          endTime: state.filters.to ? `${state.filters.to}T23:59:59Z` : undefined,
        });
        return { items: page.items, next: page.nextToken, reads: page.items.length };
      }
      case 'x_likes': {
        const page = await fetchLikedPage(token, creds.userId!, state.discovery.nextToken);
        return { items: page.items, next: page.nextToken, reads: page.items.length };
      }
      case 'threads_posts': {
        const page = await fetchThreadsPage(token, creds.userId!, state.discovery.nextToken);
        return { items: page.items, next: page.next, reads: page.items.length };
      }
      case 'facebook_page_posts': {
        const page = await fetchPagePosts(creds.pageToken!, creds.pageId!, state.discovery.nextToken, creds.appSecret);
        return { items: page.items, next: page.next, reads: page.items.length };
      }
      case 'facebook_page_comments': {
        const page = await fetchPageComments(
          creds.pageToken!,
          creds.pageId!,
          state.discovery.nextToken,
          creds.appSecret,
        );
        return { items: page.items, next: page.next, reads: page.items.length };
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Deletion                                                            */
  /* ------------------------------------------------------------------ */

  private async deleteOne(
    state: JobState,
    creds: JobCredentials,
    item: JobItem,
  ): Promise<{ outcome: ItemOutcome; error?: string; resetAt?: number; fatal?: boolean }> {
    if (state.dryRun) return { outcome: 'would_delete' };

    try {
      switch (state.kind) {
        case 'x_posts': {
          const r = await deleteTweet(creds.accessToken, item.id);
          return { outcome: r.alreadyGone ? 'skipped' : r.ok ? 'deleted' : 'failed' };
        }
        case 'x_likes': {
          const r = await unlikeTweet(creds.accessToken, creds.userId!, item.id);
          return { outcome: r.alreadyGone ? 'skipped' : r.ok ? 'deleted' : 'failed' };
        }
        case 'threads_posts': {
          const r = await deleteThreadsPost(creds.accessToken, item.id);
          return { outcome: r.alreadyGone ? 'skipped' : r.ok ? 'deleted' : 'failed' };
        }
        case 'facebook_page_posts':
        case 'facebook_page_comments': {
          const r = await deleteGraphObject(creds.pageToken!, item.id, creds.appSecret);
          return { outcome: r.alreadyGone ? 'skipped' : r.ok ? 'deleted' : 'failed' };
        }
      }
    } catch (err) {
      if (err instanceof XApiError) {
        if (err.status === 429) return { outcome: 'failed', error: err.message, resetAt: err.rate.reset };
        // 401/403 will fail for every single item — stop instead of grinding
        // through the whole list (and the whole rate budget) for nothing.
        return { outcome: 'failed', error: err.message, fatal: err.status === 401 || err.status === 403 };
      }
      if (err instanceof MetaApiError) {
        const fatal = err.status === 401 || err.status === 403 || /token expired|was revoked|permission/i.test(err.message);
        return {
          outcome: 'failed',
          error: err.message,
          fatal: fatal && !err.retryable,
          resetAt: err.retryable ? Date.now() + 15 * 60_000 : undefined,
        };
      }
      return { outcome: 'failed', error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /* ------------------------------------------------------------------ */
  /* The engine                                                          */
  /* ------------------------------------------------------------------ */

  private updateCost(state: JobState): void {
    if (state.kind !== 'x_posts' && state.kind !== 'x_likes') return;
    const reads = state.discovery.reads * X_PRICING.postReadUsd;
    // Bill on requests actually issued, not on outcomes — a 404 still cost one.
    const writes = state.billableRequests * X_PRICING.deleteUsd;
    state.costEstimateUsd = Number((reads + writes).toFixed(4));
  }

  /**
   * Tell the wallet what this job actually spent since the last settle, and
   * hand back whatever was reserved but unused.
   *
   * Safe to call more than once: it only ever reports the delta, so a job that
   * pauses on quota, tops up, resumes and finishes settles exactly twice for
   * exactly what it used.
   */
  private async finalizeBilling(state: JobState): Promise<void> {
    if (!state.metered || !state.billingAccountId) return;
    const owed = Math.max(0, state.billableRequests - state.settledRequests);
    try {
      await settleQuota(this.env, state.billingAccountId, state.id, owed);
      state.settledRequests = state.billableRequests;
    } catch (err) {
      // Never let a wallet hiccup change the job's outcome. The reservation
      // stays held and the next terminal transition retries the settle.
      console.error('wallet settle failed', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Reserve more quota for the work that is left. Used when a metered job is
   * resumed after running out. Returns how much it managed to get.
   */
  private async topUpAllowance(state: JobState): Promise<number> {
    if (!state.metered || !state.billingAccountId) return 0;
    const remaining = Math.max(0, state.total - state.cursor);
    if (!remaining) return 0;

    try {
      let result = await reserveQuota(this.env, state.billingAccountId, state.id, remaining);
      // Not enough for the whole tail — take what there is and pause again later.
      if (!result.ok && result.balance > 0) {
        result = await reserveQuota(this.env, state.billingAccountId, state.id, result.balance);
      }
      if (result.ok) {
        const got = result.reserved ?? 0;
        state.allowance += got;
        return got;
      }
    } catch (err) {
      console.error('wallet reserve failed', err instanceof Error ? err.message : err);
    }
    return 0;
  }

  private rollWindow(state: JobState, now: number): void {
    if (now - state.rate.windowStart >= state.rate.windowMs) {
      state.rate.windowStart = now;
      state.rate.used = 0;
    }
  }

  async alarm(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
    } catch (err) {
      const state = await this.getState();
      if (state) {
        state.lastError = err instanceof Error ? err.message : 'Unexpected error';
        state.lastErrorAt = Date.now();
        state.rate.consecutiveErrors += 1;
        // Exponential backoff, capped at 15 minutes.
        const delay = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(8, state.rate.consecutiveErrors));
        if (state.rate.consecutiveErrors >= 12) {
          state.status = 'failed';
          state.finishedAt = Date.now();
          await this.finalizeBilling(state);
          await this.putState(state);
        } else {
          await this.putState(state);
          await this.ctx.storage.setAlarm(Date.now() + delay);
        }
        await this.broadcast();
      }
      console.error('job tick failed', err instanceof Error ? err.message : err);
    } finally {
      this.ticking = false;
    }
  }

  private async tick(): Promise<void> {
    let state = await this.getState();
    if (!state) return;
    if (state.status !== 'running' && state.status !== 'queued' && state.status !== 'discovering') return;

    const creds = await this.getCredentials();
    if (!creds) {
      state.status = 'failed';
      state.lastError = 'Credentials for this job are no longer available. Reconnect and start a new job.';
      state.lastErrorAt = Date.now();
      state.finishedAt = Date.now();
      await this.putState(state);
      await this.broadcast();
      return;
    }

    const fresh = await this.ensureFreshToken(creds);
    const now = Date.now();

    // Respect an explicit platform backoff before doing anything else.
    if (state.rate.blockedUntil && state.rate.blockedUntil > now) {
      await this.ctx.storage.setAlarm(state.rate.blockedUntil);
      return;
    }

    /* ---------------------------- discovery ---------------------------- */
    if (!state.discovery.complete) {
      state.status = 'discovering';
      await this.putState(state);

      const deadline = now + TICK_BUDGET_MS;
      while (!state.discovery.complete && Date.now() < deadline) {
        const { items, next, reads } = await this.discoverPage(state, fresh);
        state.discovery.pagesFetched += 1;
        state.discovery.reads += reads;
        if (items.length) await this.appendItems(state, items);

        const capped = state.discovery.maxItems > 0 && state.total >= state.discovery.maxItems;
        if (!next || !items.length || capped) {
          state.discovery.complete = true;
          state.discovery.nextToken = undefined;
        } else {
          state.discovery.nextToken = next;
        }
        state.rate.consecutiveErrors = 0;
        this.updateCost(state);
        await this.putState(state);
        await this.broadcast();
        await new Promise((r) => setTimeout(r, 250));
      }

      state.status = 'running';
      await this.putState(state);
      await this.ctx.storage.setAlarm(Date.now() + 500);
      await this.broadcast();
      return;
    }

    /* ---------------------------- deletion ----------------------------- */
    state.status = 'running';
    if (!state.startedAt) state.startedAt = now;
    this.rollWindow(state, now);

    const deadline = now + TICK_BUDGET_MS;
    const pending: JobLogEntry[] = [];
    let didWork = false;
    /** Set when we must stop the job and tell the user to fix something. */
    let halt: string | null = null;

    while (state.cursor < state.total && Date.now() < deadline && !halt) {
      // Hard stop at the purchased quota. Checked before every batch as well
      // as before every item, so no path can overspend what was paid for.
      if (state.allowance > 0 && state.billableRequests >= state.allowance) break;

      // Dry runs cost nothing, so they are not rate limited.
      if (!state.dryRun) {
        this.rollWindow(state, Date.now());
        if (state.rate.used >= state.rate.limit) break;
      }

      // Read only as many as the current window can actually consume, so we
      // never load thousands of items just to drop them.
      const budget = state.dryRun ? 200 : Math.max(1, Math.min(50, state.rate.limit - state.rate.used));
      const batch = await this.readItems(state.cursor, budget);
      if (!batch.length) {
        // Storage says there is nothing more; trust it over `total`.
        state.total = state.cursor;
        break;
      }

      for (const item of batch) {
        if (state.allowance > 0 && state.billableRequests >= state.allowance) break;

        if (!state.dryRun) {
          this.rollWindow(state, Date.now());
          if (state.rate.used >= state.rate.limit) break;
          state.rate.used += 1;
          // X bills per request, so this counts the attempt — a 404 or a
          // failure still costs us. Incremented before the call, never after,
          // so a crash mid-flight can't lose a billable unit.
          state.billableRequests += 1;
        }

        const result = await this.deleteOne(state, fresh, item);
        didWork = true;
        state.cursor += 1;

        if (result.outcome === 'deleted' || result.outcome === 'would_delete') {
          state.deleted += 1;
          state.consecutiveItemFailures = 0;
        } else if (result.outcome === 'skipped') {
          state.skipped += 1;
          state.consecutiveItemFailures = 0;
        } else {
          state.failed += 1;
          state.consecutiveItemFailures += 1;
          state.lastError = result.error;
          state.lastErrorAt = Date.now();
        }

        pending.push({
          id: item.id,
          outcome: result.outcome,
          at: Date.now(),
          createdAt: item.createdAt,
          text: item.text,
          error: result.error,
        });

        if (result.resetAt) {
          // Platform told us exactly when to come back. Give back the item so
          // it is retried rather than silently marked failed.
          state.cursor -= 1;
          state.failed -= 1;
          state.consecutiveItemFailures = Math.max(0, state.consecutiveItemFailures - 1);
          pending.pop();
          // A rejected request performs no work, so don't charge for it.
          state.billableRequests = Math.max(0, state.billableRequests - 1);

          // We were throttled while our own per-user window still had budget.
          // Per-user limits can't explain that — it points at an app-wide cap,
          // which is the one thing that would make managed mode unscalable.
          if (state.rate.used < state.rate.limit) {
            state.appThrottleEvents += 1;
            console.warn(
              `[appmeter] early 429 job=${state.id} kind=${state.kind} usedInWindow=${state.rate.used}/${state.rate.limit} events=${state.appThrottleEvents}`,
            );
          }

          state.rate.blockedUntil = Math.max(result.resetAt, Date.now() + 30_000);
          break;
        }

        if (result.fatal) {
          // Same treatment: hand the item back, then stop and ask for a fix.
          state.cursor -= 1;
          state.failed -= 1;
          pending.pop();
          state.billableRequests = Math.max(0, state.billableRequests - 1);
          halt = result.error ?? 'The platform rejected this job.';
          break;
        }

        if (state.consecutiveItemFailures >= MAX_CONSECUTIVE_FAILURES) {
          halt = `${MAX_CONSECUTIVE_FAILURES} items in a row failed. Last error: ${state.lastError ?? 'unknown'}. The job is paused so you can fix the cause and resume — nothing is lost.`;
          break;
        }

        if (!state.dryRun) await new Promise((r) => setTimeout(r, PACE_MS));
        if (Date.now() >= deadline) break;
      }

      if (state.rate.blockedUntil && state.rate.blockedUntil > Date.now()) break;
    }

    if (didWork) state.rate.consecutiveErrors = 0;
    await this.appendLog(pending);
    this.updateCost(state);
    // Feeds the app-level-cap measurement. Once per tick, never per delete.
    if (didWork && !state.dryRun) {
      await recordShard(this.env.SESSIONS, {
        jobId: state.id,
        kind: state.kind,
        deletes: state.billableRequests,
        earlyThrottles: state.appThrottleEvents,
        managed: state.metered,
      });
    }

    // A halt is recoverable by definition: pause, explain, keep the queue.
    // Resuming picks up at exactly the same item.
    if (halt) {
      state.status = 'paused';
      state.lastError = halt;
      state.lastErrorAt = Date.now();
      state.consecutiveItemFailures = 0;
      await this.putState(state);
      await this.ctx.storage.deleteAlarm();
      await this.broadcast();
      return;
    }

    /* --------------------------- scheduling ---------------------------- */
    if (state.cursor >= state.total && state.discovery.complete) {
      state.status = 'completed';
      state.finishedAt = Date.now();
      await this.finalizeBilling(state);
      await this.putState(state);
      await this.ctx.storage.deleteAlarm();
      await this.broadcast();
      return;
    }

    // Quota spent with work still queued. Pause rather than fail — topping up
    // and hitting Resume continues from the exact same item.
    if (state.allowance > 0 && state.billableRequests >= state.allowance) {
      const left = Math.max(0, state.total - state.cursor);
      state.status = 'paused';
      state.lastError = `Your ${state.allowance.toLocaleString('en-US')} purchased deletions are used up, with ${left.toLocaleString('en-US')} still queued. Top up and press Resume — nothing is lost and nothing was double-charged.`;
      state.lastErrorAt = Date.now();
      await this.finalizeBilling(state);
      await this.putState(state);
      await this.ctx.storage.deleteAlarm();
      await this.broadcast();
      return;
    }

    let nextAt: number;
    if (state.rate.blockedUntil && state.rate.blockedUntil > Date.now()) {
      nextAt = state.rate.blockedUntil;
    } else if (!state.dryRun && state.rate.used >= state.rate.limit) {
      nextAt = state.rate.windowStart + state.rate.windowMs + 1_000;
    } else {
      nextAt = Date.now() + 1_000;
    }

    await this.putState(state);
    await this.ctx.storage.setAlarm(nextAt);
    await this.broadcast();
  }

  /* ------------------------------------------------------------------ */
  /* RPC surface (called from the Worker)                                */
  /* ------------------------------------------------------------------ */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/ws') {
      if (request.headers.get('upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const snap = await this.snapshot();
      if (snap) {
        try {
          pair[1].send(JSON.stringify({ type: 'progress', job: snap }));
        } catch {
          /* ignore */
        }
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const body: any = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

    switch (path) {
      case '/create':
        return this.jsonResponse(await this.create(body as CreateJobInput));
      case '/items':
        return this.jsonResponse(await this.addItems(body.items ?? []));
      case '/start':
        return this.jsonResponse(await this.control('start'));
      case '/pause':
        return this.jsonResponse(await this.control('pause'));
      case '/resume':
        return this.jsonResponse(await this.control('resume'));
      case '/cancel':
        return this.jsonResponse(await this.control('cancel'));
      case '/status':
        return this.jsonResponse(await this.snapshot());
      case '/log': {
        const offset = Number(url.searchParams.get('offset') ?? '0') || 0;
        const limit = Math.min(5000, Number(url.searchParams.get('limit') ?? '1000') || 1000);
        return this.jsonResponse(await this.readLog(offset, limit));
      }
      case '/destroy': {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        return this.jsonResponse({ ok: true });
      }
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  private jsonResponse(data: unknown): Response {
    return new Response(JSON.stringify(data ?? null), {
      headers: { 'content-type': 'application/json' },
    });
  }

  private async create(input: CreateJobInput): Promise<JobSnapshot> {
    const existing = await this.getState();
    if (existing) return (await this.snapshot())!;

    const rate = rateConfigFor(input.kind);
    const now = Date.now();
    const state: JobState = {
      id: input.jobId,
      sessionId: input.sessionId,
      kind: input.kind,
      source: input.source,
      dryRun: input.dryRun,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      total: 0,
      cursor: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      filters: input.filters,
      discovery: {
        complete: input.source === 'archive',
        pagesFetched: 0,
        reads: 0,
        maxItems: input.maxItems ?? 0,
        targetId: input.credentials.pageId ?? input.credentials.userId,
      },
      rate: { ...rate, windowStart: now, used: 0, consecutiveErrors: 0 },
      consecutiveItemFailures: 0,
      label: input.label,
      // A dry run costs nothing, so it is never metered even on a managed app.
      metered: Boolean(input.metered) && !input.dryRun,
      billingAccountId: input.billingAccountId,
      allowance: input.dryRun ? 0 : Math.max(0, Math.floor(input.allowance ?? 0)),
      billableRequests: 0,
      settledRequests: 0,
      appThrottleEvents: 0,
    };
    await this.putCredentials(input.credentials);
    await this.putState(state);
    return (await this.snapshot())!;
  }

  private async addItems(items: unknown[]): Promise<{ added: number; total: number }> {
    const state = await this.getState();
    if (!state) throw new Error('Job does not exist.');
    if (state.status !== 'draft' && state.status !== 'paused') {
      throw new Error('Items can only be added before the job starts.');
    }
    const added = await this.appendItems(state, items);
    await this.putState(state);
    return { added, total: state.total };
  }

  private async control(action: 'start' | 'pause' | 'resume' | 'cancel'): Promise<JobSnapshot | null> {
    const state = await this.getState();
    if (!state) return null;

    switch (action) {
      case 'start':
        if (state.status === 'draft' || state.status === 'paused') {
          state.status = state.discovery.complete ? 'running' : 'discovering';
          state.startedAt = state.startedAt ?? Date.now();
          await this.putState(state);
          await this.ctx.storage.setAlarm(Date.now() + 100);
        }
        break;
      case 'pause':
        if (state.status === 'running' || state.status === 'queued' || state.status === 'discovering') {
          state.status = 'paused';
          await this.putState(state);
          await this.ctx.storage.deleteAlarm();
        }
        break;
      case 'resume':
        if (state.status === 'paused') {
          // If we stopped because the quota ran out, try to pick up more before
          // restarting — otherwise the job would wake up and immediately halt.
          if (state.metered && state.allowance > 0 && state.billableRequests >= state.allowance) {
            const got = await this.topUpAllowance(state);
            if (!got) {
              state.lastError =
                'No deletions left in your balance. Buy a top-up, then press Resume again — the queue is exactly where you left it.';
              state.lastErrorAt = Date.now();
              await this.putState(state);
              await this.broadcast();
              return this.snapshot();
            }
            state.lastError = undefined;
          }
          state.status = state.discovery.complete ? 'running' : 'discovering';
          state.rate.consecutiveErrors = 0;
          state.consecutiveItemFailures = 0;
          state.rate.blockedUntil = undefined;
          await this.putState(state);
          await this.ctx.storage.setAlarm(Date.now() + 100);
        }
        break;
      case 'cancel':
        state.status = 'cancelled';
        state.finishedAt = Date.now();
        // Give back everything reserved but not spent, immediately.
        await this.finalizeBilling(state);
        await this.putState(state);
        await this.ctx.storage.deleteAlarm();
        // The job is over — drop the tokens immediately. The log survives so
        // the user can still export what happened.
        await this.ctx.storage.delete('cred');
        break;
    }
    await this.broadcast();
    return this.snapshot();
  }

  /* --------------------------- WebSockets ---------------------------- */

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string' && message === 'ping') {
      const snap = await this.snapshot();
      ws.send(JSON.stringify({ type: 'progress', job: snap }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    try {
      ws.close(code === 1006 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(): Promise<void> {
    /* nothing to clean up — hibernation handles the socket lifecycle */
  }
}
