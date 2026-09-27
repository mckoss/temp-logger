import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseThermalState, createThermalMonitor } from '../../lib/thermal.js';

it('parses only documented macOS thermal state values', () => {
  assert.deepEqual(parseThermalState('0\n'), { level: 0, label: 'Nominal' });
  assert.deepEqual(parseThermalState('3'), { level: 3, label: 'Critical' });
  for (const value of ['', '4', '-1', 'NaN', '1bad']) assert.throws(() => parseThermalState(value));
});
it('shares in-flight live samples and reports OS pressure independently of temperature', async () => {
  let resolve;
  const reading = new Promise(done => { resolve = done; });
  let calls = 0;
  const monitor = createThermalMonitor({ backend: { sample: () => { calls++; return reading; } }, readState: async () => ({ level: 3, label: 'Critical' }) });
  const first = monitor.sample();
  assert.equal(first, monitor.sample());
  resolve({ readings: { cpu: 65, gpu: 60 }, meta: {} });
  await first;
  assert.equal(calls, 1);
  assert.equal(monitor.status().state.label, 'Critical');
  assert.equal(monitor.status().latest.readings.cpu, 65);
  await monitor.stop();
});
it('keeps temperature logging available when OS pressure cannot be read', async () => {
  const monitor = createThermalMonitor({ backend: { sample: async () => ({ readings: { cpu: 90 }, meta: {} }) }, readState: async () => { throw new Error('helper missing'); } });
  assert.equal((await monitor.sample()).readings.cpu, 90);
  assert.equal(monitor.status().state, null);
  assert.equal(monitor.status().stateError, 'helper missing');
  await monitor.stop();
});
