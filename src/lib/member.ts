import bundledOrgs from '../data/vatsim-orgs.json';
import { compileRules, groupFacility } from './aggregate';
import type { FacilityDef, FetchMode, Settings } from './settings';
import { getItem, setItem } from './storage';
import { ApiError, VATSIM_API, guardedGetJson, type FetchStatus } from './vatsimApi';
import type { VatspyData } from './vatspy';

// The VATUSA API sends CORS headers, so the browser calls it directly.
export const VATUSA_API = 'https://api.vatusa.net/v2';

const TTL_MS = 12 * 3600_000;
const cacheKey = (cid: string) => `member:v1:${cid}`;

export interface MemberInfo {
  cid: string;
  fetchedAt: number;
  /** From the VATSIM API; null when it couldn't be queried (e.g. manual import mode). */
  vatsim: { region: string | null; division: string | null; subdivision: string | null; rating: number | null } | null;
  /** From the VATUSA API, for VATUSA members. Visiting facilities outside VATUSA aren't included. */
  vatusa: { facility: string; visiting: string[] } | null;
}

export type HomeSource = 'choice' | 'vatusa' | 'subdivision' | 'division' | 'hours';

export interface HomeFacility {
  code: string;
  source: HomeSource;
  /** Set when the facility was built from VATSIM data rather than defined in Settings. */
  auto?: { includes: string[] };
}

/** VATSIM divisions and subdivisions (src/data/vatsim-orgs.json, refreshed by scripts/update-vatsim-orgs.ts). */
export interface OrgData {
  divisions: { id: string; name: string; subdivisionsAllowed: boolean }[];
  subdivisions: { id: string; name: string; division: string }[];
  /** Facility code → the division/subdivision most of its probed controllers belong to. */
  facilities: Record<string, { division: string; subdivision: string | null; controllers: number }>;
}

export const ORGS = bundledOrgs as OrgData;

/**
 * A facility standing for a VATSIM division or subdivision, built from published data instead of a
 * hand-made list. It includes:
 * - a FIR with the subdivision's code (CAN's ZYZ is CZYZ, USA's ZDC is KZDC)
 * - the prefixes of the VATSpy country with the same name (Germany is ED*, ET*; "Brazil (VATBRZ)" is Brazil)
 * - facilities whose controllers were found to belong to it (scripts/probe-divisions.ts)
 */
export function orgFacility(id: string, kind: 'division' | 'subdivision', vatspy: VatspyData, orgs: OrgData = ORGS): FacilityDef | null {
  const unit = kind === 'division' ? orgs.divisions.find((d) => d.id === id) : orgs.subdivisions.find((s) => s.id === id);
  const includes = new Set<string>();

  if (kind === 'subdivision') {
    const fir = [id, `K${id}`, `C${id}`, `P${id}`].find((c) => vatspy.firNames[c]);
    if (fir) includes.add(fir);
  }

  // Try the name and any part in brackets: "Brazil (VATBRZ)" is Brazil, "Republic of China (Taiwan)" is Taiwan.
  const [, outside = '', inside = ''] = /^(.*?)\s*(?:\((.*)\))?\s*$/.exec(unit?.name ?? '') ?? [];
  const names = [outside, inside].map((n) => n.trim().toLowerCase()).filter(Boolean);
  const country = Object.entries(vatspy.countries).find(([n]) => names.includes(n.toLowerCase()));
  if (country) {
    const otherPrefixes = Object.entries(vatspy.countries)
      .filter(([n]) => n !== country[0])
      .flatMap(([, prefixes]) => prefixes);
    for (const p of country[1]) {
      // A one-letter prefix (K, U) is only safe when no other country's codes start with that letter.
      if (p.length === 1 && otherPrefixes.some((o) => o.startsWith(p))) continue;
      includes.add(`${p}*`);
    }
  }

  for (const [code, tag] of Object.entries(orgs.facilities)) {
    if ((kind === 'division' ? tag.division : tag.subdivision) === id) includes.add(code);
  }

  if (!includes.size) return null;
  return { id: `vatsim-${kind}-${id}`, code: id, name: unit?.name ?? id, patterns: [], includes: [...includes], alwaysShow: false };
}

export const HOME_SOURCE_TEXT: Record<HomeSource, string> = {
  choice: 'your selection',
  vatusa: 'the VATUSA roster',
  subdivision: 'the VATSIM subdivision',
  division: 'the VATSIM division',
  hours: 'the facility with the most hours',
};

export function parseVatsimMember(json: unknown): MemberInfo['vatsim'] {
  if (!json || typeof json !== 'object' || !('id' in json)) return null;
  const j = json as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    region: str(j.region_id),
    division: str(j.division_id),
    subdivision: str(j.subdivision_id),
    rating: typeof j.rating === 'number' ? j.rating : null,
  };
}

export function parseVatusaUser(json: unknown): MemberInfo['vatusa'] {
  const d = (json as { data?: { facility?: unknown; visiting_facilities?: unknown } } | null)?.data;
  if (!d || typeof d.facility !== 'string') return null;
  const visiting = Array.isArray(d.visiting_facilities)
    ? d.visiting_facilities.map((v) => (v as { facility?: unknown })?.facility).filter((f): f is string => typeof f === 'string')
    : [];
  return { facility: d.facility, visiting: [...new Set(visiting)] };
}

