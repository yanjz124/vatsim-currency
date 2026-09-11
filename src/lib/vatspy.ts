import { getItem, setItem } from './storage';

export const VATSPY_URL =
  'https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/VATSpy.dat';
export const VATSPY_RELEASES_API =
  'https://api.github.com/repos/vatsimnetwork/vatspy-data-project/releases/latest';

const CACHE_KEY = 'vatspy:v2';
const CACHE_TTL_MS = 24 * 3600_000;

export interface LidEntry {
  fir: string;
  icao: string;
  pseudo: boolean;
}

export interface VatspyData {
  fetchedAt: number;
  /** FIR/ACC/ARTCC code → display name (first name listed for that code). */
  firNames: Record<string, string>;
  /** Callsign prefix (may contain underscores, e.g. "LON_S") or FIR code itself → FIR code. */
  firPrefixes: Record<string, string>;
  /** UIR code → name. */
  uirNames: Record<string, string>;
  /** 4-letter airport ICAO → FIR code. */
  airportFir: Record<string, string>;
  /** Airport ICAO → name (non-pseudo entries). */
  airportNames: Record<string, string>;
  /** IATA/LID/pseudo callsign prefix → candidate airports (pseudo entries first). */
  lids: Record<string, LidEntry[]>;
  /** Country name → ICAO prefixes, e.g. China → [ZB, ZG, …]. */
  countries: Record<string, string[]>;
}

/**
 * Parse VATSpy.dat. Relevant sections:
 *   [Airports] ICAO|Name|Lat|Lon|IATA/LID|FIR|IsPseudo
 *   [FIRs]     ICAO|Name|CallsignPrefix|Boundary
 *   [UIRs]     ICAO|Name|FIR,FIR,...
 */
export function parseVatspy(text: string, fetchedAt = Date.now()): VatspyData {
  const data: VatspyData = {
    fetchedAt,
    firNames: {},
    firPrefixes: {},
    uirNames: {},
    airportFir: {},
    airportNames: {},
    lids: {},
    countries: {},
  };
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      section = line.toUpperCase();
      continue;
    }
    const p = line.split('|').map((s) => s.trim());
    if (section === '[COUNTRIES]' && p.length >= 2) {
      const [name, prefixRaw] = p;
      const prefix = prefixRaw.toUpperCase();
      if (name && /^[A-Z0-9]{1,4}$/.test(prefix)) {
        const list = (data.countries[name] ??= []);
        if (!list.includes(prefix)) list.push(prefix);
      }
    } else if (section === '[AIRPORTS]' && p.length >= 7) {
      const [icaoRaw, name, , , lidRaw, firRaw, pseudoRaw] = p;
      const icao = icaoRaw.toUpperCase();
      const fir = firRaw.toUpperCase();
      const lid = lidRaw.toUpperCase();
      const pseudo = pseudoRaw === '1';
      if (!fir) continue;
      if (!pseudo) {
        if (icao && !(icao in data.airportFir)) data.airportFir[icao] = fir;
        if (icao && !(icao in data.airportNames)) data.airportNames[icao] = name;
      }
      if (lid) {
        const list = (data.lids[lid] ??= []);
        if (!list.some((e) => e.fir === fir && e.icao === icao)) {
          const entry = { fir, icao, pseudo };
          // Pseudo entries exist specifically to describe callsign prefixes, so rank them first.
          if (pseudo) list.splice(list.findIndex((e) => !e.pseudo) >>> 0, 0, entry);
          else list.push(entry);
        }
      }
    } else if (section === '[FIRS]' && p.length >= 3) {
      const [codeRaw, name, prefixRaw] = p;
      const code = codeRaw.toUpperCase();
      const prefix = prefixRaw.toUpperCase();
      if (!code) continue;
      if (!(code in data.firNames)) data.firNames[code] = name;
      if (!(code in data.firPrefixes)) data.firPrefixes[code] = code;
      if (prefix && !(prefix in data.firPrefixes)) data.firPrefixes[prefix] = code;
    } else if (section === '[UIRS]' && p.length >= 2) {
      const code = p[0].toUpperCase();
      if (code && !(code in data.uirNames)) data.uirNames[code] = p[1];
    }
  }
  return data;
}

export async function loadVatspy(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<VatspyData> {
  if (!opts.force) {
    const cached = await getItem<VatspyData>(CACHE_KEY);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  }
  try {
    const res = await fetch(VATSPY_URL, { signal: opts.signal, cache: 'no-cache' });
    if (!res.ok) throw new Error(`VATSpy.dat download failed (HTTP ${res.status})`);
    const data = parseVatspy(await res.text());
    await setItem(CACHE_KEY, data);
    return data;
  } catch (err) {
    // Stale data beats no data when GitHub is unreachable.
    const stale = await getItem<VatspyData>(CACHE_KEY);
    if (stale) return stale;
    throw err;
  }
}

export function facilityName(code: string, data: VatspyData | null): string {
  if (!data) return '';
  return data.firNames[code] ?? data.uirNames[code] ?? '';
}

/** All known facility codes, for autocomplete. */
export function facilityCodes(data: VatspyData | null): string[] {
  if (!data) return [];
  return [...new Set([...Object.keys(data.firNames), ...Object.keys(data.uirNames)])].sort();
}
