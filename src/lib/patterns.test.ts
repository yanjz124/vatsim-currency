import { describe, expect, it } from 'vitest';
import { compileCodePattern, compilePattern, parsePatternList } from './patterns';
import { DEFAULT_SETTINGS, assignPattern, normalizeSettings, updateFacility, type Settings } from './settings';

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
