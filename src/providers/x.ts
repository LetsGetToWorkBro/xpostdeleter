/**
 * X (Twitter) API v2 client.
 *
 * Everything here uses documented, official endpoints only:
 *   - OAuth 2.0 Authorization Code with PKCE  (https://docs.x.com/resources/fundamentals/authentication)
 *   - GET    /2/users/me
 *   - GET    /2/users/:id/tweets       (timeline enumeration, max ~3200 posts)
 *   - DELETE /2/tweets/:id             (50 requests / 15 min, per user)
 *   - GET    /2/users/:id/liked_tweets
 *   - DELETE /2/users/:id/likes/:id    (50 requests / 15 min, per user)
 *
 * There is deliberately no scraping, no private/undocumented endpoint and no
 * browser-session automation anywhere in this file.
 */

import { HttpError } from '../lib/http';

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const X_REVOKE_URL = 'https://api.x.com/2/oauth2/revoke';
export const X_API = 'https://api.x.com/2';

/** Scopes we ask for. `offline.access` is what makes multi-day jobs possible. */
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'like.read', 'like.write', 'offline.access'];

/**
 * Documented per-user rate limits. Both delete endpoints are 50 requests per
 * 15 minutes, which is the single most important number in this app: a 20k
 * post history is ~100 hours of wall clock.
 */
export const X_RATE_LIMITS = {
  deleteTweet: { limit: 50, windowMs: 15 * 60 * 1000 },
  unlike: { limit: 50, windowMs: 15 * 60 * 1000 },
  /** Timeline reads are generous (900/15min per user); we stay well under. */
  timeline: { limit: 300, windowMs: 15 * 60 * 1000 },
} as const;

/**
 * Indicative pay-per-use prices (X moved new developers to credit-based
 * pricing in Feb 2026). These are used only to show an *estimate* in the UI and
 * are trivially adjustable — always check your own developer dashboard.
 */
export const X_PRICING = {
  /** "Posts: Read" — $0.005 per resource. Only spent on the API-scan path. */
  postReadUsd: 0.005,
  /** "User: Read" — $0.010 per resource. One call at connect time. */
  userReadUsd: 0.01,
  /**
   * Deleting a post.
   *
   * X's published write table has no explicit "Post: Delete" row. The two
   * candidates are "Interaction: Delete" ($0.010) and "Content: Manage"
   * ($0.005); third-party reporting since the Feb 2026 change consistently
   * describes $0.01 per delete, so we plan against the pessimistic number.
   * $0.015 is the *create* price and does not apply here.
   *
   * Verify against your own billing dashboard before quoting anyone a price —
   * this single constant decides whether a paid tier makes money.
   */
  deleteUsd: 0.01,
  currency: 'USD',
} as const;

export interface XTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
}

export interface XClientCredentials {
  clientId: string;
  clientSecret?: string;
}

export interface XRateInfo {
  limit?: number;
  remaining?: number;
  /** Epoch ms. */
  reset?: number;
}

export class XApiError extends HttpError {
  rate: XRateInfo;
  retryable: boolean;

  constructor(status: number, message: string, rate: XRateInfo, retryable: boolean, details?: unknown) {
    super(status, status === 429 ? 'rate_limited' : 'x_api_error', message, details);
    this.name = 'XApiError';
    this.rate = rate;
    this.retryable = retryable;
  }
}

function readRateHeaders(res: Response): XRateInfo {
  const limit = Number(res.headers.get('x-rate-limit-limit'));
  const remaining = Number(res.headers.get('x-rate-limit-remaining'));
  const reset = Number(res.headers.get('x-rate-limit-reset'));
  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    remaining: Number.isFinite(remaining) ? remaining : undefined,
    reset: Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined,
  };
}

/** Turn an X error body into something a non-technical user can act on. */
async function describeError(res: Response): Promise<{ message: string; body: unknown }> {
  let body: unknown = null;
  const raw = await res.text();
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw?.slice(0, 400) ?? null;
  }
  const b = body as Record<string, any> | null;
  const detail: string | undefined =
    b?.detail ?? b?.title ?? b?.errors?.[0]?.message ?? b?.error_description ?? b?.error;

  const friendly: Record<number, string> = {
    400: 'X rejected the request. This usually means the post no longer exists or was already deleted.',
    401: 'Your X authorisation expired or was revoked. Reconnect your account to continue.',
    403: 'X refused this action. Check that your developer app has Read *and* Write permissions and that the User authentication settings are configured.',
    404: 'That post no longer exists on X — nothing to delete.',
    429: 'X rate limit reached. The job will resume automatically when the window resets.',
  };
  const base = friendly[res.status] ?? `X API returned HTTP ${res.status}.`;
  return { message: detail ? `${base} (${detail})` : base, body };
}

