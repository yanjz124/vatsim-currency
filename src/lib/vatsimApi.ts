import { getItem, local, setItem } from './storage';
import type { FetchMode } from './settings';

export const VATSIM_API = 'https://api.vatsim.net';
export const PAGE_SIZE = 250;

export interface Session {
  id: number;
  callsign: string;
  /** UTC epoch ms */
  start: number;
  /** UTC epoch ms */
  end: number;
  rating?: number;
  server?: string;
}

export type DataSource = FetchMode;

export interface SessionSet {
  cid: string;
  /** When the most recent API response (or import) was received. */
  fetchedAt: number;
  /** Data is complete for sessions starting at or after this time (0 = full history). */
  coveredSince: number;
  source: DataSource;
  sessions: Session[];
}

export interface FetchStatus {
  phase: 'waiting' | 'fetching' | 'rate-limited';
  page?: number;
  /** For waiting/rate-limited: when the next request may go out. */
  until?: number;
  message: string;
}

export class ApiError extends Error {
  constructor(
    public kind: 'network' | 'rate-limited' | 'http' | 'parse' | 'cooldown' | 'aborted',
    message: string,
    public retryAt?: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Rate-limit guard
//
// The VATSIM API rate-limits aggressively and does not advertise its limits,
// so we stay well under any sensible threshold. State lives in localStorage
// so multiple open tabs share one budget.
// ---------------------------------------------------------------------------

export const GUARD = {
  /** Minimum spacing between any two requests. */
  minGapMs: 2_000,
  /** Rolling window budget. */
  windowMs: 60_000,
  maxPerWindow: 8,
  /** Cached data younger than this is reused without asking the API. */
  freshMs: 15 * 60_000,
  /** Minimum time between explicit refreshes of the same CID. */
  refreshCooldownMs: 2 * 60_000,
  /** How long we'll sit and wait on a 429 before giving up and telling the user. */
  maxAutoWaitMs: 90_000,
  maxRetries: 3,
};

const K_RECENT = 'api:recent';
const K_BLOCKED = 'api:blockedUntil';
const K_BACKOFF = 'api:backoffMs';

function recentRequests(now: number): number[] {
  return (local.get<number[]>(K_RECENT) ?? []).filter((t) => now - t < GUARD.windowMs);
}

/** Earliest time the next request may be sent under the guard. */
export function nextAllowedAt(now = Date.now()): number {
  const recent = recentRequests(now);
  let t = now;
  const blocked = local.get<number>(K_BLOCKED) ?? 0;
  if (blocked > t) t = blocked;
  if (recent.length) t = Math.max(t, Math.max(...recent) + GUARD.minGapMs);
  if (recent.length >= GUARD.maxPerWindow) {
    t = Math.max(t, recent[recent.length - GUARD.maxPerWindow] + GUARD.windowMs);
  }
  return t;
}

function recordRequest(now: number) {
  const recent = recentRequests(now);
  recent.push(now);
  local.set(K_RECENT, recent.slice(-GUARD.maxPerWindow * 2));
}

function parseRetryAfter(h: string | null, now: number): number | null {
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return now + secs * 1000;
  const date = Date.parse(h);
  return Number.isFinite(date) ? date : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ApiError('aborted', 'Cancelled'));
    const t = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ApiError('aborted', 'Cancelled'));
    }, { once: true });
  });
}

