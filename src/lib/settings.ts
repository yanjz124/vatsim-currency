import { local } from './storage';

export type FetchMode = 'proxy' | 'direct' | 'manual';
export type BoundaryMode = 'split' | 'start';

export interface OverrideRule {
  id: string;
  /**
   * prefix:   callsign prefix (e.g. "PCT", "LON_S") → facility. Longest match wins.
   * facility: resolved facility code (e.g. "EGPX") → another facility (merge/rename).
   */
  kind: 'prefix' | 'facility';
  match: string;
  facility: string;
}

export interface Settings {
  version: 1;
  homeFacility: string;
  defaultRequirement: number;
  /** Facility code → required hours per quarter. */
  requirements: Record<string, number>;
  overrides: OverrideRule[];
  countedSuffixes: string[];
  boundaryMode: BoundaryMode;
  fetchMode: FetchMode;
  /** Base URL of a CORS relay exposing /v2/members/{cid}/atc. */
  proxyUrl: string;
}

export const ALL_SUFFIXES = ['CTR', 'FSS', 'APP', 'DEP', 'TWR', 'GND', 'DEL', 'RMP', 'RDO', 'TMU', 'FMP'] as const;

export const DEFAULT_PROXY_URL: string = import.meta.env?.VITE_PROXY_URL ?? '';

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  homeFacility: '',
  defaultRequirement: 3,
  requirements: {},
  overrides: [],
  countedSuffixes: [...ALL_SUFFIXES],
  boundaryMode: 'split',
  fetchMode: DEFAULT_PROXY_URL ? 'proxy' : 'manual',
  proxyUrl: DEFAULT_PROXY_URL,
};

const KEY = 'settings:v1';

export function normalizeSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    version: 1,
    homeFacility: typeof s.homeFacility === 'string' ? s.homeFacility.trim().toUpperCase() : '',
    defaultRequirement: num(s.defaultRequirement, DEFAULT_SETTINGS.defaultRequirement),
    requirements: Object.fromEntries(
      Object.entries(s.requirements ?? {})
        .filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
        .map(([k, v]) => [k.toUpperCase(), v]),
    ),
    overrides: Array.isArray(s.overrides)
      ? s.overrides
          .filter((o) => o && (o.kind === 'prefix' || o.kind === 'facility') && o.match && o.facility)
          .map((o) => ({
            id: o.id || newId(),
            kind: o.kind,
            match: String(o.match).trim().toUpperCase(),
            facility: String(o.facility).trim().toUpperCase(),
          }))
      : [],
    countedSuffixes: Array.isArray(s.countedSuffixes)
      ? s.countedSuffixes.filter((x) => (ALL_SUFFIXES as readonly string[]).includes(x))
      : [...ALL_SUFFIXES],
    boundaryMode: s.boundaryMode === 'start' ? 'start' : 'split',
    fetchMode: s.fetchMode === 'proxy' || s.fetchMode === 'direct' || s.fetchMode === 'manual' ? s.fetchMode : DEFAULT_SETTINGS.fetchMode,
    proxyUrl: typeof s.proxyUrl === 'string' ? s.proxyUrl.trim() : DEFAULT_SETTINGS.proxyUrl,
  };
}

export function loadSettings(): Settings {
  const stored = local.get<Settings>(KEY);
  return stored ? normalizeSettings(stored) : DEFAULT_SETTINGS;
}

export function saveSettings(s: Settings): void {
  local.set(KEY, s);
}

export function requirementFor(s: Settings, facility: string): number {
  return s.requirements[facility] ?? s.defaultRequirement;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}
