/**
 * DELETE.1999 — Worker entrypoint.
 *
 *   /auth/*   OAuth start + callback (X, Facebook, Threads)
 *   /api/*    JSON API, session-cookie authenticated
 *   /*        the SPA, served from ./public by Cloudflare's asset pipeline
 *
 * Everything that can take longer than one request lives in the DeletionJob
 * Durable Object; this file stays boring on purpose.
 */

import type { Env, Provider } from './types';
import { HttpError, badRequest, errorResponse, json, notFound } from './lib/http';
import { getSession, withSession, type SessionContext } from './lib/session';
import * as Auth from './routes/auth';
import * as Jobs from './routes/jobs';
import * as Billing from './routes/billing';
import * as Calibration from './routes/calibration';
import { loadPreferences, savePreferences, supabaseEnabled } from './lib/supabase';
import { publicConnection } from './lib/session';

export { DeletionJob } from './do/DeletionJob';
export { Wallet } from './do/Wallet';

const PROVIDERS: Provider[] = ['x', 'facebook', 'threads'];

/**
 * Defence in depth on top of the SameSite=Lax session cookie: a state-changing
 * API call must come from our own origin.
 */
function assertSameOrigin(request: Request): void {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = request.headers.get('origin');
  if (!origin) return; // non-browser client, cookie wouldn't be attached cross-site anyway
  const target = new URL(request.url);
  try {
    if (new URL(origin).host !== target.host) {
      throw new HttpError(403, 'forbidden', 'Cross-origin requests are not allowed.');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(403, 'forbidden', 'Invalid Origin header.');
  }
}

function assertConfigured(env: Env): void {
  if (!env.SESSION_SECRET || !env.TOKEN_ENCRYPTION_KEY) {
    throw new HttpError(
      500,
      'not_configured',
      'This deployment is missing SESSION_SECRET and/or TOKEN_ENCRYPTION_KEY. See the README for setup.',
    );
  }
}

async function handleApi(request: Request, env: Env, url: URL, session: SessionContext): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  const segments = path.split('/').filter(Boolean); // ['api', ...]

  // ---- session -----------------------------------------------------------
  if (path === '/api/session' && method === 'GET') return Auth.sessionInfo(request, env, session);
  if (path === '/api/session/reset' && method === 'POST') return Auth.resetSession(request, env, session);

  if (path === '/api/preferences') {
    if (!supabaseEnabled(env)) {
      // Preferences are a Supabase-only nicety; without it the SPA just uses
      // localStorage and this endpoint reports that honestly.
      return json({ enabled: false, preferences: null });
    }
    if (method === 'GET') {
      return json({ enabled: true, preferences: await loadPreferences(env, session.data.id) });
    }
    if (method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      await savePreferences(env, session.data.id, body ?? {});
      return json({ enabled: true, ok: true });
    }
  }

  // ---- connections -------------------------------------------------------
  if (path === '/api/x/app' && method === 'POST') return Auth.saveXApp(request, env, session);

  if (segments[1] === 'connections' && segments[3] === 'disconnect' && method === 'POST') {
    const provider = segments[2] as Provider;
    if (!PROVIDERS.includes(provider)) throw badRequest('Unknown provider.');
    return Auth.disconnect(request, env, session, provider);
  }

  if (path === '/api/facebook/pages' && method === 'GET') {
    const conn = session.data.connections.facebook;
    return json({ connected: Boolean(conn), pages: publicConnection(conn)?.pages ?? [] });
  }

  // ---- billing -----------------------------------------------------------
  if (path === '/api/billing/pricing' && method === 'GET') return Billing.getPricing(request, env, session);
  if (path === '/api/billing/quote' && method === 'POST') return Billing.postQuote(request, env, session);
  if (path === '/api/billing/wallet' && method === 'GET') return Billing.getWallet(request, env, session);
  if (path === '/api/billing/checkout' && method === 'POST') return Billing.postCheckout(request, env, session);
  if (path === '/api/billing/confirm' && method === 'POST') return Billing.postConfirm(request, env, session);

  // ---- calibration (see docs/CALIBRATION.md) ------------------------------
  if (path === '/api/x/probe' && method === 'POST') return Calibration.postProbe(request, env, session);
  if (path === '/api/admin/appmeter' && method === 'GET') return Calibration.getAppMeter(request, env);
  if (path === '/api/admin/grant' && method === 'POST') return Billing.postGrant(request, env);

  // ---- jobs --------------------------------------------------------------
  if (path === '/api/estimate' && method === 'POST') return Jobs.estimate(request, env, session);

  if (path === '/api/jobs') {
    if (method === 'GET') return Jobs.listUserJobs(request, env, session);
    if (method === 'POST') return Jobs.createJob(request, env, session);
  }

  if (segments[1] === 'jobs' && segments[2]) {
    const jobId = segments[2];
    const action = segments[3];

    if (!action && method === 'GET') return Jobs.getJob(request, env, session, jobId);
    if (action === 'items' && method === 'POST') return Jobs.addItems(request, env, session, jobId);
    if (action === 'log' && method === 'GET') return Jobs.exportLog(request, env, session, jobId);
    if (action === 'ws' && method === 'GET') return Jobs.jobSocket(request, env, session, jobId);
    if (
      method === 'POST' &&
      (action === 'start' || action === 'pause' || action === 'resume' || action === 'cancel')
    ) {
      return Jobs.controlJob(request, env, session, jobId, action);
    }
  }

  throw notFound(`No API route for ${method} ${path}.`);
}

