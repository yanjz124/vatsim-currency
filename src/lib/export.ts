import { LEVELS, UNKNOWN, describeResolution, ruleLabel, type QuarterReport } from './aggregate';
import { BACKUP_CELL_LABEL, makeBackup } from './backup';
import { HOME_SOURCE_TEXT, type HomeFacility, type MemberInfo } from './member';
import type { Settings } from './settings';
import type { SessionSet } from './vatsimApi';
import type { VatspyData } from './vatspy';

type Cell = string | number | boolean | null | { t: 'n'; v: number; z: string };

const HOURS = '0.00';
const PCT = '0.0%';
const DATETIME = 'yyyy-mm-dd hh:mm:ss';
const EXCEL_CELL_LIMIT = 32_767;

/** Excel serial date for a UTC instant (so spreadsheets show UTC, regardless of the viewer's timezone). */
const xlDate = (ms: number): Cell => ({ t: 'n', v: ms / 86_400_000 + 25_569, z: DATETIME });
// 6 decimals: trims float noise without changing how 0.0% / 0.00 formats round.
const num = (v: number, z = HOURS): Cell => ({ t: 'n', v: Math.round(v * 1e6) / 1e6, z });
const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
const yesNo = (b: boolean) => (b ? 'Yes' : 'No');

const SOURCE_LABEL = { proxy: 'VATSIM API via proxy', direct: 'VATSIM API (direct)', manual: 'Manual import from VATSIM API' };

export interface ExportInput {
  cid: string;
  data: SessionSet;
  reports: QuarterReport[];
  settings: Settings;
  homeChoices: Record<string, string>;
  vatspy: VatspyData | null;
  member: MemberInfo | null;
  home: HomeFacility | null;
  calculatedAt: number;
}

export function exportFileName(cid: string, at: number): string {
  const d = new Date(at).toISOString();
  return `vatsim-atc-currency_${cid}_${d.slice(0, 10)}_${d.slice(11, 13)}${d.slice(14, 16)}Z.xlsx`;
}

