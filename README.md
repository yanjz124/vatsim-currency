# VATSIM ATC Currency

A static website for checking a VATSIM controller's quarterly currency. **Live:** https://yanjz124.github.io/vatsim-currency/

Enter a CID and it shows:

- counted controlling hours for the selected quarter and the one before it
- hours by facility (FIR/ARTCC/ACC or a facility you define), sorted by hours, with a breakdown by level: CTR/FSS, APP/DEP, TWR, GND/DEL/RMP, Other (RDO/TMU/FMP)
- each callsign used, its hours, and how it was matched to a facility
- whether each facility's currency requirement is met (3 h/quarter by default, adjustable per facility)
- separate requirements for specific positions, and positions left out of a facility's currency
- the 50% + 1 check against the member's home facility, taken from VATUSA or the VATSIM division when possible
- an `.xlsx` export with the query and calculation timestamps

All calculation happens in the browser. Settings, fetched sessions and member details are stored on the user's device (localStorage and IndexedDB).

## Data sources

| Source | Used for | How the browser reaches it |
| --- | --- | --- |
| VATSIM API `/v2/members/{cid}/atc` | ATC sessions | Proxy, manual import, or direct (see below) |
| VATSIM API `/v2/members/{cid}` | Division and subdivision | Proxy or direct; skipped in manual import mode |
| VATUSA API `/v2/user/{cid}` | Home and visiting facilities of VATUSA members | Directly, since it sends CORS headers. Only asked when the division is USA or unknown. Visits outside VATUSA aren't listed. |
| [VATSpy Data Project](https://github.com/vatsimnetwork/vatspy-data-project) | FIRs, airports, callsign prefixes, countries | Directly from GitHub, cached for 24 h |

The VATSIM API does not send CORS headers, so browsers block web pages from reading it. There are three ways around that (Settings → Data source):

| Mode | How it works | Requests come from |
| --- | --- | --- |
| **Proxy** (default on the live site) | Requests go through the Cloudflare Worker in [`worker/`](worker/), which relays only the two member endpoints and adds CORS headers. | Cloudflare |
| **Manual import** (default when no proxy is configured) | The site links to the API URL. The user opens it, copies the JSON and pastes it back, adding more pages if the site asks for them. | The user's browser |
| **Direct** | Fetches `api.vatsim.net` directly. Only works if VATSIM enables CORS. | The user's browser |

### Rate limiting

The VATSIM API rate-limits aggressively. [`src/lib/vatsimApi.ts`](src/lib/vatsimApi.ts):

- spaces requests at least 2 s apart, with at most 8 per rolling minute, shared across open tabs through localStorage
- pages 250 sessions at a time and stops once it has gone past the start of the previous quarter
- reuses fetched sessions for 15 minutes, then fetches only newer sessions on refresh
- allows one manual refresh per CID every 2 minutes
- on HTTP 429, pauses every request until `Retry-After` (or an exponential backoff), retries automatically if the wait is under 90 s, and otherwise shows a countdown

Member details are cached for 12 hours. The Worker caches responses at the edge for 2 minutes.

## How hours are counted

- **Counted positions**: callsigns ending in `CTR FSS APP DEP TWR GND DEL RMP RDO TMU FMP`, each of which can be switched off in Settings. OBS, ATIS, SUP and similar are listed under "Not counted".
- **Positions** ignore middle segments: `TOR_AA_APP` and `TOR_AB_APP` both count as `TOR_APP`. Callsigns are still matched to facilities one by one, so variants that land in different facilities are listed separately.
- **Quarter boundaries**: calendar quarters in UTC. By default a session that crosses a boundary is split, so each quarter gets the part inside it. Alternatively, the whole session can count in the quarter it started, as in `roster_audit.py`.
- **Facility matching**: for a callsign such as `DC_32_CTR`, the first rule that matches wins:
  1. A **callsign pattern** on a facility defined in Settings. `*` matches anything (`DC_*`, `IAD_*_TWR`, `*_FSS`). A pattern without `*` matches that prefix (`PCT` covers `PCT_APP`) or the exact callsign. If several match, the one with the most literal characters wins, then the one listed first.
  2. For CTR/FSS: a FIR callsign prefix or FIR code from VATSpy's `[FIRs]`, or a UIR code. Other positions check airports first.
  3. A 4-letter airport ICAO from `[Airports]`, mapped to its FIR
  4. An IATA/LID or pseudo-airport prefix (`PCT`, `DCA`, `ESSEX`). If a code belongs to more than one FIR, the others are shown as alternatives.
  5. For CTR/FSS, an airport match. For other positions, a FIR prefix.
  6. A guess for 3-letter codes: `K` + code (or `C` + code when it starts with `Y`), shown as "Guessed airport"
  7. Otherwise `UNKNOWN`

  The result is then folded into any defined facility that **includes** it. Includes are facility codes, exact unless they contain `*`: `EGPX`, `KZDC`, `ZB*`. Settings can fill includes from a whole VATSpy country. **Reassign** on a position row moves a callsign pattern (`DCA_*`, the exact callsign) or the whole underlying facility (`all of ZGGG`) to any facility. That can be a new custom code such as `VATSSA`, which gets created with an optional name. **Add a facility** under the By facility table defines one that has no hours yet, with callsign patterns and included codes; it stays listed with 0 hours. Settings also has a box for testing a callsign.
- **VATPRC** ships as one facility (code `PRC`) that includes every prefix VATSpy lists for China. It can be edited or removed.
- **Home facility**, chosen per CID in this order:
  1. the user's own pick for that CID, made in the report's Home column
  2. the member's VATUSA home facility (VATUSA facilities aren't VATSIM subdivisions)
  3. a facility defined in Settings with their VATSIM subdivision or division code (such as `PRC`)
  4. a facility built from VATSIM data for their subdivision, or their division if they have none (division USA is left to VATUSA). It includes a FIR with the subdivision's code (`ZYZ` → `CZYZ`), the VATSpy country with the same name (Canada → `CJ*`…`CZ*`, United Kingdom → `EG*`), and facilities tagged in [`src/data/vatsim-orgs.json`](src/data/vatsim-orgs.json). It groups the member's facilities for that report, and **Save it to Settings** turns it into an editable facility.
  5. the facility with the most hours