async function xFetch(
  path: string,
  init: RequestInit & { accessToken: string },
  attempt = 0,
): Promise<{ res: Response; rate: XRateInfo; json: any }> {
  const { accessToken, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('authorization', `Bearer ${accessToken}`);
  headers.set('user-agent', 'DELETE.1999/1.0 (+https://github.com/letsgettoworkbro/xpostdeleter)');
  if (rest.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const res = await fetch(path.startsWith('http') ? path : `${X_API}${path}`, { ...rest, headers });
  const rate = readRateHeaders(res);

  if (res.ok) {
    const raw = await res.text();
    return { res, rate, json: raw ? JSON.parse(raw) : null };
  }

  const { message, body } = await describeError(res);
  const retryable = res.status === 429 || res.status >= 500;

  // One immediate retry for transient 5xx; 429 is handled by the job scheduler
  // (which knows about the whole rate window) rather than by blocking here.
  if (res.status >= 500 && attempt === 0) {
    await new Promise((r) => setTimeout(r, 750));
    return xFetch(path, init, attempt + 1);
  }
  throw new XApiError(res.status, message, rate, retryable, body);
}

/* -------------------------------------------------------------------------- */
/* OAuth 2.0 + PKCE                                                            */
/* -------------------------------------------------------------------------- */

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string[];
}): string {
  const url = new URL(X_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', (params.scopes ?? X_SCOPES).join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function clientAuthHeaders(creds: XClientCredentials): Headers {
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  // Confidential clients must use HTTP Basic; public (PKCE-only) clients must not.
  if (creds.clientSecret) {
    headers.set('authorization', `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`);
  }
  return headers;
}

async function tokenRequest(body: URLSearchParams, creds: XClientCredentials): Promise<XTokens> {
  body.set('client_id', creds.clientId);
  const res = await fetch(X_TOKEN_URL, { method: 'POST', headers: clientAuthHeaders(creds), body });
  if (!res.ok) {
    const { message, body: errBody } = await describeError(res);
    throw new XApiError(res.status, message, readRateHeaders(res), false, errBody);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    scopes: (data.scope ?? '').split(/\s+/).filter(Boolean),
  };
}

export async function exchangeCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  creds: XClientCredentials;
}): Promise<XTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  return tokenRequest(body, params.creds);
}

export async function refreshTokens(refreshToken: string, creds: XClientCredentials): Promise<XTokens> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const tokens = await tokenRequest(body, creds);
  // X rotates refresh tokens; keep the old one only if a new one wasn't issued.
  if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
  return tokens;
}

export async function revokeToken(token: string, creds: XClientCredentials): Promise<void> {
  const body = new URLSearchParams({ token, token_type_hint: 'access_token', client_id: creds.clientId });
  await fetch(X_REVOKE_URL, { method: 'POST', headers: clientAuthHeaders(creds), body }).catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

export interface XUser {
  id: string;
  username: string;
  name: string;
  profileImageUrl?: string;
  tweetCount?: number;
}

export async function getMe(accessToken: string): Promise<XUser> {
  const { json } = await xFetch('/users/me?user.fields=profile_image_url,public_metrics,username,name', {
    method: 'GET',
    accessToken,
  });
  const u = json.data;
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    profileImageUrl: u.profile_image_url,
    tweetCount: u.public_metrics?.tweet_count,
  };
}

export interface TimelinePage {
  items: {
    id: string;
    createdAt?: string;
    text?: string;
    likes?: number;
    hasMedia?: boolean;
    isReply?: boolean;
    isRetweet?: boolean;
  }[];
  nextToken?: string;
}

/**
 * One page of the authenticated user's own posts.
 *
 * Note the hard platform ceiling: this endpoint only reaches roughly the most
 * recent 3,200 posts. For anything older the archive path is the only complete
 * source, which is exactly why DELETE.1999 leads with it.
 */