export async function exportWorkbook(input: ExportInput): Promise<void> {
  const XLSX = await import('xlsx');
  const { cid, data, reports, settings, homeChoices, vatspy, member, home, calculatedAt } = input;
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
    ['VATSIM division', member?.vatsim?.division ?? 'Unknown'],
    ['VATSIM subdivision', member?.vatsim ? (member.vatsim.subdivision ?? 'None') : 'Unknown'],
    ['VATUSA home facility', member?.vatusa?.facility ?? 'Not a VATUSA member, or not checked'],
    ['VATUSA visiting facilities', member?.vatusa?.visiting.join(', ') || 'None listed'],
    ['Home facility used', home?.code ?? '(none)'],
    ['Home facility taken from', home ? HOME_SOURCE_TEXT[home.source] : ''],
    ['Default requirement (h / quarter)', num(settings.defaultRequirement)],
    ['Quarter boundaries', settings.boundaryMode === 'split' ? 'Sessions split at the boundary' : 'Whole session counted in the quarter it started'],
    ['Counted suffixes', settings.countedSuffixes.join(', ')],
    [],
    [
      'Quarter',
      'Start (UTC)',
      'End (UTC)',
      'Counted hours',
      'Sessions',
      ...LEVELS,
      'Home hours',
      'Home share',
      'Home > 50%',
      'Facilities meeting requirement',
      'Position requirements met',
    ],
  ];
  for (const r of reports) {
    const listed = r.facilities.filter((f) => f.code !== UNKNOWN && (f.hours > 0 || f.tracked));
    const required = r.positionRules.filter((p) => p.hasRequirement);
    summary.push([
      r.quarter.label,
      xlDate(r.quarter.start),
      xlDate(r.quarter.end),
      num(r.total),
      r.sessionCount,
      ...LEVELS.map((l) => num(r.levels[l])),
      r.home ? num(r.home.homeHours) : '',
      r.home ? num(r.home.share, PCT) : '',
      r.home ? (r.home.meets == null ? 'No activity' : yesNo(r.home.meets)) : '',
      `${listed.filter((f) => f.meets).length} of ${listed.length}`,
      required.length ? `${required.filter((p) => p.meets).length} of ${required.length}` : '',
    ]);
  }
  sheet('Summary', summary, [32, 20, 20, 14, 10, 10, 10, 10, 13, 10, 12, 12, 12, 28, 24]);

  // Facilities
  const facRows: Cell[][] = [
    [
      'Quarter',
      'Facility',
      'Name',
      'Hours',
      'Currency hours',
      ...LEVELS,
      'Sessions',
      'Share of total',
      'Requirement (h)',
      'Meets requirement',
      'Short by (h)',
      'Home',
      'Visiting (VATUSA)',
    ],
  ];
  for (const r of reports) {
    for (const f of r.facilities) {
      facRows.push([
        r.quarter.label,
        f.code,
        f.name,
        num(f.hours),
        num(f.currencyHours),
        ...LEVELS.map((l) => num(f.levels[l])),
        f.sessions,
        num(f.share, PCT),
        num(f.requirement),
        yesNo(f.meets),
        num(f.shortBy),
        f.isHome ? 'Yes' : '',
        f.isVisiting ? 'Yes' : '',
      ]);
    }
  }
  sheet('Facilities', facRows, [10, 10, 28, 9, 14, 9, 9, 9, 12, 9, 9, 13, 15, 17, 12, 7, 17], 0);

  // Positions
  const posRows: Cell[][] = [
    ['Quarter', 'Callsign', 'Facility', 'Level', 'Suffix', 'Sessions', 'Hours', 'Matched by', 'Position rules', 'Counts toward facility currency'],
  ];
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
        p.positionRules.join(', '),
        yesNo(p.countsTowardFacility),
      ]);
    }
  }
  sheet('Positions', posRows, [10, 16, 10, 13, 8, 9, 9, 40, 24, 16], 0);

  // Position requirements
  if (settings.positionRules.length) {
    const ruleRows: Cell[][] = [
      ['Quarter', 'Rule', 'Callsign patterns', 'Sessions', 'Hours', 'Required (h)', 'Meets requirement', 'Short by (h)', 'Counts toward facility currency', 'Callsigns'],
    ];
    for (const r of reports) {
      for (const p of r.positionRules) {
        ruleRows.push([
          r.quarter.label,
          ruleLabel(p.rule),
          p.rule.patterns.join(', '),
          p.sessions,
          num(p.hours),
          p.hasRequirement ? num(p.rule.hours!) : '',
          p.hasRequirement ? yesNo(p.meets) : '',
          p.hasRequirement ? num(p.shortBy) : '',
          yesNo(p.rule.countsTowardFacility),
          p.callsigns.join(', '),
        ]);
      }
    }
    sheet('Position requirements', ruleRows, [10, 22, 24, 9, 9, 12, 17, 12, 16, 40], 0);
  }

  // Sessions — raw, one row per session per quarter, for pivots.
  const sesRows: Cell[][] = [
    [
      'Quarter',
      'Session ID',
      'Callsign',
      'Suffix',
      'Level',
      'Facility',
      'Matched by',
      'Start (UTC)',
      'End (UTC)',
      'Duration (h)',
      'Hours in quarter',
      'Counted',
      'Not counted because',
      'Counts toward facility currency',
      'Position rules',
      'Rating',
      'Server',
    ],
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
        yesNo(d.counted),
        d.excludedReason ?? '',
        d.counted ? yesNo(d.countsTowardFacility) : '',
        d.positionRules.join(', '),
        s.rating ?? '',
        s.server ?? '',
      ]);
    }
  }
  sheet('Sessions', sesRows, [10, 12, 16, 8, 13, 10, 34, 20, 20, 12, 15, 9, 26, 16, 20, 7, 12], 0);

  // Settings snapshot, readable and restorable (Settings → Import settings accepts this file).
  const setRows: Cell[][] = [['Facility', 'Name', 'Callsign patterns', 'Includes', 'Always listed']];
  for (const f of settings.facilities) setRows.push([f.code, f.name, f.patterns.join(', '), f.includes.join(', '), yesNo(f.alwaysShow)]);
  setRows.push([], ['Position rule', 'Callsign patterns', 'Required (h)', 'Counts toward facility currency']);
  for (const p of settings.positionRules) {
    setRows.push([ruleLabel(p), p.patterns.join(', '), p.hours == null ? '' : num(p.hours), yesNo(p.countsTowardFacility)]);
  }
  setRows.push([], ['Facility', 'Requirement (h / quarter)']);
  for (const [code, h] of Object.entries(settings.requirements)) setRows.push([code, num(h)]);
  const backup = JSON.stringify(makeBackup(settings, homeChoices));
  setRows.push(
    [],
    ['Report generated', iso(exportedAt)],
    [BACKUP_CELL_LABEL, backup.length <= EXCEL_CELL_LIMIT ? backup : 'Too large to embed. Use Settings → Export settings instead.'],
    ['', 'To restore these settings, open Settings → Import settings and choose this spreadsheet.'],
  );
  sheet('Settings', setRows, [26, 30, 36, 40, 14]);

  XLSX.writeFile(wb, exportFileName(cid, calculatedAt), { compression: true });
}
