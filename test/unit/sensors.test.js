// Unit tests for lib/sensors.js — run with: npm test
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTemp,
  parseMacthermalReport,
  detectBackend as detectBackendWithNative,
  sampleNativeSensors,
  INSTALL_HINT,
} from '../../lib/sensors.js';

const detectBackend = (options = {}) => detectBackendWithNative({ nativeLoader: async () => null, ...options });

describe('parseTemp', () => {
  it('parses a plain float', () => {
    assert.equal(parseTemp('64.2\n'), 64.2);
  });

  it('takes the first token when extra text is present', () => {
    assert.equal(parseTemp('64.2 C\n'), 64.2);
  });

  it('returns null for unparseable output', () => {
    assert.equal(parseTemp(''), null);
    assert.equal(parseTemp('n/a'), null);
  });
});

const MACTHERMAL_JSON = JSON.stringify({
  summary: {
    thermalState: 'Nominal',
    hottestC: 65.8,
    averageC: 45.6,
    sensorCount: 5,
    fanCount: 2,
  },
  temperatures: [
    { key: 'TCMz', label: 'CPU die', category: 'CPU', celsius: 65.8 },
    { key: 'TC0p', label: 'CPU core', category: 'CPU', celsius: 61.2 },
    { key: 'TG0p', label: 'GPU', category: 'GPU', celsius: 56.9 },
    { key: 'TB0t', label: 'Battery', category: 'Battery', celsius: 35.8 },
  ],
  fans: [
    { fan: 1, rpm: 2317, min: 1200, max: 5779, target: 2317, utilization: 24 },
    { fan: 2, rpm: 2515, min: 1200, max: 6241, target: 2515, utilization: 26 },
  ],
});

describe('parseMacthermalReport', () => {
  it('takes the hottest reading per CPU/GPU category', () => {
    const { readings, meta } = parseMacthermalReport(MACTHERMAL_JSON);
    assert.equal(readings.cpu, 65.8);
    assert.equal(readings.gpu, 56.9);
    assert.deepEqual(meta.cpu, { unit: '°C', label: 'CPU' });
    assert.deepEqual(meta.gpu, { unit: '°C', label: 'GPU' });
  });

  it('maps each fan to a fan<N> sensor with RPM metadata', () => {
    const { readings, meta } = parseMacthermalReport(MACTHERMAL_JSON);
    assert.equal(readings.fan1, 2317);
    assert.equal(readings.fan2, 2515);
    assert.deepEqual(meta.fan1, { unit: 'RPM', label: 'Fan 1' });
    assert.deepEqual(meta.fan2, { unit: 'RPM', label: 'Fan 2' });
  });

  it('matches categories case-insensitively and ignores unrelated ones', () => {
    const json = JSON.stringify({
      temperatures: [{ key: 'x', label: 'x', category: 'cpu', celsius: 70 }],
      fans: [],
    });
    const { readings } = parseMacthermalReport(json);
    assert.equal(readings.cpu, 70);
    assert.ok(!('gpu' in readings));
  });

  it('throws on invalid JSON', () => {
    assert.throws(() => parseMacthermalReport('not json'), SyntaxError);
  });
});

describe('detectBackend', () => {
  const realPath = process.env.PATH;
  let dir;

  const fakeSmctemp = `#!/bin/sh
case "$1" in
  -c) echo "64.2" ;;
  -g) echo "36.2" ;;
esac
`;
  const fakeMacthermal = `#!/bin/sh
echo '${MACTHERMAL_JSON}'
`;
  const addBin = (name, content) => {
    const bin = join(dir, name);
    writeFileSync(bin, content);
    chmodSync(bin, 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'temp-logger-path-'));
  });

  afterEach(() => {
    process.env.PATH = realPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the demo backend when requested, with fan sensors', async () => {
    const b = await detectBackend({ demo: true });
    assert.equal(b.name, 'demo');
    const { readings, meta } = await b.sample();
    assert.ok(Number.isFinite(readings.cpu), 'cpu is a number');
    assert.ok(Number.isFinite(readings.fan1), 'fan1 is a number');
    assert.ok(readings.fan1 > 500 && readings.fan1 < 8000, 'fan1 in sane range');
    assert.deepEqual(meta.fan1, { unit: 'RPM', label: 'Fan 1' });
  });

  it('prefers macthermal and samples temps + fans from it', async () => {
    addBin('macthermal', fakeMacthermal);
    addBin('smctemp', fakeSmctemp);
    process.env.PATH = `${dir}:${realPath}`;

    const b = await detectBackend();
    assert.equal(b.name, 'macthermal');
    const { readings, meta } = await b.sample();
    assert.deepEqual(readings, { cpu: 65.8, gpu: 56.9, fan1: 2317, fan2: 2515 });
    assert.equal(meta.fan1.unit, 'RPM');
    assert.equal(meta.cpu.unit, '°C');
  });

  it('falls back to smctemp when the macthermal probe fails', async () => {
    addBin('macthermal', '#!/bin/sh\nexit 1\n');
    addBin('smctemp', fakeSmctemp);
    process.env.PATH = `${dir}:${realPath}`;

    const b = await detectBackend();
    assert.equal(b.name, 'smctemp');
    const { readings } = await b.sample();
    assert.deepEqual(readings, { cpu: 64.2, gpu: 36.2 });
    assert.ok(!('fan1' in readings), 'no fans from smctemp');
  });

  it('detects a fake smctemp on PATH and samples from it', async () => {
    addBin('smctemp', fakeSmctemp);
    process.env.PATH = `${dir}:${realPath}`;

    const b = await detectBackend();
    assert.equal(b.name, 'smctemp');
    const { readings } = await b.sample();
    assert.deepEqual(readings, { cpu: 64.2, gpu: 36.2 });
  });

  it('reports "none" with an install hint when no backend exists', async () => {
    process.env.PATH = dir; // empty dir: nothing on PATH
    const b = await detectBackend();
    assert.equal(b.name, 'none');
    assert.equal(b.hint, INSTALL_HINT);
    await assert.rejects(b.sample, /no sensor backend/);
  });
});


describe('native sensors', () => {
  const native = {
    temperature: () => ({ cpu: 61.234, gpu: 48.76 }),
    fans: () => [{ rpm: 2000.7 }, { rpm: 0 }],
  };
  it('prefers the npm backend and reports temperatures and stopped fans', async () => {
    const backend = await detectBackend({ nativeLoader: async () => native });
    assert.equal(backend.name, 'native');
    const sample = await backend.sample();
    assert.deepEqual(sample.readings, { cpu: 61.2, gpu: 48.8, fan1: 2001, fan2: 0 });
    assert.deepEqual(sample.meta.fan2, { unit: 'RPM', label: 'Fan 2' });
  });
  it('ignores unavailable temperatures and invalid fan speeds', () => {
    const result = sampleNativeSensors({
      temperature: () => ({ cpu: null, gpu: -1 }),
      fans: () => [{ rpm: NaN }, { rpm: -1 }, { rpm: 1500 }],
    });
    assert.deepEqual(result.readings, { fan3: 1500 });
  });
  it('rejects an entirely empty sample', () => {
    assert.throws(() => sampleNativeSensors({ temperature: () => ({}), fans: () => [] }), /no usable/);
  });
  it('demo mode never attempts to load native code', async () => {
    const backend = await detectBackend({ demo: true, nativeLoader: () => { throw new Error('must not load'); } });
    assert.equal(backend.name, 'demo');
  });
});
