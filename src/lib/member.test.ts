import { describe, expect, it } from 'vitest';
import { memberFacilities, parseVatsimMember, parseVatusaUser, vatusaToVatspy, type MemberInfo } from './member';
import { DEFAULT_SETTINGS } from './settings';
import { parseVatspy } from './vatspy';

const vatspy = parseVatspy(
  `[FIRs]
KZDC|Washington||KZDC
KZTL|Atlanta||KZTL
KZME|Memphis||KZME
PAZA|Anchorage||PAZA
PHZH|Honolulu||PHZH
ZSHA|Shanghai||ZSHA
`,
  0,
);

const member = (vatsim: MemberInfo['vatsim'], vatusa: MemberInfo['vatusa'] = null): MemberInfo => ({
  cid: '1',
  fetchedAt: 0,
  vatsim,
  vatusa,
});

describe('VATSIM and VATUSA responses', () => {
  it('reads division and subdivision from the VATSIM member endpoint', () => {
    const json = { id: 1435638, rating: 4, region_id: 'APAC', division_id: 'PRC', subdivision_id: null };
    expect(parseVatsimMember(json)).toEqual({ region: 'APAC', division: 'PRC', subdivision: null, rating: 4 });
    expect(parseVatsimMember({ detail: 'Not found.' })).toBeNull();
  });

  it('reads home and visiting facilities from the VATUSA user endpoint', () => {
    const json = {
      data: {
        cid: 1340265,
        facility: 'ZDC',
        visiting_facilities: [{ facility: 'ZME' }, { facility: 'ZOB' }, { facility: 'ZTL' }, { facility: 'ZME' }],
      },
    };
    expect(parseVatusaUser(json)).toEqual({ facility: 'ZDC', visiting: ['ZME', 'ZOB', 'ZTL'] });
    expect(parseVatusaUser({ data: { status: 'error', msg: 'Not found' } })).toBeNull();
  });

  it('maps VATUSA facilities to VATSpy FIRs', () => {
    expect(vatusaToVatspy('ZDC', vatspy)).toBe('KZDC');
    expect(vatusaToVatspy('HCF', vatspy)).toBe('PHZH');
    expect(vatusaToVatspy('ZAN', vatspy)).toBe('PAZA');
    expect(vatusaToVatspy('ZZN', vatspy)).toBeNull();
    expect(vatusaToVatspy('ZDC', null)).toBeNull();
  });
});

describe('memberFacilities', () => {
  it('uses the VATUSA home facility and visiting roster', () => {
    const info = member({ region: 'AMAS', division: 'USA', subdivision: null, rating: 11 }, { facility: 'ZDC', visiting: ['ZME', 'ZOB', 'ZTL'] });
    expect(memberFacilities(info, vatspy, DEFAULT_SETTINGS)).toEqual({
      home: { code: 'KZDC', source: 'vatusa' },
      visiting: ['KZME', 'KZTL'], // ZOB isn't in this VATSpy fixture
    });
  });

  it('follows facility includes, so ZDC can stand for KZDC', () => {
    const settings = { facilities: [{ id: 'z', code: 'ZDC', name: '', patterns: [], includes: ['KZDC'], alwaysShow: false }] };
    const info = member(null, { facility: 'ZDC', visiting: [] });
    expect(memberFacilities(info, vatspy, settings).home).toEqual({ code: 'ZDC', source: 'vatusa' });
  });

  it('uses a defined subdivision, then division', () => {
    const settings = {
      facilities: [
        ...DEFAULT_SETTINGS.facilities,
        { id: 'g', code: 'GER', name: 'VATGER', patterns: [], includes: ['ED*'], alwaysShow: false },
      ],
    };
    expect(memberFacilities(member({ region: 'APAC', division: 'PRC', subdivision: null, rating: 4 }), vatspy, settings).home).toEqual({
      code: 'PRC',
      source: 'division',
    });
    expect(memberFacilities(member({ region: 'EMEA', division: 'EUD', subdivision: 'GER', rating: 3 }), vatspy, settings).home).toEqual({
      code: 'GER',
      source: 'subdivision',
    });
    expect(memberFacilities(member({ region: 'EMEA', division: 'GBR', subdivision: null, rating: 2 }), vatspy, settings).home).toBeNull();
    expect(memberFacilities(null, vatspy, settings)).toEqual({ home: null, visiting: [] });
  });
});
