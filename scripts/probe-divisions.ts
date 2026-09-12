// Learn which VATSIM division/subdivision each facility belongs to, by looking up the members who are
// controlling it right now. Run with: npx tsx scripts/probe-divisions.ts [results.json]
//
// - Online controllers come from the public data feed (refreshed every 2 minutes).
// - Each callsign is matched to a VATSpy facility with the app's own resolver.
// - Member details come from the VATSIM API at one request every 6.5 s (it allows 10 a minute per IP).
// - Facilities with the fewest observations are probed first; results are saved after every lookup,
//   so the script can be stopped and resumed.
// - It stops after STOP_AFTER lookups in a row find no new facility or division/subdivision pair,
//   after IDLE_REFRESHES feed refreshes with nobody new worth probing, or after MAX_MINUTES.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { UNKNOWN, compileRules, parseCallsign, resolveFacility } from '../src/lib/aggregate';
import { ALL_SUFFIXES } from '../src/lib/settings';
import { VATSPY_URL, parseVatspy } from '../src/lib/vatspy';

const OUT = process.argv[2] ?? 'probe-results.json';
// VATSIM allows 10 member lookups a minute per IP and answers bursts with a ~3 minute 429, so stay well under.
const MEMBER_GAP_MS = 8_000;
const FEED_EVERY_MS = 120_000;
const TARGET_OBSERVATIONS = 3;
const STOP_AFTER = Number(process.env.STOP_AFTER ?? 80);
const IDLE_REFRESHES = Number(process.env.IDLE_REFRESHES ?? 15);
const MAX_MINUTES = Number(process.env.MAX_MINUTES ?? 120);

interface Observation {
  cid: string;
  callsign: string;
  facility: string;
  division: string | null;
  subdivision: string | null;
  at: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

const state: { observations: Observation[] } = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { observations: [] };
const probed = new Set(state.observations.map((o) => o.cid));
const perFacility = new Map<string, number>();
const pairs = new Set<string>();
for (const o of state.observations) {
  perFacility.set(o.facility, (perFacility.get(o.facility) ?? 0) + 1);
  pairs.add(`${o.division}/${o.subdivision}`);
}

/** fetch that retries network failures (timeouts, resets) with a growing wait instead of throwing. */
async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      if (attempt >= 8) throw err;
      const wait = Math.min(15_000 * attempt, 120_000);
      log(`network error (${(err as Error).message}), retrying in ${wait / 1000} s`);
      await sleep(wait);
    }
  }
}

async function member(cid: string): Promise<{ division: string | null; subdivision: string | null } | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetchRetry(`https://api.vatsim.net/v2/members/${cid}`, { headers: { Accept: 'application/json' } });
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After')) * 1000 || 60_000;
      log(`429, waiting ${Math.round(wait / 1000)} s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) return null;
    const j = (await res.json()) as { division_id?: string | null; subdivision_id?: string | null };
    return { division: j.division_id ?? null, subdivision: j.subdivision_id ?? null };
  }
  return null;
}

const started = Date.now();
const vatspy = parseVatspy(await (await fetchRetry(VATSPY_URL)).text());
const rules = compileRules({ facilities: [] });
log(`VATSpy loaded; resuming with ${state.observations.length} observations, ${perFacility.size} facilities`);

let queue: { cid: string; callsign: string; facility: string }[] = [];
let lastFeed = 0;
let sinceNew = 0;
let idle = 0;

while (true) {
  if ((Date.now() - started) / 60_000 > MAX_MINUTES) {
    log('time limit reached');
    break;
  }
  if (sinceNew >= STOP_AFTER) {
    log(`${STOP_AFTER} lookups in a row found nothing new`);
    break;
  }

  if (Date.now() - lastFeed > FEED_EVERY_MS || !queue.length) {
    if (!queue.length && lastFeed && Date.now() - lastFeed < FEED_EVERY_MS) await sleep(FEED_EVERY_MS - (Date.now() - lastFeed));
    const feed = (await (await fetchRetry('https://data.vatsim.net/v3/vatsim-data.json')).json()) as {
      controllers: { cid: number; callsign: string; facility: number }[];
    };
    lastFeed = Date.now();
    queue = [];
    for (const c of feed.controllers) {
      const cid = String(c.cid);
      const parsed = parseCallsign(c.callsign);
      if (c.facility <= 0 || probed.has(cid) || !parsed || !(ALL_SUFFIXES as readonly string[]).includes(parsed.suffix)) continue;
      const facility = resolveFacility(parsed, vatspy, rules).facility;
      if (facility === UNKNOWN || (perFacility.get(facility) ?? 0) >= TARGET_OBSERVATIONS) continue;
      queue.push({ cid, callsign: c.callsign, facility });
    }
    queue.sort((a, b) => (perFacility.get(a.facility) ?? 0) - (perFacility.get(b.facility) ?? 0));
    log(`feed: ${feed.controllers.length} controllers, ${queue.length} worth probing`);
    if (!queue.length) {
      idle++;
      if (idle >= IDLE_REFRESHES) {
        log(`${IDLE_REFRESHES} feed refreshes with nobody new to probe`);
        break;
      }
      continue;
    }
    idle = 0;
  }

  const next = queue.shift()!;
  if (probed.has(next.cid) || (perFacility.get(next.facility) ?? 0) >= TARGET_OBSERVATIONS) continue;
  probed.add(next.cid);
  const m = await member(next.cid);
  if (m) {
    const pair = `${m.division}/${m.subdivision}`;
    const isNew = !perFacility.has(next.facility) || !pairs.has(pair);
    state.observations.push({ ...next, ...m, at: new Date().toISOString() });
    perFacility.set(next.facility, (perFacility.get(next.facility) ?? 0) + 1);
    pairs.add(pair);
    sinceNew = isNew ? 0 : sinceNew + 1;
    writeFileSync(OUT, JSON.stringify(state, null, 1));
    log(`${isNew ? 'NEW ' : '    '}${next.callsign.padEnd(14)} ${next.facility.padEnd(9)} ${pair.padEnd(12)} (${perFacility.size} facilities, ${pairs.size} pairs, ${sinceNew} since new)`);
  }
  await sleep(MEMBER_GAP_MS);
}

log(`done: ${state.observations.length} observations, ${perFacility.size} facilities, ${pairs.size} division/subdivision pairs`);
