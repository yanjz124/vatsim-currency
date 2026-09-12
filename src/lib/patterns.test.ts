import { describe, expect, it } from 'vitest';
import { compileCodePattern, compilePattern, isValidFacilityCode, parsePatternList } from './patterns';
import {
  DEFAULT_SETTINGS,
  addFacility,
  applyCustomization,
  assignInclude,
  assignPattern,
  describeCustomization,
  emptyCustomization,
  isEmptyCustomization,
  normalizeCustomizations,
  normalizeSettings,
  updateFacility,
  type Settings,
} from './settings';

describe('patterns', () => {
  it('parses comma, space or semicolon separated lists and rejects bad tokens', () => {
    expect(parsePatternList(' dc_*, PCT  iad_*_twr; bad-one * PCT')).toEqual({
      patterns: ['DC_*', 'PCT', 'IAD_*_TWR'],
      invalid: ['BAD-ONE', '*'],
    });
    expect(parsePatternList('egtt-s, zb*', 'code')).toEqual({ patterns: ['EGTT-S', 'ZB*'], invalid: [] });
  });

  it('treats a callsign pattern without * as a prefix or exact callsign', () => {
    const { re } = compilePattern('PCT');
    expect(['PCT_APP', 'PCT_N_DEP'].every((c) => re.test(c))).toBe(true);
    expect(re.test('PCTX_APP')).toBe(false);
    expect(compilePattern('DCA_GND').re.test('DCA_GND')).toBe(true);
    expect(compilePattern('DCA_GND').re.test('DCA_TWR')).toBe(false);
  });

  it('lets * match any run of characters', () => {
    const { re, specificity } = compilePattern('IAD_*_TWR');
    expect(re.test('IAD_N_TWR')).toBe(true);
    expect(re.test('IAD_TWR')).toBe(false);
    expect(specificity).toBe(8);
    expect(compilePattern('*_CTR').re.test('DC_32_CTR')).toBe(true);
    expect(compilePattern('DC*').re.test('DCA_GND')).toBe(true);
  });

  it('matches facility codes exactly unless * is used', () => {
    expect(compileCodePattern('ZB*').re.test('ZBPE')).toBe(true);
    expect(compileCodePattern('EGTT').re.test('EGTT-S')).toBe(false);
    expect(compileCodePattern('EGTT*').re.test('EGTT-S')).toBe(true);
  });
});

