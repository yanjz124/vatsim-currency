import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UNKNOWN, buildReport } from './lib/aggregate';
import { decodeSettingsLink } from './lib/backup';
import { exportWorkbook } from './lib/export';
import * as fmt from './lib/format';
import { fetchMemberInfo, getCachedMember, memberFacilities, type HomeFacility, type MemberInfo } from './lib/member';
import { quarterFromKey, recentQuarters, shiftQuarter, type Quarter } from './lib/quarters';
import { addFacility, assignInclude, assignPattern, loadSettings, saveSettings, type Settings } from './lib/settings';
import { clearStore, local } from './lib/storage';
import {
  ApiError,
  coversSince,
  fetchSessions,
  getCachedSessions,
  isValidCid,
  refreshAvailableAt,
  type FetchStatus,
  type SessionSet,
} from './lib/vatsimApi';
import { facilityCodes, facilityName, loadVatspy, type VatspyData } from './lib/vatspy';
import { ManualImport } from './components/ManualImport';
import { ReportView } from './components/ReportView';
import { SettingsView } from './components/SettingsView';

type View = 'check' | 'settings';

const SOURCE_TEXT: Record<Settings['fetchMode'], string> = {
  manual: 'manual import',
  proxy: 'proxy',
  direct: 'direct API',
};

/** Home facility picked by the user, per CID. */
const HOME_KEY = 'home:v1';

interface ErrorState {
  message: string;
  retryAt?: number;
  offerManual?: boolean;
}

