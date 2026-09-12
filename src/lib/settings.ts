import { isValidCodePattern, isValidPattern, normalizePattern } from './patterns';
import { local } from './storage';

export type FetchMode = 'proxy' | 'direct' | 'manual';
export type BoundaryMode = 'split' | 'start';

/** A user-defined facility. */
export interface FacilityDef {
  id: string;
  /** Use a VATSIM division/subdivision ID (PRC, GER) to make it that division's default home facility. */
  code: string;
  name: string;
  /** Callsign patterns that belong to this facility (see patterns.ts). */
  patterns: string[];
  /** Facility codes folded into this one, e.g. EGPX, KZDC or ZB*. */
  includes: string[];
  /** List in every report, even without hours. */
  alwaysShow: boolean;
}

/** A group of positions tracked on its own. */
export interface PositionRule {
  id: string;
  name: string;
  /** Callsign patterns (see patterns.ts). */
  patterns: string[];
  /** Separate requirement in hours per quarter; null for none. */
  hours: number | null;
  /** When false, matching sessions don't count toward their facility's currency (they still count toward totals). */
  countsTowardFacility: boolean;
}

export interface Settings {
  version: 2;
  defaultRequirement: number;
  /** Facility code → required hours per quarter. */
  requirements: Record<string, number>;
  facilities: FacilityDef[];
  positionRules: PositionRule[];
  countedSuffixes: string[];
  boundaryMode: BoundaryMode;
  fetchMode: FetchMode;
  /** Base URL of a CORS relay exposing /v2/members/{cid} and /v2/members/{cid}/atc. */
  proxyUrl: string;
}

export const ALL_SUFFIXES = ['CTR', 'FSS', 'APP', 'DEP', 'TWR', 'GND', 'DEL', 'RMP', 'RDO', 'TMU', 'FMP'] as const;

export const DEFAULT_PROXY_URL: string = import.meta.env?.VITE_PROXY_URL ?? '';

/**
 * VATPRC runs mainland China as a single facility. Its code matches the VATSIM division ID, and the
 * prefixes are the ones VATSpy lists for China.
 */
export const DEFAULT_FACILITIES: FacilityDef[] = [
  {
    id: 'vatprc',
    code: 'PRC',
    name: 'VATPRC (China)',
    patterns: [],
    includes: ['ZB*', 'ZG*', 'ZH*', 'ZJ*', 'ZL*', 'ZP*', 'ZS*', 'ZU*', 'ZW*', 'ZY*'],
    alwaysShow: false,
  },
];

export const DEFAULT_SETTINGS: Settings = {
  version: 2,
  defaultRequirement: 3,
  requirements: {},
  facilities: DEFAULT_FACILITIES,
  positionRules: [],
  countedSuffixes: [...ALL_SUFFIXES],
  boundaryMode: 'split',
  fetchMode: DEFAULT_PROXY_URL ? 'proxy' : 'manual',
  proxyUrl: DEFAULT_PROXY_URL,
};

const KEY = 'settings:v1';

const toCode = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : '');

const cleanList = (v: unknown, valid: (p: string) => boolean) => [
  ...new Set((Array.isArray(v) ? v : []).map((p) => normalizePattern(String(p))).filter(valid)),
];

/** Version 1 kept callsign-prefix rules and facility merges in a single list. */
interface LegacyOverride {
  kind?: string;
  match?: string;
  facility?: string;
}

