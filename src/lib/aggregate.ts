import { compileCodePattern, compilePattern, isValidCodePattern, isValidPattern, type CompiledPattern } from './patterns';
import { ALL_SUFFIXES, requirementFor, type PositionRule, type Settings } from './settings';
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
  return { callsign: callsign.toUpperCase().trim(), segments: parts.slice(0, -1), suffix: parts[parts.length - 1] };
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

/** A position without its middle segments: TOR_AA_APP and TOR_AB_APP are both TOR_APP. */
export function positionLabel(parsed: ParsedCallsign): string {
  return `${parsed.segments[0]}_${parsed.suffix}`;
}

export type ResolutionSource ='custom' | 'fir' | 'airport' | 'lid' | 'inferred' | 'unknown';

export interface Resolution {
  facility: string;
  source: ResolutionSource;
  /** Human-readable explanation, e.g. "FIR prefix DC" */
  detail: string;
  /** Other facilities the prefix could belong to (ambiguous LIDs). */
  alternatives?: string[];
  /** Set when a user-defined facility includes the matched facility. */
  groupedFrom?: string;
}

/** One-line explanation of a match, shared by the report and the spreadsheet. */
export function describeResolution(r: Resolution): string {
  let s = r.detail;
  if (r.groupedFrom) s += ` (part of ${r.facility})`;
  if (r.alternatives) s += `; also listed under ${r.alternatives.join(', ')}`;
  return s;
}

export interface FacilityMatcher extends CompiledPattern {
  facility: string;
}

export interface MatchRules {
  /** Callsign patterns, most specific first, then settings order. */
  callsigns: FacilityMatcher[];
  /** Included facility codes, most specific first, then settings order. */
  includes: FacilityMatcher[];
}

export function compileRules(s: Pick<Settings, 'facilities'>): MatchRules {
  const callsigns: (FacilityMatcher & { order: number })[] = [];
  const includes: (FacilityMatcher & { order: number })[] = [];
  s.facilities.forEach((f, fi) => {
    if (!f.code) return;
    f.patterns.forEach((p, pi) => {
      if (isValidPattern(p)) callsigns.push({ ...compilePattern(p), facility: f.code, order: fi * 1000 + pi });
    });
    f.includes.forEach((p, pi) => {
      if (isValidCodePattern(p)) includes.push({ ...compileCodePattern(p), facility: f.code, order: fi * 1000 + pi });
    });
  });
  const bySpecificity = (a: { specificity: number; order: number }, b: { specificity: number; order: number }) =>
    b.specificity - a.specificity || a.order - b.order;
  return { callsigns: callsigns.sort(bySpecificity), includes: includes.sort(bySpecificity) };
}

/** The user-defined facility that includes `code`, or `code` itself. */
export function groupFacility(code: string, rules: MatchRules): string {
  if (code === UNKNOWN) return code;
  return rules.includes.find((m) => m.facility !== code && m.re.test(code))?.facility ?? code;
}

export function resolveFacility(parsed: ParsedCallsign, vatspy: VatspyData | null, rules: MatchRules): Resolution {
  const hit = rules.callsigns.find((m) => m.re.test(parsed.callsign));
  const res: Resolution = hit
    ? { facility: hit.facility, source: 'custom', detail: `Pattern ${hit.pattern}` }
    : autoResolve(parsed, prefixCandidates(parsed.segments), vatspy);
  const group = groupFacility(res.facility, rules);
  return group === res.facility ? res : { ...res, facility: group, groupedFrom: res.facility };
}

