import { describe, expect, it } from 'vitest';
import { decodeSettingsLink, encodeSettingsLink, makeBackup, parseBackup } from './backup';
import { DEFAULT_SETTINGS, type Settings } from './settings';

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  defaultRequirement: 5,
  requirements: { KZDC: 4 },
  positionRules: [{ id: 'r', name: 'Center', patterns: ['DC_*_CTR'], hours: 2, countsTowardFacility: false }],
};

describe('settings backup', () => {
  it('round-trips a backup file with home picks', () => {
    const restored = parseBackup(JSON.parse(JSON.stringify(makeBackup(settings, { '1340265': 'kzdc', nope: 'X' }))));
    expect(restored.settings).toEqual(settings);
    expect(restored.homeChoices).toEqual({ '1340265': 'KZDC' });
  });

  it('accepts a bare settings object from older exports', () => {
    const r = parseBackup({ version: 1, overrides: [{ kind: 'prefix', match: 'PCT', facility: 'KZDC' }] });
    expect(r.homeChoices).toBeNull();
    expect(r.settings.facilities.find((f) => f.code === 'KZDC')?.patterns).toEqual(['PCT_*']);
  });

  it('rejects files that are not settings', () => {
    expect(() => parseBackup({ items: [], count: 0 })).toThrow();
    expect(() => parseBackup([1, 2])).toThrow();
    expect(() => parseBackup('text')).toThrow();
  });

  it('encodes settings into a link and back', async () => {
    const url = await encodeSettingsLink(settings, 'https://example.test/app/');
    expect(url.startsWith('https://example.test/app/#settings=z')).toBe(true);
    expect(await decodeSettingsLink(url.split('#settings=')[1])).toEqual(settings);
    expect(await decodeSettingsLink('zgarbage')).toBeNull();
    expect(await decodeSettingsLink('')).toBeNull();
  });
});