async function handleAuth(request: Request, env: Env, url: URL, session: SessionContext): Promise<Response> {
  // /auth/<provider>/<action>
  const segments = url.pathname.split('/').filter(Boolean);
  const key = `${segments[1] ?? ''}:${segments[2] ?? ''}`;
  switch (key) {
    case 'x:start':
      return Auth.startX(request, env, session);
    case 'x:callback':
      return Auth.callbackX(request, env, session);
    case 'facebook:start':
      return Auth.startFacebook(request, env, session);
    case 'facebook:callback':
      return Auth.callbackFacebook(request, env, session);
    case 'threads:start':
      return Auth.startThreads(request, env, session);
    case 'threads:callback':
      return Auth.callbackThreads(request, env, session);
    default:
      throw notFound('Unknown auth route.');
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');
    const isAuth = url.pathname.startsWith('/auth/');

    // Stripe signs the raw body and sends no cookie or Origin — it must be
    // routed before session handling, and verified purely by HMAC.
    if (url.pathname === '/api/billing/webhook') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, { status: 405 });
      try {
        return await Billing.postWebhook(request, env);
      } catch (err) {
        return errorResponse(err);
      }
    }

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        app: env.APP_NAME ?? 'DELETE.1999',
        configured: Boolean(env.SESSION_SECRET && env.TOKEN_ENCRYPTION_KEY),
        time: new Date().toISOString(),
      });
    }

    if (!isApi && !isAuth) {
      // Anything the asset pipeline didn't already serve is an SPA route.
      const assetUrl = new URL(url);
      assetUrl.pathname = '/index.html';
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    let session: SessionContext | null = null;
    try {
      assertConfigured(env);
      assertSameOrigin(request);
      session = await getSession(request, env, true);
      if (!session) throw new HttpError(401, 'no_session', 'Session could not be created.');

      const response = isApi
        ? await handleApi(request, env, url, session)
        : await handleAuth(request, env, url, session);

      return withSession(response, session);
    } catch (err) {
      // Auth callbacks should land the user back in the UI, not on a JSON blob.
      if (isAuth && !(err instanceof HttpError && err.status === 500)) {
        const message = err instanceof Error ? err.message : 'Sign-in failed.';
        const base = (env.PUBLIC_BASE_URL || url.origin).replace(/\/+$/, '');
        const target = `${base}/#${new URLSearchParams({ auth: 'error', message }).toString()}`;
        return withSession(
          new Response(null, { status: 302, headers: { location: target, 'cache-control': 'no-store' } }),
          session,
        );
      }
      return withSession(errorResponse(err), session);
    }
  },
};
