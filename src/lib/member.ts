import { compileRules, groupFacility } from './aggregate';
import type { FetchMode, Settings } from './settings';
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

/** Home and visiting facilities implied by the member's records, in report facility codes. */
export function memberFacilities(
  info: MemberInfo | null,
  vatspy: VatspyData | null,
  settings: Pick<Settings, 'facilities'>,
): { home: HomeFacility | null; visiting: string[] } {
  if (!info) return { home: null, visiting: [] };
  const rules = compileRules(settings);
  const fromVatusa = (code: string) => {
    const fir = vatusaToVatspy(code, vatspy);
    return fir ? groupFacility(fir, rules) : null;
  };

  const visiting = [...new Set((info.vatusa?.visiting ?? []).map(fromVatusa).filter((c): c is string => !!c))];
  const vatusaHome = info.vatusa ? fromVatusa(info.vatusa.facility) : null;
  if (vatusaHome) return { home: { code: vatusaHome, source: 'vatusa' }, visiting };

  const defined = new Set(settings.facilities.map((f) => f.code));
  const { subdivision, division } = info.vatsim ?? {};
  if (subdivision && defined.has(subdivision)) return { home: { code: subdivision, source: 'subdivision' }, visiting };
  if (division && defined.has(division)) return { home: { code: division, source: 'division' }, visiting };
  return { home: null, visiting };
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
