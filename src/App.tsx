import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildReport } from './lib/aggregate';
import { exportWorkbook } from './lib/export';
import * as fmt from './lib/format';
import { quarterFromKey, recentQuarters, shiftQuarter } from './lib/quarters';
import { loadSettings, newId, saveSettings, type Settings } from './lib/settings';
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

interface ErrorState {
  message: string;
  retryAt?: number;
  offerManual?: boolean;
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
  const [fromCache, setFromCache] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<FetchStatus | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [manualFor, setManualFor] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const now = fmt.useNow(1000);

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

      const since = previous.start;
      const cached = await getCachedSessions(cid);

      if (settings.fetchMode === 'manual') {
        abortRef.current?.abort();
        setData(cached ?? null);
        setFromCache(!!cached);
        setManualFor(!cached || !coversSince(cached, since) || opts.force ? cid : null);
        return;
      }

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
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
        setData(r.set);
        setFromCache(r.fromCache);
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError('network', (e as Error).message);
        if (err.kind !== 'aborted') {
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
    [cidInput, previous, quarterKey, quarters, settings.fetchMode, settings.proxyUrl],
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
    return {
      reports: [buildReport(data.sessions, focus, vatspy, settings), buildReport(data.sessions, previous, vatspy, settings)],
      at: Date.now(),
    };
  }, [data, focus, previous, vatspy, settings]);

  const codes = useMemo(() => facilityCodes(vatspy), [vatspy]);

  const onExport = async () => {
    if (!data || !computed) return;
    setExporting(true);
    try {
      await exportWorkbook({ cid: data.cid, data, reports: computed.reports, settings, vatspy, calculatedAt: computed.at });
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
          vatspy={vatspy}
          vatspyError={vatspyError}
          onReloadVatspy={() => reloadVatspy(true)}
          onClearCache={async () => {
            await clearStore();
            setData(null);
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
                onSetHome={(code) => updateSettings((s) => ({ ...s, homeFacility: code }))}
                onSetRequirement={(code, h) =>
                  updateSettings((s) => {
                    const requirements = { ...s.requirements };
                    if (h == null || h === s.defaultRequirement) delete requirements[code];
                    else requirements[code] = h;
                    return { ...s, requirements };
                  })
                }
                onAssign={(prefix, facility) =>
                  updateSettings((s) => ({
                    ...s,
                    overrides: [
                      ...s.overrides.filter((o) => !(o.kind === 'prefix' && o.match === prefix)),
                      { id: newId(), kind: 'prefix', match: prefix, facility },
                    ],
                  }))
                }
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
        Session data from the VATSIM API. Facility data from the{' '}
        <a href="https://github.com/vatsimnetwork/vatspy-data-project" target="_blank" rel="noreferrer">
          VATSpy Data Project
        </a>
        {vatspy ? ` (loaded ${fmt.utc(vatspy.fetchedAt)})` : ''}. Styled with{' '}
        <a href="https://primer.style/css" target="_blank" rel="noreferrer">
          Primer CSS
        </a>
        . Not affiliated with VATSIM.
      </footer>

      <datalist id="facility-codes">
        {codes.map((c) => (
          <option key={c} value={c}>
            {facilityName(c, vatspy)}
          </option>
        ))}
      </datalist>
    </div>
  );
}
