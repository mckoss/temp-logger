// Unit tests for lib/db.js — run with: npm test
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../lib/db.js';

describe('db', () => {
  let dir;
  let db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'temp-logger-db-'));
    db = openDatabase(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('inserts readings and reports them via latest()', () => {
    db.insert(1000, 'cpu', 55.5);
    db.insert(1000, 'gpu', 48.2);
    db.insert(2000, 'cpu', 57.1);

    const latest = db.latest();
    assert.equal(latest.length, 2);
    const cpu = latest.find((r) => r.sensor === 'cpu');
    assert.equal(cpu.ts, 2000);
    assert.equal(cpu.value_c, 57.1);
  });

  it('lists distinct sensors', () => {
    assert.deepEqual(db.sensors(), []);
    db.insert(1000, 'gpu', 48.2);
    db.insert(2000, 'cpu', 55.5);
    assert.deepEqual(db.sensors(), ['cpu', 'gpu']);
  });

  it('returns full history when under maxPoints', () => {
    for (let i = 0; i < 10; i++) db.insert(1000 + i * 1000, 'cpu', 50 + i);
    const rows = db.history('cpu', 0, 20000, 100);
    assert.equal(rows.length, 10);
    assert.ok(rows.every((r, i, a) => i === 0 || a[i - 1].ts < r.ts), 'ascending');
    assert.equal(rows[0].value_c, 50);
    assert.equal(rows[9].value_c, 59);
  });

  it('downsamples history server-side when over maxPoints', () => {
    for (let i = 0; i < 1000; i++) db.insert(i * 1000, 'cpu', 50 + (i % 10));
    const rows = db.history('cpu', 0, 999 * 1000, 100);
    assert.ok(rows.length <= 100, `expected <=100, got ${rows.length}`);
    assert.ok(rows.length >= 50, `expected a reasonable sample, got ${rows.length}`);
    assert.equal(rows[0].ts, 0, 'first point kept');
    assert.ok(rows.every((r, i, a) => i === 0 || a[i - 1].ts < r.ts), 'ascending');
  });

  it('computes min/max/avg/count stats', () => {
    db.insert(1000, 'cpu', 50);
    db.insert(2000, 'cpu', 60);
    db.insert(3000, 'cpu', 70);
    const s = db.stats('cpu', 0, 4000);
    assert.equal(s.min, 50);
    assert.equal(s.max, 70);
    assert.equal(s.avg, 60);
    assert.equal(s.n, 3);
  });

  it('restricts stats/history to the requested window', () => {
    db.insert(1000, 'cpu', 50);
    db.insert(5000, 'cpu', 90);
    const s = db.stats('cpu', 0, 2000);
    assert.equal(s.n, 1);
    assert.equal(s.max, 50);
    assert.equal(db.history('cpu', 0, 2000, 100).length, 1);
  });

  it('purges readings older than the cutoff', () => {
    db.insert(1000, 'cpu', 50);
    db.insert(9000, 'cpu', 60);
    const removed = db.purgeOlderThan(5000);
    assert.equal(removed, 1);
    assert.equal(db.rowCount(), 1);
    assert.equal(db.latest()[0].value_c, 60);
  });

  it('upserts on (ts, sensor) conflict instead of duplicating', () => {
    db.insert(1000, 'cpu', 50);
    db.insert(1000, 'cpu', 55);
    assert.equal(db.rowCount(), 1);
    assert.equal(db.latest()[0].value_c, 55);
  });

  it('stores sensor metadata (unit/label) alongside readings', () => {
    db.insert(1000, 'cpu', 55.5, { unit: '°C', label: 'CPU' });
    db.insert(1000, 'fan1', 2317, { unit: 'RPM', label: 'Fan 1' });
    assert.deepEqual(db.sensorMeta(), {
      cpu: { unit: '°C', label: 'CPU' },
      fan1: { unit: 'RPM', label: 'Fan 1' },
    });
  });

  it('leaves sensorMeta empty when no metadata is provided', () => {
    db.insert(1000, 'cpu', 55.5);
    assert.deepEqual(db.sensorMeta(), {});
  });

  it('updates metadata on re-insert', () => {
    db.insert(1000, 'fan1', 2317, { unit: 'RPM', label: 'Fan 1' });
    db.insert(2000, 'fan1', 2400, { unit: 'RPM', label: 'Left fan' });
    assert.deepEqual(db.sensorMeta().fan1, { unit: 'RPM', label: 'Left fan' });
  });

  it('aggregates hourly buckets with min/max/avg', () => {
    // 3 samples in hour 0, 2 samples in hour 1 (timestamps in ms).
    const h = 3600 * 1000;
    db.insert(10 * 60 * 1000, 'cpu', 50);
    db.insert(20 * 60 * 1000, 'cpu', 60);
    db.insert(30 * 60 * 1000, 'cpu', 70);
    db.insert(h + 10 * 60 * 1000, 'cpu', 80);
    db.insert(h + 20 * 60 * 1000, 'cpu', 90);

    const { bucket, points } = db.aggregate('cpu', 0, 2 * h, 'hour');
    assert.equal(bucket, 'hour');
    assert.equal(points.length, 2);
    assert.deepEqual(
      [points[0].min, points[0].max, points[0].avg, points[0].n],
      [50, 70, 60, 3]
    );
    assert.deepEqual(
      [points[1].min, points[1].max, points[1].avg, points[1].n],
      [80, 90, 85, 2]
    );
    assert.ok(points[0].ts < points[1].ts, 'ascending');
  });

  it('aggregates daily buckets', () => {
    const day = 86400 * 1000;
    db.insert(1000, 'fan1', 1000);
    db.insert(day + 1000, 'fan1', 2000);
    db.insert(2 * day + 1000, 'fan1', 3000);

    const { bucket, points } = db.aggregate('fan1', 0, 3 * day, 'day');
    assert.equal(bucket, 'day');
    assert.equal(points.length, 3);
    assert.equal(points[2].max, 3000);
    assert.equal(points[2].n, 1);
  });

  it('auto-selects hour buckets for short ranges and day for long ones', () => {
    const h = 3600 * 1000;
    db.insert(1000, 'cpu', 50);
    assert.equal(db.aggregate('cpu', 0, 2 * h, 'auto').bucket, 'hour');
    assert.equal(db.aggregate('cpu', 0, 3 * 24 * h, 'auto').bucket, 'day');
  });

  it('returns empty points for a sensor with no data in range', () => {
    const { points } = db.aggregate('cpu', 0, 1000, 'hour');
    assert.deepEqual(points, []);
  });
});