export async function fetchTimelinePage(
  accessToken: string,
  userId: string,
  paginationToken?: string,
  opts: { startTime?: string; endTime?: string } = {},
): Promise<TimelinePage> {
  const url = new URL(`${X_API}/users/${encodeURIComponent(userId)}/tweets`);
  url.searchParams.set('max_results', '100');
  url.searchParams.set('tweet.fields', 'created_at,public_metrics,referenced_tweets,attachments,text');
  if (paginationToken) url.searchParams.set('pagination_token', paginationToken);
  if (opts.startTime) url.searchParams.set('start_time', opts.startTime);
  if (opts.endTime) url.searchParams.set('end_time', opts.endTime);

  const { json } = await xFetch(url.toString(), { method: 'GET', accessToken });
  const data: any[] = json?.data ?? [];
  return {
    items: data.map((t) => {
      const refs: any[] = t.referenced_tweets ?? [];
      return {
        id: t.id,
        createdAt: t.created_at,
        text: typeof t.text === 'string' ? t.text.slice(0, 160) : undefined,
        likes: t.public_metrics?.like_count,
        hasMedia: Boolean(t.attachments?.media_keys?.length),
        isReply: refs.some((r) => r.type === 'replied_to'),
        isRetweet: refs.some((r) => r.type === 'retweeted'),
      };
    }),
    nextToken: json?.meta?.next_token,
  };
}

export async function fetchLikedPage(
  accessToken: string,
  userId: string,
  paginationToken?: string,
): Promise<TimelinePage> {
  const url = new URL(`${X_API}/users/${encodeURIComponent(userId)}/liked_tweets`);
  url.searchParams.set('max_results', '100');
  url.searchParams.set('tweet.fields', 'created_at,public_metrics,text');
  if (paginationToken) url.searchParams.set('pagination_token', paginationToken);

  const { json } = await xFetch(url.toString(), { method: 'GET', accessToken });
  const data: any[] = json?.data ?? [];
  return {
    items: data.map((t) => ({
      id: t.id,
      createdAt: t.created_at,
      text: typeof t.text === 'string' ? t.text.slice(0, 160) : undefined,
      likes: t.public_metrics?.like_count,
    })),
    nextToken: json?.meta?.next_token,
  };
}

export interface DeleteOutcome {
  ok: boolean;
  /** True when the post was already gone — counts as success, not failure. */
  alreadyGone?: boolean;
  rate: XRateInfo;
}

export async function deleteTweet(accessToken: string, tweetId: string): Promise<DeleteOutcome> {
  try {
    const { json, rate } = await xFetch(`/tweets/${encodeURIComponent(tweetId)}`, { method: 'DELETE', accessToken });
    return { ok: json?.data?.deleted !== false, rate };
  } catch (err) {
    // 404 / "not found" means someone (probably you) already deleted it.
    if (err instanceof XApiError && (err.status === 404 || err.status === 400)) {
      return { ok: true, alreadyGone: true, rate: err.rate };
    }
    throw err;
  }
}

/**
 * Calibration probe: delete exactly one post and report everything X tells us.
 *
 * X does not publish a "Post: Delete" price and does not return billing data on
 * the response, so the only way to learn the real unit cost is to spend one
 * credit and read the meter. This makes that a single call: note your credit
 * balance, run this, note it again. The difference is the answer.
 *
 * Also dumps the full rate-limit header set, which is what tells you whether
 * the ceiling you hit is the per-user one or something app-wide.
 */
export async function probeDelete(
  accessToken: string,
  tweetId: string,
): Promise<{
  ok: boolean;
  status: number;
  alreadyGone: boolean;
  durationMs: number;
  rateHeaders: Record<string, string>;
  rate: XRateInfo;
  body: unknown;
  error?: string;
}> {
  const started = Date.now();
  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
    'user-agent': 'DELETE.1999/1.0 (calibration probe)',
  });
  const res = await fetch(`${X_API}/tweets/${encodeURIComponent(tweetId)}`, { method: 'DELETE', headers });
  const durationMs = Date.now() - started;

  const rateHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    // Everything X exposes about limits, verbatim — including any header we
    // don't currently model, which is exactly what a probe is for.
    if (/^x-(rate|app|user|account)/i.test(key)) rateHeaders[key] = value;
  });

  const raw = await res.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw.slice(0, 400);
  }

  const alreadyGone = res.status === 404 || res.status === 400;
  return {
    ok: res.ok,
    status: res.status,
    alreadyGone,
    durationMs,
    rateHeaders,
    rate: readRateHeaders(res),
    body,
    error: res.ok ? undefined : (await describeError(new Response(raw, { status: res.status }))).message,
  };
}

export async function unlikeTweet(accessToken: string, userId: string, tweetId: string): Promise<DeleteOutcome> {
  try {
    const { json, rate } = await xFetch(
      `/users/${encodeURIComponent(userId)}/likes/${encodeURIComponent(tweetId)}`,
      { method: 'DELETE', accessToken },
    );
    return { ok: json?.data?.liked !== true, rate };
  } catch (err) {
    if (err instanceof XApiError && (err.status === 404 || err.status === 400)) {
      return { ok: true, alreadyGone: true, rate: err.rate };
    }
    throw err;
  }
}
