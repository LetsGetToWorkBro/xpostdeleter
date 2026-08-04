/**
 * Optional Supabase mirror.
 *
 * DELETE.1999 works completely without Supabase — jobs live in Durable Objects.
 * If (and only if) SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are configured we
 * additionally mirror job headers so a user can see their history across
 * devices, and so an operator can keep records beyond the 30-day session TTL.
 *
 * Every call here is fire-and-forget: a Supabase outage must never break or
 * slow down a deletion job.
 */

import type { Env, JobSnapshot } from '../types';

export function supabaseEnabled(env: Env): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

async function rest(env: Env, path: string, init: RequestInit): Promise<Response | null> {
  if (!supabaseEnabled(env)) return null;
  const headers = new Headers(init.headers);
  headers.set('apikey', env.SUPABASE_SERVICE_ROLE_KEY!);
  headers.set('authorization', `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY!}`);
  headers.set('content-type', 'application/json');
  headers.set('prefer', 'resolution=merge-duplicates,return=minimal');
  try {
    return await fetch(`${env.SUPABASE_URL!.replace(/\/+$/, '')}/rest/v1${path}`, { ...init, headers });
  } catch (err) {
    console.warn('supabase mirror unavailable', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Upsert a job header. Never includes tokens or post bodies. */
export async function mirrorJob(env: Env, sessionId: string, job: JobSnapshot): Promise<void> {
  const res = await rest(env, '/jobs?on_conflict=id', {
    method: 'POST',
    body: JSON.stringify([
      {
        id: job.id,
        session_id: sessionId,
        kind: job.kind,
        source: job.source,
        dry_run: job.dryRun,
        status: job.status,
        total: job.total,
        deleted: job.deleted,
        failed: job.failed,
        skipped: job.skipped,
        label: job.label ?? null,
        cost_estimate_usd: job.costEstimateUsd ?? null,
        created_at: new Date(job.createdAt).toISOString(),
        updated_at: new Date(job.updatedAt).toISOString(),
        finished_at: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      },
    ]),
  });
  if (res && !res.ok) {
    console.warn('supabase mirror rejected job upsert', res.status);
  }
}

/** Store user preferences (theme, default filters). Optional convenience only. */
export async function savePreferences(env: Env, sessionId: string, prefs: Record<string, unknown>): Promise<void> {
  await rest(env, '/preferences?on_conflict=session_id', {
    method: 'POST',
    body: JSON.stringify([{ session_id: sessionId, data: prefs, updated_at: new Date().toISOString() }]),
  });
}

export async function loadPreferences(env: Env, sessionId: string): Promise<Record<string, unknown> | null> {
  const res = await rest(env, `/preferences?session_id=eq.${encodeURIComponent(sessionId)}&select=data`, {
    method: 'GET',
    headers: { prefer: 'return=representation' },
  });
  if (!res || !res.ok) return null;
  const rows = (await res.json().catch(() => [])) as { data?: Record<string, unknown> }[];
  return rows[0]?.data ?? null;
}
