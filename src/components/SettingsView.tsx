import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { compileRules, describeResolution, parseCallsign, resolveFacility, ruleLabel } from '../lib/aggregate';
import { backupFileName, encodeSettingsLink, makeBackup, readBackupFile } from '../lib/backup';
import * as fmt from '../lib/format';
import { compilePattern, isValidFacilityCode, isValidPattern, parsePatternList } from '../lib/patterns';
import {
  ALL_SUFFIXES,
  DEFAULT_SETTINGS,
  newId,
  updateFacility,
  type FacilityDef,
  type PositionRule,
  type Settings,
} from '../lib/settings';
import { GUARD } from '../lib/vatsimApi';
import { facilityName, type VatspyData } from '../lib/vatspy';

interface Props {
  settings: Settings;
  update(fn: (s: Settings) => Settings): void;
  homeChoices: Record<string, string>;
  /** Replace settings (and per-CID home picks, when the source has them). */
  onRestore(settings: Settings, homeChoices: Record<string, string> | null): void;
  vatspy: VatspyData | null;
  vatspyError: string | null;
  onReloadVatspy(): void;
  onClearCache(): Promise<void>;
}

const upper = (s: string) => s.trim().toUpperCase();
const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur();
const invalidMessage = (tokens: string[]) =>
  tokens.length ? `Ignored ${tokens.join(', ')}. Use letters, digits, _ and * (and - in facility codes).` : null;

function Section({ title, children, desc }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section">
      <div className="settings-label">
        <h2>{title}</h2>
        {desc && <div className="f6 color-fg-muted">{desc}</div>}
      </div>
      <div className="settings-body">{children}</div>
    </section>
  );
}

function HoursInput({
  value,
  onChange,
  ...rest
}: {
  value: number | string;
  onChange(v: string): void;
  placeholder?: string;
  onBlur?(): void;
  onKeyDown?(e: KeyboardEvent<HTMLInputElement>): void;
}) {
  return (
    <input
      type="number"
      min={0}
      step={0.5}
      className="form-control input-sm req"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  );
}

const validHours = (v: string) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;

const Code = ({ children }: { children: ReactNode }) => <span className="text-mono">{children}</span>;

