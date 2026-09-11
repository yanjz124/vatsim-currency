import { Fragment, useEffect, useState } from 'react';
import {
  LEVELS,
  UNKNOWN,
  describeResolution,
  prefixCandidates,
  ruleLabel,
  type FacilityStat,
  type PositionStat,
  type QuarterReport,
} from '../lib/aggregate';
import * as fmt from '../lib/format';
import { HOME_SOURCE_TEXT, type HomeFacility } from '../lib/member';

interface Props {
  /** [selected quarter, previous quarter] */
  reports: QuarterReport[];
  currentKey: string;
  requirements: Record<string, number>;
  home: HomeFacility | null;
  onSetHome(code: string): void;
  /** Drop the user's pick for this CID and go back to the default. */
  onResetHome(): void;
  onSetRequirement(code: string, hours: number | null): void;
  /** Add a callsign pattern to a facility (created if needed). */
  onAssign(pattern: string, facility: string): void;
}

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

      <HomeRule report={r} home={props.home} onResetHome={props.onResetHome} />
      <Facilities report={r} {...props} />
      <PositionRequirements report={r} />
      <Positions report={r} onAssign={props.onAssign} />
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
              <th scope="row">Share at {home.facility} (50% + 1)</th>
              {reports.map((r) => (
                <td key={r.quarter.key} className="num">
                  {r.home && r.home.meets !== null ? (
                    <>
                      {fmt.pct(r.home.share)} <RuleMark meets={r.home.meets} />
                    </>
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

function HomeRule({ report, home, onResetHome }: { report: QuarterReport; home: HomeFacility | null; onResetHome(): void }) {
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
            <div className="share-mid" />
          </div>
          <p>
            {fmt.hours(h.homeHours)} of {fmt.hours(h.total)} hours ({fmt.pct(h.share)}) in {q} were at {h.facility}.{' '}
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
                  Needs more than {fmt.hours(h.neededAtHome)} additional hours at {h.facility}, assuming no more time elsewhere.
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
  onSetHome,
  onSetRequirement,
}: { report: QuarterReport } & Pick<Props, 'requirements' | 'onSetHome' | 'onSetRequirement'>) {
  if (!report.facilities.length) {
    return (
      <section>
        <h2 className="section-title">By facility</h2>
        <p className="color-fg-muted">No controlling time in {report.quarter.label}.</p>
      </section>
    );
  }
  return (
    <section>
      <h2 className="section-title">By facility</h2>
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
    </section>
  );
}

function FacilityRow({
  f,
  custom,
  onSetHome,
  onSetRequirement,
}: {
  f: FacilityStat;
  custom: boolean;
  onSetHome(code: string): void;
  onSetRequirement(code: string, hours: number | null): void;
}) {
  const unknown = f.code === UNKNOWN;
  return (
    <tr className={f.isHome ? 'is-home' : undefined}>
      <td className="facility-cell">
        <span className="code">{f.code}</span>
        {f.name && <span className="color-fg-muted"> {f.name}</span>}
        {f.isVisiting && <span className="f6 color-fg-muted"> · visiting</span>}
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

function Positions({ report, onAssign }: { report: QuarterReport; onAssign: Props['onAssign'] }) {
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
                const tone =
                  p.resolution.source === 'unknown'
                    ? 'color-fg-danger'
                    : p.resolution.source === 'inferred' || p.resolution.alternatives
                      ? 'color-fg-attention'
                      : 'color-fg-muted';
                return (
                  <Fragment key={p.callsign}>
                    <tr>
                      <td className="text-mono f6">{p.callsign}</td>
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
                            {!p.countsTowardFacility && ' · not counted toward facility currency'}
                          </div>
                        )}
                      </td>
                      <td className="text-right">
                        <button className="btn-link f6" onClick={() => setEditing(editing === p.callsign ? null : p.callsign)}>
                          Reassign
                        </button>
                      </td>
                    </tr>
                    {editing === p.callsign && (
                      <tr className="editor">
                        <td colSpan={6}>
                          <AssignForm
                            position={p}
                            onSave={(pattern, facility) => {
                              onAssign(pattern, facility);
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
  onSave,
  onCancel,
}: {
  position: PositionStat;
  onSave(pattern: string, facility: string): void;
  onCancel(): void;
}) {
  // Shortest prefix first (DCA_*), then longer ones (DCA_N_*), then the exact callsign.
  const options = [...prefixCandidates(position.segments).reverse().map((c) => `${c}_*`), position.callsign];
  const [pattern, setPattern] = useState(options[0]);
  const [facility, setFacility] = useState(position.facility === UNKNOWN ? '' : position.facility);
  return (
    <form
      className="hstack"
      onSubmit={(e) => {
        e.preventDefault();
        const code = facility.trim().toUpperCase();
        if (code) onSave(pattern, code);
      }}
    >
      <span>Assign</span>
      <select className="form-select input-sm input-monospace" value={pattern} onChange={(e) => setPattern(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <span>to facility</span>
      <input
        className="form-control input-sm input-monospace"
        list="facility-codes"
        value={facility}
        onChange={(e) => setFacility(e.target.value)}
        placeholder="KZDC"
        size={10}
        autoFocus
        spellCheck={false}
      />
      <button type="submit" className="btn btn-sm btn-primary">
        Save
      </button>
      <button type="button" className="btn btn-sm" onClick={onCancel}>
        Cancel
      </button>
      <span className="f6 color-fg-muted">Adds the pattern to that facility in Settings.</span>
    </form>
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
                <tr key={e.callsign}>
                  <td className="text-mono f6">{e.callsign}</td>
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
