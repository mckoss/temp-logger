import test from 'node:test';
import assert from 'node:assert/strict';
import { createPowerMonitor, aggregateEnergy } from '../../lib/power.js';
import { openDatabase } from '../../lib/db.js';

test('integrates time-weighted watts, skips outages, and flushes without double counting', async () => {
  let ts = 100000, watts = 100;
  const monitor = createPowerMonitor({ intervalMs: 1000, now: () => ts, read: async () => watts });
  await monitor.sample(); ts += 1000; watts = 200; await monitor.sample();
  ts += 2000; await monitor.sample();
  const first = await monitor.flush();
  assert.equal(first.length, 1);
  assert.ok(Math.abs(first[0].wh - 550 / 3600) < 1e-10);
  ts += 60000; await monitor.sample();
  assert.deepEqual(await monitor.flush(), []);
  ts += 1000; watts = 0; await monitor.sample();
  assert.equal(monitor.status().current, null);
  ts += 1000; watts = 100; await monitor.sample();
  assert.deepEqual(await monitor.flush(), []);
  ts += 1000;
  assert.ok(Math.abs((await monitor.flush())[0].wh - 100 / 3600) < 1e-10);
  assert.deepEqual(await monitor.flush(), []);
});
test('splits integration at midnight and reports daily/weekly energy with coverage', async () => {
  let ts = +new Date(2026, 8, 28, 23, 59, 59);
  const monitor = createPowerMonitor({ now: () => ts, read: async () => 100 });
  await monitor.sample(); ts += 2000;
  const rows = await monitor.flush();
  assert.equal(rows.length, 2);
  const points = aggregateEnergy(rows, rows[0].start, rows[1].end);
  assert.equal(points.length, 2);
  for (const point of points) {
    assert.ok(Math.abs(point.avgWatts - 100) < 1e-8);
    assert.equal(point.coverage, 1); assert.equal(point.partial, true);
  }
  const weekly = aggregateEnergy(rows, rows[0].start, rows[1].end, 'week');
  assert.equal(weekly.length, 1);
  assert.ok(Math.abs(weekly[0].kwh - 200 / 3600000) < 1e-10);
});
test('energy uses calendar day length across daylight saving time and leaves missing days null', () => {
  const oldTZ = process.env.TZ; process.env.TZ = 'America/Los_Angeles';
  try {
    const start = +new Date(2026, 2, 8), end = +new Date(2026, 2, 9);
    assert.equal((end - start) / 3600000, 23);
    const [point, missing] = aggregateEnergy([{ start, end, wh: 2300 }], start, +new Date(2026, 2, 10));
    assert.equal(point.kwh, 2.3); assert.equal(point.avgWatts, 100); assert.equal(point.partial, false);
    assert.equal(missing.kwh, null); assert.equal(missing.coverage, 0);
  } finally { if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ; }
});
test('power storage persists independently, clips queries, and rolls back invalid batches', () => {
  const db = openDatabase(':memory:');
  try {
    db.insertPower([{ start: 0, end: 1000, wh: 0.1 }]);
    assert.throws(() => db.insertPower([{ start: 1000, end: 2000, wh: 0.2 }, { start: 3, end: 2, wh: -1 }]));
    assert.equal(db.powerIntervals(0, 5000).length, 1);
    const [point] = aggregateEnergy(db.powerIntervals(500, 1000), 500, 1000);
    assert.ok(Math.abs(point.kwh - 0.00005) < 1e-10);
    db.purgeOlderThan(2000);
    assert.equal(db.powerIntervals(0, 5000).length, 0);
  } finally { db.close(); }
});
