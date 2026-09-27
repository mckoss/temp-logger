# temp-logger

A small Node.js app that records your Mac Studio's CPU/GPU temperature
and fan-speed history into SQLite and shows it on a local web dashboard
with live Chart.js graphs — including long-term min/max/average trend
bands.

## How it works

- `lib/sensors.js` — reads temperatures + fan RPMs from `macthermal`
  (no sudo needed). Falls back to `smctemp` (temps only), then to
  synthetic demo data with `--demo`, or reports "not configured" if no
  backend is available.
- `lib/logger.js` — samples the backend on an interval and writes every
  reading to SQLite, with per-sensor unit/label metadata.
- `lib/db.js` — SQLite storage via the built-in `node:sqlite` module.
  Server-side downsampling keeps history queries fast; `aggregate()`
  buckets min/max/avg for the trends view.
- `server.js` — Express server: JSON API + static dashboard.

## Requirements

- macOS on Apple Silicon (Mac Studio)
- Node.js 22.5+ (24 LTS recommended — `node:sqlite` is stable there)
- `macthermal` for real readings (temperatures **and** fan speeds):

```sh
brew install guillerDev/tap/macthermal
```

Temperatures only? `brew tap narugit/tap && brew install narugit/tap/smctemp`
also works — the app detects it automatically (no fans in that case).

## Install & run

```sh
cd temp-logger
npm install
node server.js
# dashboard: http://localhost:3000
```

Preview without sensors (synthetic data):

```sh
npm run demo   # or: node server.js --demo
```

## The dashboard

- **Cards** — current CPU, GPU, and per-fan readings (°C / RPM).
- **History** — temperature and fan-speed graphs over 1H–30D, sampled
  every 5 minutes.
- **Long-term trends** — min/max band + average line per sensor,
  bucketed by hour (short ranges) or day, over 7D–90D.
- **Range statistics** — current/min/max/avg/sample count per sensor.

## Configuration (env vars)

| Var              | Default              | What it does                              |
|------------------|----------------------|-------------------------------------------|
| `PORT`           | `3000`               | HTTP port for the dashboard               |
| `INTERVAL_MS`    | `300000`             | Sampling interval, ms (5 min)             |
| `DB_PATH`        | `data/temps.db`      | SQLite database location                  |
| `RETENTION_DAYS` | `90`                 | Readings older than this are purged hourly|

## API

- `GET /api/status` — backend, health, row count, uptime
- `GET /api/sensors` — sensors with unit/label metadata
- `GET /api/current` — latest reading per sensor
- `GET /api/history?from=&to=&sensors=cpu,gpu,fan1&maxPoints=1200` — downsampled series
- `GET /api/aggregate?from=&to=&sensors=...&bucket=hour|day|auto` — min/max/avg buckets
- `GET /api/stats?from=&to=` — min/max/avg/count per sensor

Times are epoch milliseconds.

## Tests

```sh
npm test          # unit tests (node:test, zero extra deps)
npm run test:e2e  # Playwright end-to-end tests (starts a demo server)
```

E2E first run: `npx playwright install chromium`.

## Data

Readings live in `data/temps.db` (gitignored). At the default 5-minute
interval that's ~288 rows/sensor/day — trivial for SQLite. Delete the
file to start fresh.
