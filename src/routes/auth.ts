/**
 * OAuth routes for X, Facebook and Threads.
 *
 * Design notes:
 *  - X uses Authorization Code + PKCE. The code verifier never leaves the
 *    server; the browser only ever sees an opaque session cookie.
 *  - "Bring your own app": a user can paste their own X client id (and secret
 *    for confidential apps). It is sealed with AES-GCM before it touches KV.
 *  - Every callback validates `state` against the pending auth stored in the
 *    session, which is single-use.
 */

import type { Connection, Env, PendingAuth, Provider } from '../types';
import { HttpError, badRequest, baseUrl, json, readJson, redirect } from '../lib/http';
import { createPkce, randomId, seal, unseal } from '../lib/crypto';
import { getSession, publicConnection, type SessionContext } from '../lib/session';
import * as X from '../providers/x';
import * as Meta from '../providers/meta';

const PENDING_TTL_MS = 10 * 60 * 1000;

export function redirectUriFor(request: Request, env: Env, provider: Provider): string {
  return `${baseUrl(request, env.PUBLIC_BASE_URL)}/auth/${provider}/callback`;
}

interface SealedClient {
  clientId: string;
  clientSecret?: string;
}

/** Land the user back in the SPA with a message it can render. */
function finish(request: Request, env: Env, params: Record<string, string>): Response {
  const url = new URL(baseUrl(request, env.PUBLIC_BASE_URL));
  const hash = new URLSearchParams(params).toString();
  url.hash = hash;
  return redirect(url.toString());
}

function takePending(session: SessionContext, state: string): PendingAuth {
  const pending = session.data.pending;
  if (!pending || pending.state !== state) {
    throw badRequest('This sign-in link is no longer valid. Please start the connection again.');
  }
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    throw badRequest('The sign-in attempt timed out. Please try connecting again.');
  }
  session.data.pending = undefined; // single use
  return pending;
}

/* -------------------------------------------------------------------------- */
/* X                                                                           */
/* -------------------------------------------------------------------------- */

/** Store the user's own X app credentials so they never need a shared app. */
export async function saveXApp(request: Request, env: Env, session: SessionContext): Promise<Response> {
  const body = await readJson<{ clientId?: string; clientSecret?: string }>(request);
  const clientId = (body.clientId ?? '').trim();
  const clientSecret = (body.clientSecret ?? '').trim();

  if (!clientId) throw badRequest('Client ID is required.');
  if (clientId.length > 200 || (clientSecret && clientSecret.length > 300)) {
    throw badRequest('Those credentials do not look like X app credentials.');
  }

  const prefs = session.data.preferences ?? {};
  prefs.xClient = await seal({ clientId, clientSecret: clientSecret || undefined } satisfies SealedClient, env.TOKEN_ENCRYPTION_KEY);
  prefs.xClientIdHint = `${clientId.slice(0, 6)}…${clientId.slice(-4)}`;
  prefs.xClientConfidential = Boolean(clientSecret);
  session.data.preferences = prefs;
  await session.save();

  return json({
    ok: true,
    redirectUri: redirectUriFor(request, env, 'x'),
    hint: prefs.xClientIdHint,
    confidential: Boolean(clientSecret),
  });
}

async function resolveXClient(env: Env, session: SessionContext): Promise<SealedClient> {
  const sealed = session.data.preferences?.xClient as string | undefined;
  if (sealed) return unseal<SealedClient>(sealed, env.TOKEN_ENCRYPTION_KEY);
  if (env.X_CLIENT_ID) return { clientId: env.X_CLIENT_ID, clientSecret: env.X_CLIENT_SECRET };
  throw badRequest(
    'No X app is configured. Add your own X app Client ID in step 1, or ask the operator to set X_CLIENT_ID.',
  );
}

export async function startX(request: Request, env: Env, session: SessionContext): Promise<Response> {
  const client = await resolveXClient(env, session);
  const pkce = await createPkce();
  const state = randomId(18);
  const redirectUri = redirectUriFor(request, env, 'x');

  session.data.pending = {
    provider: 'x',
    state,
    codeVerifier: pkce.verifier,
    createdAt: Date.now(),
    sealedClient: await seal(client, env.TOKEN_ENCRYPTION_KEY),
    redirectUri,
    scopes: X.X_SCOPES,
  };
  await session.save();

  return redirect(
    X.buildAuthorizeUrl({
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge: pkce.challenge,
      scopes: X.X_SCOPES,
    }),
  );
}

