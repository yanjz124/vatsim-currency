# VATSIM ATC Currency

A static website for checking a VATSIM controller's quarterly currency. Enter a CID and it shows:

- counted controlling hours for the selected quarter and the one before it
- hours by facility (FIR/ARTCC/ACC), with a breakdown by level: CTR/FSS, APP/DEP, TWR, GND/DEL/RMP, Other (RDO/TMU/FMP)
- each callsign used, its hours, and how it was matched to a facility
- whether each facility's currency requirement is met (3 h/quarter by default, adjustable per facility)
- the 50% + 1 check against a chosen home facility
- an `.xlsx` export with the query and calculation timestamps

Everything is calculated in the browser. Settings, facility overrides and fetched sessions are stored on the user's device (localStorage and IndexedDB). There is no backend.

Based on the logic in `zdc_roster_audit/individual_activity.py`.

## Getting session data

The VATSIM API (`api.vatsim.net/v2/members/{cid}/atc`) does not send CORS headers, so browsers block web pages from reading it. The site supports three ways around that (Settings → Data source):

| Mode | How it works | Requests come from |
| --- | --- | --- |
| **Manual import** (default when no proxy is configured) | The site links to the API URL. The user opens it, copies the JSON and pastes it back. Longer histories take more than one page; the site says when another page is needed. | The user's browser |
| **Proxy** | The site fetches through the Cloudflare Worker in [`worker/`](worker/), which relays that one endpoint and adds CORS headers. | Cloudflare |
| **Direct** | Fetches `api.vatsim.net` directly. Only works if VATSIM enables CORS. | The user's browser |

### Rate limiting

The VATSIM API rate-limits aggressively. The fetch code in [`src/lib/vatsimApi.ts`](src/lib/vatsimApi.ts):

- spaces requests at least 2 s apart, with at most 8 per rolling minute, shared across open tabs through localStorage
- pages 250 sessions at a time and stops once it has gone past the start of the previous quarter
- reuses fetched data for 15 minutes; after that, a refresh only fetches sessions newer than the saved copy
- allows one manual refresh per CID every 2 minutes
- on HTTP 429, pauses every request until `Retry-After` (or an exponential backoff), retries automatically if the wait is under 90 s, and otherwise shows a countdown

The Worker also caches each response at the edge for 2 minutes.

## How hours are counted

- **Counted positions**: callsigns ending in `CTR FSS APP DEP TWR GND DEL RMP RDO TMU FMP`, each of which can be switched off in Settings. OBS, ATIS, SUP and similar are listed under "Not counted".
- **Quarter boundaries**: calendar quarters in UTC. By default a session that crosses a boundary is split, so each quarter gets the part that falls inside it. Settings can instead count the whole session in the quarter it started, which is what `roster_audit.py` does.
- **Facility matching** uses [VATSpy.dat](https://github.com/vatsimnetwork/vatspy-data-project), downloaded from GitHub and cached for 24 h. For a callsign such as `DC_32_CTR`, the first rule that matches wins:
  1. A user **prefix override**, longest prefix first (`LON_S` before `LON`)
  2. For CTR/FSS: a FIR callsign prefix or FIR code from `[FIRs]`, or a UIR code. Other positions check airports first.
  3. A 4-letter airport ICAO from `[Airports]`, mapped to its FIR
  4. An IATA/LID or pseudo-airport prefix from `[Airports]` (e.g. `PCT`, `DCA`, `ESSEX`). If a code belongs to more than one FIR, the others are shown as alternatives.
  5. For CTR/FSS, an airport match. For other positions, a FIR prefix.
  6. A guess for 3-letter codes: `K` + code (or `C` + code when it starts with `Y`), shown as "Guessed airport"
  7. Otherwise `UNKNOWN`

  Afterwards, **merge overrides** rename the facility, for example `EGPX → EGTT` or `KZDC → ZDC`. Clicking **Reassign** on a position row creates a prefix override.
- **50% + 1**: met when home hours are more than half of all counted hours in the quarter, across the whole network. Exactly 50% does not meet it. The report also shows how many more home hours are needed, or how many hours can still be controlled elsewhere.

## Spreadsheet export

`vatsim-atc-currency_<cid>_<YYYY-MM-DD>_<HHMM>Z.xlsx`, with these sheets:

- **Summary**: CID, data query time, calculation time and export time (all UTC), data source, VATSpy load time, the settings used, and a totals row per quarter
- **Facilities**: one row per quarter and facility, with level breakdown, share, requirement, status and home flag
- **Positions**: one row per quarter and callsign, with facility, level, sessions, hours and match reason
- **Sessions**: one row per session, with real Excel date-times in UTC, full duration, hours inside the quarter, and why a session wasn't counted. Filters are enabled, so it can go straight into a pivot table.
- **Settings**: the overrides and custom requirements in effect

## Stack

- [Vite](https://vite.dev) + React + TypeScript, built to a static bundle
- [Primer CSS](https://primer.style/css), GitHub's design system, for buttons, form controls, typography and utilities. Its design tokens (`@primer/primitives`) provide the light and dark themes, which follow the OS setting. The tables, tabs and notices in `src/styles.css` are built from the same tokens.
- [SheetJS](https://sheetjs.com) for the `.xlsx` export, loaded only when exporting

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (facility matching, aggregation, rate-limit guard)
npm run build      # static site in dist/
```

`dist/` can be served from any static host: GitHub Pages, Cloudflare Pages, Netlify or a plain folder. Asset paths are relative.

To make proxy mode the default for everyone, build with the Worker URL:

```bash
VITE_PROXY_URL=https://vatsim-currency-proxy.<account>.workers.dev npm run build
```

### Deployment

**Site:** [`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs the tests, builds, and publishes to GitHub Pages on every push to `main`. It builds with the repository variable `VITE_PROXY_URL` (Settings → Secrets and variables → Actions → Variables), so the live site defaults to proxy mode.

**Proxy:**

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

`ALLOWED_ORIGINS` in `worker/wrangler.toml` lists the sites allowed to use the relay: the GitHub Pages origin and localhost for development.