function autoResolve(parsed: ParsedCallsign, candidates: string[], vatspy: VatspyData | null): Resolution {
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

// ---------------------------------------------------------------------------
// Quarter report
// ---------------------------------------------------------------------------

export interface SessionDetail {
  session: Session;
  /** Callsign without middle segments, e.g. TOR_APP */
  position: string;
  suffix: string;
  level: Level | null;
  counted: boolean;
  excludedReason?: string;
  resolution: Resolution | null;
  /** Hours attributed to the quarter. */
  hours: number;
  /** Position rules the callsign matches. */
  positionRules: string[];
  countsTowardFacility: boolean;
}

/** Sessions on one position (see positionLabel) at one facility. */
export interface PositionStat {
  /** e.g. TOR_APP */
  position: string;
  /** Callsigns grouped into the position, most hours first. */
  callsigns: string[];
  /** First callsign segment, e.g. TOR */
  prefix: string;
  facility: string;
  suffix: string;
  level: Level;
  hours: number;
  sessions: number;
  /** How the first session's callsign was matched. */
  resolution: Resolution;
  /** Position rules any of the callsigns match. */
  positionRules: string[];
  /** Hours that count toward the facility's currency (position rules can leave some out). */
  currencyHours: number;
}

export type LevelHours = Record<Level, number>;

export interface FacilityStat {
  code: string;
  name: string;
  hours: number;
  /** Hours that count toward the facility requirement (position rules can leave some out). */
  currencyHours: number;
  levels: LevelHours;
  sessions: number;
  positions: PositionStat[];
  requirement: number;
  meets: boolean;
  shortBy: number;
  /** Share of the member's total counted hours (0..1). */
  share: number;
  isHome: boolean;
  isVisiting: boolean;
  /** Listed even without hours: home, visiting, or marked "always list". */
  tracked: boolean;
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
  /** Grouped like positions, e.g. EGKK_ATIS */
  position: string;
  callsigns: string[];
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
  positionRules: PositionRuleStat[];
  details: SessionDetail[];
}

export interface PositionRuleStat {
  rule: PositionRule;
  hours: number;
  sessions: number;
  callsigns: string[];
  hasRequirement: boolean;
  /** True when the rule has no requirement of its own. */
  meets: boolean;
  shortBy: number;
}

export const ruleLabel = (r: PositionRule) => r.name || r.patterns.join(', ') || 'Unnamed rule';

/** Member-specific context for a report. */
export interface ReportContext {
  home?: string | null;
  /** Facilities the member is on the visiting roster of. */
  visiting?: string[];
}

export const emptyLevels = (): LevelHours => ({ 'CTR/FSS': 0, 'APP/DEP': 0, TWR: 0, 'GND/DEL/RMP': 0, Other: 0 });

export function hoursInQuarter(s: Session, q: Quarter, mode: Settings['boundaryMode']): number {
  if (mode === 'start') return s.start >= q.start && s.start < q.end ? (s.end - s.start) / 3_600_000 : 0;
  return overlapHours(s.start, s.end, q.start, q.end);
}

export function buildReport(
  sessions: Session[],
  quarter: Quarter,
  vatspy: VatspyData | null,
  settings: Settings,
  ctx: ReportContext = {},
): QuarterReport {
  const counted = new Set(settings.countedSuffixes);
  const rules = compileRules(settings);
  const details: SessionDetail[] = [];
  // Keyed by `${facility}|${position}`, so variants that resolve to different facilities stay apart.
  const positions = new Map<string, PositionStat>();
  const callsignHours = new Map<string, Map<string, number>>();
  const excluded = new Map<string, ExcludedStat>();
  const resolutionCache = new Map<string, Resolution>();

  const positionRules = settings.positionRules.map((rule) => ({
    rule,
    res: rule.patterns.filter(isValidPattern).map((p) => compilePattern(p).re),
    stat: { rule, hours: 0, sessions: 0, callsigns: [], hasRequirement: rule.hours != null, meets: true, shortBy: 0 } as PositionRuleStat,
  }));
  const ruleCache = new Map<string, typeof positionRules>();

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
      const position = parsed ? positionLabel(parsed) : s.callsign;
      details.push({
        session: s,
        position,
        suffix,
        level: null,
        counted: false,
        excludedReason: reason,
        resolution: null,
        hours,
        positionRules: [],
        countsTowardFacility: false,
      });
      const ex = excluded.get(position) ?? { position, callsigns: [], reason: reason!, hours: 0, sessions: 0 };
      ex.hours += hours;
      ex.sessions++;
      if (!ex.callsigns.includes(s.callsign)) ex.callsigns.push(s.callsign);
      excluded.set(position, ex);
      continue;
    }

    let resolution = resolutionCache.get(s.callsign);
    if (!resolution) {
      resolution = resolveFacility(parsed, vatspy, rules);
      resolutionCache.set(s.callsign, resolution);
    }
    let matched = ruleCache.get(s.callsign);
    if (!matched) {
      matched = positionRules.filter((p) => p.res.some((re) => re.test(s.callsign)));
      ruleCache.set(s.callsign, matched);
    }
    for (const { stat } of matched) {
      stat.hours += hours;
      stat.sessions++;
      if (!stat.callsigns.includes(s.callsign)) stat.callsigns.push(s.callsign);
    }
    const ruleNames = matched.map((p) => ruleLabel(p.rule));
    const countsTowardFacility = matched.every((p) => p.rule.countsTowardFacility);

    const level = SUFFIX_LEVEL[suffix];
    const position = positionLabel(parsed);
    details.push({ session: s, position, suffix, level, counted: true, resolution, hours, positionRules: ruleNames, countsTowardFacility });

    const key = `${resolution.facility}|${position}`;
    let pos = positions.get(key);
    if (!pos) {
      pos = {
        position,
        callsigns: [],
        prefix: parsed.segments[0],
        facility: resolution.facility,
        suffix,
        level,
        hours: 0,
        sessions: 0,
        resolution,
        positionRules: [],
        currencyHours: 0,
      };
      positions.set(key, pos);
    }
    pos.hours += hours;
    pos.sessions++;
    if (countsTowardFacility) pos.currencyHours += hours;
    for (const name of ruleNames) if (!pos.positionRules.includes(name)) pos.positionRules.push(name);
    const perCallsign = callsignHours.get(key) ?? new Map<string, number>();
    perCallsign.set(s.callsign, (perCallsign.get(s.callsign) ?? 0) + hours);
    callsignHours.set(key, perCallsign);
  }

  for (const [key, pos] of positions) {
    pos.callsigns = [...callsignHours.get(key)!].sort((a, b) => b[1] - a[1]).map(([callsign]) => callsign);
  }

  const home = ctx.home || '';
  const visiting = new Set(ctx.visiting ?? []);
  const defined = new Map(settings.facilities.map((f) => [f.code, f]));
  // Requirements are global per facility, so they don't force a listing; otherwise a facility
  // configured while looking at one member would show up for every member.
  const tracked = new Set(
    [home, ...visiting, ...settings.facilities.filter((f) => f.alwaysShow).map((f) => f.code)].filter((c) => c && c !== UNKNOWN),
  );

  const facilities = new Map<string, FacilityStat>();
  const ensureFacility = (code: string): FacilityStat => {
    let f = facilities.get(code);
    if (!f) {
      f = {
        code,
        name: code === UNKNOWN ? 'Unrecognised callsigns' : defined.get(code)?.name || facilityName(code, vatspy),
        hours: 0,
        currencyHours: 0,
        levels: emptyLevels(),
        sessions: 0,
        positions: [],
        requirement: requirementFor(settings, code),
        meets: false,
        shortBy: 0,
        share: 0,
        isHome: code === home,
        isVisiting: visiting.has(code),
        tracked: tracked.has(code),
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
    f.currencyHours += p.currencyHours;
    f.levels[p.level] += p.hours;
    f.sessions += p.sessions;
    f.positions.push(p);
    levels[p.level] += p.hours;
    total += p.hours;
    sessionCount += p.sessions;
  }
  for (const code of tracked) ensureFacility(code);

  for (const f of facilities.values()) {
    f.positions.sort((a, b) => b.hours - a.hours);
    f.meets = f.currencyHours >= f.requirement - 1e-9;
    f.shortBy = Math.max(0, f.requirement - f.currencyHours);
    f.share = total > 0 ? f.hours / total : 0;
  }

  const facilityList = [...facilities.values()].sort(
    (a, b) =>
      Number(a.code === UNKNOWN) - Number(b.code === UNKNOWN) ||
      b.hours - a.hours ||
      Number(b.isHome) - Number(a.isHome) ||
      a.code.localeCompare(b.code),
  );

  let homeStatus: HomeStatus | null = null;
  if (home) {
    const hf = facilities.get(home)!;
    homeStatus = {
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

  for (const { rule, stat } of positionRules) {
    if (rule.hours == null) continue;
    stat.meets = stat.hours >= rule.hours - 1e-9;
    stat.shortBy = Math.max(0, rule.hours - stat.hours);
  }

  return {
    quarter,
    positionRules: positionRules.map((p) => p.stat),
    total,
    sessionCount,
    levels,
    facilities: facilityList,
    positions: [...positions.values()].sort((a, b) => b.hours - a.hours),
    excluded: [...excluded.values()].sort((a, b) => b.hours - a.hours),
    home: homeStatus,
    details: details.sort((a, b) => b.session.start - a.session.start),
  };
}