export async function callbackX(request: Request, env: Env, session: SessionContext): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) {
    return finish(request, env, {
      auth: 'error',
      provider: 'x',
      message: error === 'access_denied' ? 'You cancelled the X authorisation.' : `X returned: ${error}`,
    });
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return finish(request, env, { auth: 'error', provider: 'x', message: 'Missing code or state.' });

  try {
    const pending = takePending(session, state);
    const client = await unseal<SealedClient>(pending.sealedClient!, env.TOKEN_ENCRYPTION_KEY);
    const tokens = await X.exchangeCode({
      code,
      codeVerifier: pending.codeVerifier!,
      redirectUri: pending.redirectUri,
      creds: client,
    });
    const me = await X.getMe(tokens.accessToken);

    const connection: Connection = {
      provider: 'x',
      accountId: me.id,
      username: me.username,
      displayName: me.name,
      avatarUrl: me.profileImageUrl,
      scopes: tokens.scopes.length ? tokens.scopes : X.X_SCOPES,
      connectedAt: Date.now(),
      expiresAt: tokens.expiresAt,
      sealedTokens: await seal(
        { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, userId: me.id },
        env.TOKEN_ENCRYPTION_KEY,
      ),
      sealedClient: pending.sealedClient,
    };
    session.data.connections.x = connection;
    await session.save();

    return finish(request, env, { auth: 'connected', provider: 'x', username: me.username });
  } catch (err) {
    const message = err instanceof HttpError ? err.message : 'Could not complete the X sign-in.';
    return finish(request, env, { auth: 'error', provider: 'x', message });
  }
}

/* -------------------------------------------------------------------------- */
/* Facebook                                                                    */
/* -------------------------------------------------------------------------- */

export async function startFacebook(request: Request, env: Env, session: SessionContext): Promise<Response> {
  if (!env.FACEBOOK_APP_ID || !env.FACEBOOK_APP_SECRET) {
    throw badRequest('Facebook is not configured on this deployment (FACEBOOK_APP_ID / FACEBOOK_APP_SECRET missing).');
  }
  const state = randomId(18);
  const redirectUri = redirectUriFor(request, env, 'facebook');
  session.data.pending = {
    provider: 'facebook',
    state,
    createdAt: Date.now(),
    redirectUri,
    scopes: Meta.FB_SCOPES,
  };
  await session.save();
  return redirect(
    Meta.buildFacebookAuthorizeUrl({ appId: env.FACEBOOK_APP_ID, redirectUri, state, scopes: Meta.FB_SCOPES }),
  );
}

export async function callbackFacebook(request: Request, env: Env, session: SessionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get('error')) {
    return finish(request, env, {
      auth: 'error',
      provider: 'facebook',
      message: url.searchParams.get('error_description') ?? 'You cancelled the Facebook authorisation.',
    });
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return finish(request, env, { auth: 'error', provider: 'facebook', message: 'Missing code or state.' });
  }

  try {
    const pending = takePending(session, state);
    const tokens = await Meta.exchangeFacebookCode({
      code,
      redirectUri: pending.redirectUri,
      appId: env.FACEBOOK_APP_ID!,
      appSecret: env.FACEBOOK_APP_SECRET!,
    });
    const me = await Meta.getFacebookMe(tokens.accessToken, env.FACEBOOK_APP_SECRET);
    const rawPages = await Meta.listPages(tokens.accessToken, env.FACEBOOK_APP_SECRET).catch(() => []);

    const pages = await Promise.all(
      rawPages.map(async (p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        tasks: p.tasks ?? [],
        sealedToken: await seal({ accessToken: p.access_token }, env.TOKEN_ENCRYPTION_KEY),
      })),
    );

    session.data.connections.facebook = {
      provider: 'facebook',
      accountId: me.id,
      username: me.name,
      displayName: me.name,
      avatarUrl: me.avatarUrl,
      scopes: tokens.scopes,
      connectedAt: Date.now(),
      expiresAt: tokens.expiresAt,
      sealedTokens: await seal({ accessToken: tokens.accessToken }, env.TOKEN_ENCRYPTION_KEY),
      pages,
    };
    await session.save();

    return finish(request, env, { auth: 'connected', provider: 'facebook', username: me.name, pages: String(pages.length) });
  } catch (err) {
    const message = err instanceof HttpError ? err.message : 'Could not complete the Facebook sign-in.';
    return finish(request, env, { auth: 'error', provider: 'facebook', message });
  }
}

/* -------------------------------------------------------------------------- */
/* Threads                                                                     */
/* -------------------------------------------------------------------------- */