describe('settings', () => {
  it('migrates version 1 prefix overrides and merges, keeping the built-in facilities', () => {
    const s = normalizeSettings({
      version: 1,
      homeFacility: 'KZDC',
      overrides: [
        { id: 'a', kind: 'prefix', match: 'pct', facility: 'kzdc' },
        { id: 'b', kind: 'prefix', match: 'DCA', facility: 'KZDC' },
        { id: 'c', kind: 'facility', match: 'EGPX', facility: 'EGTT' },
      ],
    });
    expect(s.version).toBe(2);
    expect(s.facilities.map((f) => f.code)).toEqual(['PRC', 'KZDC', 'EGTT']);
    expect(s.facilities[1]).toMatchObject({ patterns: ['PCT_*', 'DCA_*'], includes: [] });
    expect(s.facilities[2]).toMatchObject({ patterns: [], includes: ['EGPX'] });
    expect(s.positionRules).toEqual([]);
    expect('homeFacility' in s).toBe(false);
  });

  it('drops invalid patterns, self-includes and duplicate facility codes', () => {
    const s = normalizeSettings({
      facilities: [
        { code: 'zdc', patterns: ['dc_*', 'bad pattern', 'DC_*'], includes: ['kzdc', 'ZDC', 'bad code!'] },
        { code: 'ZDC', patterns: ['X_*'] },
      ],
    });
    expect(s.facilities).toHaveLength(1);
    expect(s.facilities[0]).toMatchObject({ code: 'ZDC', name: '', patterns: ['DC_*'], includes: ['KZDC'], alwaysShow: false });
  });

  it('cleans position rules', () => {
    const s = normalizeSettings({
      facilities: [],
      positionRules: [
        { name: ' Center ', patterns: ['dc_*_ctr', 'bad!'], hours: 2 },
        { name: 'Training', patterns: ['*_I_*'], hours: -1, countsTowardFacility: false },
        { name: '', patterns: [] },
      ],
    });
    expect(s.positionRules).toMatchObject([
      { name: 'Center', patterns: ['DC_*_CTR'], hours: 2, countsTowardFacility: true },
      { name: 'Training', patterns: ['*_I_*'], hours: null, countsTowardFacility: false },
    ]);
  });

  it('moves a callsign pattern between facilities', () => {
    const start: Settings = {
      ...DEFAULT_SETTINGS,
      facilities: [{ id: '1', code: 'A', name: '', patterns: ['DC_*', 'PCT'], includes: [], alwaysShow: false }],
    };
    const next = assignPattern(start, 'DC_*', 'B');
    expect(next.facilities.map((f) => [f.code, f.patterns])).toEqual([
      ['A', ['PCT']],
      ['B', ['DC_*']],
    ]);
    expect(start.facilities[0].patterns).toEqual(['DC_*', 'PCT']); // not mutated
  });

  it('accepts VATSpy and custom facility codes', () => {
    expect(['KZDC', 'EGTT-S', 'VATPRC', 'VATSSA', 'ZDC_TRACON'].every(isValidFacilityCode)).toBe(true);
    expect(['', 'VAT SSA', '-X', 'ZB*', 'A'.repeat(25)].some(isValidFacilityCode)).toBe(false);
  });

  it('creates a named custom facility when reassigning to a new code', () => {
    const next = assignPattern(DEFAULT_SETTINGS, 'JNB_*', 'VATSSA', 'VATSSA (Southern Africa)');
    expect(next.facilities.find((f) => f.code === 'VATSSA')).toMatchObject({ name: 'VATSSA (Southern Africa)', patterns: ['JNB_*'] });
    // Naming an existing facility doesn't overwrite its name.
    expect(assignPattern(next, 'CPT_*', 'VATSSA', 'Other').facilities.find((f) => f.code === 'VATSSA')?.name).toBe('VATSSA (Southern Africa)');
  });

  it('moves a whole facility code between facilities', () => {
    let s = assignInclude(DEFAULT_SETTINGS, 'ZGGG', 'SOUTH');
    expect(s.facilities.find((f) => f.code === 'SOUTH')?.includes).toEqual(['ZGGG']);
    s = assignInclude(s, 'ZGGG', 'PRC');
    expect(s.facilities.find((f) => f.code === 'SOUTH')?.includes).toEqual([]);
    expect(s.facilities.find((f) => f.code === 'PRC')?.includes).toContain('ZGGG');
    expect(assignInclude(s, 'PRC', 'PRC')).toBe(s);
  });

  it('adds a listed facility, merging into an existing one and taking over its patterns', () => {
    let s = assignPattern(DEFAULT_SETTINGS, 'NY_*', 'OLD');
    s = addFacility(s, { code: 'KZNY', name: '', patterns: ['NY_*', 'JFK_*'], includes: ['KZNY-W'], alwaysShow: true });
    expect(s.facilities.find((f) => f.code === 'KZNY')).toMatchObject({ patterns: ['NY_*', 'JFK_*'], includes: ['KZNY-W'], alwaysShow: true });
    expect(s.facilities.find((f) => f.code === 'OLD')?.patterns).toEqual([]);
    s = addFacility(s, { code: 'KZNY', name: 'New York', patterns: ['EWR_*'], includes: [], alwaysShow: false });
    expect(s.facilities.filter((f) => f.code === 'KZNY')).toHaveLength(1);
    expect(s.facilities.find((f) => f.code === 'KZNY')).toMatchObject({ name: 'New York', patterns: ['NY_*', 'JFK_*', 'EWR_*'], alwaysShow: true });
  });

  it('keeps report changes per CID and layers them over shared settings', () => {
    const shared: Settings = {
      ...DEFAULT_SETTINGS,
      requirements: { KZDC: 5 },
      facilities: [...DEFAULT_SETTINGS.facilities, { id: 'z', code: 'ZDC', name: '', patterns: ['DC_*', 'PCT_*'], includes: [], alwaysShow: false }],
    };
    let custom = emptyCustomization();
    expect(isEmptyCustomization(custom)).toBe(true);
    custom = addFacility(custom, { code: 'KZNY', name: '', patterns: [], includes: [], alwaysShow: true });
    custom = assignPattern(custom, 'PCT_*', 'POTOMAC');
    custom = { ...custom, requirements: { KZDC: 2 }, home: 'ZDC' };
    expect(describeCustomization(custom)).toBe('home ZDC; facilities KZNY, POTOMAC; requirements KZDC 2 h');

    const applied = applyCustomization(shared, custom);
    expect(applied.requirements).toEqual({ KZDC: 2 });
    expect(applied.facilities.find((f) => f.code === 'KZNY')).toMatchObject({ alwaysShow: true });
    expect(applied.facilities.find((f) => f.code === 'ZDC')?.patterns).toEqual(['DC_*']); // PCT_* moved for this CID
    expect(applied.facilities.find((f) => f.code === 'POTOMAC')?.patterns).toEqual(['PCT_*']);
    // Shared settings are untouched, so another CID doesn't see any of it.
    expect(shared.facilities.find((f) => f.code === 'ZDC')?.patterns).toEqual(['DC_*', 'PCT_*']);
    expect(applyCustomization(shared, undefined)).toBe(shared);
  });

  it('cleans stored per-CID changes', () => {
    const raw = {
      '1340265': { home: ' kzdc ', facilities: [{ code: 'kzny', alwaysShow: true, patterns: ['ny_*', 'bad one'] }], requirements: { kztl: 2, x: -1 } },
      '1575101': { facilities: [], requirements: {} },
      notacid: { home: 'X' },
    };
    expect(normalizeCustomizations(raw)).toEqual({
      '1340265': {
        home: 'KZDC',
        facilities: [{ id: expect.any(String), code: 'KZNY', name: '', patterns: ['NY_*'], includes: [], alwaysShow: true }],
        requirements: { KZTL: 2 },
      },
    });
    expect(normalizeCustomizations(null)).toEqual({});
  });

  it('carries a requirement over when a facility is renamed', () => {
    const s: Settings = {
      ...DEFAULT_SETTINGS,
      requirements: { ZDC: 5 },
      facilities: [{ id: '1', code: 'ZDC', name: '', patterns: [], includes: [], alwaysShow: false }],
    };
    const next = updateFacility(s, { ...s.facilities[0], code: 'KZDC' });
    expect(next.requirements).toEqual({ KZDC: 5 });
  });
});
