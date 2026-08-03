/**
 * Filter evaluation, shared by the browser preview and the server.
 *
 * The browser applies these to give an instant preview; the Durable Object
 * applies exactly the same rules again before it deletes anything. Client-side
 * filtering is a UX nicety, never the safety boundary.
 */

import type { JobFilters, JobItem } from '../types';

export interface CompiledFilters {
  fromMs?: number;
  toMs?: number;
  keywords: string[];
  excludeKeywords: string[];
  media: 'any' | 'only' | 'none';
  includeOriginals: boolean;
  includeReplies: boolean;
  includeRetweets: boolean;
  maxLikes?: number;
  keepIds: Set<string>;
}

export function compileFilters(filters: JobFilters = {}): CompiledFilters {
  const fromMs = filters.from ? Date.parse(`${filters.from}T00:00:00.000Z`) : undefined;
  // `to` is inclusive of the whole day.
  const toMs = filters.to ? Date.parse(`${filters.to}T23:59:59.999Z`) : undefined;
  return {
    fromMs: Number.isFinite(fromMs) ? fromMs : undefined,
    toMs: Number.isFinite(toMs) ? toMs : undefined,
    keywords: (filters.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean),
    excludeKeywords: (filters.excludeKeywords ?? []).map((k) => k.toLowerCase()).filter(Boolean),
    media: filters.media ?? 'any',
    includeOriginals: filters.includeOriginals !== false,
    includeReplies: filters.includeReplies !== false,
    includeRetweets: filters.includeRetweets !== false,
    maxLikes: typeof filters.maxLikes === 'number' && filters.maxLikes >= 0 ? filters.maxLikes : undefined,
    keepIds: new Set(filters.keepIds ?? []),
  };
}

export function matchesFilters(item: JobItem, f: CompiledFilters): boolean {
  if (f.keepIds.has(item.id)) return false;

  if (f.fromMs !== undefined || f.toMs !== undefined) {
    if (!item.createdAt) return false; // no date, and a date bound was requested
    const ts = Date.parse(item.createdAt);
    if (!Number.isFinite(ts)) return false;
    if (f.fromMs !== undefined && ts < f.fromMs) return false;
    if (f.toMs !== undefined && ts > f.toMs) return false;
  }

  const kind = item.isRetweet ? 'retweet' : item.isReply ? 'reply' : 'original';
  if (kind === 'retweet' && !f.includeRetweets) return false;
  if (kind === 'reply' && !f.includeReplies) return false;
  if (kind === 'original' && !f.includeOriginals) return false;

  if (f.media === 'only' && !item.hasMedia) return false;
  if (f.media === 'none' && item.hasMedia) return false;

  if (f.maxLikes !== undefined && typeof item.likes === 'number' && item.likes > f.maxLikes) return false;

  if (f.keywords.length || f.excludeKeywords.length) {
    const haystack = (item.text ?? '').toLowerCase();
    if (f.excludeKeywords.some((k) => haystack.includes(k))) return false;
    if (f.keywords.length && !f.keywords.some((k) => haystack.includes(k))) return false;
  }

  return true;
}

/** Normalise whatever the browser sent into a trustworthy JobItem. */
export function sanitizeItem(raw: unknown): JobItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : typeof r.id === 'number' ? String(r.id) : '';
  if (!id || id.length > 64 || !/^[A-Za-z0-9_\-.:]+$/.test(id)) return null;

  const item: JobItem = { id };
  if (typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt))) {
    item.createdAt = new Date(r.createdAt).toISOString();
  }
  // Keep a short excerpt only — enough to make the audit log meaningful.
  if (typeof r.text === 'string' && r.text) item.text = r.text.slice(0, 160);
  if (typeof r.likes === 'number' && Number.isFinite(r.likes)) item.likes = Math.max(0, Math.floor(r.likes));
  if (r.hasMedia) item.hasMedia = true;
  if (r.isReply) item.isReply = true;
  if (r.isRetweet) item.isRetweet = true;
  if (typeof r.ownerId === 'string' && /^[A-Za-z0-9_\-.:]{1,64}$/.test(r.ownerId)) item.ownerId = r.ownerId;
  return item;
}

export function sanitizeFilters(raw: unknown): JobFilters {
  const r = (raw ?? {}) as Record<string, any>;
  const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const words = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x) => typeof x === 'string' && x.trim()).map((x: string) => x.trim().slice(0, 80)).slice(0, 50)
      : [];

  return {
    from: isDate(r.from) ? r.from : undefined,
    to: isDate(r.to) ? r.to : undefined,
    keywords: words(r.keywords),
    excludeKeywords: words(r.excludeKeywords),
    media: r.media === 'only' || r.media === 'none' ? r.media : 'any',
    includeOriginals: r.includeOriginals !== false,
    includeReplies: r.includeReplies !== false,
    includeRetweets: r.includeRetweets !== false,
    maxLikes: typeof r.maxLikes === 'number' && r.maxLikes >= 0 ? Math.floor(r.maxLikes) : undefined,
    keepIds: Array.isArray(r.keepIds)
      ? r.keepIds.filter((x: unknown) => typeof x === 'string').slice(0, 5000)
      : undefined,
  };
}
