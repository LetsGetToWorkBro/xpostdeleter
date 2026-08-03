/**
 * Meta providers: Facebook Graph API (Pages) and the Threads API.
 *
 * READ THIS BEFORE EXTENDING THIS FILE
 * ------------------------------------
 * There is no supported Graph API path for deleting posts from a *personal*
 * Facebook timeline. `publish_actions` was removed in Graph API v3.0 (2018) and
 * nothing replaced it; `user_posts` grants read access only, and DELETE on a
 * personal post id is rejected. PostCleaner therefore does not pretend to
 * automate that — the app ships a guided Activity Log / Manage Activity flow
 * instead, plus an offline analyser for your "Download Your Information" export.
 *
 * What *is* officially supported and implemented here:
 *   - Facebook Pages you administer: list, read the feed, delete posts and
 *     delete comments (pages_manage_posts / pages_manage_engagement).
 *   - Threads: list your posts and delete them (threads_delete), capped by
 *     Meta at 100 deletions per profile per 24 hours.
 */

import { HttpError } from '../lib/http';
import { hmacHex } from '../lib/crypto';

export const GRAPH_VERSION = 'v23.0';
export const GRAPH_API = `https://graph.facebook.com/${GRAPH_VERSION}`;
export const FB_AUTHORIZE_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
export const FB_TOKEN_URL = `${GRAPH_API}/oauth/access_token`;

export const THREADS_API = 'https://graph.threads.net/v1.0';
export const THREADS_AUTHORIZE_URL = 'https://threads.net/oauth/authorize';
export const THREADS_TOKEN_URL = 'https://graph.threads.net/oauth/access_token';
export const THREADS_REFRESH_URL = 'https://graph.threads.net/refresh_access_token';

/**
 * Page scopes. We ask for the narrowest set that still allows deleting a post
 * and a comment, and we explain each one in the UI before the user clicks.
 */
export const FB_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement'];

/** `threads_delete` is the permission Meta added for post deletion (Mar 2025). */
export const THREADS_SCOPES = ['threads_basic', 'threads_delete'];

/** Meta caps Threads deletions at 100 per profile per rolling 24 hours. */
export const THREADS_RATE_LIMIT = { limit: 100, windowMs: 24 * 60 * 60 * 1000 } as const;

/**
 * Pages have no single published per-endpoint delete limit — the platform uses
 * a rolling app+page budget. We stay deliberately conservative.
 */
export const FB_PAGE_RATE_LIMIT = { limit: 180, windowMs: 60 * 60 * 1000 } as const;

export class MetaApiError extends HttpError {
  retryable: boolean;
  subcode?: number;

  constructor(status: number, message: string, retryable: boolean, subcode?: number, details?: unknown) {
    super(status, status === 429 ? 'rate_limited' : 'meta_api_error', message, details);
    this.name = 'MetaApiError';
    this.retryable = retryable;
    this.subcode = subcode;
  }
}

/** Graph API error codes that mean "slow down", not "you did something wrong". */
const THROTTLE_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80003, 80004]);

async function metaFetch(url: string, init: RequestInit = {}, attempt = 0): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set('user-agent', 'PostCleaner/1.0');
  const res = await fetch(url, { ...init, headers });
  const raw = await res.text();
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = { raw: raw.slice(0, 400) };
  }

  if (res.ok && !body?.error) return body;

  const err = body?.error ?? {};
  const code: number | undefined = err.code;
  const subcode: number | undefined = err.error_subcode;
  const throttled = res.status === 429 || (code !== undefined && THROTTLE_CODES.has(code));
  const retryable = throttled || res.status >= 500;

  let message: string = err.message ?? `Meta API returned HTTP ${res.status}.`;
  if (code === 190) {
    message = 'Your Meta access token expired or was revoked. Reconnect the account to continue.';
  } else if (throttled) {
    message = 'Meta is rate limiting this app. The job will pause and retry automatically.';
  } else if (code === 200 || code === 10) {
    message = `Meta refused this action for permission reasons: ${err.message ?? 'missing permission'}. Check that the required page/Threads permissions were granted.`;
  } else if (code === 100 && /nonexisting|does not exist|Unsupported/i.test(err.message ?? '')) {
    message = 'That object no longer exists (or was already deleted).';
  }

  if (res.status >= 500 && attempt === 0) {
    await new Promise((r) => setTimeout(r, 750));
    return metaFetch(url, init, attempt + 1);
  }
  throw new MetaApiError(res.status === 200 ? 400 : res.status, message, retryable, subcode, err);
}

/** Meta strongly recommends signing calls with an appsecret_proof. */
async function withProof(url: URL, accessToken: string, appSecret?: string): Promise<URL> {
  url.searchParams.set('access_token', accessToken);
  if (appSecret) url.searchParams.set('appsecret_proof', await hmacHex(accessToken, appSecret));
  return url;
}

