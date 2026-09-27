import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTemperatures, temperatureKeys, TEMPERATURE_KEYS } from '../../lib/temperature.js';
import { detectBackend } from '../../lib/sensors.js';

test('M5 readings use separate mapped CPU/GPU sensors and ignore PMU and unrelated keys', () => {
  const result = selectTemperatures({ Tp00: 95, Tp04: 75, Tg0U: 60, Tg0X: 62, 'PMU tdie': 59, 'PMU tdev': 59, TgZZ: 120, TpZZ: 125 }, 'Apple M5 Ultra');
  assert.equal(result.cpu, 85); assert.equal(result.gpu, 61);
  assert.equal(result.sources.cpu.min, 75); assert.equal(result.sources.cpu.max, 95);
  assert.equal(result.sources.cpu.average, 85); assert.equal(result.sources.gpu.average, 61);
  assert.equal(result.sources.cpu.key, 'Tp00'); assert.equal(result.sources.gpu.key, 'Tg0X');
  assert.deepEqual(result.sources.cpu.keys, ['Tp00', 'Tp04']);
});
test('missing or invalid mapped temperatures remain unavailable', () => {
  const result = selectTemperatures({ Tp00: 0, Tp04: 200, Tp08: NaN, Tg0U: 59 }, 'Apple M5 Ultra');
  assert.equal(result.cpu, null); assert.equal(result.sources.cpu.count, 0);
  assert.equal(result.gpu, 59);
  assert.throws(() => temperatureKeys('Unknown chip'), /No verified temperature/);
});
test('CPU and GPU key sets are disjoint for each chip, with M4 variant selection', () => {
  for (const group of Object.values(TEMPERATURE_KEYS)) {
    assert.ok(group.cpu.length); assert.ok(group.gpu.length);
    assert.equal(group.cpu.some(key => group.gpu.includes(key)), false);
  }
  assert.ok(temperatureKeys('Apple M4').gpu.includes('Tg0G'));
  assert.ok(!temperatureKeys('Apple M4 Max').gpu.includes('Tg0G'));
  assert.ok(temperatureKeys('Apple M4 Max').gpu.includes('Tg1U'));
});
test('native integration bypasses ambiguous library summaries, exposes provenance, and never falls back on failure', async () => {
  let fail = false;
  const backend = await detectBackend({ nativeLoader: async () => ({
    temperature: () => { throw new Error('Ambiguous PMU summary must not be used'); },
    readTemperatures: async () => { if (fail) throw new Error('SMC missing'); return selectTemperatures({ Tp00: 95, Tg0U: 60 }, 'Apple M5 Ultra'); },
    fans: () => [{ rpm: 1500 }],
  }) });
  const good = await backend.sample();
  assert.equal(good.readings.cpu, 95); assert.equal(good.readings.gpu, 60);
  assert.equal(good.sources.cpu.key, 'Tp00');
  fail = true;
  const missing = await backend.sample();
  assert.deepEqual(missing.readings, { fan1: 1500 });
  assert.equal(missing.temperatureError, 'SMC missing');
});