function FacilityEditRow({
  def,
  autoName,
  taken,
  onSave,
  onRemove,
}: {
  def: FacilityDef;
  autoName: string;
  taken(code: string): boolean;
  onSave(next: FacilityDef): void;
  onRemove(): void;
}) {
  const [code, setCode] = useState(def.code);
  const [name, setName] = useState(def.name);
  const [patterns, setPatterns] = useState(def.patterns.join(', '));
  const [includes, setIncludes] = useState(def.includes.join(', '));
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setCode(def.code);
    setName(def.name);
    setPatterns(def.patterns.join(', '));
    setIncludes(def.includes.join(', '));
  }, [def]);

  const commit = (alwaysShow = def.alwaysShow) => {
    const c = upper(code);
    if (!isValidFacilityCode(c)) {
      setCode(def.code);
      return setProblem('Facility codes use letters, digits, - and _, for example KZNY or VATSSA.');
    }
    if (c !== def.code && taken(c)) return setProblem(`${c} is already defined.`);
    const p = parsePatternList(patterns);
    const inc = parsePatternList(includes, 'code');
    setProblem(invalidMessage([...p.invalid, ...inc.invalid]));
    const next: FacilityDef = {
      ...def,
      code: c,
      name: name.trim(),
      patterns: p.patterns,
      includes: inc.patterns.filter((x) => x !== c),
      alwaysShow,
    };
    if (JSON.stringify(next) !== JSON.stringify(def)) onSave(next);
    else {
      setPatterns(next.patterns.join(', '));
      setIncludes(next.includes.join(', '));
    }
  };

  return (
    <tr>
      <td>
        <input
          className="form-control input-sm input-monospace"
          size={7}
          value={code}
          spellCheck={false}
          aria-label="Facility code"
          onChange={(e) => setCode(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={blurOnEnter}
        />
      </td>
      <td>
        <input
          className="form-control input-sm"
          size={16}
          value={name}
          placeholder={autoName || 'Name'}
          aria-label="Facility name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={blurOnEnter}
        />
      </td>
      <td>
        <input
          className="form-control input-sm input-monospace width-full"
          value={patterns}
          placeholder="None"
          spellCheck={false}
          aria-label="Callsign patterns"
          onChange={(e) => setPatterns(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={blurOnEnter}
        />
        {problem && <div className="f6 color-fg-danger mt-1">{problem}</div>}
      </td>
      <td>
        <input
          className="form-control input-sm input-monospace width-full"
          value={includes}
          placeholder="None"
          spellCheck={false}
          aria-label="Included facility codes"
          onChange={(e) => setIncludes(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={blurOnEnter}
        />
      </td>
      <td className="text-center">
        <input type="checkbox" checked={def.alwaysShow} onChange={(e) => commit(e.target.checked)} aria-label="Always list in reports" />
      </td>
      <td className="text-right">
        <button className="btn-link f6" onClick={onRemove}>
          Remove
        </button>
      </td>
    </tr>
  );
}

function PositionRuleRow({ rule, onSave, onRemove }: { rule: PositionRule; onSave(next: PositionRule): void; onRemove(): void }) {
  const [name, setName] = useState(rule.name);
  const [patterns, setPatterns] = useState(rule.patterns.join(', '));
  const [hours, setHours] = useState(rule.hours == null ? '' : String(rule.hours));
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setName(rule.name);
    setPatterns(rule.patterns.join(', '));
    setHours(rule.hours == null ? '' : String(rule.hours));
  }, [rule]);

  const commit = (countsTowardFacility = rule.countsTowardFacility) => {
    const p = parsePatternList(patterns);
    const h = hours.trim() === '' ? null : Number(hours);
    if (h != null && !(Number.isFinite(h) && h >= 0)) {
      setHours(rule.hours == null ? '' : String(rule.hours));
      return setProblem('Required hours must be a number, or blank for no separate requirement.');
    }
    setProblem(invalidMessage(p.invalid));
    const next: PositionRule = { ...rule, name: name.trim(), patterns: p.patterns, hours: h, countsTowardFacility };
    if (JSON.stringify(next) !== JSON.stringify(rule)) onSave(next);
    else setPatterns(next.patterns.join(', '));
  };

  return (
    <tr>
      <td>
        <input
          className="form-control input-sm"
          size={16}
          value={name}
          placeholder="Name"
          aria-label="Rule name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={blurOnEnter}
        />
      </td>
      <td>
        <input
          className="form-control input-sm input-monospace width-full"
          value={patterns}
          placeholder="DC_*_CTR"
          spellCheck={false}
          aria-label="Callsign patterns"
          onChange={(e) => setPatterns(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={blurOnEnter}
        />
        {problem && <div className="f6 color-fg-danger mt-1">{problem}</div>}
      </td>
      <td className="num">
        <HoursInput value={hours} placeholder="None" onChange={setHours} onBlur={() => commit()} onKeyDown={blurOnEnter} />
      </td>
      <td className="text-center">
        <input
          type="checkbox"
          checked={rule.countsTowardFacility}
          onChange={(e) => commit(e.target.checked)}
          aria-label="Counts toward facility currency"
        />
      </td>
      <td className="text-right">
        <button className="btn-link f6" onClick={onRemove}>
          Remove
        </button>
      </td>
    </tr>
  );
}

const EMPTY_FACILITY = { code: '', name: '', patterns: '', includes: '', alwaysShow: true };
const EMPTY_RULE = { name: '', patterns: '', hours: '', countsTowardFacility: true };

export function SettingsView({ settings, update, homeChoices, onRestore, vatspy, vatspyError, onReloadVatspy, onClearCache }: Props) {
  const [reqCode, setReqCode] = useState('');
  const [reqHours, setReqHours] = useState('');
  const [newFac, setNewFac] = useState(EMPTY_FACILITY);
  const [facProblem, setFacProblem] = useState<string | null>(null);
  const [newRule, setNewRule] = useState(EMPTY_RULE);
  const [ruleProblem, setRuleProblem] = useState<string | null>(null);
  const [testCallsign, setTestCallsign] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => update((s) => ({ ...s, [key]: value }));
  const name = (code: string) => settings.facilities.find((f) => f.code === code)?.name || facilityName(code, vatspy);

  const rules = useMemo(() => compileRules(settings), [settings]);
  const tested = useMemo(() => {
    const parsed = parseCallsign(testCallsign);
    return parsed ? resolveFacility(parsed, vatspy, rules) : null;
  }, [testCallsign, vatspy, rules]);
  const testedRules = useMemo(() => {
    const cs = testCallsign.trim().toUpperCase();
    if (!cs) return [];
    return settings.positionRules.filter((r) => r.patterns.some((p) => isValidPattern(p) && compilePattern(p).re.test(cs)));
  }, [testCallsign, settings.positionRules]);
  const countries = useMemo(() => (vatspy ? Object.keys(vatspy.countries).sort() : []), [vatspy]);

  const setRequirement = (code: string, hours: number | null) =>
    update((s) => {
      const requirements = { ...s.requirements };
      if (hours == null) delete requirements[code];
      else requirements[code] = hours;
      return { ...s, requirements };
    });

  const addFacility = () => {
    const code = upper(newFac.code);
    if (!isValidFacilityCode(code)) return setFacProblem('Facility codes use letters, digits, - and _, for example KZNY or VATSSA.');
    if (settings.facilities.some((f) => f.code === code)) return setFacProblem(`${code} is already defined. Edit it above.`);
    const p = parsePatternList(newFac.patterns);
    const inc = parsePatternList(newFac.includes, 'code');
    update((s) => ({
      ...s,
      facilities: [
        ...s.facilities,
        {
          id: newId(),
          code,
          name: newFac.name.trim(),
          patterns: p.patterns,
          includes: inc.patterns.filter((x) => x !== code),
          alwaysShow: newFac.alwaysShow,
        },
      ],
    }));
    setFacProblem(invalidMessage([...p.invalid, ...inc.invalid]));
    setNewFac(EMPTY_FACILITY);
  };

  const addRule = () => {
    const p = parsePatternList(newRule.patterns);
    if (!p.patterns.length) return setRuleProblem(invalidMessage(p.invalid) ?? 'Enter at least one callsign pattern.');
    if (newRule.hours.trim() !== '' && !validHours(newRule.hours)) return setRuleProblem('Required hours must be a number, or blank.');
    update((s) => ({
      ...s,
      positionRules: [
        ...s.positionRules,
        {
          id: newId(),
          name: newRule.name.trim(),
          patterns: p.patterns,
          hours: newRule.hours.trim() === '' ? null : Number(newRule.hours),
          countsTowardFacility: newRule.countsTowardFacility,
        },
      ],
    }));
    setRuleProblem(invalidMessage(p.invalid));
    setNewRule(EMPTY_RULE);
  };

  const exportSettings = () => {
    const blob = new Blob([JSON.stringify(makeBackup(settings, homeChoices), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = backupFileName();
    a.click();
    URL.revokeObjectURL(a.href);
    setNotice('Settings exported.');
  };

  const importSettings = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const restored = await readBackupFile(file);
      const summary = `${fmt.plural(restored.settings.facilities.length, 'facility', 'facilities')}, ${fmt.plural(restored.settings.positionRules.length, 'position rule')}`;
      if (!window.confirm(`Replace your current settings with the ones in ${file.name} (${summary})?`)) return;
      onRestore(restored.settings, restored.homeChoices);
      setNotice(`Settings restored from ${file.name}.`);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const copyLink = async () => {
    const url = await encodeSettingsLink(settings, `${window.location.origin}${window.location.pathname}`);
    try {
      await navigator.clipboard.writeText(url);
      setLink(null);
      setNotice('Link copied. Opening it offers to load these facilities and rules; home picks per CID are not included.');
    } catch {
      setLink(url);
      setNotice('Copy this link:');
    }
  };

  const requirements = Object.entries(settings.requirements).sort(([a], [b]) => a.localeCompare(b));

  return (
    <main>
      <Section
        title="Facilities"
        desc={
          <>
            <p className="mb-2">
              A facility collects callsigns by pattern and other facilities by code. <Code>*</Code> matches anything: callsigns{' '}
              <Code>DC_*</Code> or <Code>*_FSS</Code>, codes <Code>ZB*</Code> or <Code>KZ*</Code>. A callsign pattern without{' '}
              <Code>*</Code> matches that prefix, so <Code>PCT</Code> covers PCT_APP.
            </p>
            <p className="mb-2">
              The longest match wins, and these rules come before VATSpy. Give a facility a VATSIM division or subdivision ID as its code
              (PRC, GER) and members of that division get it as their default home facility.
            </p>
          </>
        }
      >
        {settings.facilities.length > 0 ? (
          <div className="panel block table-wrap">
            <table className="data wide">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Callsign patterns</th>
                  <th>Includes facilities</th>
                  <th className="text-center">Always list</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {settings.facilities.map((f) => (
                  <FacilityEditRow
                    key={f.id}
                    def={f}
                    autoName={facilityName(f.code, vatspy)}
                    taken={(c) => settings.facilities.some((x) => x.code === c && x.id !== f.id)}
                    onSave={(next) => update((s) => updateFacility(s, next))}
                    onRemove={() => set('facilities', settings.facilities.filter((x) => x.id !== f.id))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="color-fg-muted">No facilities defined. You can also create one with Reassign in a report.</p>
        )}

        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            addFacility();
          }}
        >
          <div className="hstack">
            <input
              className="form-control input-sm input-monospace"
              list="facility-codes"
              placeholder="Code"
              size={8}
              spellCheck={false}
              value={newFac.code}
              onChange={(e) => setNewFac({ ...newFac, code: e.target.value })}
            />
            <input
              className="form-control input-sm"
              placeholder="Name (optional)"
              size={18}
              value={newFac.name}
              onChange={(e) => setNewFac({ ...newFac, name: e.target.value })}
            />
            {countries.length > 0 && (
              <select
                className="form-select input-sm"
                value=""
                aria-label="Fill includes from a country"
                onChange={(e) => {
                  const country = e.target.value;
                  const prefixes = vatspy?.countries[country];
                  if (!prefixes) return;
                  setNewFac((f) => ({ ...f, name: f.name || country, includes: prefixes.map((p) => `${p}*`).join(', ') }));
                }}
              >
                <option value="">Include a whole country…</option>
                {countries.map((c) => (
                  <option key={c} value={c}>
                    {c} ({vatspy!.countries[c].join(', ')})
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="hstack mt-2">
            <input
              className="form-control input-sm input-monospace"
              placeholder="Callsign patterns: DC_*, PCT"
              size={24}
              spellCheck={false}
              value={newFac.patterns}
              onChange={(e) => setNewFac({ ...newFac, patterns: e.target.value })}
            />
            <input
              className="form-control input-sm input-monospace"
              placeholder="Includes: KZDC, ZB*"
              size={24}
              spellCheck={false}
              value={newFac.includes}
              onChange={(e) => setNewFac({ ...newFac, includes: e.target.value })}
            />
            <label className="text-normal hstack">
              <input type="checkbox" checked={newFac.alwaysShow} onChange={(e) => setNewFac({ ...newFac, alwaysShow: e.target.checked })} />
              Always list
            </label>
            <button type="submit" className="btn btn-sm">
              Add facility
            </button>
          </div>
        </form>
        {facProblem && <p className="f6 color-fg-danger mt-1 mb-0">{facProblem}</p>}

        <div className="hstack mt-3">
          <input
            className="form-control input-sm input-monospace"
            placeholder="Test a callsign"
            size={16}
            spellCheck={false}
            value={testCallsign}
            onChange={(e) => setTestCallsign(e.target.value)}
          />
          {tested ? (
            <span>
              <span className="code">{tested.facility}</span>
              {name(tested.facility) && <span className="color-fg-muted"> {name(tested.facility)}</span>}
              <span className="f6 color-fg-muted"> · {describeResolution(tested)}</span>
              {testedRules.length > 0 && <span className="f6 color-fg-muted"> · position rules: {testedRules.map(ruleLabel).join(', ')}</span>}
            </span>
          ) : (
            testCallsign.trim() && <span className="f6 color-fg-muted">Enter a full callsign, e.g. IAD_N_TWR</span>
          )}
        </div>
      </Section>

      <Section title="Currency requirements" desc="Hours needed per quarter at each facility. Facilities without their own value use the default.">
        <label className="hstack text-normal mb-3">
          Default
          <HoursInput value={settings.defaultRequirement} onChange={(v) => validHours(v) && set('defaultRequirement', Number(v))} />
          hours per quarter
        </label>
        {requirements.length > 0 && (
          <div className="panel">
            <table className="data">
              <thead>
                <tr>
                  <th>Facility</th>
                  <th className="num">Hours</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {requirements.map(([code, h]) => (
                  <tr key={code}>
                    <td>
                      <span className="code">{code}</span> <span className="color-fg-muted">{name(code)}</span>
                    </td>
                    <td className="num">
                      <HoursInput value={h} onChange={(v) => validHours(v) && setRequirement(code, Number(v))} />
                    </td>
                    <td className="text-right">
                      <button className="btn-link f6" onClick={() => setRequirement(code, null)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form
          className="hstack mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (upper(reqCode) && validHours(reqHours)) {
              setRequirement(upper(reqCode), Number(reqHours));
              setReqCode('');
              setReqHours('');
            }
          }}
        >
          <input
            className="form-control input-sm input-monospace"
            list="facility-codes"
            placeholder="Facility"
            size={10}
            value={reqCode}
            onChange={(e) => setReqCode(e.target.value)}
          />
          <HoursInput placeholder="Hours" value={reqHours} onChange={setReqHours} />
          <button type="submit" className="btn btn-sm">
            Add
          </button>
        </form>
      </Section>

      <Section
        title="Position requirements"
        desc={
          <>
            <p className="mb-2">
              Track specific positions on their own. Give a rule required hours for a separate currency check, for example 2 hours a
              quarter on <Code>DC_*_CTR</Code>.
            </p>
            <p className="mb-2">
              Untick “Counts toward facility” to leave those hours out of the facility's own requirement. They still count toward total
              hours and the 50% + 1 rule.
            </p>
          </>
        }
      >
        {settings.positionRules.length > 0 ? (
          <div className="panel block table-wrap">
            <table className="data wide">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Callsign patterns</th>
                  <th className="num">Required hours</th>
                  <th className="text-center">Counts toward facility</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {settings.positionRules.map((r) => (
                  <PositionRuleRow
                    key={r.id}
                    rule={r}
                    onSave={(next) => set('positionRules', settings.positionRules.map((x) => (x.id === next.id ? next : x)))}
                    onRemove={() => set('positionRules', settings.positionRules.filter((x) => x.id !== r.id))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="color-fg-muted">No position rules.</p>
        )}
        <form
          className="hstack mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            addRule();
          }}
        >
          <input
            className="form-control input-sm"
            placeholder="Name"
            size={16}
            value={newRule.name}
            onChange={(e) => setNewRule({ ...newRule, name: e.target.value })}
          />
          <input
            className="form-control input-sm input-monospace"
            placeholder="Patterns: DC_*_CTR"
            size={22}
            spellCheck={false}
            value={newRule.patterns}
            onChange={(e) => setNewRule({ ...newRule, patterns: e.target.value })}
          />
          <HoursInput placeholder="Hours" value={newRule.hours} onChange={(v) => setNewRule({ ...newRule, hours: v })} />
          <label className="text-normal hstack">
            <input
              type="checkbox"
              checked={newRule.countsTowardFacility}
              onChange={(e) => setNewRule({ ...newRule, countsTowardFacility: e.target.checked })}
            />
            Counts toward facility
          </label>
          <button type="submit" className="btn btn-sm">
            Add rule
          </button>
        </form>
        {ruleProblem && <p className="f6 color-fg-danger mt-1 mb-0">{ruleProblem}</p>}
      </Section>

      <Section title="What counts">
        <p className="text-bold f6 mb-1">Position suffixes</p>
        <div className="checks mb-3">
          {ALL_SUFFIXES.map((sfx) => (
            <label key={sfx}>
              <input
                type="checkbox"
                checked={settings.countedSuffixes.includes(sfx)}
                onChange={(e) =>
                  set(
                    'countedSuffixes',
                    e.target.checked
                      ? ALL_SUFFIXES.filter((x) => x === sfx || settings.countedSuffixes.includes(x))
                      : settings.countedSuffixes.filter((x) => x !== sfx),
                  )
                }
              />
              <span className="text-mono f6">{sfx}</span>
            </label>
          ))}
        </div>
        <p className="text-bold f6 mb-1">Sessions that cross into another quarter</p>
        <div className="form-checkbox">
          <label className="text-normal">
            <input type="radio" name="boundary" checked={settings.boundaryMode === 'split'} onChange={() => set('boundaryMode', 'split')} />
            Split at the quarter boundary
          </label>
        </div>
        <div className="form-checkbox">
          <label className="text-normal">
            <input type="radio" name="boundary" checked={settings.boundaryMode === 'start'} onChange={() => set('boundaryMode', 'start')} />
            Count the whole session in the quarter it started
          </label>
        </div>
      </Section>

      <Section
        title="Back up and restore"
        desc="Settings are saved in this browser automatically. Export a backup to restore them later or on another device. Exported .xlsx reports include a backup too."
      >
        <div className="hstack">
          <button className="btn btn-sm" onClick={exportSettings}>
            Export settings
          </button>
          <label className="btn btn-sm">
            Import settings
            <input
              type="file"
              accept=".json,.xlsx,application/json"
              hidden
              onChange={(e) => void importSettings(e.currentTarget)}
            />
          </label>
          <button className="btn btn-sm" onClick={() => void copyLink()}>
            Copy settings link
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={() => {
              if (window.confirm('Reset all settings to defaults? Export a backup first if you might want them back.')) {
                update(() => DEFAULT_SETTINGS);
                setNotice('Settings reset.');
              }
            }}
          >
            Reset settings
          </button>
        </div>
        <p className="f6 color-fg-muted mt-2 mb-0">
          Import accepts a settings .json file or an exported report. The backup file also keeps your home facility picks per CID.
        </p>
        {notice && <p className="mt-2 mb-0">{notice}</p>}
        {link && <input className="form-control input-sm input-monospace width-full mt-2" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />}
      </Section>

      <Section
        title="Data source"
        desc={`Requests are spaced ${GUARD.minGapMs / 1000} s apart, capped at ${GUARD.maxPerWindow} a minute across tabs, and reused for ${GUARD.freshMs / 60_000} minutes. A rate-limit response pauses all requests until the API allows them again.`}
      >
        <div className="form-checkbox">
          <label>
            <input type="radio" name="source" checked={settings.fetchMode === 'manual'} onChange={() => set('fetchMode', 'manual')} />
            Manual import
          </label>
          <p className="note">Open the VATSIM API link yourself and paste the result. No server involved. Division details are skipped.</p>
        </div>
        <div className="form-checkbox">
          <label>
            <input type="radio" name="source" checked={settings.fetchMode === 'proxy'} onChange={() => set('fetchMode', 'proxy')} />
            Proxy
          </label>
          <p className="note">A small relay that adds CORS headers. See worker/ in the repository.</p>
          {settings.fetchMode === 'proxy' && (
            <input
              className="form-control input-sm input-monospace width-full mt-2"
              style={{ maxWidth: 460 }}
              placeholder="https://vatsim-currency-proxy.example.workers.dev"
              value={settings.proxyUrl}
              spellCheck={false}
              onChange={(e) => set('proxyUrl', e.target.value.trim())}
            />
          )}
        </div>
        <div className="form-checkbox">
          <label>
            <input type="radio" name="source" checked={settings.fetchMode === 'direct'} onChange={() => set('fetchMode', 'direct')} />
            Direct
          </label>
          <p className="note">Only works if the VATSIM API starts sending CORS headers.</p>
        </div>
      </Section>

      <Section title="Stored data">
        <p>
          VATSpy data:{' '}
          {vatspy ? (
            `loaded ${fmt.utc(vatspy.fetchedAt)}`
          ) : vatspyError ? (
            <span className="color-fg-danger">{vatspyError}</span>
          ) : (
            'loading…'
          )}{' '}
          <button className="btn-link" onClick={onReloadVatspy}>
            Reload
          </button>
        </p>
        <button
          className="btn btn-sm"
          onClick={async () => {
            await onClearCache();
            setNotice('Cached sessions, member details and VATSpy data cleared. Settings were kept.');
          }}
        >
          Clear cached data
        </button>
      </Section>
    </main>
  );
}
