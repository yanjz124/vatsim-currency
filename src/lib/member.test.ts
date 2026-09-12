import { describe, expect, it } from 'vitest';
import { compileRules, groupFacility } from './aggregate';
import {
  ORGS,
  memberFacilities,
  orgFacility,
  parseVatsimMember,
  parseVatusaUser,
  vatusaToVatspy,
  type MemberInfo,
  type OrgData,
} from './member';
import { DEFAULT_SETTINGS } from './settings';
import { parseVatspy } from './vatspy';

const vatspy = parseVatspy(
  `[Countries]
Canada|CY|
Canada|CZ|
United Kingdom|EG|Control
United States|K|Center
Brazil|SB|
Russia|U|
Ukraine|UK|
Taiwan|RC|Control
[FIRs]
KZDC|Washington||KZDC
KZTL|Atlanta||KZTL
KZME|Memphis||KZME
PAZA|Anchorage||PAZA
PHZH|Honolulu||PHZH
ZSHA|Shanghai||ZSHA
CZYZ|Toronto|TOR|CZYZ
`,
  0,
);

const orgs: OrgData = {
  divisions: [
    { id: 'BRZ', name: 'Brazil (VATBRZ)', subdivisionsAllowed: false },
    { id: 'CAN', name: 'Canada', subdivisionsAllowed: true },
    { id: 'EUD', name: 'Europe (except UK)', subdivisionsAllowed: true },
    { id: 'GBR', name: 'United Kingdom', subdivisionsAllowed: false },
    { id: 'ROC', name: 'Republic of China (Taiwan)', subdivisionsAllowed: false },
    { id: 'RUS', name: 'Russia', subdivisionsAllowed: false },
    { id: 'USA', name: 'United States', subdivisionsAllowed: true },
  ],
  subdivisions: [
    { id: 'ADRIA', name: 'Adria', division: 'EUD' },
    { id: 'SCA', name: 'Scandinavia', division: 'EUD' },
    { id: 'ZYZ', name: 'Toronto', division: 'CAN' },
  ],
  facilities: {
    ESAA: { division: 'EUD', subdivision: 'SCA', controllers: 3 },
    EKDK: { division: 'EUD', subdivision: 'SCA', controllers: 2 },
  },
};

const member = (vatsim: MemberInfo['vatsim'], vatusa: MemberInfo['vatusa'] = null): MemberInfo => ({
  cid: '1',
  fetchedAt: 0,
  vatsim,
  vatusa,
});
const vatsim = (division: string, subdivision: string | null = null) => ({ region: 'X', division, subdivision, rating: 5 });

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

describe('orgFacility', () => {
  it('uses the VATSpy country with the same name as a division', () => {
    expect(orgFacility('CAN', 'division', vatspy, orgs)).toMatchObject({ code: 'CAN', name: 'Canada', includes: ['CY*', 'CZ*'] });
    expect(orgFacility('GBR', 'division', vatspy, orgs)?.includes).toEqual(['EG*']);
    expect(orgFacility('BRZ', 'division', vatspy, orgs)?.includes).toEqual(['SB*']);
    expect(orgFacility('ROC', 'division', vatspy, orgs)?.includes).toEqual(['RC*']);
  });

  it('uses a FIR with the subdivision code', () => {
    expect(orgFacility('ZYZ', 'subdivision', vatspy, orgs)).toMatchObject({ code: 'ZYZ', name: 'Toronto', includes: ['CZYZ'] });
  });

  it('uses facilities tagged by probing', () => {
    expect(orgFacility('SCA', 'subdivision', vatspy, orgs)?.includes).toEqual(['ESAA', 'EKDK']);
    expect(orgFacility('EUD', 'division', vatspy, orgs)?.includes).toEqual(['ESAA', 'EKDK']);
  });

  it('skips one-letter country prefixes other countries share, and gives up when nothing matches', () => {
    expect(orgFacility('RUS', 'division', vatspy, orgs)).toBeNull(); // U would also cover Ukraine (UK)
    expect(orgFacility('ADRIA', 'subdivision', vatspy, orgs)).toBeNull();
    expect(orgFacility('NOPE', 'division', vatspy, orgs)).toBeNull();
  });

  it('bundles the published division and subdivision lists', () => {
    expect(ORGS.divisions.find((d) => d.id === 'CAN')?.name).toBe('Canada');
    expect(ORGS.subdivisions.find((s) => s.id === 'ZYZ')).toMatchObject({ division: 'CAN' });
  });
});

