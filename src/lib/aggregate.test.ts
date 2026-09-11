import { describe, expect, it } from 'vitest';
import {
  buildReport,
  compileRules,
  describeResolution,
  groupFacility,
  parseCallsign,
  prefixCandidates,
  resolveFacility,
  ruleLabel,
  UNKNOWN,
} from './aggregate';
import { makeQuarter, overlapHours, quarterOf, shiftQuarter } from './quarters';
import { DEFAULT_SETTINGS, type FacilityDef, type Settings } from './settings';
import { parseVatspy } from './vatspy';
import type { Session } from './vatsimApi';

const DAT = `[Countries]
United States|K|Center
China|ZB|Control
China|ZS|Control
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

const fac = (code: string, patterns: string[] = [], name = '', includes: string[] = [], alwaysShow = false): FacilityDef => ({
  id: code,
  code,
  name,
  patterns,
  includes,
  alwaysShow,
});

function resolve(callsign: string, facilities: FacilityDef[] = []) {
  return resolveFacility(parseCallsign(callsign)!, vatspy, compileRules({ facilities }));
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

describe('VATSpy facility resolution', () => {
  it('parses the country list', () => {
    expect(vatspy.countries).toEqual({ 'United States': ['K'], China: ['ZB', 'ZS'] });
  });

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
    expect(resolve('EGLL_N__GND').facility).toBe('EGTT');
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
    expect(describeResolution(resolve('DUP_TWR'))).toBe('Airport code DUP (XXAA); also listed under BBBB');
  });

  it('returns UNKNOWN when nothing matches', () => {
    expect(resolve('ZZZZ_APP')).toMatchObject({ facility: UNKNOWN, source: 'unknown' });
  });
});

describe('user-defined facilities', () => {
  const facilities = [fac('ZDC', ['DC_*', 'PCT', 'IAD_*']), fac('IADTWR', ['IAD_*_TWR']), fac('FSS', ['*_FSS']), fac('OCEAN', ['ZZZZ_APP'])];

  it('matches wildcard, prefix and exact callsign patterns ahead of VATSpy', () => {
    expect(resolve('DC_32_CTR', facilities)).toMatchObject({ facility: 'ZDC', source: 'custom', detail: 'Pattern DC_*' });
    expect(resolve('PCT_APP', facilities)).toMatchObject({ facility: 'ZDC', detail: 'Pattern PCT' });
    expect(resolve('PCTX_APP', facilities).facility).toBe(UNKNOWN);
    expect(resolve('LON_FSS', facilities).facility).toBe('FSS');
    expect(resolve('ZZZZ_APP', facilities).facility).toBe('OCEAN');
    expect(resolve('ZZZZ_TWR', facilities).facility).toBe(UNKNOWN);
    expect(resolve('EGLL_TWR', facilities).facility).toBe('EGTT');
  });

  it('prefers the most specific pattern, then list order', () => {
    expect(resolve('IAD_N_TWR', facilities).facility).toBe('IADTWR');
    expect(resolve('IAD_APP', facilities).facility).toBe('ZDC');
    expect(resolve('EGLL_TWR', [fac('A', ['EGLL_*']), fac('B', ['EGLL_*'])]).facility).toBe('A');
  });

  it('folds included facility codes into a facility', () => {
    const groups = [fac('ZDC', [], '', ['KZDC']), fac('PRC', [], 'VATPRC', ['ZB*', 'ZS*'])];
    expect(resolve('IAD_TWR', groups)).toMatchObject({ facility: 'ZDC', groupedFrom: 'KZDC' });
    expect(describeResolution(resolve('IAD_TWR', groups))).toBe('Airport code IAD (KIAD) (part of ZDC)');
    expect(resolve('ZBAA_CTR', groups).facility).toBe('PRC');
    expect(resolve('ZBAA_TWR', groups).facility).toBe('PRC');
    expect(resolve('EGLL_TWR', groups).facility).toBe('EGTT');
    expect(groupFacility('KZDC', compileRules({ facilities: groups }))).toBe('ZDC');
    expect(groupFacility(UNKNOWN, compileRules({ facilities: [fac('X', [], '', ['UNK*'])] }))).toBe(UNKNOWN);
    // Includes also apply to callsign-pattern matches, and a facility never includes itself.
    expect(resolve('DC_CTR', [fac('A', ['DC_*'], '', ['A']), fac('B', [], '', ['A'])]).facility).toBe('B');
  });

  it('ships VATPRC as one facility by default', () => {
    const rules = compileRules(DEFAULT_SETTINGS);
    expect(groupFacility('ZBPE', rules)).toBe('PRC');
    expect(groupFacility('ZSHA', rules)).toBe('PRC');
    expect(groupFacility('ZMUB', rules)).toBe('ZMUB');
    expect(groupFacility('KZDC', rules)).toBe('KZDC');
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

  const settings: Settings = { ...DEFAULT_SETTINGS, requirements: { EGTT: 4 } };
  const ctx = { home: 'KZDC' };

  it('totals hours by facility and level, excluding non-controlling callsigns', () => {
    const r = buildReport(sessions, q3, vatspy, settings, ctx);
    expect(r.total).toBeCloseTo(2 + 1.5 + 1 + 3 + 2 + 0.5);
    const zdc = r.facilities.find((f) => f.code === 'KZDC')!;
    expect(zdc.hours).toBeCloseTo(6.5);
    expect(zdc.levels).toMatchObject({ 'GND/DEL/RMP': 2, 'APP/DEP': 1.5, 'CTR/FSS': 1, TWR: 2 });
    expect(zdc.meets).toBe(true);
    const egtt = r.facilities.find((f) => f.code === 'EGTT')!;
    expect(egtt).toMatchObject({ requirement: 4, meets: false });
    expect(egtt.shortBy).toBeCloseTo(1);
    expect(r.excluded.map((e) => e.callsign).sort()).toEqual(['DCA_ATIS', 'KDCA_OBS']);
  });

  it('sorts facilities by hours, not by home, with unknown last', () => {
    const r = buildReport(sessions, q3, vatspy, settings, { home: 'EGTT' });
    expect(r.facilities.map((f) => f.code)).toEqual(['KZDC', 'EGTT', UNKNOWN]);
    expect(r.facilities[1].isHome).toBe(true);
  });

  it('lists home, visiting, always-listed and required facilities even without hours', () => {
    const r = buildReport(
      sessions,
      q3,
      vatspy,
      { ...settings, facilities: [fac('ZOB', ['CLE_*'], 'Cleveland', [], true), fac('HIDDEN', ['XYZ_*'])], requirements: { EGTT: 4, KZLA: 2 } },
      { home: 'KZNY', visiting: ['KZTL'] },
    );
    expect(r.facilities.find((f) => f.code === 'ZOB')).toMatchObject({ hours: 0, name: 'Cleveland', tracked: true, meets: false, shortBy: 3 });
    expect(r.facilities.find((f) => f.code === 'KZNY')).toMatchObject({ hours: 0, isHome: true, tracked: true });
    expect(r.facilities.find((f) => f.code === 'KZTL')).toMatchObject({ hours: 0, isVisiting: true, tracked: true });
    expect(r.facilities.find((f) => f.code === 'KZLA')).toMatchObject({ hours: 0, requirement: 2, shortBy: 2 });
    expect(r.facilities.find((f) => f.code === 'HIDDEN')).toBeUndefined();
  });

  it('counts hours for user-defined facilities', () => {
    const r = buildReport(sessions, q3, vatspy, { ...settings, facilities: [fac('ZDC', ['DC*', 'PCT', 'IAD_*'])] }, { home: 'ZDC' });
    expect(r.facilities[0]).toMatchObject({ code: 'ZDC', isHome: true });
    expect(r.facilities[0].hours).toBeCloseTo(6.5);
    expect(r.facilities.find((f) => f.code === 'KZDC')).toBeUndefined();
  });

  it('applies the 50% + 1 rule', () => {
    const r = buildReport(sessions, q3, vatspy, settings, ctx);
    // 6.5 home of 10 total
    expect(r.home).toMatchObject({ facility: 'KZDC', meets: true });
    expect(r.home!.share).toBeCloseTo(0.65);
    expect(r.home!.headroomElsewhere).toBeCloseTo(3);
    expect(r.home!.neededAtHome).toBe(0);

    const away = buildReport(sessions, q3, vatspy, settings, { home: 'EGTT' });
    expect(away.home).toMatchObject({ meets: false });
    expect(away.home!.neededAtHome).toBeCloseTo(4); // 10 - 2*3
    expect(buildReport(sessions, q3, vatspy, settings).home).toBeNull();
  });

  it('exactly 50% does not meet the rule', () => {
    const even = [s('DCA_GND', q3.start + h(1), 2), s('EGLL_TWR', q3.start + h(5), 2)];
    expect(buildReport(even, q3, vatspy, settings, ctx).home!.meets).toBe(false);
  });

  it('lists the home facility even with no hours', () => {
    const r = buildReport([s('EGLL_TWR', q3.start + h(5), 2)], q3, vatspy, settings, ctx);
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

  it('tracks position rules separately and can leave them out of facility currency', () => {
    const r = buildReport(
      sessions,
      q3,
      vatspy,
      {
        ...settings,
        requirements: {},
        positionRules: [
          { id: 'ctr', name: 'Center', patterns: ['*_CTR'], hours: 2, countsTowardFacility: true },
          { id: 'dca', name: 'DCA ground', patterns: ['DCA_GND'], hours: null, countsTowardFacility: false },
        ],
      },
      ctx,
    );
    const [ctr, dca] = r.positionRules;
    expect(ctr).toMatchObject({ hours: 1, sessions: 1, callsigns: ['DC_32_CTR'], hasRequirement: true, meets: false });
    expect(ctr.shortBy).toBeCloseTo(1);
    expect(dca).toMatchObject({ hours: 2, hasRequirement: false, meets: true, shortBy: 0 });
    const zdc = r.facilities.find((f) => f.code === 'KZDC')!;
    expect(zdc.hours).toBeCloseTo(6.5); // still in totals
    expect(zdc.currencyHours).toBeCloseTo(4.5); // DCA_GND left out of facility currency
    expect(r.home!.homeHours).toBeCloseTo(6.5); // and still in the 50% + 1 rule
    expect(r.positions.find((p) => p.callsign === 'DCA_GND')).toMatchObject({ positionRules: ['DCA ground'], countsTowardFacility: false });
    expect(ruleLabel({ id: 'x', name: '', patterns: ['A_*', 'B_*'], hours: null, countsTowardFacility: true })).toBe('A_*, B_*');
  });

  it('checks facility currency against counted hours only', () => {
    const r = buildReport(
      sessions,
      q3,
      vatspy,
      { ...settings, requirements: { KZDC: 5 }, positionRules: [{ id: 'x', name: '', patterns: ['DCA_*'], hours: null, countsTowardFacility: false }] },
      ctx,
    );
    const zdc = r.facilities.find((f) => f.code === 'KZDC')!;
    expect(zdc.meets).toBe(false);
    expect(zdc.shortBy).toBeCloseTo(0.5);
  });

  it('respects disabled suffixes', () => {
    const r = buildReport(sessions, q3, vatspy, { ...settings, countedSuffixes: ['CTR', 'APP', 'TWR'] });
    expect(r.facilities.find((f) => f.code === 'KZDC')!.hours).toBeCloseTo(4.5);
    expect(r.excluded.find((e) => e.callsign === 'DCA_GND')?.reason).toMatch(/not counted/);
  });
});