// VATUSA facilities whose VATSpy FIR isn't "K" + code.
const VATUSA_TO_VATSPY: Record<string, string> = { HCF: 'PHZH', ZAN: 'PAZA' };

/**
 * Map a VATUSA facility (ZDC) to its VATSpy FIR (KZDC). Returns null for anything that isn't a
 * real FIR, which also filters out VATUSA's non-facility placeholders.
 */
export function vatusaToVatspy(code: string, vatspy: VatspyData | null): string | null {
  if (!vatspy) return null;
  const fir = VATUSA_TO_VATSPY[code] ?? `K${code}`;
  return vatspy.firNames[fir] ? fir : null;
}

export interface MemberFacilities {
  home: HomeFacility | null;
  visiting: string[];
  /** Facility built from VATSIM data for the home division/subdivision; add it to the report's facilities. */
  autoFacility: FacilityDef | null;
}

/**
 * Home and visiting facilities implied by the member's records, in report facility codes. Home comes
 * from, in order: the VATUSA roster, a facility defined in Settings with the subdivision or division
 * code, then a facility built from VATSIM data for the subdivision (or the division, for members
 * without one). US members are left to VATUSA, whose facilities aren't VATSIM subdivisions.
 */
export function memberFacilities(
  info: MemberInfo | null,
  vatspy: VatspyData | null,
  settings: Pick<Settings, 'facilities'>,
  orgs: OrgData = ORGS,
): MemberFacilities {
  if (!info) return { home: null, visiting: [], autoFacility: null };
  const rules = compileRules(settings);
  const fromVatusa = (code: string) => {
    const fir = vatusaToVatspy(code, vatspy);
    return fir ? groupFacility(fir, rules) : null;
  };

  const visiting = [...new Set((info.vatusa?.visiting ?? []).map(fromVatusa).filter((c): c is string => !!c))];
  const vatusaHome = info.vatusa ? fromVatusa(info.vatusa.facility) : null;
  if (vatusaHome) return { home: { code: vatusaHome, source: 'vatusa' }, visiting, autoFacility: null };

  const defined = new Set(settings.facilities.map((f) => f.code));
  const { subdivision, division } = info.vatsim ?? {};
  if (subdivision && defined.has(subdivision)) return { home: { code: subdivision, source: 'subdivision' }, visiting, autoFacility: null };
  if (division && defined.has(division)) return { home: { code: division, source: 'division' }, visiting, autoFacility: null };
  if (!vatspy) return { home: null, visiting, autoFacility: null };

  // A subdivision member belongs to the subdivision, not the whole division, so there's no fallback.
  const auto = subdivision
    ? orgFacility(subdivision, 'subdivision', vatspy, orgs)
    : division && division !== 'USA'
      ? orgFacility(division, 'division', vatspy, orgs)
      : null;
  if (!auto) return { home: null, visiting, autoFacility: null };
  return {
    home: { code: auto.code, source: subdivision ? 'subdivision' : 'division', auto: { includes: auto.includes } },
    visiting,
    autoFacility: auto,
  };
}

export function getCachedMember(cid: string): Promise<MemberInfo | undefined> {
  return getItem<MemberInfo>(cacheKey(cid));
}

export interface MemberFetchOptions {
  cid: string;
  mode: FetchMode;
  proxyUrl: string;
  signal?: AbortSignal;
  onStatus?: (s: FetchStatus) => void;
}

/**
 * Division/subdivision (VATSIM, through the same rate-limit guard as sessions) and VATUSA roster
 * facilities. Cached for 12 hours; failures fall back to the cached copy.
 */
export async function fetchMemberInfo(opts: MemberFetchOptions): Promise<MemberInfo> {
  const { cid, mode, signal } = opts;
  const cached = await getCachedMember(cid);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS && (cached.vatsim || mode === 'manual')) return cached;

  let vatsim: MemberInfo['vatsim'] = null;
  if (mode !== 'manual') {
    const base = (mode === 'direct' ? VATSIM_API : opts.proxyUrl).replace(/\/+$/, '');
    try {
      const json = await guardedGetJson(`${base}/v2/members/${encodeURIComponent(cid)}`, mode, opts.onStatus ?? (() => {}), 'member details', signal);
      vatsim = parseVatsimMember(json);
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'aborted') throw e;
      vatsim = cached?.vatsim ?? null;
    }
  }

  let vatusa: MemberInfo['vatusa'] = null;
  if (!vatsim || vatsim.division === 'USA') {
    try {
      const res = await fetch(`${VATUSA_API}/user/${encodeURIComponent(cid)}`, { signal, headers: { Accept: 'application/json' } });
      if (res.ok) vatusa = parseVatusaUser(await res.json());
    } catch (e) {
      if (signal?.aborted) throw e;
      vatusa = cached?.vatusa ?? null;
    }
  }

  const info: MemberInfo = { cid, fetchedAt: Date.now(), vatsim, vatusa };
  await setItem(cacheKey(cid), info);
  return info;
}
