/** Tiny HTTP helpers: JSON responses, typed errors, redirect + cookie plumbing. */

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'You need to connect an account first.') =>
  new HttpError(401, 'unauthorized', message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function text(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(body, { ...init, headers });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
  }
  // Anything unexpected: log the stack for `wrangler tail`, but never echo it out.
  console.error('unhandled error', err instanceof Error ? err.stack : err);
  return json(
    { error: { code: 'internal_error', message: 'Something went wrong on our side. Please try again.' } },
    { status: 500 },
  );
}

export function redirect(location: string, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('location', location);
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 302, headers });
}

/** Parse and validate a JSON body, with a hard size ceiling. */
export async function readJson<T>(request: Request, maxBytes = 8 * 1024 * 1024): Promise<T> {
  const len = Number(request.headers.get('content-length') ?? '0');
  if (len > maxBytes) throw badRequest('Request body is too large.');
  const raw = await request.text();
  if (raw.length > maxBytes) throw badRequest('Request body is too large.');
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw badRequest('Request body must be valid JSON.');
  }
}

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('cookie');
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; secure?: boolean; sameSite?: 'Lax' | 'Strict' | 'None'; path?: string } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  if (opts.secure !== false) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  return parts.join('; ');
}

/** Origin the browser is actually talking to, used to build OAuth redirect URIs. */
export function baseUrl(request: Request, configured?: string): string {
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, '');
  return new URL(request.url).origin;
}

/** Constant-time-ish string comparison for tokens/signatures. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
