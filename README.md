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
# Open http://127.0.0.1:49173
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

- Current CPU/GPU temperatures and per-fan speed (RPM).
- Header °C/°F toggle updates all temperature displays and remembers your choice
  in this browser. Stored readings and API values always remain in Celsius.
- One detailed chart overlays temperature, fans, and workload over 1H–30D,
  with independent °C/°F, RPM, and 0–100% axes and up to 5,000 saved points per series.
  Values use their actual timestamps. Click legend entries to isolate series.
- One combined long-term chart shows hourly/daily min/max bands and average
  lines over 7D–90D, with per-sensor toggle chips.
- Current/min/max/average/sample count per sensor.
- App version from `package.json`, displayed in the header and `/api/status`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address; set `0.0.0.0` to expose on your network |
| `PORT` | `49173` | HTTP port (1–65535) |
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


## Live workload and history

The top row shows live CPU and GPU utilization, sampled and refreshed about once
per second. CPU is busy time across all cores divided by total available CPU
time: one busy core on a 30-core Mac is 3.3%; all cores busy is 100%. This weights
cores equally rather than estimating throughput from core type or clock speed.
GPU utilization comes from macOS's built-in `ioreg` Device Utilization counter.
No additional package or sudo is required. Missing GPU readings show unavailable,
not zero. Short bursts between polls can still be missed.

Only summaries are saved with each thermal sample (five minutes by default):
`cpu_load` / `gpu_load` are averages, and `cpu_peak` / `gpu_peak` are sampled peaks.
All four use `%` metadata and the 0–100% workload axis in both combined charts. CPU averages are
weighted by observed CPU time; GPU averages are the mean of valid observations.
The first summary appears after the first storage interval. Live observations
remain in memory and do not create extra SQLite rows. Shutdown or a crash may
lose the unfinished interval. The Fahrenheit toggle does not change percentages,
RPM, stored temperatures, or API temperature values.

`GET /api/workload` provides live workload, core count, timestamp, and errors.
The Status page (`/status`) confirms the server process is reachable, shows PID,
uptime, last saved sample, and errors. `GET /api/activity` returns the last 30
local calendar days, including today and zero-filled days, with sampling-cycle
and sensor-datapoint counts. Counts reflect retained data; today is partial.

## Native window and automatic startup (macOS)

```sh
npm run service:install   # Build native app, install login agents, start both
npm run service:status   # Inspect the supervised logger
npm run app              # Open/reopen the native window
npm run service:uninstall # Stop/remove login agents; preserve app, data, logs
```

The app is installed at `~/Applications/Temp Logger.app`. Drag it into the Dock
or choose Options → Keep in Dock. The window uses Apple's WKWebView and has no
browser toolbar. Window → Always on Top (Shift-Command-T) toggles floating and
remembers the setting. Closing the window leaves the logger running; opening
the Dock app brings the dashboard back.

Two per-user launchd agents start at login: `com.mckoss.temp-logger` supervises
the Node logger/web server, and `com.mckoss.temp-logger.window` opens the native
window. The logger restarts after an exit or crash. The window restarts after a
crash but stays closed after a normal close/quit. This runs while logged in;
it is not a system service before login, and sleeping Macs cannot collect samples.

The default port is **49173**, taken from `package.json` by the server, app build,
and service installer. It binds only to `127.0.0.1`, away from usual development
ports. A database lock prevents duplicate loggers even on different ports, and a
second server on the same address/port exits before sampling. launchd maintains
one managed process. Stale locks recover after a crash (typically 10–20 seconds). Port conflicts are reported in the service logs.
Manual `PORT` overrides are for development; the installed window/service use
the manifest port. Re-run `service:install` after moving the checkout, changing
Node's executable location, or updating the native app.

Logs are in `~/Library/Logs/temp-logger/`. Agent definitions are in
`~/Library/LaunchAgents/`. The service runs the primary checkout directly and
stores data in its `data/temps.db`; keep that checkout available. Native builds
use Apple's Swift compiler and Cocoa/WebKit frameworks, with no added npm
runtime dependencies. `npm run build:desktop` creates the app bundle in `dist/`.


## Thermal pressure and display guides

Current CPU/GPU cards refresh from live sensor observations about every five
seconds, independently of five-minute database writes. `/api/thermal` exposes
these live readings and macOS's system-wide thermal-pressure state. The native
helper built by `npm run build:desktop` reads Foundation's `ProcessInfo.thermalState`:
Nominal (normal limits), Fair (slightly elevated), Serious (high), or Critical
(significant performance impact). Unavailable telemetry is shown as unavailable.
This is a system thermal-pressure signal, not a measurement of exact CPU clock
reduction or a per-chip throttle flag.

Apple publishes no fixed die-temperature boundaries in its thermal-state API.
The Mac Studio's 10–35°C operating specification is **ambient room temperature**,
not a CPU/GPU temperature target. See [Apple's thermal-state definitions](https://developer.apple.com/documentation/foundation/processinfo/thermalstate-swift.enum)
and [Mac Studio handling guidance](https://support.apple.com/en-ie/guide/mac-studio/apd876e1a2ea/2026/mac/27).

Numbered chart/card zones are **app-defined visual guides**, not Apple limits or
recommended safe temperatures. Defaults are below 60°C, 60–80°C, 80–95°C, and
95°C or above. Edit the three boundaries in “Temperature guide zones”; choices
are stored in this browser. Boundaries and axis labels convert with °C/°F.
Use macOS pressure to assess reported thermal stress rather than inferring a
throttle event from a guide-zone number. Historical chart bands are guides,
not historical measurements of macOS thermal pressure.
