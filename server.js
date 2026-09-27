// temp-logger server: samples Mac temperature/fan sensors into SQLite and
// serves a Chart.js dashboard plus a small JSON API.
//
//   node server.js          # real sensors (needs `macthermal` or `smctemp`)
//   node server.js --demo   # synthetic data, for preview/testing
//
// Config via env: PORT, INTERVAL_MS, DB_PATH, RETENTION_DAYS.

import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './lib/db.js';
import { detectBackend } from './lib/sensors.js';
import { createLogger } from './lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '3000', 10);
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '300000', 10); // 5 min
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data', 'temps.db');
const RETENTION_DAYS = parseFloat(process.env.RETENTION_DAYS || '90');
const DEMO = process.argv.includes('--demo');

const db = openDatabase(DB_PATH);
const backend = await detectBackend({ demo: DEMO });
const logger = createLogger({
  db,
  backend,
  intervalMs: DEMO ? 5000 : INTERVAL_MS,
});
logger.start();

// Hourly purge of readings older than the retention window.
setInterval(() => {
  try {
    const n = db.purgeOlderThan(Date.now() - RETENTION_DAYS * 86400000);
    if (n > 0) console.log(`[temp-logger] purged ${n} readings older than ${RETENTION_DAYS}d`);
  } catch (err) {
    console.error('[temp-logger] purge failed:', err.message);
  }
}, 3600000);

const app = express();
app.use(express.static(join(__dirname, 'public')));
app.use('/vendor/chart.js', express.static(join(__dirname, 'node_modules', 'chart.js', 'dist')));

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);

// Sensor metadata: historical truth from the db, filled in from the live
// backend for sensors that haven't recorded anything yet.
function sensorMeta() {
  return { ...backend.meta, ...db.sensorMeta() };
}

app.get('/api/status', asyncHandler(async (req, res) => {
  res.json({
    ...logger.status(),
    rows: db.rowCount(),
    retentionDays: RETENTION_DAYS,
    serverTime: Date.now(),
  });
}));

app.get('/api/sensors', asyncHandler(async (req, res) => {
  const meta = sensorMeta();
  const sensors = db.sensors();
  for (const s of Object.keys(backend.meta)) {
    if (!sensors.includes(s)) sensors.push(s);
  }
  res.json({
    sensors: sensors.map((s) => ({
      sensor: s,
      unit: meta[s]?.unit || null,
      label: meta[s]?.label || s,
    })),
  });
}));

app.get('/api/current', asyncHandler(async (req, res) => {
  res.json({ latest: db.latest(), serverTime: Date.now() });
}));

// ?from=&to= epoch ms, ?sensors=cpu,gpu,fan1, ?maxPoints=1200
app.get('/api/history', asyncHandler(async (req, res) => {
  const to = parseInt(req.query.to || String(Date.now()), 10);
  const from = parseInt(req.query.from || String(to - 86400000), 10);
  const maxPoints = Math.min(parseInt(req.query.maxPoints || '1200', 10) || 1200, 5000);
  const sensors = req.query.sensors
    ? String(req.query.sensors).split(',').filter(Boolean)
    : db.sensors();
  const series = {};
  for (const s of sensors) series[s] = db.history(s, from, to, maxPoints);
  res.json({ from, to, series });
}));

// Bucketed min/max/avg per sensor for the long-term trends view.
// ?from=&to= epoch ms, ?sensors=..., ?bucket=hour|day|auto
app.get('/api/aggregate', asyncHandler(async (req, res) => {
  const to = parseInt(req.query.to || String(Date.now()), 10);
  const from = parseInt(req.query.from || String(to - 30 * 86400000), 10);
  const bucket = ['hour', 'day'].includes(req.query.bucket) ? req.query.bucket : 'auto';
  const sensors = req.query.sensors
    ? String(req.query.sensors).split(',').filter(Boolean)
    : db.sensors();
  const series = {};
  let resolvedBucket = bucket === 'auto'
    ? (to - from <= 48 * 3600 * 1000 ? 'hour' : 'day')
    : bucket;
  for (const s of sensors) {
    const r = db.aggregate(s, from, to, bucket);
    series[s] = r.points;
    resolvedBucket = r.bucket;
  }
  res.json({ from, to, bucket: resolvedBucket, series });
}));

app.get('/api/stats', asyncHandler(async (req, res) => {
  const to = parseInt(req.query.to || String(Date.now()), 10);
  const from = parseInt(req.query.from || String(to - 86400000), 10);
  const stats = {};
  for (const s of db.sensors()) stats[s] = db.stats(s, from, to);
  res.json({ from, to, stats });
}));

// JSON 404 / error bodies for unknown API routes.
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[temp-logger]', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

const server = app.listen(PORT, () => {
  console.log(`[temp-logger] backend : ${backend.name}`);
  console.log(`[temp-logger] dashboard: http://localhost:${PORT}`);
  if (backend.hint) console.log(`[temp-logger] setup   : ${backend.hint}`);
});

function shutdown() {
  logger.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
