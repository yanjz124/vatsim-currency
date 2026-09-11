import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearStore } from './storage';
import {
  ApiError,
  GUARD,
  PAGE_SIZE,
  coversSince,
  fetchSessions,
  mergeSessions,
  parseSessionsJson,
} from './vatsimApi';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 11, 12);

function item(i: number) {
  const start = NOW - i * DAY;
  return {
    connection_id: {
      id: 1000 + i,
      vatsim_id: '1234567',
      callsign: 'DCA_GND',
      start: new Date(start).toISOString(),
      end: new Date(start + 3_600_000).toISOString(),
    },
  };
}

/** Fake API with `total` sessions, one per day going back from NOW. */
function fakeApi(total: number) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset'));
    const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, k) => item(offset + k));
    return new Response(JSON.stringify({ items, count: total }), { status: 200 });
  });
  return { calls, fetchMock };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  Object.assign(GUARD, { minGapMs: 0, maxPerWindow: 1000 });
  await clearStore();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('parseSessionsJson', () => {
  it('accepts a page, an array of pages, or bare items', () => {
    expect(parseSessionsJson({ items: [item(0), item(1)], count: 2 }).sessions).toHaveLength(2);
    expect(parseSessionsJson([{ items: [item(0)] }, { items: [item(1)] }]).sessions).toHaveLength(2);
    expect(parseSessionsJson([item(0)]).cids).toEqual(['1234567']);
    expect(parseSessionsJson({ nope: true }).sessions).toHaveLength(0);
  });

  it('merges by id, newest first', () => {
    const a = parseSessionsJson([item(0), item(2)]).sessions;
    const b = parseSessionsJson([item(1), item(2)]).sessions;
    expect(mergeSessions(a, b).map((s) => s.id)).toEqual([1000, 1001, 1002]);
  });
});

describe('fetchSessions', () => {
  it('pages only as far back as needed, then serves from cache', async () => {
    const { calls, fetchMock } = fakeApi(2000);
    vi.stubGlobal('fetch', fetchMock);
    const since = NOW - 300 * DAY; // needs ~301 days → 2 pages of 250

    const first = await fetchSessions({ cid: '1234567', since, mode: 'proxy', proxyUrl: 'https://proxy.test' });
    expect(first.requests).toBe(2);
    expect(calls[1]).toContain(`offset=${PAGE_SIZE}`);
    expect(coversSince(first.set, since)).toBe(true);

    const second = await fetchSessions({ cid: '1234567', since, mode: 'proxy', proxyUrl: 'https://proxy.test' });
    expect(second.fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('marks full history when the last page is short', async () => {
    const { fetchMock } = fakeApi(40);
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchSessions({ cid: '1234567', since: NOW - 300 * DAY, mode: 'proxy', proxyUrl: 'https://proxy.test' });
    expect(r.set.coveredSince).toBe(0);
    expect(r.set.sessions).toHaveLength(40);
  });

  it('enforces the refresh cooldown, then refreshes incrementally', async () => {
    const { fetchMock } = fakeApi(2000);
    vi.stubGlobal('fetch', fetchMock);
    const opts = { cid: '1234567', since: NOW - 30 * DAY, mode: 'proxy' as const, proxyUrl: 'https://proxy.test' };
    await fetchSessions(opts);
    await expect(fetchSessions({ ...opts, force: true })).rejects.toMatchObject({ kind: 'cooldown' });

    vi.setSystemTime(NOW + GUARD.refreshCooldownMs + 1);
    const r = await fetchSessions({ ...opts, force: true });
    expect(r.requests).toBe(1);
    expect(r.fromCache).toBe(false);
  });

  it('waits out a 429 using Retry-After, then succeeds', async () => {
    const { fetchMock } = fakeApi(10);
    let hits = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (hits++ === 0) return new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } });
        return fetchMock(url);
      }),
    );
    const statuses: string[] = [];
    const r = await fetchSessions({
      cid: '1234567',
      since: NOW - 30 * DAY,
      mode: 'proxy',
      proxyUrl: 'https://proxy.test',
      onStatus: (s) => statuses.push(s.phase),
    });
    expect(r.set.sessions).toHaveLength(10);
    expect(statuses).toContain('rate-limited');
  });

  it('gives up when the API asks for a long wait', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '600' } })));
    const err = await fetchSessions({ cid: '1', since: NOW - DAY, mode: 'proxy', proxyUrl: 'https://proxy.test' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('rate-limited');
    expect(err.retryAt).toBeGreaterThan(NOW);
  });

  it('explains CORS failures in direct mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(fetchSessions({ cid: '1', since: NOW - DAY, mode: 'direct', proxyUrl: '' })).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringMatching(/CORS/),
    });
  });
});
