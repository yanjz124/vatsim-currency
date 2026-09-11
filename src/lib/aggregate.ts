import { ALL_SUFFIXES, requirementFor, type OverrideRule, type Settings } from './settings';
import { facilityName, type VatspyData } from './vatspy';
import { overlapHours, type Quarter } from './quarters';
import type { Session } from './vatsimApi';

export const LEVELS = ['CTR/FSS', 'APP/DEP', 'TWR', 'GND/DEL/RMP', 'Other'] as const;
export type Level = (typeof LEVELS)[number];

export const SUFFIX_LEVEL: Record<string, Level> = {
  CTR: 'CTR/FSS',
  FSS: 'CTR/FSS',
  APP: 'APP/DEP',
  DEP: 'APP/DEP',
  TWR: 'TWR',
  GND: 'GND/DEL/RMP',
  DEL: 'GND/DEL/RMP',
  RMP: 'GND/DEL/RMP',
  RDO: 'Other',
  TMU: 'Other',
  FMP: 'Other',
};

export const UNKNOWN = 'UNKNOWN';

export interface ParsedCallsign {
  callsign: string;
  /** Segments before the suffix, e.g. DC_32_CTR → ["DC", "32"] */
  segments: string[];
  suffix: string;
}

export function parseCallsign(callsign: string): ParsedCallsign | null {
  const parts = callsign.toUpperCase().trim().split('_');
  if (parts.length < 2 || !parts[0]) return null;
  return { callsign: callsign.toUpperCase(), segments: parts.slice(0, -1), suffix: parts[parts.length - 1] };
}

