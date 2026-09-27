# temp-logger

Records your Mac Studio's CPU/GPU temperatures and fan speeds in SQLite,
with a local dashboard for history, min/max/average trends, and range statistics.

## Install and run

Requires Node.js 22.13+ (Node 24 recommended) and npm. For real readings, use
macOS on Apple Silicon with Apple Command Line Tools and Python 3 available
for npm's native addon compilation. Install the tools once if needed with
`xcode-select --install`.

```sh
npm ci
npm run sensors:check
npm start
# Open http://127.0.0.1:3000
```

All application and test dependencies are declared in `package.json`, locked
in `package-lock.json`, and served locally; there are no CDN assets, global npm
packages, or required Homebrew sensor tools. The platform-specific
[`macos-temperature-sensor`](https://github.com/sebhildebrandt/macos-temperature-sensor)
dependency provides CPU/GPU readings and fan RPMs without sudo. It is optional
so installation and demo/testing work on other platforms. Native compilation
still requires the system toolchain described above; npm cannot supply macOS
frameworks or Apple's compiler. `npm run sensors:check` fails clearly if no
working sensor backend is available.

If native installation fails, fix the toolchain and run `npm ci --include=optional`.
For environments that disable install scripts, allow the native package's
`node-gyp rebuild` script. The manifest also declares this permission for npm
versions that support `allowScripts`.

Preview on any platform:

```sh
npm run demo
```

Demo readings go to `data/demo.db`, separately from real readings in
`data/temps.db`. Existing `macthermal` or `smctemp` installations are optional
fallbacks when the npm backend is unavailable. A missing backend shows setup
instructions; real mode never silently substitutes demo data.

## Dashboard

- Current CPU/GPU temperatures (°C) and per-fan speed (RPM).
- Separate temperature and fan history charts over 1H–30D.
- Hourly/daily min/max bands and average lines over 7D–90D.
- Current/min/max/average/sample count per sensor.
- App version from `package.json`, displayed in the header and `/api/status`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address; set `0.0.0.0` to expose on your network |
| `PORT` | `3000` | HTTP port (1–65535) |
| `INTERVAL_MS` | `300000` (demo: `5000`) | Sample interval in milliseconds |
| `DB_PATH` | `data/temps.db` (demo: `data/demo.db`) | SQLite path; `:memory:` for disposable runs |
| `RETENTION_DAYS` | `90` | Retention window, purged hourly |

Invalid numeric configuration fails at startup. Slow samples never overlap;
shutdown waits for the active sample before closing SQLite. The app has no
authentication and binds only to loopback by default.

## API

- `GET /api/status` — version, backend, health, row count, uptime.
- `GET /api/sensors` — sensor keys, units, and labels.
- `GET /api/current` — latest reading per sensor.
- `GET /api/history?from=&to=&sensors=cpu,gpu,fan1&maxPoints=1200` — downsampled series.
- `GET /api/aggregate?from=&to=&sensors=...&bucket=hour|day|auto` — min/max/average buckets.
- `GET /api/stats?from=&to=` — min/max/average/count per sensor.

Supply times as nonnegative integer epoch milliseconds with `from <= to`.
Omit parameters for defaults; empty or invalid numeric parameters return JSON
HTTP 400. `maxPoints` must be an integer from 1 to 5000. Aggregate buckets follow
the server's local calendar. SQLite retains the original `value_c` column name
for both temperature and RPM values; interpret values using sensor metadata.

## Build and tests

```sh
npm run build         # Check all JS and the installed Chart.js browser asset
npm test              # Unit tests, including sensor adapters and sampling lifecycle
npm run test:install  # Install Playwright's Chromium browser once
npm run test:e2e      # Browser and API tests with a fresh in-memory demo database
npm run check         # Build, unit tests, and browser/API tests
```

This app uses plain JavaScript; no bundler or generated assets are required.
Playwright's browser is a test runtime downloaded by the declared Playwright
dependency. Tests refuse to reuse an existing server on port 3101. GitHub Actions
runs all checks on Linux and macOS with Node 22.13 and 24.

## Storage and source

`lib/sensors.js` selects and adapts sensor backends, `lib/logger.js` serializes
sampling, and `lib/db.js` handles SQLite storage, retention, and queries.
`server.js` serves the API and the dashboard in `public/`.

Databases and test output are gitignored. At the default five-minute interval,
each sensor records about 288 rows/day. Stop the server before backing up or
removing a database and its associated WAL files.