describe('memberFacilities', () => {
  it('uses the VATUSA home facility and visiting roster', () => {
    const info = member(vatsim('USA'), { facility: 'ZDC', visiting: ['ZME', 'ZOB', 'ZTL'] });
    expect(memberFacilities(info, vatspy, DEFAULT_SETTINGS, orgs)).toEqual({
      home: { code: 'KZDC', source: 'vatusa' },
      visiting: ['KZME', 'KZTL'], // ZOB isn't in this VATSpy fixture
      autoFacility: null,
    });
  });

  it('follows facility includes, so ZDC can stand for KZDC', () => {
    const settings = { facilities: [{ id: 'z', code: 'ZDC', name: '', patterns: [], includes: ['KZDC'], alwaysShow: false }] };
    expect(memberFacilities(member(null, { facility: 'ZDC', visiting: [] }), vatspy, settings, orgs).home).toEqual({ code: 'ZDC', source: 'vatusa' });
  });

  it('prefers facilities defined in Settings', () => {
    const settings = {
      facilities: [...DEFAULT_SETTINGS.facilities, { id: 'g', code: 'SCA', name: 'Scandinavia', patterns: [], includes: ['EK*'], alwaysShow: false }],
    };
    expect(memberFacilities(member(vatsim('PRC')), vatspy, settings, orgs)).toMatchObject({ home: { code: 'PRC', source: 'division' }, autoFacility: null });
    expect(memberFacilities(member(vatsim('EUD', 'SCA')), vatspy, settings, orgs)).toMatchObject({
      home: { code: 'SCA', source: 'subdivision' },
      autoFacility: null,
    });
  });

  it('builds the home facility from VATSIM data when Settings has none', () => {
    const can = memberFacilities(member(vatsim('CAN')), vatspy, DEFAULT_SETTINGS, orgs);
    expect(can.home).toEqual({ code: 'CAN', source: 'division', auto: { includes: ['CY*', 'CZ*'] } });
    // The built facility groups the member's Canadian FIRs for the report.
    expect(groupFacility('CZYZ', compileRules({ facilities: [can.autoFacility!] }))).toBe('CAN');

    expect(memberFacilities(member(vatsim('CAN', 'ZYZ')), vatspy, DEFAULT_SETTINGS, orgs).home).toMatchObject({ code: 'ZYZ', source: 'subdivision' });
    expect(memberFacilities(member(vatsim('GBR')), vatspy, DEFAULT_SETTINGS, orgs).home).toMatchObject({ code: 'GBR' });
  });

  it('falls back when the subdivision or US division can’t be built', () => {
    // A subdivision member isn't given the whole division instead.
    expect(memberFacilities(member(vatsim('EUD', 'ADRIA')), vatspy, DEFAULT_SETTINGS, orgs).home).toBeNull();
    // US members come from VATUSA; without it there's no home, rather than all of K*.
    expect(memberFacilities(member(vatsim('USA')), vatspy, DEFAULT_SETTINGS, orgs).home).toBeNull();
    expect(memberFacilities(member(vatsim('CAN')), null, DEFAULT_SETTINGS, orgs).home).toBeNull();
    expect(memberFacilities(null, vatspy, DEFAULT_SETTINGS, orgs)).toEqual({ home: null, visiting: [], autoFacility: null });
  });
});
