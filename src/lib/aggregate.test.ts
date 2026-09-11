import { describe, expect, it } from 'vitest';
import { buildReport, describeResolution, parseCallsign, prefixCandidates, resolveFacility, UNKNOWN } from './aggregate';
import { makeQuarter, overlapHours, quarterOf, shiftQuarter } from './quarters';
import { DEFAULT_SETTINGS, type OverrideRule, type Settings } from './settings';
import { parseVatspy } from './vatspy';
import type { Session } from './vatsimApi';

const DAT = `[Countries]
United States|K|Center
[Airports]
;ICAO|Airport Name|Latitude Decimal|Longitude Decimal|IATA/LID|FIR|IsPseudo
KDCA|Washington Reagan VA|38.85|-77.03|DCA|KZDC|0
KDCA|Potomac Combined|38.85|-77.03|PCT|KZDC|1
KDCA|Washington|38.85|-77.03|DC|KZDC|1
KIAD|Washington Dulles|38.94|-77.45|IAD|KZDC|0
KHEF|Manassas Regional|38.72|-77.51||KZDC|0
EGLL|London Heathrow|51.47|-0.46|LHR|EGTT|0
EGSS|Stansted & Luton|51.885|0.235|ESSEX|EGTT|1
ZBAA|Beijing Capital|40.07|116.59|PEK|ZBPE|0
XXAA|Dup A|0|0|DUP|AAAA|0
XXBB|Dup B|0|0|DUP|BBBB|0
[FIRs]
;ICAO|NAME|CALLSIGN PREFIX|FIR BOUNDARY
KZDC|Washington|DC|KZDC
KZDC|Washington|WAS|KZDC
EGTT|London|LON|EGTT
EGTT-S|London South|LON_S|EGTT-S
ZBAA|Beijing ACC||ZBAA
ZBPE|Beijing FIR||ZBPE
[UIRs]
EURM|Euro Middle|EDGG,EDMM
[IDL]
`;

const vatspy = parseVatspy(DAT, 0);

function resolve(callsign: string, overrides: OverrideRule[] = []) {
  return resolveFacility(parseCallsign(callsign)!, vatspy, overrides);
}

describe('callsign parsing', () => {
  it('splits prefix segments and suffix', () => {
    expect(parseCallsign('DC_32_CTR')).toEqual({ callsign: 'DC_32_CTR', segments: ['DC', '32'], suffix: 'CTR' });
    expect(parseCallsign('OBSERVER')).toBeNull();
  });
  it('lists candidate prefixes longest first, skipping empty segments', () => {
    expect(prefixCandidates(['LON', 'S'])).toEqual(['LON_S', 'LON']);
    expect(prefixCandidates(['LON', ''])).toEqual(['LON']);
  });
});

describe('facility resolution', () => {
  it('uses FIR callsign prefixes for enroute positions', () => {
    expect(resolve('DC_32_CTR')).toMatchObject({ facility: 'KZDC', source: 'fir' });
    expect(resolve('WAS_CTR').facility).toBe('KZDC');
    expect(resolve('LON_S_CTR').facility).toBe('EGTT-S');
    expect(resolve('LON_CTR').facility).toBe('EGTT');
    expect(resolve('ZBAA_CTR').facility).toBe('ZBAA');
    expect(resolve('EURM_CTR')).toMatchObject({ facility: 'EURM', detail: 'UIR EURM' });
  });

  it('uses airports for terminal positions', () => {
    expect(resolve('EGLL_N_TWR')).toMatchObject({ facility: 'EGTT', source: 'airport' });
    expect(resolve('ZBAA_TWR').facility).toBe('ZBPE');
    expect(resolve('DCA_GND')).toMatchObject({ facility: 'KZDC', source: 'lid' });
    expect(resolve('PCT_APP')).toMatchObject({ facility: 'KZDC', source: 'lid' });
    expect(resolve('ESSEX_APP').facility).toBe('EGTT');
  });

  it('guesses US airports that VATSpy only lists by ICAO', () => {
    expect(resolve('HEF_TWR')).toMatchObject({ facility: 'KZDC', source: 'inferred' });
  });

  it('flags ambiguous identifiers', () => {
    expect(resolve('DUP_TWR')).toMatchObject({ facility: 'AAAA', alternatives: ['BBBB'] });
  });

  it('returns UNKNOWN when nothing matches', () => {
    expect(resolve('ZZZZ_APP')).toMatchObject({ facility: UNKNOWN, source: 'unknown' });
  });

  it('applies prefix overrides (longest first) and facility merges', () => {
    const overrides: OverrideRule[] = [
      { id: '1', kind: 'prefix', match: 'ZZZZ', facility: 'KZNY' },
      { id: '2', kind: 'prefix', match: 'DCA', facility: 'KZNY' },
      { id: '3', kind: 'prefix', match: 'DCA_N', facility: 'KZOB' },
      { id: '4', kind: 'facility', match: 'KZDC', facility: 'ZDC' },
    ];
    expect(resolve('ZZZZ_APP', overrides)).toMatchObject({ facility: 'KZNY', source: 'override' });
    expect(resolve('DCA_GND', overrides).facility).toBe('KZNY');
    expect(resolve('DCA_N_GND', overrides).facility).toBe('KZOB');
    expect(resolve('IAD_TWR', overrides)).toMatchObject({ facility: 'ZDC', mergedFrom: 'KZDC' });
    expect(describeResolution(resolve('IAD_TWR', overrides))).toBe('Airport code IAD (KIAD) (merged into ZDC)');
    expect(describeResolution(resolve('DUP_TWR'))).toBe('Airport code DUP (XXAA); also listed under BBBB');
  });

  it('does not loop on circular merges', () => {
    const overrides: OverrideRule[] = [
      { id: '1', kind: 'facility', match: 'KZDC', facility: 'ZDC' },
      { id: '2', kind: 'facility', match: 'ZDC', facility: 'KZDC' },
    ];
    expect(resolve('IAD_TWR', overrides).facility).toBe('ZDC');
  });
});

