import { LEVELS, describeResolution, type QuarterReport } from './aggregate';
import type { Settings } from './settings';
import type { SessionSet } from './vatsimApi';
import type { VatspyData } from './vatspy';

type Cell = string | number | boolean | null | { t: 'n'; v: number; z: string };

const HOURS = '0.00';
const PCT = '0.0%';
const DATETIME = 'yyyy-mm-dd hh:mm:ss';

/** Excel serial date for a UTC instant (so spreadsheets show UTC, regardless of the viewer's timezone). */
const xlDate = (ms: number): Cell => ({ t: 'n', v: ms / 86_400_000 + 25_569, z: DATETIME });
// 6 decimals: trims float noise without changing how 0.0% / 0.00 formats round.
const num = (v: number, z = HOURS): Cell => ({ t: 'n', v: Math.round(v * 1e6) / 1e6, z });
const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');

const SOURCE_LABEL = { proxy: 'VATSIM API via proxy', direct: 'VATSIM API (direct)', manual: 'Manual import from VATSIM API' };

export interface ExportInput {
  cid: string;
  data: SessionSet;
  reports: QuarterReport[];
  settings: Settings;
  vatspy: VatspyData | null;
  calculatedAt: number;
}

export function exportFileName(cid: string, at: number): string {
  const d = new Date(at).toISOString();
  return `vatsim-atc-currency_${cid}_${d.slice(0, 10)}_${d.slice(11, 13)}${d.slice(14, 16)}Z.xlsx`;
}

export async function exportWorkbook(input: ExportInput): Promise<void> {
  const XLSX = await import('xlsx');
  const { cid, data, reports, settings, vatspy, calculatedAt } = input;
  const exportedAt = Date.now();
  const wb = XLSX.utils.book_new();

  const sheet = (name: string, rows: Cell[][], widths: number[], headerRow?: number) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = widths.map((wch) => ({ wch }));
    if (headerRow != null && rows.length > headerRow + 1) {
      const lastCol = XLSX.utils.encode_col(rows[headerRow].length - 1);
      ws['!autofilter'] = { ref: `A${headerRow + 1}:${lastCol}${rows.length}` };
    }
    XLSX.utils.book_append_sheet(wb, ws, name);
  };

  // Summary
  const summary: Cell[][] = [
    ['VATSIM ATC currency report'],
    [],
    ['CID', cid],
    ['Data queried at (UTC)', xlDate(data.fetchedAt)],
    ['Calculated at (UTC)', xlDate(calculatedAt)],
    ['Exported at (UTC)', xlDate(exportedAt)],
    ['Data source', SOURCE_LABEL[data.source]],
    ['Sessions loaded', data.sessions.length],
    ['Complete back to (UTC)', data.coveredSince ? xlDate(data.coveredSince) : 'Full history'],
    ['VATSpy data loaded at (UTC)', vatspy ? xlDate(vatspy.fetchedAt) : 'Not loaded'],
    ['Home facility', settings.homeFacility || '(not set)'],
    ['Default requirement (h / quarter)', num(settings.defaultRequirement)],
    ['Quarter boundaries', settings.boundaryMode === 'split' ? 'Sessions split at the boundary' : 'Whole session counted in the quarter it started'],
    ['Counted suffixes', settings.countedSuffixes.join(', ')],
    [],
    ['Quarter', 'Start (UTC)', 'End (UTC)', 'Counted hours', 'Sessions', ...LEVELS, 'Home hours', 'Home share', 'Home > 50%', 'Facilities meeting requirement'],
  ];
  for (const r of reports) {
    summary.push([
      r.quarter.label,
      xlDate(r.quarter.start),
      xlDate(r.quarter.end),
      num(r.total),
      r.sessionCount,
      ...LEVELS.map((l) => num(r.levels[l])),
      r.home ? num(r.home.homeHours) : '',
      r.home ? num(r.home.share, PCT) : '',
      r.home ? (r.home.meets == null ? 'No activity' : r.home.meets ? 'Yes' : 'No') : '',
      `${r.facilities.filter((f) => f.meets && f.hours > 0).length} of ${r.facilities.filter((f) => f.hours > 0).length}`,
    ]);
  }
  sheet('Summary', summary, [32, 20, 20, 14, 10, 10, 10, 10, 13, 10, 12, 12, 12, 28]);

  // Facilities
  const facRows: Cell[][] = [
    ['Quarter', 'Facility', 'Name', 'Hours', ...LEVELS, 'Sessions', 'Share of total', 'Requirement (h)', 'Meets requirement', 'Short by (h)', 'Home'],
  ];
  for (const r of reports) {
    for (const f of r.facilities) {
      facRows.push([
        r.quarter.label,
        f.code,
        f.name,
        num(f.hours),
        ...LEVELS.map((l) => num(f.levels[l])),
        f.sessions,
        num(f.share, PCT),
        num(f.requirement),
        f.meets ? 'Yes' : 'No',
        num(f.shortBy),
        f.isHome ? 'Yes' : '',
      ]);
    }
  }
  sheet('Facilities', facRows, [10, 10, 28, 9, 9, 9, 9, 12, 9, 9, 13, 15, 17, 12, 7], 0);

  // Positions
  const posRows: Cell[][] = [['Quarter', 'Callsign', 'Facility', 'Level', 'Suffix', 'Sessions', 'Hours', 'Matched by']];
  for (const r of reports) {
    for (const p of r.positions) {
      posRows.push([
        r.quarter.label,
        p.callsign,
        p.facility,
        p.level,
        p.suffix,
        p.sessions,
        num(p.hours),
        describeResolution(p.resolution),
      ]);
    }
  }
  sheet('Positions', posRows, [10, 16, 10, 13, 8, 9, 9, 40], 0);

  // Sessions — raw, one row per session per quarter, for pivots.
  const sesRows: Cell[][] = [
    ['Quarter', 'Session ID', 'Callsign', 'Suffix', 'Level', 'Facility', 'Matched by', 'Start (UTC)', 'End (UTC)', 'Duration (h)', 'Hours in quarter', 'Counted', 'Not counted because', 'Rating', 'Server'],
  ];
  for (const r of reports) {
    for (const d of r.details) {
      const s = d.session;
      sesRows.push([
        r.quarter.label,
        s.id,
        s.callsign,
        d.suffix,
        d.level ?? '',
        d.resolution?.facility ?? '',
        d.resolution ? describeResolution(d.resolution) : '',
        xlDate(s.start),
        xlDate(s.end),
        num((s.end - s.start) / 3_600_000),
        num(d.hours),
        d.counted ? 'Yes' : 'No',
        d.excludedReason ?? '',
        s.rating ?? '',
        s.server ?? '',
      ]);
    }
  }
  sheet('Sessions', sesRows, [10, 12, 16, 8, 13, 10, 34, 20, 20, 12, 15, 9, 26, 7, 12], 0);

  // Settings snapshot, so a spreadsheet can be understood later.
  const setRows: Cell[][] = [['Override type', 'Match', 'Facility']];
  for (const o of settings.overrides) setRows.push([o.kind === 'prefix' ? 'Callsign prefix' : 'Facility merge', o.match, o.facility]);
  setRows.push([], ['Facility', 'Requirement (h / quarter)']);
  for (const [code, h] of Object.entries(settings.requirements)) setRows.push([code, num(h)]);
  setRows.push([], ['Report generated', iso(exportedAt)]);
  sheet('Settings', setRows, [18, 26, 12]);

  XLSX.writeFile(wb, exportFileName(cid, calculatedAt), { compression: true });
}