export function normalizeSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings> & { overrides?: LegacyOverride[] };
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);

  const facilities: FacilityDef[] = [];
  const source = (Array.isArray(s.facilities) ? s.facilities : DEFAULT_FACILITIES) as Partial<FacilityDef>[];
  for (const f of source) {
    const code = toCode(f?.code);
    if (!code || facilities.some((x) => x.code === code)) continue;
    facilities.push({
      id: typeof f.id === 'string' && f.id ? f.id : newId(),
      code,
      name: typeof f.name === 'string' ? f.name.trim() : '',
      patterns: cleanList(f.patterns, isValidPattern),
      includes: cleanList(f.includes, isValidCodePattern).filter((p) => p !== code),
      alwaysShow: f.alwaysShow === true,
    });
  }

  const facilityFor = (code: string) => {
    let f = facilities.find((x) => x.code === code);
    if (!f) facilities.push((f = { id: newId(), code, name: '', patterns: [], includes: [], alwaysShow: false }));
    return f;
  };
  for (const o of Array.isArray(s.overrides) ? s.overrides : []) {
    const match = toCode(o?.match);
    const target = toCode(o?.facility);
    if (!match || !target || match === target) continue;
    if (o.kind === 'prefix' && isValidPattern(`${match}_*`)) {
      const f = facilityFor(target);
      if (!f.patterns.includes(`${match}_*`)) f.patterns.push(`${match}_*`);
    } else if (o.kind === 'facility' && isValidCodePattern(match)) {
      const f = facilityFor(target);
      if (!f.includes.includes(match)) f.includes.push(match);
    }
  }

  const positionRules: PositionRule[] = (Array.isArray(s.positionRules) ? (s.positionRules as Partial<PositionRule>[]) : [])
    .map((r) => ({
      id: typeof r?.id === 'string' && r.id ? r.id : newId(),
      name: typeof r?.name === 'string' ? r.name.trim() : '',
      patterns: cleanList(r?.patterns, isValidPattern),
      hours: typeof r?.hours === 'number' && Number.isFinite(r.hours) && r.hours >= 0 ? r.hours : null,
      countsTowardFacility: r?.countsTowardFacility !== false,
    }))
    .filter((r) => r.name || r.patterns.length);

  return {
    version: 2,
    defaultRequirement: num(s.defaultRequirement, DEFAULT_SETTINGS.defaultRequirement),
    requirements: Object.fromEntries(
      Object.entries(s.requirements ?? {})
        .filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
        .map(([k, v]) => [k.toUpperCase(), v]),
    ),
    facilities,
    positionRules,
    countedSuffixes: Array.isArray(s.countedSuffixes)
      ? s.countedSuffixes.filter((x) => (ALL_SUFFIXES as readonly string[]).includes(x))
      : [...ALL_SUFFIXES],
    boundaryMode: s.boundaryMode === 'start' ? 'start' : 'split',
    fetchMode: s.fetchMode === 'proxy' || s.fetchMode === 'direct' || s.fetchMode === 'manual' ? s.fetchMode : DEFAULT_SETTINGS.fetchMode,
    proxyUrl: typeof s.proxyUrl === 'string' ? s.proxyUrl.trim() : DEFAULT_SETTINGS.proxyUrl,
  };
}

export function loadSettings(): Settings {
  const stored = local.get<unknown>(KEY);
  return stored ? normalizeSettings(stored) : DEFAULT_SETTINGS;
}

export function saveSettings(s: Settings): void {
  local.set(KEY, s);
}

export function requirementFor(s: Settings, facility: string): number {
  return s.requirements[facility] ?? s.defaultRequirement;
}

const cloneFacilities = (s: Settings) => s.facilities.map((f) => ({ ...f, patterns: [...f.patterns], includes: [...f.includes] }));

/** The facility with `code` in `facilities`, created (and appended) if missing. */
function targetFacility(facilities: FacilityDef[], code: string, name: string): FacilityDef {
  let f = facilities.find((x) => x.code === code);
  if (!f) facilities.push((f = { id: newId(), code, name, patterns: [], includes: [], alwaysShow: false }));
  else if (!f.name && name) f.name = name;
  return f;
}

/** Move a callsign pattern to a facility (removing it from any other), creating the facility if needed. */
export function assignPattern(s: Settings, pattern: string, code: string, name = ''): Settings {
  const facilities = cloneFacilities(s);
  for (const f of facilities) f.patterns = f.patterns.filter((p) => p !== pattern);
  targetFacility(facilities, code, name).patterns.push(pattern);
  return { ...s, facilities };
}

/** Move an included facility code (e.g. ZGGG) to a facility, creating the facility if needed. */
export function assignInclude(s: Settings, include: string, code: string, name = ''): Settings {
  if (include === code) return s;
  const facilities = cloneFacilities(s);
  for (const f of facilities) f.includes = f.includes.filter((p) => p !== include);
  targetFacility(facilities, code, name).includes.push(include);
  return { ...s, facilities };
}

/** Create or extend a facility. Its patterns and includes move over from any other facility that had them. */
export function addFacility(
  s: Settings,
  def: { code: string; name: string; patterns: string[]; includes: string[]; alwaysShow: boolean },
): Settings {
  const facilities = cloneFacilities(s);
  const target = targetFacility(facilities, def.code, def.name);
  target.alwaysShow ||= def.alwaysShow;
  let next: Settings = { ...s, facilities };
  for (const p of def.patterns) next = assignPattern(next, p, def.code);
  for (const i of def.includes) next = assignInclude(next, i, def.code);
  return next;
}

/** Replace a facility definition; a renamed code keeps its requirement. */
export function updateFacility(s: Settings, next: FacilityDef): Settings {
  const prev = s.facilities.find((f) => f.id === next.id);
  let { requirements } = s;
  if (prev && prev.code !== next.code && prev.code in requirements && !(next.code in requirements)) {
    requirements = { ...requirements, [next.code]: requirements[prev.code] };
    delete requirements[prev.code];
  }
  return { ...s, requirements, facilities: s.facilities.map((f) => (f.id === next.id ? next : f)) };
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}
