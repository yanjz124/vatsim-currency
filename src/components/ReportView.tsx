import { Fragment, useEffect, useState } from 'react';
import {
  LEVELS,
  UNKNOWN,
  describeResolution,
  ruleLabel,
  type FacilityStat,
  type PositionStat,
  type QuarterReport,
} from '../lib/aggregate';
import * as fmt from '../lib/format';
import { HOME_SOURCE_TEXT, type HomeFacility } from '../lib/member';
import { isValidFacilityCode, parsePatternList } from '../lib/patterns';

/** Reassigning a position: callsign patterns, or the whole underlying facility code. */
export interface Assignment {
  kind: 'pattern' | 'include';
  /** Patterns to move (a position like TOR_APP needs both TOR_APP and TOR_*_APP), or one facility code. */
  values: string[];
  facility: string;
  /** Name for the facility when it's created. */
  name: string;
}

export interface NewFacility {
  code: string;
  name: string;
  patterns: string[];
  includes: string[];
}

/** Whether a facility code is already known (VATSpy or Settings), and its name. */
export type CodeInfo = (code: string) => { known: boolean; name: string };

interface Props {
  /** [selected quarter, previous quarter] */
  reports: QuarterReport[];
  currentKey: string;
  requirements: Record<string, number>;
  home: HomeFacility | null;
  codeInfo: CodeInfo;
  onSetHome(code: string): void;
  /** Drop the user's pick for this CID and go back to the default. */
  onResetHome(): void;
  onSetRequirement(code: string, hours: number | null): void;
  onAssign(a: Assignment): void;
  /** Define a facility (listed even without hours). */
  onAddFacility(f: NewFacility): void;
  /** Copy a home facility built from VATSIM data into Settings. */
  onSaveAutoFacility(): void;
  /** Facilities added for this CID only, which can be removed from their row. */
  customFacilities: string[];
  onRemoveCustomFacility(code: string): void;
}

const CODE_HELP = 'Facility codes use letters, digits, - and _, for example KZNY or VATSSA.';

export function ReportView(props: Props) {
  const { reports, currentKey } = props;
  const [tab, setTab] = useState(0);
  const r = reports[tab] ?? reports[0];
  const label = (rep: QuarterReport) => rep.quarter.label + (rep.quarter.key === currentKey ? ' (to date)' : '');

  return (
    <>
      <Comparison reports={reports} label={label} />

      <div className="underline-nav tabs" role="tablist">
        {reports.map((rep, i) => (
          <button key={rep.quarter.key} role="tab" aria-selected={i === tab} onClick={() => setTab(i)}>
            {label(rep)}
          </button>
        ))}
      </div>

      <HomeRule report={r} home={props.home} onResetHome={props.onResetHome} onSaveAuto={props.onSaveAutoFacility} />
      <Facilities report={r} {...props} />
      <PositionRequirements report={r} />
      <Positions report={r} codeInfo={props.codeInfo} onAssign={props.onAssign} />
      <Excluded report={r} />
    </>
  );
}

