/**
 * Session handling.
 *
 * The browser only ever holds `<id>.<hmac>`. Everything else — including the
 * sealed OAuth tokens — lives in KV under that id. Logging out or disconnecting
 * deletes the KV record, which is the only copy of the tokens we hold.
 */

import type { Connection, Env, Provider, SessionData } from '../types';
import { randomId, sign, verify } from './crypto';
import { parseCookies, serializeCookie, timingSafeEqual } from './http';

export const SESSION_COOKIE = 'pc_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const kvKey = (id: string) => `session:${id}`;

export interface SessionContext {
  data: SessionData;
  /** Set when a new cookie needs to go out with the response. */
  setCookie?: string;
  save(): Promise<void>;
  destroy(): Promise<void>;
}

async function readCookieSession(request: Request, env: Env): Promise<string | null> {
  const raw = parseCookies(request)[SESSION_COOKIE];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expected = await sign(id, env.SESSION_SECRET);
  if (!timingSafeEqual(expected, signature)) return null;
  return id;
}

function emptySession(id: string): SessionData {
  const now = Date.now();
  return { id, createdAt: now, updatedAt: now, connections: {} };
}

/**
 * Load the caller's session, creating one if the cookie is missing or invalid.
 * `create: false` returns null instead of minting a session (used by endpoints
 * that must not hand out cookies to crawlers).
 */
export async function getSession(request: Request, env: Env, create = true): Promise<SessionContext | null> {
  const existingId = await readCookieSession(request, env);
  let data: SessionData | null = null;

  if (existingId) {
    const stored = await env.SESSIONS.get(kvKey(existingId), 'json');
    if (stored) data = stored as SessionData;
  }

  let setCookie: string | undefined;
  if (!data) {
    if (!create) return null;
    const id = randomId(24);
    data = emptySession(id);
    const signature = await sign(id, env.SESSION_SECRET);
    setCookie = serializeCookie(SESSION_COOKIE, `${id}.${signature}`, {
      maxAge: SESSION_TTL_SECONDS,
      secure: new URL(request.url).protocol === 'https:',
    });
  }

  const ctx: SessionContext = {
    data,
    setCookie,
    async save() {
      this.data.updatedAt = Date.now();
      await env.SESSIONS.put(kvKey(this.data.id), JSON.stringify(this.data), {
        expirationTtl: SESSION_TTL_SECONDS,
      });
    },
    async destroy() {
      await env.SESSIONS.delete(kvKey(this.data.id));
    },
  };
  return ctx;
}

/** Attach a freshly minted session cookie to an outgoing response. */
export function withSession(response: Response, session: SessionContext | null): Response {
  if (!session?.setCookie) return response;
  // A 101 cannot be re-constructed — WebSocket upgrades pass through untouched.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.append('set-cookie', session.setCookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Strip everything the browser has no business seeing. */
export function publicConnection(conn: Connection | undefined) {
  if (!conn) return null;
  return {
    provider: conn.provider,
    accountId: conn.accountId,
    username: conn.username,
    displayName: conn.displayName ?? null,
    avatarUrl: conn.avatarUrl ?? null,
    scopes: conn.scopes,
    connectedAt: conn.connectedAt,
    expiresAt: conn.expiresAt,
    pages: conn.pages?.map((p) => ({ id: p.id, name: p.name, category: p.category ?? null, tasks: p.tasks })) ?? null,
  };
}

export function requireConnection(session: SessionContext, provider: Provider): Connection {
  const conn = session.data.connections[provider];
  if (!conn) {
    const label = provider === 'x' ? 'X' : provider === 'threads' ? 'Threads' : 'Facebook';
    throw Object.assign(new Error(`Connect your ${label} account first.`), { status: 401 });
  }
  return conn;
}

/* -------------------------------------------------------------------------- */
/* Job index — a lightweight per-session list so the UI can show history.      */
/* -------------------------------------------------------------------------- */

export interface JobIndexEntry {
  jobId: string;
  kind: string;
  label?: string;
  dryRun: boolean;
  createdAt: number;
  status: string;
  total: number;
  deleted: number;
}

const jobIndexKey = (sessionId: string, jobId: string) => `job:${sessionId}:${jobId}`;

export async function indexJob(env: Env, sessionId: string, entry: JobIndexEntry): Promise<void> {
  await env.SESSIONS.put(jobIndexKey(sessionId, entry.jobId), JSON.stringify(entry), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function listJobs(env: Env, sessionId: string): Promise<JobIndexEntry[]> {
  const listed = await env.SESSIONS.list({ prefix: `job:${sessionId}:`, limit: 200 });
  const entries = await Promise.all(
    listed.keys.map(async (k) => (await env.SESSIONS.get(k.name, 'json')) as JobIndexEntry | null),
  );
  return entries.filter((e): e is JobIndexEntry => Boolean(e)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function ownsJob(env: Env, sessionId: string, jobId: string): Promise<boolean> {
  return (await env.SESSIONS.get(jobIndexKey(sessionId, jobId))) !== null;
}
