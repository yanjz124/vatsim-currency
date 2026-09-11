import { useState, type ReactNode } from 'react';
import * as fmt from '../lib/format';
import {
  ALL_SUFFIXES,
  DEFAULT_SETTINGS,
  newId,
  normalizeSettings,
  type OverrideRule,
  type Settings,
} from '../lib/settings';
import { GUARD } from '../lib/vatsimApi';
import { facilityName, type VatspyData } from '../lib/vatspy';

interface Props {
  settings: Settings;
  update(fn: (s: Settings) => Settings): void;
  vatspy: VatspyData | null;
  vatspyError: string | null;
  onReloadVatspy(): void;
  onClearCache(): Promise<void>;
}

const upper = (s: string) => s.trim().toUpperCase();

function Section({ title, children, desc }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section">
      <div className="settings-label">
        <h2>{title}</h2>
        {desc && <p className="f6 color-fg-muted mb-0">{desc}</p>}
      </div>
      <div className="settings-body">{children}</div>
    </section>
  );
}

function HoursInput({ value, onChange, ...rest }: { value: number | string; onChange(v: string): void; placeholder?: string }) {
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

export function SettingsView({ settings, update, vatspy, vatspyError, onReloadVatspy, onClearCache }: Props) {
  const [home, setHome] = useState(settings.homeFacility);
  const [reqCode, setReqCode] = useState('');
  const [reqHours, setReqHours] = useState('');
  const [rule, setRule] = useState<Omit<OverrideRule, 'id'>>({ kind: 'prefix', match: '', facility: '' });
  const [notice, setNotice] = useState<string | null>(null);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => update((s) => ({ ...s, [key]: value }));
  const name = (code: string) => facilityName(code, vatspy);

  const setRequirement = (code: string, hours: number | null) =>
    update((s) => {
      const requirements = { ...s.requirements };
      if (hours == null) delete requirements[code];
      else requirements[code] = hours;
      return { ...s, requirements };
    });

  const addRule = () => {
    const match = upper(rule.match).replace(/_+$/, '');
    const facility = upper(rule.facility);
    if (!match || !facility) return;
    update((s) => ({
      ...s,
      overrides: [...s.overrides.filter((o) => !(o.kind === rule.kind && o.match === match)), { id: newId(), kind: rule.kind, match, facility }],
    }));
    setRule({ ...rule, match: '', facility: '' });
  };

  const exportSettings = () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vatsim-currency-settings.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importSettings = async (file: File | undefined) => {
    if (!file) return;
    try {
      const next = normalizeSettings(JSON.parse(await file.text()));
      update(() => next);
      setHome(next.homeFacility);
      setNotice('Settings imported.');
    } catch {
      setNotice("Couldn't read that settings file.");
    }
  };

  const requirements = Object.entries(settings.requirements).sort(([a], [b]) => a.localeCompare(b));
  const overrides = [...settings.overrides].sort((a, b) => a.kind.localeCompare(b.kind) || a.match.localeCompare(b.match));

  return (
    <main>
      <Section title="Home facility" desc="More than half of your counted hours each quarter must be at your home facility (the 50% + 1 rule).">
        <div className="hstack">
          <input
            className="form-control input-monospace"
            list="facility-codes"
            value={home}
            placeholder="KZDC"
            size={12}
            spellCheck={false}
            onChange={(e) => setHome(e.target.value)}
            onBlur={() => set('homeFacility', upper(home))}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <span className="color-fg-muted">{name(upper(home)) || (home ? 'Custom facility' : 'Not set')}</span>
        </div>
      </Section>

      <Section title="Currency requirements" desc="Hours needed per quarter. Facilities without their own value use the default.">
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
        title="Facility overrides"
        desc={
          <>
            A prefix rule sends callsigns to a facility, e.g. <span className="text-mono">PCT</span> to KZDC. The longest matching prefix
            wins. A merge rule folds one facility into another, e.g. EGPX into EGTT, or KZDC into ZDC.
          </>
        }
      >
        {overrides.length > 0 ? (
          <div className="panel">
            <table className="data">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Match</th>
                  <th>Facility</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {overrides.map((o) => (
                  <tr key={o.id}>
                    <td className="color-fg-muted">{o.kind === 'prefix' ? 'Prefix' : 'Merge'}</td>
                    <td className="text-mono f6">{o.kind === 'prefix' ? `${o.match}_` : o.match}</td>
                    <td>
                      <span className="code">{o.facility}</span> <span className="color-fg-muted">{name(o.facility)}</span>
                    </td>
                    <td className="text-right">
                      <button className="btn-link f6" onClick={() => set('overrides', settings.overrides.filter((x) => x.id !== o.id))}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="color-fg-muted">No overrides yet. You can also add one with Reassign in a report.</p>
        )}
        <form
          className="hstack mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            addRule();
          }}
        >
          <select
            className="form-select input-sm"
            value={rule.kind}
            onChange={(e) => setRule({ ...rule, kind: e.target.value as OverrideRule['kind'] })}
          >
            <option value="prefix">Prefix</option>
            <option value="facility">Merge</option>
          </select>
          <input
            className="form-control input-sm input-monospace"
            placeholder={rule.kind === 'prefix' ? 'Prefix, e.g. PCT' : 'Facility, e.g. EGPX'}
            list={rule.kind === 'facility' ? 'facility-codes' : undefined}
            size={16}
            spellCheck={false}
            value={rule.match}
            onChange={(e) => setRule({ ...rule, match: e.target.value })}
          />
          <span className="color-fg-muted">to</span>
          <input
            className="form-control input-sm input-monospace"
            list="facility-codes"
            placeholder="Facility"
            size={10}
            spellCheck={false}
            value={rule.facility}
            onChange={(e) => setRule({ ...rule, facility: e.target.value })}
          />
          <button type="submit" className="btn btn-sm">
            Add
          </button>
        </form>
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
        title="Data source"
        desc={`Requests are spaced ${GUARD.minGapMs / 1000} s apart, capped at ${GUARD.maxPerWindow} a minute across tabs, and reused for ${GUARD.freshMs / 60_000} minutes. A rate-limit response pauses all requests until the API allows them again.`}
      >
        <div className="form-checkbox">
          <label>
            <input type="radio" name="source" checked={settings.fetchMode === 'manual'} onChange={() => set('fetchMode', 'manual')} />
            Manual import
          </label>
          <p className="note">Open the VATSIM API link yourself and paste the result. No server involved.</p>
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
        <div className="hstack">
          <button
            className="btn btn-sm"
            onClick={async () => {
              await onClearCache();
              setNotice('Cached sessions and VATSpy data cleared.');
            }}
          >
            Clear cached data
          </button>
          <button className="btn btn-sm" onClick={exportSettings}>
            Export settings
          </button>
          <label className="btn btn-sm">
            Import settings
            <input type="file" accept=".json,application/json" hidden onChange={(e) => void importSettings(e.target.files?.[0])} />
          </label>
          <button
            className="btn btn-sm btn-danger"
            onClick={() => {
              if (window.confirm('Reset all settings to defaults?')) {
                update(() => DEFAULT_SETTINGS);
                setHome('');
                setNotice('Settings reset.');
              }
            }}
          >
            Reset settings
          </button>
        </div>
        {notice && <p className="color-fg-muted mt-2">{notice}</p>}
      </Section>
    </main>
  );
}