export async function startThreads(request: Request, env: Env, session: SessionContext): Promise<Response> {
  if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET) {
    throw badRequest('Threads is not configured on this deployment (THREADS_APP_ID / THREADS_APP_SECRET missing).');
  }
  const state = randomId(18);
  const redirectUri = redirectUriFor(request, env, 'threads');
  session.data.pending = {
    provider: 'threads',
    state,
    createdAt: Date.now(),
    redirectUri,
    scopes: Meta.THREADS_SCOPES,
  };
  await session.save();
  return redirect(
    Meta.buildThreadsAuthorizeUrl({ appId: env.THREADS_APP_ID, redirectUri, state, scopes: Meta.THREADS_SCOPES }),
  );
}

export async function callbackThreads(request: Request, env: Env, session: SessionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get('error')) {
    return finish(request, env, {
      auth: 'error',
      provider: 'threads',
      message: url.searchParams.get('error_description') ?? 'You cancelled the Threads authorisation.',
    });
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return finish(request, env, { auth: 'error', provider: 'threads', message: 'Missing code or state.' });
  }

  try {
    const pending = takePending(session, state);
    // Threads appends "#_" to the code on some redirects.
    const cleanCode = code.replace(/#_$/, '');
    const tokens = await Meta.exchangeThreadsCode({
      code: cleanCode,
      redirectUri: pending.redirectUri,
      appId: env.THREADS_APP_ID!,
      appSecret: env.THREADS_APP_SECRET!,
    });
    const me = await Meta.getThreadsMe(tokens.accessToken);

    session.data.connections.threads = {
      provider: 'threads',
      accountId: me.id || tokens.userId,
      username: me.username ?? me.name,
      displayName: me.name,
      avatarUrl: me.avatarUrl,
      scopes: tokens.scopes,
      connectedAt: Date.now(),
      expiresAt: tokens.expiresAt,
      sealedTokens: await seal(
        { accessToken: tokens.accessToken, userId: me.id || tokens.userId },
        env.TOKEN_ENCRYPTION_KEY,
      ),
    };
    await session.save();
    return finish(request, env, { auth: 'connected', provider: 'threads', username: me.username ?? me.name });
  } catch (err) {
    const message = err instanceof HttpError ? err.message : 'Could not complete the Threads sign-in.';
    return finish(request, env, { auth: 'error', provider: 'threads', message });
  }
}

/* -------------------------------------------------------------------------- */
/* Session info + disconnect                                                   */
/* -------------------------------------------------------------------------- */

export async function sessionInfo(request: Request, env: Env, session: SessionContext): Promise<Response> {
  const prefs = session.data.preferences ?? {};
  return json({
    sessionId: session.data.id,
    connections: {
      x: publicConnection(session.data.connections.x),
      facebook: publicConnection(session.data.connections.facebook),
      threads: publicConnection(session.data.connections.threads),
    },
    capabilities: {
      xSharedApp: Boolean(env.X_CLIENT_ID),
      xUserApp: Boolean(prefs.xClient),
      xClientHint: (prefs.xClientIdHint as string) ?? null,
      facebook: Boolean(env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET),
      threads: Boolean(env.THREADS_APP_ID && env.THREADS_APP_SECRET),
      supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
    },
    redirectUris: {
      x: redirectUriFor(request, env, 'x'),
      facebook: redirectUriFor(request, env, 'facebook'),
      threads: redirectUriFor(request, env, 'threads'),
    },
    limits: {
      xDeletePer15Min: X.X_RATE_LIMITS.deleteTweet.limit,
      threadsDeletePer24h: Meta.THREADS_RATE_LIMIT.limit,
      facebookPagePerHour: Meta.FB_PAGE_RATE_LIMIT.limit,
    },
    pricing: X.X_PRICING,
  });
}

export async function disconnect(
  request: Request,
  env: Env,
  session: SessionContext,
  provider: Provider,
): Promise<Response> {
  const conn = session.data.connections[provider];
  if (conn && provider === 'x' && conn.sealedClient) {
    // Best effort: tell X to invalidate the token immediately.
    try {
      const tokens = await unseal<{ accessToken: string }>(conn.sealedTokens, env.TOKEN_ENCRYPTION_KEY);
      const client = await unseal<SealedClient>(conn.sealedClient, env.TOKEN_ENCRYPTION_KEY);
      await X.revokeToken(tokens.accessToken, client);
    } catch {
      /* revocation is advisory; the local delete below is what matters */
    }
  }
  delete session.data.connections[provider];
  await session.save();
  return json({ ok: true });
}

export async function resetSession(_request: Request, _env: Env, session: SessionContext): Promise<Response> {
  await session.destroy();
  return json({ ok: true });
}