/** Candidate prefixes, longest first: LON_S_CTR → ["LON_S", "LON"]. */
export function prefixCandidates(segments: string[]): string[] {
  const out: string[] = [];
  for (let k = segments.length; k >= 1; k--) {
    const p = segments.slice(0, k).filter(Boolean).join('_');
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export type ResolutionSource = 'override' | 'fir' | 'airport' | 'lid' | 'inferred' | 'unknown';

export interface Resolution {
  facility: string;
  source: ResolutionSource;
  /** Human-readable explanation, e.g. "FIR prefix DC" */
  detail: string;
  /** Other facilities the prefix could belong to (ambiguous LIDs). */
  alternatives?: string[];
  /** Set when a facility-merge override renamed the auto-detected facility. */
  mergedFrom?: string;
}

/** One-line explanation of a match, shared by the report and the spreadsheet. */
export function describeResolution(r: Resolution): string {
  let s = r.detail;
  if (r.mergedFrom) s += ` (merged into ${r.facility})`;
  if (r.alternatives) s += `; also listed under ${r.alternatives.join(', ')}`;
  return s;
}

export function resolveFacility(parsed: ParsedCallsign, vatspy: VatspyData | null, overrides: OverrideRule[]): Resolution {
  const candidates = prefixCandidates(parsed.segments);
  const res = autoResolve(parsed, candidates, vatspy, overrides);
  return applyFacilityRules(res, overrides);
}

function autoResolve(
  parsed: ParsedCallsign,
  candidates: string[],
  vatspy: VatspyData | null,
  overrides: OverrideRule[],
): Resolution {
  for (const c of candidates) {
    const rule = overrides.find((o) => o.kind === 'prefix' && o.match === c);
    if (rule) return { facility: rule.facility, source: 'override', detail: `Override for prefix ${c}` };
  }
  if (!vatspy) return { facility: UNKNOWN, source: 'unknown', detail: 'VATSpy data not loaded' };

  const first = candidates[candidates.length - 1];

  const byFir = (): Resolution | null => {
    for (const c of candidates) {
      const fir = vatspy.firPrefixes[c];
      if (fir) return { facility: fir, source: 'fir', detail: c === fir ? `FIR ${c}` : `FIR prefix ${c}` };
      if (vatspy.uirNames[c]) return { facility: c, source: 'fir', detail: `UIR ${c}` };
    }
    return null;
  };

  const byAirport = (): Resolution | null => {
    if (vatspy.airportFir[first]) {
      return { facility: vatspy.airportFir[first], source: 'airport', detail: `Airport ${first}` };
    }
    for (const c of candidates) {
      const entries = vatspy.lids[c];
      if (!entries?.length) continue;
      const firs = [...new Set(entries.map((e) => e.fir))];
      return {
        facility: firs[0],
        source: 'lid',
        detail: `${entries[0].pseudo ? 'Callsign prefix' : 'Airport code'} ${c} (${entries[0].icao})`,
        alternatives: firs.length > 1 ? firs.slice(1) : undefined,
      };
    }
    return null;
  };

  const enroute = parsed.suffix === 'CTR' || parsed.suffix === 'FSS';
  const hit = enroute ? (byFir() ?? byAirport()) : (byAirport() ?? byFir());
  if (hit) return hit;

  // Last resort for 3-letter FAA/TC identifiers that VATSpy lists only by ICAO.
  if (/^[A-Z0-9]{3}$/.test(first)) {
    for (const icao of first.startsWith('Y') ? ['C' + first, 'K' + first] : ['K' + first]) {
      const fir = vatspy.airportFir[icao];
      if (fir) return { facility: fir, source: 'inferred', detail: `Guessed airport ${icao}` };
    }
  }
  return { facility: UNKNOWN, source: 'unknown', detail: 'No match in VATSpy data' };
}

function applyFacilityRules(res: Resolution, overrides: OverrideRule[]): Resolution {
  let facility = res.facility;
  const seen = new Set([facility]);
  for (let i = 0; i < 5; i++) {
    const rule = overrides.find((o) => o.kind === 'facility' && o.match === facility);
    if (!rule || seen.has(rule.facility)) break;
    facility = rule.facility;
    seen.add(facility);
  }
  return facility === res.facility ? res : { ...res, facility, mergedFrom: res.facility };
}

// ---------------------------------------------------------------------------
// Quarter report
// ---------------------------------------------------------------------------

export interface SessionDetail {
  session: Session;
  suffix: string;
  level: Level | null;
  counted: boolean;
  excludedReason?: string;
  resolution: Resolution | null;
  /** Hours attributed to the quarter. */
  hours: number;
}

export interface PositionStat {
  callsign: string;
  facility: string;
  suffix: string;
  level: Level;
  hours: number;
  sessions: number;
  resolution: Resolution;
  segments: string[];
}

export type LevelHours = Record<Level, number>;

export interface FacilityStat {
  code: string;
  name: string;
  hours: number;
  levels: LevelHours;
  sessions: number;
  positions: PositionStat[];
  requirement: number;
  meets: boolean;
  shortBy: number;
  /** Share of the member's total counted hours (0..1). */
  share: number;
  isHome: boolean;
}

export interface HomeStatus {
  facility: string;
  name: string;
  homeHours: number;
  total: number;
  share: number;
  /** null when there is no counted activity at all. */
  meets: boolean | null;
  /** Home must exceed this many additional hours (if everything else stays the same). */
  neededAtHome: number;
  /** Hours that can still be controlled elsewhere while staying above 50%. */
  headroomElsewhere: number;
}

export interface ExcludedStat {
  callsign: string;
  reason: string;
  hours: number;
  sessions: number;
}

export interface QuarterReport {
  quarter: Quarter;
  total: number;
  sessionCount: number;
  levels: LevelHours;
  facilities: FacilityStat[];
  positions: PositionStat[];
  excluded: ExcludedStat[];
  home: HomeStatus | null;
  details: SessionDetail[];
}

export const emptyLevels = (): LevelHours => ({ 'CTR/FSS': 0, 'APP/DEP': 0, TWR: 0, 'GND/DEL/RMP': 0, Other: 0 });

export function hoursInQuarter(s: Session, q: Quarter, mode: Settings['boundaryMode']): number {
  if (mode === 'start') return s.start >= q.start && s.start < q.end ? (s.end - s.start) / 3_600_000 : 0;
  return overlapHours(s.start, s.end, q.start, q.end);
}

export function buildReport(sessions: Session[], quarter: Quarter, vatspy: VatspyData | null, settings: Settings): QuarterReport {
  const counted = new Set(settings.countedSuffixes);
  const details: SessionDetail[] = [];
  const positions = new Map<string, PositionStat>();
  const excluded = new Map<string, ExcludedStat>();
  const resolutionCache = new Map<string, Resolution>();

  for (const s of sessions) {
    const hours = hoursInQuarter(s, quarter, settings.boundaryMode);
    if (hours <= 0) continue;
    const parsed = parseCallsign(s.callsign);
    const suffix = parsed?.suffix ?? '';
    const isAtc = (ALL_SUFFIXES as readonly string[]).includes(suffix);
    let reason: string | undefined;
    if (!parsed || !isAtc) reason = 'Not a controlling position';
    else if (!counted.has(suffix)) reason = `${suffix} not counted (Settings)`;

    if (reason || !parsed) {
      details.push({ session: s, suffix, level: null, counted: false, excludedReason: reason, resolution: null, hours });
      const ex = excluded.get(s.callsign) ?? { callsign: s.callsign, reason: reason!, hours: 0, sessions: 0 };
      ex.hours += hours;
      ex.sessions++;
      excluded.set(s.callsign, ex);
      continue;
    }

    let resolution = resolutionCache.get(s.callsign);
    if (!resolution) {
      resolution = resolveFacility(parsed, vatspy, settings.overrides);
      resolutionCache.set(s.callsign, resolution);
    }
    const level = SUFFIX_LEVEL[suffix];
    details.push({ session: s, suffix, level, counted: true, resolution, hours });

    const pos = positions.get(s.callsign) ?? {
      callsign: s.callsign,
      facility: resolution.facility,
      suffix,
      level,
      hours: 0,
      sessions: 0,
      resolution,
      segments: parsed.segments,
    };
    pos.hours += hours;
    pos.sessions++;
    positions.set(s.callsign, pos);
  }

  const facilities = new Map<string, FacilityStat>();
  const ensureFacility = (code: string): FacilityStat => {
    let f = facilities.get(code);
    if (!f) {
      f = {
        code,
        name: code === UNKNOWN ? 'Unrecognised callsigns' : facilityName(code, vatspy),
        hours: 0,
        levels: emptyLevels(),
        sessions: 0,
        positions: [],
        requirement: requirementFor(settings, code),
        meets: false,
        shortBy: 0,
        share: 0,
        isHome: code === settings.homeFacility,
      };
      facilities.set(code, f);
    }
    return f;
  };

  const levels = emptyLevels();
  let total = 0;
  let sessionCount = 0;
  for (const p of positions.values()) {
    const f = ensureFacility(p.facility);
    f.hours += p.hours;
    f.levels[p.level] += p.hours;
    f.sessions += p.sessions;
    f.positions.push(p);
    levels[p.level] += p.hours;
    total += p.hours;
    sessionCount += p.sessions;
  }
  if (settings.homeFacility) ensureFacility(settings.homeFacility);

  for (const f of facilities.values()) {
    f.positions.sort((a, b) => b.hours - a.hours);
    f.meets = f.hours >= f.requirement - 1e-9;
    f.shortBy = Math.max(0, f.requirement - f.hours);
    f.share = total > 0 ? f.hours / total : 0;
  }

  const facilityList = [...facilities.values()].sort(
    (a, b) => Number(b.isHome) - Number(a.isHome) || Number(a.code === UNKNOWN) - Number(b.code === UNKNOWN) || b.hours - a.hours,
  );

  let home: HomeStatus | null = null;
  if (settings.homeFacility) {
    const hf = facilities.get(settings.homeFacility)!;
    home = {
      facility: hf.code,
      name: hf.name,
      homeHours: hf.hours,
      total,
      share: total > 0 ? hf.hours / total : 0,
      meets: total > 0 ? hf.hours > total / 2 : null,
      neededAtHome: Math.max(0, total - 2 * hf.hours),
      headroomElsewhere: Math.max(0, 2 * hf.hours - total),
    };
  }

  return {
    quarter,
    total,
    sessionCount,
    levels,
    facilities: facilityList,
    positions: [...positions.values()].sort((a, b) => b.hours - a.hours),
    excluded: [...excluded.values()].sort((a, b) => b.hours - a.hours),
    home,
    details: details.sort((a, b) => b.session.start - a.session.start),
  };
}
