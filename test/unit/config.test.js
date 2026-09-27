import { it } from 'node:test';
import assert from 'node:assert/strict';
import { numberOption, timeRange } from '../../lib/config.js';

it('validates numeric inputs without silently truncating them', () => {
  for (const value of ['', ' ', '10ms', 'NaN', 'Infinity', '-1', '1.5', ['10'], '9007199254740992']) {
    assert.throws(() => numberOption(value, 'test', 100));
  }
  assert.equal(numberOption(undefined, 'test', 100), 100);
  assert.equal(numberOption('0', 'test', 100), 0);
  assert.throws(() => numberOption('65536', 'PORT', 3000, { max: 65535 }));
  assert.equal(numberOption('0.5', 'retention', 90, { integer: false }), 0.5);
});
it('validates time ranges and preserves epoch zero', () => {
  assert.deepEqual(timeRange({ from: '0', to: '100' }, 1000), { from: 0, to: 100 });
  assert.deepEqual(timeRange({ to: '100' }, 1000), { from: 0, to: 100 });
  assert.throws(() => timeRange({ from: '100', to: '0' }, 1000), /from/);
});
