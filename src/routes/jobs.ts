/**
 * Job API. The Worker is a thin, authenticated shell around the Durable Object:
 * it decides *whether* you may touch a job and assembles the credentials, the
 * DO decides *how* the work gets done.
 */

import type { Env, JobKind, JobLogEntry, JobSnapshot, JobSource, Provider } from '../types';
import type { JobCredentials } from '../do/DeletionJob';
import { HttpError, badRequest, json, notFound, readJson, text, unauthorized } from '../lib/http';
import { randomId, unseal } from '../lib/crypto';
import { indexJob, listJobs, ownsJob, type SessionContext } from '../lib/session';
import { sanitizeFilters } from '../lib/filters';
import { mirrorJob, supabaseEnabled } from '../lib/supabase';
import { X_PRICING, X_RATE_LIMITS } from '../providers/x';
import { reserveQuota } from '../do/Wallet';
import { quoteFor } from '../lib/billing';
import { FB_PAGE_RATE_LIMIT, THREADS_RATE_LIMIT } from '../providers/meta';

const KINDS: JobKind[] = [
  'x_posts',
  'x_likes',
  'threads_posts',
  'facebook_page_posts',
  'facebook_page_comments',
];

const PROVIDER_FOR_KIND: Record<JobKind, Provider> = {
  x_posts: 'x',
  x_likes: 'x',
  threads_posts: 'threads',
  facebook_page_posts: 'facebook',
  facebook_page_comments: 'facebook',
};

/** Max items accepted in one /items call — keeps request bodies sane. */
const MAX_ITEMS_PER_CALL = 5_000;

function stub(env: Env, jobId: string): DurableObjectStub {
  return env.DELETION_JOB.get(env.DELETION_JOB.idFromName(jobId));
}