function memberSummary(m: MemberInfo | null): string {
  if (!m) return '';
  const parts: string[] = [];
  if (m.vatsim?.division) parts.push(`Division ${m.vatsim.division}${m.vatsim.subdivision ? ` / ${m.vatsim.subdivision}` : ''}`);
  if (m.vatusa) parts.push(`VATUSA ${m.vatusa.facility}${m.vatusa.visiting.length ? `, visiting ${m.vatusa.visiting.join(', ')}` : ''}`);
  return parts.join(' · ');
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const updateSettings = useCallback((fn: (s: Settings) => Settings) => {
    setSettings((prev) => {
      const next = fn(prev);
      saveSettings(next);
      return next;
    });
  }, []);

  const [view, setView] = useState<View>('check');
  const [vatspy, setVatspy] = useState<VatspyData | null>(null);
  const [vatspyError, setVatspyError] = useState<string | null>(null);
  const reloadVatspy = useCallback((force = false) => {
    setVatspyError(null);
    loadVatspy({ force })
      .then(setVatspy)
      .catch((e: Error) => setVatspyError(e.message));
  }, []);
  useEffect(() => {
    reloadVatspy();
  }, [reloadVatspy]);

  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const quarters = useMemo(() => recentQuarters(8), []);
  const [cidInput, setCidInput] = useState(() => params.get('cid') ?? local.get<string>('lastCid') ?? '');
  const [quarterKey, setQuarterKey] = useState(() => {
    const k = params.get('q');
    return k && quarterFromKey(k) ? k : quarters[0].key;
  });
  const focus = useMemo(() => quarterFromKey(quarterKey) ?? quarters[0], [quarterKey, quarters]);
  const previous = useMemo(() => shiftQuarter(focus, -1), [focus]);

  const [data, setData] = useState<SessionSet | null>(null);
  const [member, setMember] = useState<MemberInfo | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<FetchStatus | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [manualFor, setManualFor] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [homeChoices, setHomeChoices] = useState<Record<string, string>>(() => local.get<Record<string, string>>(HOME_KEY) ?? {});
  const abortRef = useRef<AbortController | null>(null);
  const now = fmt.useNow(1000);

  const chooseHome = useCallback((cid: string, code: string | null) => {
    setHomeChoices((prev) => {
      const next = { ...prev };
      if (code) next[cid] = code;
      else delete next[cid];
      local.set(HOME_KEY, next);
      return next;
    });
  }, []);

  const restore = useCallback(
    (next: Settings, choices: Record<string, string> | null) => {
      updateSettings(() => next);
      if (choices) {
        local.set(HOME_KEY, choices);
        setHomeChoices(choices);
      }
    },
    [updateSettings],
  );

  // Settings shared as a link (#settings=…): ask before replacing the current ones.
  const linkHandled = useRef(false);
  useEffect(() => {
    const m = /[#&]settings=([^&]+)/.exec(window.location.hash);
    if (!m || linkHandled.current) return;
    linkHandled.current = true;
    const url = new URL(window.location.href);
    url.hash = '';
    window.history.replaceState(null, '', url);
    void decodeSettingsLink(m[1]).then((shared) => {
      if (!shared) return setError({ message: "That settings link couldn't be read. It may be incomplete." });
      const summary = `${fmt.plural(shared.facilities.length, 'facility', 'facilities')}, ${fmt.plural(shared.positionRules.length, 'position rule')}`;
      if (window.confirm(`Use the settings from this link (${summary})? They replace your current settings.`)) {
        restore(shared, null);
        setView('settings');
      }
    });
  }, [restore]);

  const loadMember = useCallback(
    async (cid: string, signal?: AbortSignal) => {
      try {
        const info = await fetchMemberInfo({ cid, mode: settings.fetchMode, proxyUrl: settings.proxyUrl, signal, onStatus: setStatus });
        if (!signal?.aborted) setMember(info);
      } catch {
        // Division and VATUSA details are optional; the report works without them.
      }
    },
    [settings.fetchMode, settings.proxyUrl],
  );

  const check = useCallback(
    async (opts: { force?: boolean } = {}) => {
      const cid = cidInput.trim();
      if (!isValidCid(cid)) {
        setError({ message: 'Enter a numeric VATSIM CID.' });
        return;
      }
      setError(null);
      local.set('lastCid', cid);
      const url = new URL(window.location.href);
      url.searchParams.set('cid', cid);
      if (quarterKey === quarters[0].key) url.searchParams.delete('q');
      else url.searchParams.set('q', quarterKey);
      window.history.replaceState(null, '', url);

      // A new query supersedes any still running, and a different member's report must not stay on
      // screen while this one loads.
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setData((d) => (d?.cid === cid ? d : null));
      setMember((m) => (m?.cid === cid ? m : null));

      const since = previous.start;
      const [cached, cachedMember] = await Promise.all([getCachedSessions(cid), getCachedMember(cid)]);
      if (ac.signal.aborted) return;
      if (cachedMember) setMember(cachedMember);

      if (settings.fetchMode === 'manual') {
        setBusy(false);
        setStatus(null);
        setData(cached ?? null);
        setFromCache(!!cached);
        setManualFor(!cached || !coversSince(cached, since) || opts.force ? cid : null);
        void loadMember(cid, ac.signal);
        return;
      }

      setBusy(true);
      setManualFor(null);
      try {
        const r = await fetchSessions({
          cid,
          since,
          mode: settings.fetchMode,
          proxyUrl: settings.proxyUrl,
          force: opts.force,
          signal: ac.signal,
          onStatus: setStatus,
        });
        if (ac.signal.aborted) return;
        setData(r.set);
        setFromCache(r.fromCache);
        await loadMember(cid, ac.signal);
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError('network', (e as Error).message);
        if (err.kind !== 'aborted' && !ac.signal.aborted) {
          if (cached) {
            setData(cached);
            setFromCache(true);
          }
          setError({
            message: err.message,
            retryAt: err.retryAt,
            offerManual: err.kind === 'network' || err.kind === 'rate-limited' || err.kind === 'http',
          });
        }
      } finally {
        if (abortRef.current === ac) {
          setBusy(false);
          setStatus(null);
        }
      }
    },
    [cidInput, previous, quarterKey, quarters, settings.fetchMode, settings.proxyUrl, loadMember],
  );

  // Open straight into a report when the page is loaded with ?cid=
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoRan.current && params.get('cid')) {
      autoRan.current = true;
      void check();
    }
  }, [check, params]);

  const computed = useMemo(() => {
    if (!data) return null;
    const info = member?.cid === data.cid ? member : null;
    const fromMember = memberFacilities(info, vatspy, settings);
    const busiest = (q: Quarter) =>
      buildReport(data.sessions, q, vatspy, settings).facilities.find((f) => f.code !== UNKNOWN && f.hours > 0)?.code;

    const choice = homeChoices[data.cid];
    let home: HomeFacility | null = choice ? { code: choice, source: 'choice' } : fromMember.home;
    if (!home) {
      const code = busiest(focus) ?? busiest(previous);
      if (code) home = { code, source: 'hours' };
    }
    const ctx = { home: home?.code ?? null, visiting: fromMember.visiting };
    return {
      reports: [buildReport(data.sessions, focus, vatspy, settings, ctx), buildReport(data.sessions, previous, vatspy, settings, ctx)],
      home,
      member: info,
      at: Date.now(),
    };
  }, [data, member, focus, previous, vatspy, settings, homeChoices]);

  const codes = useMemo(
    () =>
      [...new Set([...settings.facilities.map((f) => f.code), ...facilityCodes(vatspy)])]
        .sort()
        .map((code) => ({ code, name: settings.facilities.find((f) => f.code === code)?.name || facilityName(code, vatspy) })),
    [vatspy, settings.facilities],
  );
  const codeInfo = useMemo(() => {
    const names = new Map(codes.map((c) => [c.code, c.name]));
    return (code: string) => ({ known: names.has(code), name: names.get(code) ?? '' });
  }, [codes]);

  const onExport = async () => {
    if (!data || !computed) return;
    setExporting(true);
    try {
      await exportWorkbook({
        cid: data.cid,
        data,
        reports: computed.reports,
        settings,
        homeChoices,
        vatspy,
        member: computed.member,
        home: computed.home,
        calculatedAt: computed.at,
      });
    } catch (e) {
      setError({ message: `Export failed: ${(e as Error).message}` });
    } finally {
      setExporting(false);
    }
  };

  const onRefresh = () => {
    if (!data) return;
    if (data.cid !== cidInput.trim()) setCidInput(data.cid);
    if (settings.fetchMode === 'manual') setManualFor(data.cid);
    else void check({ force: true });
  };

  const refreshAt = data && settings.fetchMode !== 'manual' ? refreshAvailableAt(data) : 0;
  const incomplete = data && !coversSince(data, previous.start);
  const summary = memberSummary(computed?.member ?? null);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">VATSIM ATC Currency</div>
        <nav className="underline-nav" aria-label="Main">
          <button aria-current={view === 'check' ? 'page' : undefined} onClick={() => setView('check')}>
            Check
          </button>
          <button aria-current={view === 'settings' ? 'page' : undefined} onClick={() => setView('settings')}>
            Settings
          </button>
        </nav>
      </header>

      {view === 'settings' ? (
        <SettingsView
          settings={settings}
          update={updateSettings}
          homeChoices={homeChoices}
          onRestore={restore}
          vatspy={vatspy}
          vatspyError={vatspyError}
          onReloadVatspy={() => reloadVatspy(true)}
          onClearCache={async () => {
            await clearStore();
            setData(null);
            setMember(null);
            reloadVatspy(true);
          }}
        />
      ) : (
        <main>
          <form
            className="query"
            onSubmit={(e) => {
              e.preventDefault();
              void check();
            }}
          >
            <label className="field">
              <span>CID</span>
              <input
                className="form-control input-monospace"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                value={cidInput}
                placeholder="1234567"
                onChange={(e) => setCidInput(e.target.value.replace(/\D/g, ''))}
                size={12}
              />
            </label>
            <label className="field">
              <span>Quarter</span>
              <select className="form-select" value={quarterKey} onChange={(e) => setQuarterKey(e.target.value)}>
                {quarters.map((q, i) => (
                  <option key={q.key} value={q.key}>
                    {q.label}
                    {i === 0 ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Checking…' : 'Check'}
            </button>
            {busy && (
              <button className="btn" type="button" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            )}
            <p className="query-meta f6 color-fg-muted">
              {fmt.day(focus.start)} to {fmt.day(focus.end - 1)} UTC, compared with {previous.label}. Data source:{' '}
              {SOURCE_TEXT[settings.fetchMode]} (
              <button type="button" className="btn-link" onClick={() => setView('settings')}>
                change
              </button>
              )
            </p>
          </form>

          {status && (
            <p className="status">
              {status.message}
              {status.until && status.until > now ? ` (${fmt.countdown(status.until - now)})` : '…'}
            </p>
          )}

          {error && (
            <div className="notice notice-danger" role="alert">
              {error.message}
              {error.retryAt && error.retryAt > now && <> Try again in {fmt.countdown(error.retryAt - now)}.</>}
              {error.offerManual && isValidCid(cidInput.trim()) && (
                <>
                  {' '}
                  <button className="btn-link" onClick={() => setManualFor(cidInput.trim())}>
                    Import the data manually instead
                  </button>
                </>
              )}
            </div>
          )}

          {!vatspy && !vatspyError && <p className="status">Loading VATSpy facility data…</p>}
          {vatspyError && (
            <div className="notice notice-danger">
              Couldn't load VATSpy data ({vatspyError}). Facilities can't be identified until it loads.{' '}
              <button className="btn-link" onClick={() => reloadVatspy(true)}>
                Retry
              </button>
            </div>
          )}

          {manualFor && (
            <ManualImport
              key={manualFor}
              cid={manualFor}
              since={previous.start}
              sinceLabel={previous.label}
              base={data?.cid === manualFor ? data : null}
              onImported={(set, complete) => {
                setData(set);
                setFromCache(false);
                setError(null);
                if (complete) setManualFor(null);
              }}
              onClose={() => setManualFor(null)}
            />
          )}

          {data && computed && (
            <>
              <div className="report-head">
                <div>
                  <h1 className="f3 text-mono">CID {data.cid}</h1>
                  {summary && <div className="f5">{summary}</div>}
                  <div className="f6 color-fg-muted">
                    Data queried {fmt.utc(data.fetchedAt)} ({fmt.ago(data.fetchedAt, now)}
                    {fromCache ? ', saved copy' : ''}) · calculated {fmt.utc(computed.at)} · {data.sessions.length} sessions loaded
                  </div>
                </div>
                <div className="hstack">
                  <button className="btn btn-sm" onClick={onRefresh} disabled={busy || refreshAt > now} title="Fetch the latest sessions">
                    {refreshAt > now ? `Refresh in ${fmt.countdown(refreshAt - now)}` : 'Refresh'}
                  </button>
                  <button className="btn btn-sm" onClick={onExport} disabled={exporting}>
                    {exporting ? 'Exporting…' : 'Export .xlsx'}
                  </button>
                </div>
              </div>

              {incomplete && (
                <div className="notice notice-attention">
                  Loaded data only goes back to {fmt.day(data.coveredSince)}, but {previous.label} starts {fmt.day(previous.start)}, so
                  hours may be missing.{' '}
                  <button className="btn-link" onClick={() => (settings.fetchMode === 'manual' ? setManualFor(data.cid) : void check())}>
                    Load older sessions
                  </button>
                </div>
              )}

              <ReportView
                reports={computed.reports}
                currentKey={quarters[0].key}
                requirements={settings.requirements}
                home={computed.home}
                onSetHome={(code) => chooseHome(data.cid, code)}
                onResetHome={() => chooseHome(data.cid, null)}
                onSetRequirement={(code, h) =>
                  updateSettings((s) => {
                    const requirements = { ...s.requirements };
                    if (h == null || h === s.defaultRequirement) delete requirements[code];
                    else requirements[code] = h;
                    return { ...s, requirements };
                  })
                }
                codeInfo={codeInfo}
                onAssign={(a) =>
                  updateSettings((s) =>
                    a.values.reduce(
                      (acc, v) => (a.kind === 'pattern' ? assignPattern(acc, v, a.facility, a.name) : assignInclude(acc, v, a.facility, a.name)),
                      s,
                    ),
                  )
                }
                onAddFacility={(f) => updateSettings((s) => addFacility(s, { ...f, alwaysShow: true }))}
              />
            </>
          )}

          {!data && !manualFor && !busy && (
            <div className="empty">
              <p>Enter a VATSIM CID to see controlling hours for the quarter, by facility, position and level.</p>
              <p className="color-fg-muted">All calculations run in your browser. Settings and fetched data stay on this device.</p>
            </div>
          )}
        </main>
      )}

      <footer className="footer f6 color-fg-muted">
        Session and member data from the VATSIM and VATUSA APIs. Facility data from the{' '}
        <a href="https://github.com/vatsimnetwork/vatspy-data-project" target="_blank" rel="noreferrer">
          VATSpy Data Project
        </a>
        {vatspy ? ` (loaded ${fmt.utc(vatspy.fetchedAt)})` : ''}. Styled with{' '}
        <a href="https://primer.style/css" target="_blank" rel="noreferrer">
          Primer CSS
        </a>
        . Not affiliated with VATSIM or VATUSA.
      </footer>

      <datalist id="facility-codes">
        {codes.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </datalist>
    </div>
  );
}