/* -------------------------------------------------------------------------- */
/* Facebook OAuth                                                              */
/* -------------------------------------------------------------------------- */

export function buildFacebookAuthorizeUrl(params: {
  appId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const url = new URL(FB_AUTHORIZE_URL);
  url.searchParams.set('client_id', params.appId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (params.scopes ?? FB_SCOPES).join(','));
  return url.toString();
}

export interface MetaTokens {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

export async function exchangeFacebookCode(params: {
  code: string;
  redirectUri: string;
  appId: string;
  appSecret: string;
}): Promise<MetaTokens> {
  const url = new URL(FB_TOKEN_URL);
  url.searchParams.set('client_id', params.appId);
  url.searchParams.set('client_secret', params.appSecret);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('code', params.code);
  const short = await metaFetch(url.toString());

  // Immediately upgrade to a ~60-day long-lived token so multi-day jobs survive.
  const longUrl = new URL(FB_TOKEN_URL);
  longUrl.searchParams.set('grant_type', 'fb_exchange_token');
  longUrl.searchParams.set('client_id', params.appId);
  longUrl.searchParams.set('client_secret', params.appSecret);
  longUrl.searchParams.set('fb_exchange_token', short.access_token);
  const long = await metaFetch(longUrl.toString()).catch(() => short);

  return {
    accessToken: long.access_token,
    expiresAt: Date.now() + (long.expires_in ?? 60 * 24 * 3600) * 1000,
    scopes: FB_SCOPES,
  };
}

export interface MetaProfile {
  id: string;
  name: string;
  avatarUrl?: string;
}

export async function getFacebookMe(accessToken: string, appSecret?: string): Promise<MetaProfile> {
  const url = await withProof(new URL(`${GRAPH_API}/me`), accessToken, appSecret);
  url.searchParams.set('fields', 'id,name,picture.type(large)');
  const data = await metaFetch(url.toString());
  return { id: data.id, name: data.name, avatarUrl: data.picture?.data?.url };
}

export interface RawPage {
  id: string;
  name: string;
  category?: string;
  access_token: string;
  tasks?: string[];
}

export async function listPages(accessToken: string, appSecret?: string): Promise<RawPage[]> {
  const url = await withProof(new URL(`${GRAPH_API}/me/accounts`), accessToken, appSecret);
  url.searchParams.set('fields', 'id,name,category,access_token,tasks');
  url.searchParams.set('limit', '100');
  const out: RawPage[] = [];
  let next: string | undefined = url.toString();
  while (next && out.length < 300) {
    const page: any = await metaFetch(next);
    out.push(...(page.data ?? []));
    next = page.paging?.next;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Facebook Page content                                                       */
/* -------------------------------------------------------------------------- */

export interface MetaFeedPage {
  items: { id: string; createdAt?: string; text?: string; likes?: number; hasMedia?: boolean }[];
  next?: string;
}

/**
 * Posts published by the page itself. `/{page-id}/posts` (as opposed to
 * `/feed`) excludes posts other people made on the page, which are not ours
 * to delete.
 */
export async function fetchPagePosts(
  pageToken: string,
  pageId: string,
  after?: string,
  appSecret?: string,
): Promise<MetaFeedPage> {
  const url = await withProof(new URL(`${GRAPH_API}/${encodeURIComponent(pageId)}/posts`), pageToken, appSecret);
  url.searchParams.set('fields', 'id,created_time,message,attachments{media_type},likes.summary(true).limit(0)');
  url.searchParams.set('limit', '50');
  if (after) url.searchParams.set('after', after);

  const data = await metaFetch(url.toString());
  return {
    items: (data.data ?? []).map((p: any) => ({
      id: p.id,
      createdAt: p.created_time,
      text: typeof p.message === 'string' ? p.message.slice(0, 160) : undefined,
      likes: p.likes?.summary?.total_count,
      hasMedia: Boolean(p.attachments?.data?.length),
    })),
    next: data.paging?.cursors?.after && data.data?.length ? data.paging.cursors.after : undefined,
  };
}

/** Comments left *by the page* across its own posts. */
export async function fetchPageComments(
  pageToken: string,
  pageId: string,
  after?: string,
  appSecret?: string,
): Promise<MetaFeedPage> {
  const url = await withProof(new URL(`${GRAPH_API}/${encodeURIComponent(pageId)}/posts`), pageToken, appSecret);
  url.searchParams.set('fields', 'id,comments.limit(50){id,created_time,message,from}');
  url.searchParams.set('limit', '25');
  if (after) url.searchParams.set('after', after);

  const data = await metaFetch(url.toString());
  const items: MetaFeedPage['items'] = [];
  for (const post of data.data ?? []) {
    for (const c of post.comments?.data ?? []) {
      if (c.from?.id && c.from.id !== pageId) continue; // only our own comments
      items.push({
        id: c.id,
        createdAt: c.created_time,
        text: typeof c.message === 'string' ? c.message.slice(0, 160) : undefined,
      });
    }
  }
  return {
    items,
    next: data.paging?.cursors?.after && data.data?.length ? data.paging.cursors.after : undefined,
  };
}

export async function deleteGraphObject(
  pageToken: string,
  objectId: string,
  appSecret?: string,
): Promise<{ ok: boolean; alreadyGone?: boolean }> {
  const url = await withProof(new URL(`${GRAPH_API}/${encodeURIComponent(objectId)}`), pageToken, appSecret);
  try {
    const data = await metaFetch(url.toString(), { method: 'DELETE' });
    return { ok: data?.success !== false };
  } catch (err) {
    if (err instanceof MetaApiError && /no longer exists|already been deleted|nonexisting/i.test(err.message)) {
      return { ok: true, alreadyGone: true };
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Threads                                                                     */
/* -------------------------------------------------------------------------- */

export function buildThreadsAuthorizeUrl(params: {
  appId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const url = new URL(THREADS_AUTHORIZE_URL);
  url.searchParams.set('client_id', params.appId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', (params.scopes ?? THREADS_SCOPES).join(','));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', params.state);
  return url.toString();
}

export async function exchangeThreadsCode(params: {
  code: string;
  redirectUri: string;
  appId: string;
  appSecret: string;
}): Promise<MetaTokens & { userId: string }> {
  const body = new URLSearchParams({
    client_id: params.appId,
    client_secret: params.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: params.redirectUri,
    code: params.code,
  });
  const short = await metaFetch(THREADS_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  // Upgrade to the 60-day long-lived token.
  const longUrl = new URL('https://graph.threads.net/access_token');
  longUrl.searchParams.set('grant_type', 'th_exchange_token');
  longUrl.searchParams.set('client_secret', params.appSecret);
  longUrl.searchParams.set('access_token', short.access_token);
  const long = await metaFetch(longUrl.toString()).catch(() => short);

  return {
    accessToken: long.access_token,
    expiresAt: Date.now() + (long.expires_in ?? 60 * 24 * 3600) * 1000,
    scopes: THREADS_SCOPES,
    userId: String(short.user_id ?? ''),
  };
}

export async function refreshThreadsToken(accessToken: string): Promise<MetaTokens> {
  const url = new URL(THREADS_REFRESH_URL);
  url.searchParams.set('grant_type', 'th_refresh_token');
  url.searchParams.set('access_token', accessToken);
  const data = await metaFetch(url.toString());
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 60 * 24 * 3600) * 1000,
    scopes: THREADS_SCOPES,
  };
}

export async function getThreadsMe(accessToken: string): Promise<MetaProfile & { username?: string }> {
  const url = new URL(`${THREADS_API}/me`);
  url.searchParams.set('fields', 'id,username,name,threads_profile_picture_url');
  url.searchParams.set('access_token', accessToken);
  const data = await metaFetch(url.toString());
  return {
    id: String(data.id),
    name: data.name ?? data.username ?? 'Threads user',
    username: data.username,
    avatarUrl: data.threads_profile_picture_url,
  };
}

export async function fetchThreadsPage(
  accessToken: string,
  userId: string,
  after?: string,
): Promise<MetaFeedPage> {
  const url = new URL(`${THREADS_API}/${encodeURIComponent(userId)}/threads`);
  url.searchParams.set('fields', 'id,text,timestamp,media_type,is_quote_post');
  url.searchParams.set('limit', '100');
  url.searchParams.set('access_token', accessToken);
  if (after) url.searchParams.set('after', after);

  const data = await metaFetch(url.toString());
  return {
    items: (data.data ?? []).map((t: any) => ({
      id: String(t.id),
      createdAt: t.timestamp,
      text: typeof t.text === 'string' ? t.text.slice(0, 160) : undefined,
      hasMedia: t.media_type && t.media_type !== 'TEXT_POST',
    })),
    next: data.paging?.cursors?.after && data.data?.length ? data.paging.cursors.after : undefined,
  };
}

export async function deleteThreadsPost(
  accessToken: string,
  mediaId: string,
): Promise<{ ok: boolean; alreadyGone?: boolean }> {
  const url = new URL(`${THREADS_API}/${encodeURIComponent(mediaId)}`);
  url.searchParams.set('access_token', accessToken);
  try {
    const data = await metaFetch(url.toString(), { method: 'DELETE' });
    return { ok: data?.success !== false };
  } catch (err) {
    if (err instanceof MetaApiError && /no longer exists|nonexisting|does not exist/i.test(err.message)) {
      return { ok: true, alreadyGone: true };
    }
    throw err;
  }
}