/** GET a VATSIM API URL as JSON under the rate-limit guard. `label` describes it in status messages. */
export async function guardedGetJson(
  url: string,
  mode: FetchMode,
  onStatus: (s: FetchStatus) => void,
  label: string,
  signal?: AbortSignal,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let now = Date.now();
    const at = nextAllowedAt(now);
    if (at - now > GUARD.maxAutoWaitMs) {
      throw new ApiError('rate-limited', 'The VATSIM API asked us to slow down. Try again later.', at);
    }
    if (at > now) {
      onStatus({ phase: 'waiting', until: at, message: 'Pacing requests to stay under the VATSIM API rate limit' });
      await sleep(at - now, signal);
    }

    now = Date.now();
    recordRequest(now);
    onStatus({ phase: 'fetching', message: `Fetching ${label}` });

    let res: Response;
    try {
      res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    } catch (err) {
      if (signal?.aborted) throw new ApiError('aborted', 'Cancelled');
      throw new ApiError(
        'network',
        mode === 'direct'
          ? 'The browser could not read the VATSIM API response. The API does not send CORS headers, so direct requests from a web page are usually blocked. Switch the data source to manual import or a proxy in Settings.'
          : `Could not reach the proxy (${(err as Error).message}). Check the proxy URL in Settings, or use manual import.`,
      );
    }

    if (res.status === 429) {
      const backoff = Math.min((local.get<number>(K_BACKOFF) ?? 15_000) * 2, 10 * 60_000);
      local.set(K_BACKOFF, backoff);
      const retryAt = parseRetryAfter(res.headers.get('Retry-After'), Date.now()) ?? Date.now() + backoff;
      local.set(K_BLOCKED, retryAt);
      if (attempt >= GUARD.maxRetries || retryAt - Date.now() > GUARD.maxAutoWaitMs) {
        throw new ApiError('rate-limited', 'Rate limited by the VATSIM API.', retryAt);
      }
      onStatus({ phase: 'rate-limited', until: retryAt, message: 'Rate limited by the VATSIM API, waiting before retrying' });
      continue;
    }
    if (res.status >= 500 && attempt < 2) {
      local.set(K_BLOCKED, Date.now() + 5_000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new ApiError('http', `VATSIM API returned HTTP ${res.status}.`);

    local.set(K_BACKOFF, 15_000);
    try {
      return await res.json();
    } catch {
      throw new ApiError('parse', 'The response was not valid JSON.');
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface RawConnection {
  id?: number;
  vatsim_id?: string | number;
  callsign?: string;
  start?: string;
  end?: string;
  rating?: number;
  server?: string;
}

export interface ParsedPage {
  sessions: Session[];
  /** Number of raw items in the page (including ones we couldn't parse). */
  itemCount: number;
  /** CIDs seen in the data. */
  cids: string[];
  totalCount?: number;
}

/** Accepts an API page ({items, count}), a bare item array, or an array of pages. */
export function parseSessionsJson(json: unknown): ParsedPage {
  const items: unknown[] = [];
  let totalCount: number | undefined;
  const collect = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object' && Array.isArray((v as { items?: unknown[] }).items)) {
      const page = v as { items: unknown[]; count?: number };
      items.push(...page.items);
      if (typeof page.count === 'number') totalCount = page.count;
    } else if (v && typeof v === 'object' && 'connection_id' in v) items.push(v);
  };
  collect(json);

  const sessions: Session[] = [];
  const cids = new Set<string>();
  for (const it of items) {
    const c = (it as { connection_id?: RawConnection }).connection_id;
    if (!c?.callsign || !c.start || !c.end) continue;
    const start = Date.parse(c.start);
    const end = Date.parse(c.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (c.vatsim_id != null) cids.add(String(c.vatsim_id));
    sessions.push({
      id: typeof c.id === 'number' ? c.id : hashId(c.callsign, start),
      callsign: c.callsign.toUpperCase().trim(),
      start,
      end: Math.max(start, end),
      rating: c.rating,
      server: c.server,
    });
  }
  return { sessions, itemCount: items.length, cids: [...cids], totalCount };
}

function hashId(callsign: string, start: number): number {
  let h = start;
  for (const ch of callsign) h = (h * 31 + ch.charCodeAt(0)) % 2 ** 52;
  return -h;
}

export function mergeSessions(a: Session[], b: Session[]): Session[] {
  const byId = new Map<number, Session>();
  for (const s of a) byId.set(s.id, s);
  for (const s of b) byId.set(s.id, s);
  return [...byId.values()].sort((x, y) => y.start - x.start);
}

export function isValidCid(cid: string): boolean {
  return /^\d{3,10}$/.test(cid);
}

export function memberAtcUrl(base: string, cid: string, limit: number, offset: number): string {
  return `${base.replace(/\/+$/, '')}/v2/members/${encodeURIComponent(cid)}/atc?limit=${limit}&offset=${offset}`;
}

// ---------------------------------------------------------------------------
// Cache + fetch orchestration
// ---------------------------------------------------------------------------

const cacheKey = (cid: string) => `sessions:v1:${cid}`;

export function getCachedSessions(cid: string): Promise<SessionSet | undefined> {
  return getItem<SessionSet>(cacheKey(cid));
}

export function saveSessions(set: SessionSet): Promise<void> {
  return setItem(cacheKey(set.cid), set);
}

/** A session can't be longer than this; used as slack when deciding where paging can stop. */
export const MAX_SESSION_MS = 36 * 3600_000;

/** True when `set` holds every session that could overlap [since, fetchedAt). */
export function coversSince(set: SessionSet, since: number): boolean {
  return set.coveredSince <= since - MAX_SESSION_MS;
}

export interface FetchOptions {
  cid: string;
  /** Need complete data for sessions overlapping [since, now). */
  since: number;
  mode: Exclude<FetchMode, 'manual'>;
  proxyUrl: string;
  /** Explicit refresh — bypasses freshness (but not the cooldown). */
  force?: boolean;
  signal?: AbortSignal;
  onStatus?: (s: FetchStatus) => void;
}

export interface FetchResult {
  set: SessionSet;
  fromCache: boolean;
  requests: number;
}

export function refreshAvailableAt(set: SessionSet | undefined): number {
  return set ? set.fetchedAt + GUARD.refreshCooldownMs : 0;
}

export async function fetchSessions(opts: FetchOptions): Promise<FetchResult> {
  const { cid, since, mode, signal } = opts;
  const onStatus = opts.onStatus ?? (() => {});
  const base = mode === 'direct' ? VATSIM_API : opts.proxyUrl;
  if (!base) throw new ApiError('http', 'No proxy URL configured. Set one in Settings, or use manual import.');

  const cached = await getCachedSessions(cid);
  const now = Date.now();
  const covers = cached && coversSince(cached, since);

  if (cached && covers && !opts.force && now - cached.fetchedAt < GUARD.freshMs) {
    return { set: cached, fromCache: true, requests: 0 };
  }
  if (cached && opts.force && now < refreshAvailableAt(cached)) {
    throw new ApiError('cooldown', 'This CID was refreshed a moment ago.', refreshAvailableAt(cached));
  }

  // With complete cached coverage we only need sessions newer than the last fetch.
  const incremental = cached && covers;
  const stopBefore = incremental ? cached.fetchedAt - MAX_SESSION_MS : since - MAX_SESSION_MS;

  let collected: Session[] = [];
  let coveredSince = since;
  let requests = 0;
  for (let page = 1, offset = 0; ; page++, offset += PAGE_SIZE) {
    const json = await guardedGetJson(memberAtcUrl(base, cid, PAGE_SIZE, offset), mode, onStatus, `sessions (page ${page})`, signal);
    requests++;
    const parsed = parseSessionsJson(json);
    collected = mergeSessions(collected, parsed.sessions);
    if (parsed.itemCount < PAGE_SIZE) {
      coveredSince = 0; // reached the end of the member's history
      break;
    }
    if (!parsed.sessions.length || page >= 40) {
      // Unparseable full page, or a runaway loop — keep what we have, but don't claim coverage.
      coveredSince = incremental ? cached.coveredSince : since;
      break;
    }
    const oldest = Math.min(...parsed.sessions.map((s) => s.start));
    if (oldest < stopBefore) {
      coveredSince = incremental ? cached.coveredSince : Math.max(0, oldest);
      break;
    }
  }

  const set: SessionSet = {
    cid,
    fetchedAt: Date.now(),
    coveredSince: incremental ? Math.min(coveredSince, cached.coveredSince) : coveredSince,
    source: mode,
    sessions: incremental ? mergeSessions(cached.sessions, collected) : collected,
  };
  await saveSessions(set);
  return { set, fromCache: false, requests };
}