async function callDo<T>(env: Env, jobId: string, path: string, body?: unknown): Promise<T> {
  const res = await stub(env, jobId).fetch(`https://job${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new HttpError(res.status === 404 ? 404 : 500, 'job_error', detail || 'The job could not be updated.');
  }
  return (await res.json()) as T;
}

async function assertOwner(env: Env, session: SessionContext, jobId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(jobId)) throw badRequest('Invalid job id.');
  if (!(await ownsJob(env, session.data.id, jobId))) throw notFound('That job does not belong to this session.');
}

/* -------------------------------------------------------------------------- */
/* Credential assembly                                                         */
/* -------------------------------------------------------------------------- */

async function buildCredentials(
  env: Env,
  session: SessionContext,
  kind: JobKind,
  pageId?: string,
): Promise<JobCredentials> {
  const provider = PROVIDER_FOR_KIND[kind];
  const conn = session.data.connections[provider];
  if (!conn) {
    const label = provider === 'x' ? 'X' : provider === 'threads' ? 'Threads' : 'Facebook';
    throw unauthorized(`Connect your ${label} account before starting this job.`);
  }

  if (provider === 'x') {
    const tokens = await unseal<{ accessToken: string; refreshToken?: string; userId: string }>(
      conn.sealedTokens,
      env.TOKEN_ENCRYPTION_KEY,
    );
    const client = conn.sealedClient
      ? await unseal<{ clientId: string; clientSecret?: string }>(conn.sealedClient, env.TOKEN_ENCRYPTION_KEY)
      : { clientId: env.X_CLIENT_ID ?? '', clientSecret: env.X_CLIENT_SECRET };
    return {
      provider: 'x',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: conn.expiresAt,
      clientId: client.clientId || undefined,
      clientSecret: client.clientSecret,
      userId: tokens.userId ?? conn.accountId,
    };
  }

  if (provider === 'threads') {
    const tokens = await unseal<{ accessToken: string; userId: string }>(conn.sealedTokens, env.TOKEN_ENCRYPTION_KEY);
    return {
      provider: 'threads',
      accessToken: tokens.accessToken,
      expiresAt: conn.expiresAt,
      userId: tokens.userId ?? conn.accountId,
    };
  }

  // Facebook page
  if (!pageId) throw badRequest('Choose which Facebook Page to clean.');
  const page = conn.pages?.find((p) => p.id === pageId);
  if (!page) throw badRequest('That Page is not in your list of managed Pages. Reconnect Facebook and try again.');
  if (!page.tasks.includes('MANAGE') && !page.tasks.includes('CREATE_CONTENT')) {
    throw badRequest(
      `You do not have content-management rights on "${page.name}". Facebook only allows deletion by admins/editors.`,
    );
  }
  const pageToken = await unseal<{ accessToken: string }>(page.sealedToken, env.TOKEN_ENCRYPTION_KEY);
  const userTokens = await unseal<{ accessToken: string }>(conn.sealedTokens, env.TOKEN_ENCRYPTION_KEY);

  return {
    provider: 'facebook',
    accessToken: userTokens.accessToken,
    expiresAt: conn.expiresAt,
    appSecret: env.FACEBOOK_APP_SECRET,
    pageId: page.id,
    pageToken: pageToken.accessToken,
  };
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                      */
/* -------------------------------------------------------------------------- */

interface CreateBody {
  kind?: string;
  source?: string;
  dryRun?: boolean;
  filters?: unknown;
  items?: unknown[];
  pageId?: string;
  maxItems?: number;
  label?: string;
  /** Full archive size, declared up front so quota can be reserved for it. */
  expectedTotal?: number;
}

export async function createJob(request: Request, env: Env, session: SessionContext): Promise<Response> {
  const body = await readJson<CreateBody>(request);

  const kind = body.kind as JobKind;
  if (!KINDS.includes(kind)) throw badRequest(`Unknown job kind. Expected one of: ${KINDS.join(', ')}.`);

  const source = (body.source === 'archive' ? 'archive' : 'api') as JobSource;
  if (source === 'archive' && kind !== 'x_posts' && kind !== 'x_likes') {
    throw badRequest('Archive import is only available for X posts and likes.');
  }

  // Safe default: anything that isn't an explicit `false` is a dry run.
  const dryRun = body.dryRun !== false;
  const filters = sanitizeFilters(body.filters);
  const credentials = await buildCredentials(env, session, kind, body.pageId);

  const jobId = randomId(12);
  const label =
    typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : undefined;
  const maxItems = typeof body.maxItems === 'number' && body.maxItems > 0 ? Math.floor(body.maxItems) : 0;

  /* ------------------------------ metering ------------------------------ */
  // Only X jobs on *our* app cost us money. Bring-your-own-app users pay X
  // directly, and dry runs make no delete calls at all — both run unmetered.
  const xConn = session.data.connections.x;
  const metered = !dryRun && (kind === 'x_posts' || kind === 'x_likes') && Boolean(xConn?.managed);

  let allowance = 0;
  if (metered && xConn) {
    // We must know the size up front to reserve against it. The archive gives
    // an exact count for free; an API scan has to be explicitly capped.
    //
    // `expectedTotal` is the client's declared archive size — items arrive in
    // chunks after this call, so `body.items` is only the first page. It does
    // not need to be trusted: the reservation caps what the job may ever spend,
    // so understating it just means the job pauses early and asks for a top-up.
    const declared = Math.max(0, Math.floor(Number(body.expectedTotal) || 0));
    const needed = source === 'archive' ? declared || (body.items?.length ?? 0) : maxItems;
    if (!needed) {
      throw badRequest(
        'Set a maximum number of posts before starting a managed scan — we reserve that many deletions from your balance up front so a job can never spend more than you paid for.',
      );
    }

    const reservation = await reserveQuota(env, xConn.accountId, jobId, needed);
    if (!reservation.ok) {
      const quote = quoteFor(Math.max(0, reservation.shortfall ?? needed), env);
      throw new HttpError(402, 'insufficient_quota', 'You do not have enough deletions left for this job.', {
        needed,
        balance: reservation.balance,
        shortfall: reservation.shortfall ?? needed,
        quote,
      });
    }
    allowance = reservation.reserved ?? needed;
  }

  const snapshot = await callDo<JobSnapshot>(env, jobId, '/create', {
    jobId,
    sessionId: session.data.id,
    kind,
    source,
    dryRun,
    filters,
    label,
    maxItems,
    credentials,
    metered,
    billingAccountId: metered ? xConn!.accountId : undefined,
    allowance,
  });

  let final = snapshot;
  if (source === 'archive' && Array.isArray(body.items) && body.items.length) {
    if (body.items.length > MAX_ITEMS_PER_CALL) throw badRequest(`Send at most ${MAX_ITEMS_PER_CALL} items per request.`);
    await callDo(env, jobId, '/items', { items: body.items });
    final = (await callDo<JobSnapshot>(env, jobId, '/status'))!;
  }

  await indexJob(env, session.data.id, {
    jobId,
    kind,
    label,
    dryRun,
    createdAt: final.createdAt,
    status: final.status,
    total: final.total,
    deleted: final.deleted,
  });

  return json({ job: withDerived(final) });
}

export async function addItems(request: Request, env: Env, session: SessionContext, jobId: string): Promise<Response> {
  await assertOwner(env, session, jobId);
  const body = await readJson<{ items?: unknown[] }>(request);
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length > MAX_ITEMS_PER_CALL) throw badRequest(`Send at most ${MAX_ITEMS_PER_CALL} items per request.`);
  const result = await callDo<{ added: number; total: number }>(env, jobId, '/items', { items });
  return json(result);
}

export async function controlJob(
  _request: Request,
  env: Env,
  session: SessionContext,
  jobId: string,
  action: 'start' | 'pause' | 'resume' | 'cancel',
): Promise<Response> {
  await assertOwner(env, session, jobId);
  const snapshot = await callDo<JobSnapshot | null>(env, jobId, `/${action}`, {});
  if (!snapshot) throw notFound('Job not found.');

  await indexJob(env, session.data.id, {
    jobId,
    kind: snapshot.kind,
    label: snapshot.label,
    dryRun: snapshot.dryRun,
    createdAt: snapshot.createdAt,
    status: snapshot.status,
    total: snapshot.total,
    deleted: snapshot.deleted,
  });
  if (supabaseEnabled(env)) await mirrorJob(env, session.data.id, snapshot).catch(() => undefined);

  return json({ job: withDerived(snapshot) });
}

export async function getJob(_request: Request, env: Env, session: SessionContext, jobId: string): Promise<Response> {
  await assertOwner(env, session, jobId);
  const snapshot = await callDo<JobSnapshot | null>(env, jobId, '/status');
  if (!snapshot) throw notFound('Job not found.');

  // Keep the cheap KV index roughly in sync so the history list is accurate.
  await indexJob(env, session.data.id, {
    jobId,
    kind: snapshot.kind,
    label: snapshot.label,
    dryRun: snapshot.dryRun,
    createdAt: snapshot.createdAt,
    status: snapshot.status,
    total: snapshot.total,
    deleted: snapshot.deleted,
  });

  return json({ job: withDerived(snapshot) });
}

export async function listUserJobs(_request: Request, env: Env, session: SessionContext): Promise<Response> {
  return json({ jobs: await listJobs(env, session.data.id) });
}

export async function exportLog(request: Request, env: Env, session: SessionContext, jobId: string): Promise<Response> {
  await assertOwner(env, session, jobId);
  const url = new URL(request.url);
  const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';

  const all: JobLogEntry[] = [];
  let offset = 0;
  // Page through the DO log so a 40k-item job still exports in one file.
  for (;;) {
    const { entries, total } = await callDo<{ entries: JobLogEntry[]; total: number }>(
      env,
      jobId,
      `/log?offset=${offset}&limit=5000`,
    );
    all.push(...entries);
    offset += entries.length;
    if (!entries.length || offset >= total || all.length >= 200_000) break;
  }

  if (format === 'json') {
    return json({ jobId, entries: all }, { headers: { 'content-disposition': `attachment; filename="postcleaner-${jobId}.json"` } });
  }

  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [
    'id,outcome,processed_at,original_created_at,excerpt,error',
    ...all.map((e) =>
      [e.id, e.outcome, new Date(e.at).toISOString(), e.createdAt ?? '', e.text ?? '', e.error ?? '']
        .map(esc)
        .join(','),
    ),
  ];
  return text(rows.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="postcleaner-${jobId}.csv"`,
    },
  });
}

