// temp-logger server: samples Mac temperature/fan sensors into SQLite and
// serves a Chart.js dashboard plus a small JSON API.
//
//   node server.js          # real sensors (npm-managed native backend)
//   node server.js --demo   # synthetic data, for preview/testing
//
// Config via env: HOST, PORT, INTERVAL_MS, DB_PATH, RETENTION_DAYS.

import express from 'express';
import { readFileSync } from 'node:fs';
import { numberOption, timeRange } from './lib/config.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockDatabase } from './lib/instance.js';
import { openDatabase } from './lib/db.js';
import { detectBackend } from './lib/sensors.js';
import { createLogger } from './lib/logger.js';
import { createWorkloadMonitor, WORKLOAD_META } from './lib/workload.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { version, config } = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
const DEMO = process.argv.includes('--demo');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = numberOption(process.env.PORT, 'PORT', config.port, { min: 1, max: 65535 });
const INTERVAL_MS = numberOption(process.env.INTERVAL_MS, 'INTERVAL_MS', DEMO ? 5000 : 300000, { min: 1, max: 2147483647 });
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data', DEMO ? 'demo.db' : 'temps.db');
const RETENTION_DAYS = numberOption(process.env.RETENTION_DAYS, 'RETENTION_DAYS', 90, { min: 0.001, max: 36500, integer: false });

const releaseDatabase = lockDatabase(DB_PATH);
const db = openDatabase(DB_PATH);
const thermalBackend = await detectBackend({ demo: DEMO });
const workload = createWorkloadMonitor({ intervalMs: Math.min(1000, INTERVAL_MS), demo: DEMO });
const backend = {
  ...thermalBackend,
  meta: { ...thermalBackend.meta, ...WORKLOAD_META },
  async sample() {
    const thermal = await thermalBackend.sample();
    const load = await workload.flush();
    return { readings: { ...thermal.readings, ...load.readings }, meta: { ...thermal.meta, ...load.meta } };
  },
};
const logger = createLogger({
  db,
  backend,
  intervalMs: INTERVAL_MS,
});

// Hourly purge of readings older than the retention window.
const purgeTimer = setInterval(() => {
  try {
    const n = db.purgeOlderThan(Date.now() - RETENTION_DAYS * 86400000);
    if (n > 0) console.log(`[temp-logger] purged ${n} readings older than ${RETENTION_DAYS}d`);
  } catch (err) {
    console.error('[temp-logger] purge failed:', err.message);
  }
}, 3600000);

const app = express();
app.use(express.static(join(__dirname, 'public')));
app.get('/status', (req, res) => res.sendFile(join(__dirname, 'public', 'status.html')));
app.use('/vendor/chart.js', express.static(join(__dirname, 'node_modules', 'chart.js', 'dist')));

function badRequest(fn) {
  try { return fn(); } catch (err) { err.status = 400; throw err; }
}
const readRange = (query, duration) => badRequest(() => timeRange(query, duration));
const queryNumber = (...args) => badRequest(() => numberOption(...args));

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
    version,
    pid: process.pid,
    workload: workload.status(),
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

app.get('/api/activity', (req, res) => {
  res.json({ days: db.dailyCounts(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
});

app.get('/api/workload', (req, res) => {
  res.set('Cache-Control', 'no-store').json(workload.status());
});

app.get('/api/current', asyncHandler(async (req, res) => {
  res.json({ latest: db.latest(), serverTime: Date.now() });
}));

// ?from=&to= epoch ms, ?sensors=cpu,gpu,fan1, ?maxPoints=1200
app.get('/api/history', asyncHandler(async (req, res) => {
  const { from, to } = readRange(req.query, 86400000);
  const maxPoints = queryNumber(req.query.maxPoints, 'maxPoints', 1200, { min: 1, max: 5000 });
  const sensors = req.query.sensors
    ? String(req.query.sensors).split(',').filter(Boolean)
    : db.sensors();
  const series = Object.create(null);
  for (const s of sensors) series[s] = db.history(s, from, to, maxPoints);
  res.json({ from, to, series });
}));

// Bucketed min/max/avg per sensor for the long-term trends view.
// ?from=&to= epoch ms, ?sensors=..., ?bucket=hour|day|auto
app.get('/api/aggregate', asyncHandler(async (req, res) => {
  const { from, to } = readRange(req.query, 30 * 86400000);
  const bucket = req.query.bucket ?? 'auto';
  if (!['hour', 'day', 'auto'].includes(bucket)) return res.status(400).json({ error: 'bucket must be hour, day, or auto' });
  const sensors = req.query.sensors
    ? String(req.query.sensors).split(',').filter(Boolean)
    : db.sensors();
  const series = Object.create(null);
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
  const { from, to } = readRange(req.query, 86400000);
  const stats = Object.create(null);
  for (const s of db.sensors()) stats[s] = db.stats(s, from, to);
  res.json({ from, to, stats });
}));

// JSON 404 / error bodies for unknown API routes.
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.status !== 400) console.error('[temp-logger]', err);
  res.status(err.status || 500).json({ error: err.status === 400 ? err.message : 'internal error' });
});

const server = app.listen(PORT, HOST, () => {
  workload.start();
  logger.start();
  console.log(`[temp-logger] backend : ${backend.name}`);
  console.log(`[temp-logger] dashboard: http://${HOST}:${PORT}`);
  if (backend.hint) console.log(`[temp-logger] setup   : ${backend.hint}`);
});

server.on('error', async err => {
  console.error(`[temp-logger] ${err.code === 'EADDRINUSE' ? 'Another instance is already using this address and port' : err.message}`);
  clearInterval(purgeTimer);
  await logger.stop();
  await workload.stop();
  db.close();
  releaseDatabase();
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(purgeTimer);
  await logger.stop();
  await workload.stop();
  server.close(() => {
    db.close();
    releaseDatabase();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
