import { normalizeCustomizations, normalizeSettings, type CidCustomization, type Settings } from './settings';

// Settings live in localStorage. These helpers move them in and out: a .json backup file, the
// Settings sheet of an exported .xlsx report, or a link that carries the settings in its #hash.

export const BACKUP_APP = 'vatsim-atc-currency';
/** Label of the Settings-sheet row that holds the JSON backup in exported reports. */
export const BACKUP_CELL_LABEL = 'Settings backup (JSON)';

export interface Backup {
  app: typeof BACKUP_APP;
  kind: 'settings';
  version: 2;
  exportedAt: string;
  settings: Settings;
  /** Changes made in reports, per CID. */
  customizations: Record<string, CidCustomization>;
}

export interface Restored {
  settings: Settings;
  /** null when the source had none (old exports, shared links). */
  customizations: Record<string, CidCustomization> | null;
}

export function makeBackup(settings: Settings, customizations: Record<string, CidCustomization>): Backup {
  return { app: BACKUP_APP, kind: 'settings', version: 2, exportedAt: new Date().toISOString(), settings, customizations };
}

export function backupFileName(at = Date.now()): string {
  return `vatsim-currency-settings_${new Date(at).toISOString().slice(0, 10)}.json`;
}

/** Accepts a backup (current or version 1, which only kept home picks), or a bare settings object. */
export function parseBackup(raw: unknown): Restored {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error("That file doesn't contain settings.");
  const r = raw as Partial<Backup> & { homeChoices?: unknown };
  if (r.app === BACKUP_APP && r.settings && typeof r.settings === 'object') {
    const customizations = normalizeCustomizations(r.customizations);
    // Version 1 backups stored home picks on their own.
    for (const [cid, code] of Object.entries(r.homeChoices && typeof r.homeChoices === 'object' ? r.homeChoices : {})) {
      if (/^\d{3,10}$/.test(cid) && typeof code === 'string' && code.trim()) {
        customizations[cid] ??= { facilities: [], requirements: {} };
        customizations[cid].home ??= code.trim().toUpperCase();
      }
    }
    return { settings: normalizeSettings(r.settings), customizations };
  }
  const looksLikeSettings = ['facilities', 'overrides', 'defaultRequirement', 'requirements', 'countedSuffixes'].some((k) => k in raw);
  if (!looksLikeSettings) throw new Error("That file doesn't contain settings.");
  return { settings: normalizeSettings(raw), customizations: null };
}

/** Read a backup from a .json file, or from the Settings sheet of an exported .xlsx report. */
export async function readBackupFile(file: File): Promise<Restored> {
  if (/\.xlsx$/i.test(file.name)) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets.Settings;
    if (!ws) throw new Error('That spreadsheet has no Settings sheet.');
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true });
    const row = rows.find((cells) => Array.isArray(cells) && cells[0] === BACKUP_CELL_LABEL);
    if (!row || typeof row[1] !== 'string' || !row[1].startsWith('{')) {
      throw new Error("That spreadsheet doesn't include a settings backup. Reports exported from this version do.");
    }
    return parseBackup(JSON.parse(row[1]));
  }
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  return parseBackup(json);
}

// ---------------------------------------------------------------------------
// Settings links: #settings=z<base64url(deflate-raw(json))>, or j<base64url(json)> without CompressionStream
// ---------------------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encodeSettingsLink(settings: Settings, baseUrl: string): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(settings));
  const payload =
    typeof CompressionStream === 'function' ? `z${toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))}` : `j${toBase64Url(json)}`;
  return `${baseUrl}#settings=${payload}`;
}

export async function decodeSettingsLink(payload: string): Promise<Settings | null> {
  try {
    const bytes = fromBase64Url(payload.slice(1));
    let json: Uint8Array;
    if (payload[0] === 'z') json = await pipe(bytes, new DecompressionStream('deflate-raw'));
    else if (payload[0] === 'j') json = bytes;
    else return null;
    return parseBackup(JSON.parse(new TextDecoder().decode(json))).settings;
  } catch {
    return null;
  }
}
