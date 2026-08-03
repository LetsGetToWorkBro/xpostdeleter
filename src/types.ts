/**
 * Shared types for PostCleaner.
 *
 * Nothing in here ever holds a plaintext token in a place that gets logged or
 * returned to the browser — see `lib/crypto.ts` for how credentials are sealed.
 */

export interface Env {
  ASSETS: Fetcher;
  SESSIONS: KVNamespace;
  DELETION_JOB: DurableObjectNamespace;

  // Vars
  APP_NAME: string;
  PUBLIC_BASE_URL?: string;

  // Required secrets
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;

  // Optional secrets
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  FACEBOOK_APP_ID?: string;
  FACEBOOK_APP_SECRET?: string;
  THREADS_APP_ID?: string;
  THREADS_APP_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

/** An OAuth connection, stored with the token material already encrypted. */
export interface Connection {
  provider: Provider;
  /** Display info that is safe to send to the browser. */
  accountId: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  scopes: string[];
  connectedAt: number;
  expiresAt: number;
  /** Sealed JSON: { accessToken, refreshToken? } */
  sealedTokens: string;
  /** Sealed JSON of the OAuth client the user brought, when applicable. */
  sealedClient?: string;
  /** For Facebook: the pages we are allowed to manage. */
  pages?: FacebookPage[];
}

export type Provider = 'x' | 'facebook' | 'threads';

export interface FacebookPage {
  id: string;
  name: string;
  category?: string;
  /** Sealed page access token. */
  sealedToken: string;
  tasks: string[];
}

export interface SessionData {
  id: string;
  createdAt: number;
  updatedAt: number;
  connections: Partial<Record<Provider, Connection>>;
  /** Transient PKCE / CSRF state, keyed by the `state` parameter. */
  pending?: PendingAuth;
  preferences?: Record<string, unknown>;
}

export interface PendingAuth {
  provider: Provider;
  state: string;
  codeVerifier?: string;
  createdAt: number;
  /** Sealed { clientId, clientSecret? } for bring-your-own-app flows. */
  sealedClient?: string;
  redirectUri: string;
  scopes: string[];
}

/* -------------------------------------------------------------------------- */
/* Jobs                                                                        */
/* -------------------------------------------------------------------------- */

export type JobStatus =
  | 'draft'
  | 'queued'
  | 'discovering'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

/** What we are deleting and where it lives. */
export type JobKind =
  | 'x_posts'
  | 'x_likes'
  | 'threads_posts'
  | 'facebook_page_posts'
  | 'facebook_page_comments';

/** Where the list of things to delete comes from. */
export type JobSource = 'archive' | 'api';

export interface JobFilters {
  /** Inclusive ISO-8601 date (UTC) lower bound. */
  from?: string;
  /** Inclusive ISO-8601 date (UTC) upper bound. */
  to?: string;
  /** Delete only items containing at least one of these (case-insensitive). */
  keywords?: string[];
  /** Never delete items containing any of these (case-insensitive). */
  excludeKeywords?: string[];
  /** 'any' = ignore media, 'only' = media required, 'none' = text-only. */
  media?: 'any' | 'only' | 'none';
  includeOriginals?: boolean;
  includeReplies?: boolean;
  includeRetweets?: boolean;
  /** Protect posts that did well: skip anything with more likes than this. */
  maxLikes?: number;
  /** Explicit allow-list of IDs that must never be touched. */
  keepIds?: string[];
}

export interface JobItem {
  id: string;
  /** ISO timestamp, when known. */
  createdAt?: string;
  /** Trimmed for the audit log — never the full post. */
  text?: string;
  likes?: number;
  hasMedia?: boolean;
  isReply?: boolean;
  isRetweet?: boolean;
  /** Facebook only — the page that owns this object. */
  ownerId?: string;
}

export type ItemOutcome = 'deleted' | 'failed' | 'skipped' | 'would_delete';

export interface JobLogEntry {
  id: string;
  outcome: ItemOutcome;
  at: number;
  createdAt?: string;
  text?: string;
  error?: string;
}

export interface RateWindow {
  /** Max requests per window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
  /** Epoch ms when the current window opened. */
  windowStart: number;
  used: number;
  /** Set when the platform tells us to back off until a specific time. */
  blockedUntil?: number;
  /** Consecutive transport/5xx failures — drives exponential backoff. */
  consecutiveErrors: number;
}

export interface JobState {
  id: string;
  sessionId: string;
  kind: JobKind;
  source: JobSource;
  dryRun: boolean;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;

  total: number;
  cursor: number;
  deleted: number;
  failed: number;
  skipped: number;

  filters: JobFilters;

  discovery: {
    /** True once every page of the source has been enumerated. */
    complete: boolean;
    nextToken?: string;
    pagesFetched: number;
    reads: number;
    /** X user id / Threads user id / Facebook page id. */
    targetId?: string;
    /** Stop enumerating after this many items (0 = no cap). */
    maxItems: number;
  };

  rate: RateWindow;

  /** Human-readable, never contains tokens. */
  lastError?: string;
  lastErrorAt?: number;
  /**
   * Failures in a row. A revoked token or an app without write permission
   * fails *every* item, so we stop rather than burn the whole rate budget.
   */
  consecutiveItemFailures: number;
  /** Rolling estimate of when the job finishes, epoch ms. */
  etaMs?: number;

  costEstimateUsd?: number;

  label?: string;
}

/** The shape the browser polls / receives over the WebSocket. */
export interface JobSnapshot extends JobState {
  remaining: number;
  ratePerHour: number;
  nextRunAt?: number;
  recentLog: JobLogEntry[];
}
