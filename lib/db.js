// SQLite storage for temperature/fan readings.
// Uses the built-in node:sqlite module (Node 22.13+), zero dependencies.
//
// Schema:
//   readings(ts INTEGER, sensor TEXT, value_c REAL, PRIMARY KEY (ts, sensor))
//   sensor_meta(sensor TEXT PRIMARY KEY, unit TEXT, label TEXT)
//
// `value_c` holds the raw value in the sensor's own unit ("°C" or "RPM" —
// see sensor_meta). History queries downsample server-side so charts stay
// fast; aggregate() buckets min/max/avg for the long-term trends view.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS readings (
      ts      INTEGER NOT NULL,   -- epoch milliseconds
      sensor  TEXT    NOT NULL,   -- e.g. 'cpu', 'gpu', 'fan1'
      value_c REAL    NOT NULL,   -- value in the sensor's own unit
      PRIMARY KEY (ts, sensor)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_readings_sensor_ts ON readings (sensor, ts);
    CREATE TABLE IF NOT EXISTS sensor_meta (
      sensor TEXT PRIMARY KEY,
      unit   TEXT NOT NULL,        -- '°C' or 'RPM'
      label  TEXT NOT NULL         -- display label, e.g. 'Fan 1'
    );
  `);

  const insertStmt = db.prepare(
    'INSERT OR REPLACE INTO readings (ts, sensor, value_c) VALUES (?, ?, ?)'
  );
  const metaStmt = db.prepare(
    `INSERT INTO sensor_meta (sensor, unit, label) VALUES (?, ?, ?)
     ON CONFLICT (sensor) DO UPDATE SET unit = excluded.unit, label = excluded.label`
  );
  const sensorsStmt = db.prepare(
    'SELECT DISTINCT sensor FROM readings ORDER BY sensor'
  );
  const metaAllStmt = db.prepare('SELECT sensor, unit, label FROM sensor_meta');
  const countStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM readings WHERE sensor = ? AND ts >= ? AND ts <= ?'
  );
  // Server-side downsampling: keep roughly maxPoints, evenly spaced.
  const historyStmt = db.prepare(`
    SELECT ts, value_c FROM (
      SELECT ts, value_c, ROW_NUMBER() OVER (ORDER BY ts) AS rn
      FROM readings
      WHERE sensor = ? AND ts >= ? AND ts <= ?
    )
    WHERE (rn - 1) % ? = 0
    ORDER BY ts
  `);
  const statsStmt = db.prepare(`
    SELECT MIN(value_c) AS min, MAX(value_c) AS max, AVG(value_c) AS avg, COUNT(*) AS n
    FROM readings WHERE sensor = ? AND ts >= ? AND ts <= ?
  `);
  const latestStmt = db.prepare(`
    SELECT r.sensor, r.ts, r.value_c FROM
      (SELECT sensor, MAX(ts) AS ts FROM readings GROUP BY sensor) latest
    JOIN readings r ON r.sensor = latest.sensor AND r.ts = latest.ts
  `);
  // Bucketed min/max/avg. Buckets align to local calendar boundaries.
  const aggregateStmt = db.prepare(`
    SELECT MIN(ts) AS ts,
           MIN(value_c) AS min, MAX(value_c) AS max,
           AVG(value_c) AS avg, COUNT(*) AS n
    FROM readings
    WHERE sensor = ? AND ts >= ? AND ts <= ?
    GROUP BY strftime(?, ts / 1000, 'unixepoch', 'localtime')
    ORDER BY ts
  `);
  const purgeStmt = db.prepare('DELETE FROM readings WHERE ts < ?');
  const rowCountStmt = db.prepare('SELECT COUNT(*) AS n FROM readings');

  return {
    insert(ts, sensor, value, meta) {
      insertStmt.run(ts, sensor, value);
      if (meta && meta.unit && meta.label) {
        metaStmt.run(sensor, meta.unit, meta.label);
      }
    },
    sensors() {
      return sensorsStmt.all().map((r) => r.sensor);
    },
    sensorMeta() {
      const out = {};
      for (const r of metaAllStmt.all()) {
        out[r.sensor] = { unit: r.unit, label: r.label };
      }
      return out;
    },
    history(sensor, from, to, maxPoints = 1200) {
      const n = countStmt.get(sensor, from, to).n;
      if (n === 0) return [];
      const stride = Math.max(1, Math.ceil(n / maxPoints));
      return historyStmt.all(sensor, from, to, stride);
    },
    // bucket: 'hour' | 'day' | 'auto' (hour for ranges <= 48h, else day)
    aggregate(sensor, from, to, bucket = 'auto') {
      let b = bucket;
      if (b === 'auto') b = to - from <= 48 * 3600 * 1000 ? 'hour' : 'day';
      const fmt = b === 'day' ? '%Y-%m-%d' : '%Y-%m-%d %H';
      const points = aggregateStmt
        .all(sensor, from, to, fmt)
        .map((r) => ({
          ts: r.ts,
          min: round2(r.min),
          max: round2(r.max),
          avg: round2(r.avg),
          n: r.n,
        }));
      return { bucket: b, points };
    },
    stats(sensor, from, to) {
      const r = statsStmt.get(sensor, from, to);
      return { min: r.min, max: r.max, avg: round2(r.avg), n: r.n };
    },
    latest() {
      return latestStmt.all();
    },
    purgeOlderThan(cutoffTs) {
      return purgeStmt.run(cutoffTs).changes;
    },
    rowCount() {
      return rowCountStmt.get().n;
    },
    close() {
      db.close();
    },
  };
}

function round2(n) {
  return n == null ? n : Math.round(n * 100) / 100;
}