/** Live progress. Falls back to polling client-side if the socket fails. */
export async function jobSocket(request: Request, env: Env, session: SessionContext, jobId: string): Promise<Response> {
  await assertOwner(env, session, jobId);
  // Forward the headers rather than re-wrapping the Request — re-constructing
  // an upgrade request is fragile across runtime versions.
  return stub(env, jobId).fetch('https://job/ws', { headers: request.headers });
}

/* -------------------------------------------------------------------------- */
/* Estimation (used by the confirm screen before anything is deleted)          */
/* -------------------------------------------------------------------------- */

export async function estimate(request: Request, env: Env, _session: SessionContext): Promise<Response> {
  const body = await readJson<{ kind?: string; count?: number; discoveryReads?: number; dryRun?: boolean }>(request);
  const kind = body.kind as JobKind;
  const count = Math.max(0, Math.floor(body.count ?? 0));
  const reads = Math.max(0, Math.floor(body.discoveryReads ?? 0));

  const limits =
    kind === 'x_posts'
      ? X_RATE_LIMITS.deleteTweet
      : kind === 'x_likes'
        ? X_RATE_LIMITS.unlike
        : kind === 'threads_posts'
          ? THREADS_RATE_LIMIT
          : FB_PAGE_RATE_LIMIT;

  const windows = count > 0 ? Math.ceil(count / limits.limit) : 0;
  const durationMs = windows > 0 ? (windows - 1) * limits.windowMs + count * 500 : 0;

  const isX = kind === 'x_posts' || kind === 'x_likes';
  const costUsd = isX && !body.dryRun ? count * X_PRICING.deleteUsd + reads * X_PRICING.postReadUsd : 0;

  return json({
    count,
    perWindow: limits.limit,
    windowMs: limits.windowMs,
    durationMs,
    finishesAt: durationMs ? Date.now() + durationMs : null,
    costEstimateUsd: Number(costUsd.toFixed(2)),
    costNote: isX
      ? 'X moved new developers to pay-per-use pricing in Feb 2026. This is an indicative estimate — check your own developer dashboard for the rates on your account.'
      : 'This platform does not charge per API call for these endpoints.',
  });
}

function withDerived(job: JobSnapshot): JobSnapshot & { progress: number } {
  const progress = job.total > 0 ? Math.min(1, job.cursor / job.total) : 0;
  return { ...job, progress };
}
