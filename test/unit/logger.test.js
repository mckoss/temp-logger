// Unit tests for lib/logger.js — run with: npm test
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../lib/db.js';
import { createLogger } from '../../lib/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fakeBackend = (sampleFn) => ({
  name: 'fake',
  label: 'fake',
  sample: sampleFn,
  meta: {},
  hint: null,
});

describe('logger', () => {
  let dir;
  let db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'temp-logger-logger-'));
    db = openDatabase(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('samples the backend and writes readings with metadata to the db', async () => {
    const backend = fakeBackend(async () => ({
      readings: { cpu: 55.5, fan1: 2317 },
      meta: {
        cpu: { unit: '°C', label: 'CPU' },
        fan1: { unit: 'RPM', label: 'Fan 1' },
      },
    }));
    const logger = createLogger({ db, backend, intervalMs: 30 });
    logger.start();
    await sleep(160);
    await logger.stop();

    const latest = db.latest();
    assert.equal(latest.length, 2);
    assert.equal(latest.find((r) => r.sensor === 'cpu').value_c, 55.5);
    assert.equal(latest.find((r) => r.sensor === 'fan1').value_c, 2317);
    assert.deepEqual(db.sensorMeta(), {
      cpu: { unit: '°C', label: 'CPU' },
      fan1: { unit: 'RPM', label: 'Fan 1' },
    });

    const status = logger.status();
    assert.equal(status.ok, true);
    assert.ok(status.totalSamples >= 3, `expected >=3 samples, got ${status.totalSamples}`);
    assert.equal(status.consecutiveFailures, 0);
    assert.ok(status.lastSample.readings.cpu === 55.5);
  });

  it('tracks consecutive failures and the last error', async () => {
    const backend = fakeBackend(async () => {
      throw new Error('sensor exploded');
    });
    const logger = createLogger({ db, backend, intervalMs: 30 });
    logger.start();
    await sleep(120);
    await logger.stop();

    const status = logger.status();
    assert.equal(status.ok, false);
    assert.equal(status.lastError, 'sensor exploded');
    assert.ok(status.consecutiveFailures >= 2);
    assert.equal(status.totalSamples, 0);
    assert.equal(db.rowCount(), 0);
  });

  it('recovers after transient failures', async () => {
    let calls = 0;
    const backend = fakeBackend(async () => {
      calls++;
      if (calls <= 2) throw new Error('blip');
      return { readings: { cpu: 60 }, meta: { cpu: { unit: '°C', label: 'CPU' } } };
    });
    const logger = createLogger({ db, backend, intervalMs: 30 });
    logger.start();
    await sleep(200);
    await logger.stop();

    const status = logger.status();
    assert.equal(status.ok, true);
    assert.equal(status.consecutiveFailures, 0);
    assert.ok(status.totalSamples >= 1);
  });
});


it('serializes slow samples and stop waits before closing the database', async () => {
  let release;
  const sample = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const writes = [];
  const logger = createLogger({
    db: { insert: (...args) => writes.push(args) },
    backend: fakeBackend(async () => { calls++; return sample; }),
    intervalMs: 5,
  });
  logger.start();
  logger.start();
  assert.equal(logger.status().ok, false);
  await sleep(30);
  assert.equal(calls, 1);
  let stopped = false;
  const stop = logger.stop().then(() => { stopped = true; });
  await sleep(10);
  assert.equal(stopped, false);
  release({ readings: { cpu: 55 }, meta: {} });
  await stop;
  assert.equal(writes.length, 1);
  await sleep(20);
  assert.equal(calls, 1);
});

it('rejects invalid samples before storing any readings', async () => {
  const writes = [];
  const logger = createLogger({
    db: { insert: (...args) => writes.push(args) },
    backend: fakeBackend(async () => ({ readings: { cpu: 50, gpu: NaN } })),
    intervalMs: 1000,
  });
  logger.start();
  await logger.stop();
  assert.equal(writes.length, 0);
  assert.equal(logger.status().ok, false);
  assert.match(logger.status().lastError, /invalid values/);
});