function Comparison({ reports, label }: { reports: QuarterReport[]; label: (r: QuarterReport) => string }) {
  const home = reports[0].home;
  const listed = (r: QuarterReport) => r.facilities.filter((f) => f.code !== UNKNOWN && (f.hours > 0 || f.tracked));
  return (
    <div className="table-wrap">
      <table className="compare">
        <thead>
          <tr>
            <th />
            {reports.map((r) => (
              <th key={r.quarter.key} className="num">
                {label(r)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Controlling hours</th>
            {reports.map((r) => (
              <td key={r.quarter.key} className="num big" title={`${fmt.hm(r.total)} h:mm`}>
                {fmt.hours(r.total)}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">Sessions</th>
            {reports.map((r) => (
              <td key={r.quarter.key} className="num">
                {r.sessionCount}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">Facilities meeting requirement</th>
            {reports.map((r) => {
              const a = listed(r);
              return (
                <td key={r.quarter.key} className="num">
                  {a.filter((f) => f.meets).length} of {a.length}
                </td>
              );
            })}
          </tr>
          {reports.some((r) => r.positionRules.some((p) => p.hasRequirement)) && (
            <tr>
              <th scope="row">Position requirements met</th>
              {reports.map((r) => {
                const required = r.positionRules.filter((p) => p.hasRequirement);
                return (
                  <td key={r.quarter.key} className="num">
                    {required.filter((p) => p.meets).length} of {required.length}
                  </td>
                );
              })}
            </tr>
          )}
          {home && (
            <tr>
              <th scope="row">Hours at {home.facility} (50% + 1)</th>
              {reports.map((r) => (
                <td key={r.quarter.key} className="num">
                  {r.home && r.home.meets !== null ? (
                    <span title={`${fmt.pct(r.home.share)} of ${fmt.hours(r.home.total)} h`}>
                      {fmt.hours(r.home.homeHours)} of {r.home.required} h <RuleMark meets={r.home.meets} />
                    </span>
                  ) : (
                    <span className="color-fg-muted">no activity</span>
                  )}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function RuleMark({ meets }: { meets: boolean }) {
  return meets ? <span className="color-fg-success">met</span> : <span className="color-fg-danger">not met</span>;
}

function HomeRule({
  report,
  home,
  onResetHome,
  onSaveAuto,
}: {
  report: QuarterReport;
  home: HomeFacility | null;
  onResetHome(): void;
  onSaveAuto(): void;
}) {
  const h = report.home;
  const q = report.quarter.label;
  if (!h || !home) {
    return (
      <section>
        <h2 className="section-title">50% + 1 rule</h2>
        <p className="color-fg-muted">No home facility found for this member. Pick one in the Home column below.</p>
      </section>
    );
  }
  return (
    <section>
      <h2 className="section-title">
        50% + 1 rule: {h.facility}
        {h.name && <span className="text-normal color-fg-muted"> {h.name}</span>}
      </h2>
      <p className="f6 color-fg-muted mb-2">
        Home facility from {HOME_SOURCE_TEXT[home.source]}.{' '}
        {home.auto && (
          <>
            Built from VATSIM data, it covers{' '}
            <span className="text-mono">
              {home.auto.includes.slice(0, 10).join(', ')}
              {home.auto.includes.length > 10 ? ` and ${home.auto.includes.length - 10} more` : ''}
            </span>
            .{' '}
            <button className="btn-link" onClick={onSaveAuto}>
              Save it to Settings
            </button>{' '}
            to change what it covers.{' '}
          </>
        )}
        {home.source === 'choice' ? (
          <button className="btn-link" onClick={onResetHome}>
            Use the default
          </button>
        ) : (
          'Pick a different one in the Home column.'
        )}
      </p>
      {h.meets === null ? (
        <p className="color-fg-muted">No controlling time in {q}.</p>
      ) : (
        <>
          <div className="share" aria-hidden>
            <div className={h.meets ? 'share-fill meets' : 'share-fill short'} style={{ width: `${Math.min(100, h.share * 100)}%` }} />
            <div className="share-mid" style={{ left: `${Math.min(100, (h.required / h.total) * 100)}%` }} />
          </div>
          <p>
            {fmt.hours(h.homeHours)} of {fmt.hours(h.total)} hours ({fmt.pct(h.share)}) in {q} were at {h.facility}. The rule needs{' '}
            {h.required} h there: half of {fmt.hours(h.total)}, rounded up to the next whole hour.{' '}
            {h.meets ? (
              <>
                <span className="color-fg-success text-bold">Meets the rule.</span>{' '}
                <span className="color-fg-muted">
                  It stays met as long as less than {fmt.hours(h.headroomElsewhere)} more hours are controlled elsewhere without more time
                  at {h.facility}.
                </span>
              </>
            ) : (
              <>
                <span className="color-fg-danger text-bold">Does not meet the rule.</span>{' '}
                <span className="color-fg-muted">
                  Needs {fmt.hours(h.neededAtHome)} more hours at {h.facility}, assuming no more time elsewhere.
                </span>
              </>
            )}
          </p>
        </>
      )}
    </section>
  );
}

function Facilities({
  report,
  requirements,
  codeInfo,
  onSetHome,
  onSetRequirement,
  onAddFacility,
  customFacilities,
  onRemoveCustomFacility,
}: { report: QuarterReport } & Pick<
  Props,
  'requirements' | 'codeInfo' | 'onSetHome' | 'onSetRequirement' | 'onAddFacility' | 'customFacilities' | 'onRemoveCustomFacility'
>) {
  return (
    <section>
      <h2 className="section-title">By facility</h2>
      {report.facilities.length ? (
        <div className="panel table-wrap">
          <table className="data facilities">
            <thead>
              <tr>
                <th>Facility</th>
                {LEVELS.map((l) => (
                  <th key={l} className="num">
                    {l}
                  </th>
                ))}
                <th className="num">Total</th>
                <th className="num">Share</th>
                <th className="num">Required</th>
                <th>Status</th>
                <th className="text-center">Home</th>
              </tr>
            </thead>
            <tbody>
              {report.facilities.map((f) => (
                <FacilityRow
                  key={f.code}
                  f={f}
                  custom={f.code in requirements}
                  onSetHome={onSetHome}
                  onSetRequirement={onSetRequirement}
                  onRemove={customFacilities.includes(f.code) && f.hours === 0 ? () => onRemoveCustomFacility(f.code) : undefined}
                />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>All facilities</td>
                {LEVELS.map((l) => (
                  <td key={l} className="num">
                    {fmt.hours(report.levels[l])}
                  </td>
                ))}
                <td className="num">{fmt.hours(report.total)}</td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <p className="color-fg-muted">No controlling time in {report.quarter.label}.</p>
      )}
      <AddFacilityForm codeInfo={codeInfo} onAdd={onAddFacility} />
    </section>
  );
}

function AddFacilityForm({ codeInfo, onAdd }: { codeInfo: CodeInfo; onAdd(f: NewFacility): void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [patterns, setPatterns] = useState('');
  const [includes, setIncludes] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  if (!open) {
    return (
      <button className="btn btn-sm mt-2" onClick={() => setOpen(true)}>
        Add a facility
      </button>
    );
  }

  const c = code.trim().toUpperCase();
  const info = c ? codeInfo(c) : null;
  const close = () => {
    setOpen(false);
    setCode('');
    setName('');
    setPatterns('');
    setIncludes('');
    setProblem(null);
  };

  const submit = () => {
    if (!isValidFacilityCode(c)) return setProblem(CODE_HELP);
    const p = parsePatternList(patterns);
    const inc = parsePatternList(includes, 'code');
    const invalid = [...p.invalid, ...inc.invalid];
    if (invalid.length) return setProblem(`Can't use ${invalid.join(', ')}. Patterns use letters, digits, _ and * (and - in facility codes).`);
    if (!p.patterns.length && !inc.patterns.length && !info?.known) {
      return setProblem(`${c} is a new code, so give it at least one callsign pattern or included facility.`);
    }
    onAdd({ code: c, name: name.trim(), patterns: p.patterns, includes: inc.patterns.filter((x) => x !== c) });
    close();
  };

  return (
    <div className="panel mt-2">
      <div className="panel-body">
        <form
          className="hstack"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            className="form-control input-sm input-monospace"
            list="facility-codes"
            placeholder="Code: KZNY, VATSSA"
            size={16}
            spellCheck={false}
            autoFocus
            value={code}
            aria-label="Facility code"
            onChange={(e) => setCode(e.target.value)}
          />
          <input
            className="form-control input-sm"
            placeholder={info?.name || 'Name (optional)'}
            size={18}
            value={name}
            aria-label="Facility name"
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="form-control input-sm input-monospace"
            placeholder="Callsigns: NY_*, JFK_*"
            size={20}
            spellCheck={false}
            value={patterns}
            aria-label="Callsign patterns"
            onChange={(e) => setPatterns(e.target.value)}
          />
          <input
            className="form-control input-sm input-monospace"
            placeholder="Includes: FA*, FY*"
            size={16}
            spellCheck={false}
            value={includes}
            aria-label="Included facility codes"
            onChange={(e) => setIncludes(e.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-primary">
            Add
          </button>
          <button type="button" className="btn btn-sm" onClick={close}>
            Cancel
          </button>
        </form>
        <p className="f6 color-fg-muted mt-2 mb-0">
          {c && info?.known ? `Adds ${c}${info.name ? ` ${info.name}` : ''}. ` : c ? `Creates facility ${c}. ` : ''}
          Callsign patterns take <span className="text-mono">*</span> wildcards. Leave both lists empty for a facility VATSpy already knows.
          It's saved for this CID only and stays listed, even with no hours, until you remove it.
        </p>
        {problem && <p className="f6 color-fg-danger mt-1 mb-0">{problem}</p>}
      </div>
    </div>
  );
}

function FacilityRow({
  f,
  custom,
  onSetHome,
  onSetRequirement,
  onRemove,
}: {
  f: FacilityStat;
  custom: boolean;
  onSetHome(code: string): void;
  onSetRequirement(code: string, hours: number | null): void;
  /** Present for a facility added for this CID only. */
  onRemove?: () => void;
}) {
  const unknown = f.code === UNKNOWN;
  return (
    <tr className={f.isHome ? 'is-home' : undefined}>
      <td className="facility-cell">
        <span className="code">{f.code}</span>
        {f.name && <span className="color-fg-muted"> {f.name}</span>}
        {f.isVisiting && <span className="f6 color-fg-muted"> · visiting</span>}
        {onRemove && (
          <>
            {' '}
            <button className="btn-link f6" onClick={onRemove} title="Added for this CID only">
              remove
            </button>
          </>
        )}
      </td>
      {LEVELS.map((l) => (
        <td key={l} className={f.levels[l] ? 'num' : 'num color-fg-subtle'}>
          {f.levels[l] ? fmt.hours(f.levels[l]) : '–'}
        </td>
      ))}
      <td className="num text-bold" title={`${fmt.hm(f.hours)} h:mm`}>
        {fmt.hours(f.hours)}
        {Math.abs(f.currencyHours - f.hours) > 1e-9 && (
          <div className="f6 text-normal color-fg-muted" title="Hours that count toward this facility's requirement">
            {fmt.hours(f.currencyHours)} counted
          </div>
        )}
      </td>
      <td className="num">{fmt.pct(f.share)}</td>
      <td className="num">
        {unknown ? (
          <span className="color-fg-subtle">–</span>
        ) : (
          <RequirementInput value={f.requirement} custom={custom} onCommit={(h) => onSetRequirement(f.code, h)} />
        )}
      </td>
      <td className="no-wrap">
        {unknown ? (
          <span className="color-fg-subtle">–</span>
        ) : f.meets ? (
          <span className="color-fg-success">Met</span>
        ) : (
          <span className="color-fg-danger">{fmt.hours(f.shortBy)} h short</span>
        )}
      </td>
      <td className="text-center">
        {!unknown && (
          <input
            type="radio"
            name="home-facility"
            checked={f.isHome}
            onChange={() => onSetHome(f.code)}
            aria-label={`Set ${f.code} as home facility`}
          />
        )}
      </td>
    </tr>
  );
}

function RequirementInput({ value, custom, onCommit }: { value: number; custom: boolean; onCommit(h: number | null): void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const t = text.trim();
    if (t === '') return onCommit(null);
    const n = Number(t);
    if (Number.isFinite(n) && n >= 0) {
      if (n !== value) onCommit(n);
    } else setText(String(value));
  };
  return (
    <input
      className={custom ? 'form-control input-sm req custom' : 'form-control input-sm req'}
      type="number"
      min={0}
      step={0.5}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      title={custom ? 'Custom requirement for this facility. Clear it to use the default.' : 'Default requirement'}
      aria-label="Required hours per quarter"
    />
  );
}

function PositionRequirements({ report }: { report: QuarterReport }) {
  if (!report.positionRules.length) return null;
  return (
    <section>
      <h2 className="section-title">Position requirements</h2>
      <div className="panel table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Callsigns</th>
              <th className="num">Sessions</th>
              <th className="num">Hours</th>
              <th className="num">Required</th>
              <th>Status</th>
              <th>Facility currency</th>
            </tr>
          </thead>
          <tbody>
            {report.positionRules.map((p) => (
              <tr key={p.rule.id}>
                <td>
                  {ruleLabel(p.rule)}
                  <div className="f6 text-mono color-fg-muted">{p.rule.patterns.join(', ')}</div>
                </td>
                <td className="f6 text-mono">{p.callsigns.length ? p.callsigns.join(', ') : <span className="color-fg-subtle">None</span>}</td>
                <td className="num">{p.sessions}</td>
                <td className="num text-bold">{fmt.hours(p.hours)}</td>
                <td className="num">{p.hasRequirement ? fmt.hours(p.rule.hours!) : <span className="color-fg-subtle">–</span>}</td>
                <td className="no-wrap">
                  {!p.hasRequirement ? (
                    <span className="color-fg-subtle">–</span>
                  ) : p.meets ? (
                    <span className="color-fg-success">Met</span>
                  ) : (
                    <span className="color-fg-danger">{fmt.hours(p.shortBy)} h short</span>
                  )}
                </td>
                <td className="f6 color-fg-muted">{p.rule.countsTowardFacility ? 'Counts' : 'Not counted'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Positions({ report, codeInfo, onAssign }: { report: QuarterReport; codeInfo: CodeInfo; onAssign: Props['onAssign'] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const groups = report.facilities.filter((f) => f.positions.length);
  if (!groups.length) return null;
  return (
    <section>
      <h2 className="section-title">Positions</h2>
      <div className="panel table-wrap">
        <table className="data positions">
          <thead>
            <tr>
              <th>Callsign</th>
              <th>Level</th>
              <th className="num">Sessions</th>
              <th className="num">Hours</th>
              <th>Matched by</th>
              <th />
            </tr>
          </thead>
          {groups.map((f) => (
            <tbody key={f.code}>
              <tr className="group">
                <td colSpan={6}>
                  <span className="code">{f.code}</span>
                  {f.name && <span className="color-fg-muted"> {f.name}</span>}
                  <span className="color-fg-muted"> · {fmt.hours(f.hours)} h</span>
                </td>
              </tr>
              {f.positions.map((p) => {
                const key = `${f.code}|${p.position}`;
                const tone =
                  p.resolution.source === 'unknown'
                    ? 'color-fg-danger'
                    : p.resolution.source === 'inferred' || p.resolution.alternatives
                      ? 'color-fg-attention'
                      : 'color-fg-muted';
                return (
                  <Fragment key={p.position}>
                    <tr>
                      <td className="f6 no-wrap" title={p.callsigns.join(', ')}>
                        <span className="text-mono">{p.position}</span>
                        {p.callsigns.length > 1 && <span className="color-fg-muted"> · {p.callsigns.length} callsigns</span>}
                      </td>
                      <td className="no-wrap">{p.level}</td>
                      <td className="num">{p.sessions}</td>
                      <td className="num" title={`${fmt.hm(p.hours)} h:mm`}>
                        {fmt.hours(p.hours)}
                      </td>
                      <td className={`${tone} f6`}>
                        {describeResolution(p.resolution)}
                        {p.positionRules.length > 0 && (
                          <div className="color-fg-muted">
                            {p.positionRules.join(', ')}
                            {p.currencyHours <= 1e-9
                              ? ' · not counted toward facility currency'
                              : p.currencyHours < p.hours - 1e-9 && ` · ${fmt.hours(p.currencyHours)} h counted toward facility currency`}
                          </div>
                        )}
                      </td>
                      <td className="text-right">
                        <button className="btn-link f6" onClick={() => setEditing(editing === key ? null : key)}>
                          Reassign
                        </button>
                      </td>
                    </tr>
                    {editing === key && (
                      <tr className="editor">
                        <td colSpan={6}>
                          <AssignForm
                            position={p}
                            codeInfo={codeInfo}
                            onSave={(a) => {
                              onAssign(a);
                              setEditing(null);
                            }}
                            onCancel={() => setEditing(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

function AssignForm({
  position,
  codeInfo,
  onSave,
  onCancel,
}: {
  position: PositionStat;
  codeInfo: CodeInfo;
  onSave(a: Assignment): void;
  onCancel(): void;
}) {
  // The VATSpy facility the callsign resolved to, before any grouping. Moving "all of" it only makes
  // sense when it came from VATSpy rather than from one of the user's own callsign patterns.
  const r = position.resolution;
  const underlying = r.groupedFrom ?? (r.source === 'custom' || r.source === 'unknown' ? null : r.facility);
  const { prefix, suffix } = position;
  // Every position with the prefix, then this position whatever its middle segments, then the whole facility.
  const options: { value: string; label: string }[] = [
    { value: `pattern:${prefix}_*`, label: `${prefix}_* (every ${prefix} position)` },
    { value: `pattern:${prefix}_${suffix}|${prefix}_*_${suffix}`, label: `${position.position} (any ${prefix} … ${suffix})` },
    ...(underlying ? [{ value: `include:${underlying}`, label: `all of ${underlying}` }] : []),
  ];
  const [choice, setChoice] = useState(options[0].value);
  const [facility, setFacility] = useState(position.facility === UNKNOWN ? '' : position.facility);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const code = facility.trim().toUpperCase();
  const info = code ? codeInfo(code) : null;
  const split = choice.indexOf(':');
  const kind = choice.slice(0, split) as Assignment['kind'];
  const values = choice.slice(split + 1).split('|');

  return (
    <>
      <form
        className="hstack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!isValidFacilityCode(code)) return setProblem(CODE_HELP);
          if (kind === 'include' && values[0] === code) return setProblem(`${code} is already that facility.`);
          onSave({ kind, values, facility: code, name: name.trim() });
        }}
      >
        <span>Assign</span>
        <select className="form-select input-sm input-monospace" value={choice} onChange={(e) => setChoice(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span>to</span>
        <input
          className="form-control input-sm input-monospace"
          list="facility-codes"
          value={facility}
          onChange={(e) => {
            setFacility(e.target.value);
            setProblem(null);
          }}
          placeholder="KZDC or VATPRC"
          size={14}
          autoFocus
          spellCheck={false}
          aria-label="Facility code"
        />
        {info && !info.known && (
          <input
            className="form-control input-sm"
            placeholder="Name for the new facility"
            size={22}
            value={name}
            aria-label="New facility name"
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <button type="submit" className="btn btn-sm btn-primary">
          Save
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <span className="f6 color-fg-muted">
          {!code
            ? 'Type an existing facility, or a new code such as VATSSA.'
            : info?.known
              ? `${code}${info.name ? ` ${info.name}` : ''}`
              : `Creates facility ${code}.`}
        </span>
      </form>
      {problem && <p className="f6 color-fg-danger mt-1 mb-0">{problem}</p>}
    </>
  );
}

function Excluded({ report }: { report: QuarterReport }) {
  if (!report.excluded.length) return null;
  const total = report.excluded.reduce((a, e) => a + e.hours, 0);
  return (
    <section>
      <details>
        <summary>
          Not counted: {report.excluded.length} callsign{report.excluded.length === 1 ? '' : 's'}, {fmt.hours(total)} h
        </summary>
        <div className="panel table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Callsign</th>
                <th>Reason</th>
                <th className="num">Sessions</th>
                <th className="num">Hours</th>
              </tr>
            </thead>
            <tbody>
              {report.excluded.map((e) => (
                <tr key={e.position}>
                  <td className="f6 no-wrap" title={e.callsigns.join(', ')}>
                    <span className="text-mono">{e.position}</span>
                    {e.callsigns.length > 1 && <span className="color-fg-muted"> · {e.callsigns.length} callsigns</span>}
                  </td>
                  <td className="color-fg-muted">{e.reason}</td>
                  <td className="num">{e.sessions}</td>
                  <td className="num">{fmt.hours(e.hours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