- **Listed facilities**: facilities with hours, plus the home facility, VATUSA visiting facilities and facilities marked "Always list", even with no hours. A facility's own requirement applies to every member, but doesn't make it appear for members with no hours there.
- **Position requirements**: rules with callsign patterns, optional required hours per quarter, and a "Counts toward facility" switch. A rule with hours gets its own currency check. Hours from a rule that doesn't count toward the facility are left out of that facility's requirement, but still count toward total hours and the 50% + 1 rule.
- **50% + 1**: met when home hours are more than half of all counted hours in the quarter across the network. Exactly 50% does not meet it. The report shows how many more home hours are needed, or how many can still be controlled elsewhere.

## Settings backup

Settings save automatically in the browser. Under Settings → Back up and restore:

- **Export settings** downloads a `.json` backup, including the home-facility pick for each CID.
- **Import settings** restores from that file, or from any `.xlsx` report exported by this version, which carries the same backup on its Settings sheet.
- **Copy settings link** puts the facilities, rules and requirements into a link (`#settings=…`, compressed). Opening it asks before replacing the current settings. Per-CID home picks are not included.

## Spreadsheet export

`vatsim-atc-currency_<cid>_<YYYY-MM-DD>_<HHMM>Z.xlsx`, with these sheets:

- **Summary**: CID, data query time, calculation time and export time (UTC), data source, VATSpy load time, division/subdivision, VATUSA facilities, the home facility and where it came from, the settings used, and totals per quarter
- **Facilities**: per quarter and facility, with hours, currency hours, level breakdown, share, requirement, status, home and visiting flags
- **Positions**: per quarter and callsign, with facility, level, sessions, hours, match reason and position rules
- **Position requirements**: per quarter and rule, when any rules exist
- **Sessions**: one row per session, with real Excel date-times in UTC, hours inside the quarter, and why a session wasn't counted. Filters are enabled for pivot tables.
- **Settings**: facilities, position rules, requirements, and the restorable JSON backup

## Stack

- [Vite](https://vite.dev) + React + TypeScript, built to a static bundle
- [Primer CSS](https://primer.style/css), GitHub's design system, for buttons, form controls, typography and utilities. Its design tokens (`@primer/primitives`) provide the light and dark themes, which follow the OS setting. The tables, tabs and notices in `src/styles.css` are built from the same tokens.
- [SheetJS](https://sheetjs.com) for `.xlsx` export and import, loaded only when needed

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run build      # static site in dist/
```

To make proxy mode the default, build with the Worker URL:

```bash
VITE_PROXY_URL=https://vatsim-currency-proxy.<account>.workers.dev npm run build
```

### VATSIM division data

[`src/data/vatsim-orgs.json`](src/data/vatsim-orgs.json) holds VATSIM's division and subdivision lists, plus facility → division tags learned from real controllers:

```bash
npx tsx scripts/probe-divisions.ts probe-results.json      # look up online controllers' divisions (slow: VATSIM allows 10 lookups a minute)
npx tsx scripts/update-vatsim-orgs.ts probe-results.json   # refresh the lists and tag facilities by majority vote
```

A facility is tagged only when at least two probed controllers agree and they are more than half of everyone seen there, so visiting controllers don't mislabel it.

### Deployment

**Site:** [`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs the tests, builds, and publishes to GitHub Pages on every push to `main`. It builds with the repository variable `VITE_PROXY_URL` (Settings → Secrets and variables → Actions → Variables).

**Proxy:**

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

`ALLOWED_ORIGINS` in `worker/wrangler.toml` lists the sites allowed to use the relay: the GitHub Pages origin and localhost for development.
