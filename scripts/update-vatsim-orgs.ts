// Refresh src/data/vatsim-orgs.json: the VATSIM division and subdivision lists, plus facility → division
// tags from a scripts/probe-divisions.ts results file.
// Run with: npx tsx scripts/update-vatsim-orgs.ts [probe-results.json]
//
// Visiting controllers are common, so a facility is only tagged when at least MIN_VOTES probed
// controllers agree and they are more than half of everyone seen there. The subdivision is kept only
// when it passes the same test among that division's controllers.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { OrgData } from '../src/lib/member';

const OUT = new URL('../src/data/vatsim-orgs.json', import.meta.url);
const MIN_VOTES = 2;
const probeFile = process.argv[2];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.ok) return (await res.json()) as T;
    if (attempt === 5) throw new Error(`${url}: HTTP ${res.status}`);
    await sleep(5_000 * attempt);
  }
}

const divisions = await getJson<{ id: string; name: string; subdivisionallowed: number }[]>('https://api.vatsim.net/api/divisions/');
const subdivisions = await getJson<{ code: string; fullname: string; parentdivision: string }[]>('https://api.vatsim.net/api/subdivisions/');

const previous: Partial<OrgData> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
let facilities: OrgData['facilities'] = previous.facilities ?? {};

if (probeFile) {
  const { observations } = JSON.parse(readFileSync(probeFile, 'utf8')) as {
    observations: { facility: string; division: string | null; subdivision: string | null }[];
  };
  const byFacility = new Map<string, typeof observations>();
  for (const o of observations) {
    if (!o.division) continue;
    byFacility.set(o.facility, [...(byFacility.get(o.facility) ?? []), o]);
  }

  const top = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    const [value, votes] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    return votes >= MIN_VOTES && votes > values.length / 2 ? value : null;
  };

  facilities = {};
  let skipped = 0;
  for (const [code, obs] of [...byFacility].sort(([a], [b]) => a.localeCompare(b))) {
    const division = top(obs.map((o) => o.division!));
    if (!division) {
      skipped++;
      continue;
    }
    const inDivision = obs.filter((o) => o.division === division);
    const subdivision = top(inDivision.map((o) => o.subdivision ?? '')) || null;
    facilities[code] = { division, subdivision, controllers: obs.length };
  }
  console.log(`${Object.keys(facilities).length} facilities tagged from ${observations.length} observations; ${skipped} without a clear majority`);
}

const data: OrgData & { source: string; updated: string } = {
  source: 'VATSIM API /api/divisions/ and /api/subdivisions/; facility tags from scripts/probe-divisions.ts',
  updated: new Date().toISOString().slice(0, 10),
  divisions: divisions
    .map((d) => ({ id: d.id, name: d.name, subdivisionsAllowed: !!d.subdivisionallowed }))
    .sort((a, b) => a.id.localeCompare(b.id)),
  subdivisions: subdivisions
    .map((s) => ({ id: s.code, name: s.fullname, division: s.parentdivision }))
    .sort((a, b) => a.division.localeCompare(b.division) || a.id.localeCompare(b.id)),
  facilities,
};
writeFileSync(OUT, JSON.stringify(data, null, 1) + '\n');
console.log(`${data.divisions.length} divisions, ${data.subdivisions.length} subdivisions written to src/data/vatsim-orgs.json`);