describe('quarters', () => {
  it('normalises quarter arithmetic across years', () => {
    expect(makeQuarter(2026, 0).label).toBe('Q4 2025');
    expect(shiftQuarter(makeQuarter(2026, 1), -1).key).toBe('2025-Q4');
    expect(quarterOf(Date.UTC(2026, 8, 11)).label).toBe('Q3 2026');
  });
  it('uses UTC boundaries', () => {
    const q = makeQuarter(2026, 3);
    expect(new Date(q.start).toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(new Date(q.end).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
  it('computes overlap', () => {
    expect(overlapHours(0, 7_200_000, 3_600_000, 10_800_000)).toBe(1);
    expect(overlapHours(0, 1, 5, 10)).toBe(0);
  });
});

describe('buildReport', () => {
  const q3 = makeQuarter(2026, 3);
  const h = (n: number) => n * 3_600_000;
  let id = 1;
  const s = (callsign: string, start: number, hours: number): Session => ({ id: id++, callsign, start, end: start + h(hours) });

  const sessions: Session[] = [
    s('DCA_GND', q3.start + h(24), 2),
    s('PCT_APP', q3.start + h(48), 1.5),
    s('DC_32_CTR', q3.start + h(72), 1),
    s('EGLL_TWR', q3.start + h(96), 3),
    s('DCA_ATIS', q3.start + h(100), 5),
    s('KDCA_OBS', q3.start + h(100), 5),
    // Crosses into Q3: 1 h in Q2, 2 h in Q3
    s('IAD_TWR', q3.start - h(1), 3),
    s('ZZZZ_APP', q3.start + h(120), 0.5),
  ];

  const settings: Settings = { ...DEFAULT_SETTINGS, homeFacility: 'KZDC', requirements: { EGTT: 4 } };

  it('totals hours by facility and level, excluding non-controlling callsigns', () => {
    const r = buildReport(sessions, q3, vatspy, settings);
    expect(r.total).toBeCloseTo(2 + 1.5 + 1 + 3 + 2 + 0.5);
    const zdc = r.facilities.find((f) => f.code === 'KZDC')!;
    expect(zdc.hours).toBeCloseTo(6.5);
    expect(zdc.levels).toMatchObject({ 'GND/DEL/RMP': 2, 'APP/DEP': 1.5, 'CTR/FSS': 1, TWR: 2 });
    expect(zdc.meets).toBe(true);
    const egtt = r.facilities.find((f) => f.code === 'EGTT')!;
    expect(egtt).toMatchObject({ requirement: 4, meets: false });
    expect(egtt.shortBy).toBeCloseTo(1);
    expect(r.excluded.map((e) => e.callsign).sort()).toEqual(['DCA_ATIS', 'KDCA_OBS']);
    expect(r.facilities[0].code).toBe('KZDC'); // home first
    expect(r.facilities[r.facilities.length - 1].code).toBe(UNKNOWN); // unknown last
  });

  it('applies the 50% + 1 rule', () => {
    const r = buildReport(sessions, q3, vatspy, settings);
    // 6.5 home of 10 total
    expect(r.home).toMatchObject({ facility: 'KZDC', meets: true });
    expect(r.home!.share).toBeCloseTo(0.65);
    expect(r.home!.headroomElsewhere).toBeCloseTo(3);
    expect(r.home!.neededAtHome).toBe(0);

    const away = buildReport(sessions, q3, vatspy, { ...settings, homeFacility: 'EGTT' });
    expect(away.home).toMatchObject({ meets: false });
    expect(away.home!.neededAtHome).toBeCloseTo(4); // 10 - 2*3
  });

  it('exactly 50% does not meet the rule', () => {
    const even = [s('DCA_GND', q3.start + h(1), 2), s('EGLL_TWR', q3.start + h(5), 2)];
    expect(buildReport(even, q3, vatspy, settings).home!.meets).toBe(false);
  });

  it('lists the home facility even with no hours', () => {
    const r = buildReport([s('EGLL_TWR', q3.start + h(5), 2)], q3, vatspy, settings);
    expect(r.facilities.find((f) => f.code === 'KZDC')).toMatchObject({ hours: 0, meets: false, isHome: true });
  });

  it('supports both quarter-boundary modes', () => {
    const crossing = [s('IAD_TWR', q3.start - h(1), 3)];
    const q2 = shiftQuarter(q3, -1);
    expect(buildReport(crossing, q3, vatspy, settings).total).toBeCloseTo(2);
    expect(buildReport(crossing, q2, vatspy, settings).total).toBeCloseTo(1);
    const startMode = { ...settings, boundaryMode: 'start' as const };
    expect(buildReport(crossing, q3, vatspy, startMode).total).toBe(0);
    expect(buildReport(crossing, q2, vatspy, startMode).total).toBeCloseTo(3);
  });

  it('respects disabled suffixes', () => {
    const r = buildReport(sessions, q3, vatspy, { ...settings, countedSuffixes: ['CTR', 'APP', 'TWR'] });
    expect(r.facilities.find((f) => f.code === 'KZDC')!.hours).toBeCloseTo(4.5);
    expect(r.excluded.find((e) => e.callsign === 'DCA_GND')?.reason).toMatch(/not counted/);
  });
});
