import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const helper = fileURLToPath(new URL('../dist/temperature-status', import.meta.url));
// Chip-specific key identities from https://github.com/exelban/stats/blob/master/Modules/Sensors/values.swift
// Use only mapped core/GPU sensors, never PMU tdie/tdev or an entire arbitrary key prefix.
export const TEMPERATURE_KEYS = {
  "M1": {
    "cpu": [
      "Tp09",
      "Tp0T",
      "Tp01",
      "Tp05",
      "Tp0D",
      "Tp0H",
      "Tp0L",
      "Tp0P",
      "Tp0X",
      "Tp0b"
    ],
    "gpu": [
      "Tg05",
      "Tg0D",
      "Tg0L",
      "Tg0T"
    ]
  },
  "M2": {
    "cpu": [
      "Tp1h",
      "Tp1t",
      "Tp1p",
      "Tp1l",
      "Tp01",
      "Tp05",
      "Tp09",
      "Tp0D",
      "Tp0X",
      "Tp0b",
      "Tp0f",
      "Tp0j"
    ],
    "gpu": [
      "Tg0f",
      "Tg0j"
    ]
  },
  "M3": {
    "cpu": [
      "Te05",
      "Te0L",
      "Te0P",
      "Te0S",
      "Tf04",
      "Tf09",
      "Tf0A",
      "Tf0B",
      "Tf0D",
      "Tf0E",
      "Tf44",
      "Tf49",
      "Tf4A",
      "Tf4B",
      "Tf4D",
      "Tf4E"
    ],
    "gpu": [
      "Tf14",
      "Tf18",
      "Tf19",
      "Tf1A",
      "Tf24",
      "Tf28",
      "Tf29",
      "Tf2A"
    ]
  },
  "M4": {
    "cpu": [
      "Te05",
      "Te0S",
      "Te09",
      "Te0H",
      "Tp01",
      "Tp05",
      "Tp09",
      "Tp0D",
      "Tp0V",
      "Tp0Y",
      "Tp0b",
      "Tp0e"
    ],
    "gpu": [
      "Tg0G",
      "Tg0H",
      "Tg1U",
      "Tg1k",
      "Tg0K",
      "Tg0L",
      "Tg0d",
      "Tg0e",
      "Tg0j",
      "Tg0k"
    ]
  },
  "M5": {
    "cpu": [
      "Tp00",
      "Tp04",
      "Tp08",
      "Tp0C",
      "Tp0G",
      "Tp0K",
      "Tp0O",
      "Tp0R",
      "Tp0U",
      "Tp0X",
      "Tp0a",
      "Tp0d",
      "Tp0g",
      "Tp0j",
      "Tp0m",
      "Tp0p",
      "Tp0u",
      "Tp0y"
    ],
    "gpu": [
      "Tg0U",
      "Tg0X",
      "Tg0d",
      "Tg0g",
      "Tg0j",
      "Tg1Y",
      "Tg1c",
      "Tg1g"
    ]
  }
};
export function temperatureKeys(model) {
  const generation = model.match(/Apple (M[1-5])(?:\s|$)/)?.[1];
  const mapping = TEMPERATURE_KEYS[generation];
  if (!mapping) throw new Error(`No verified temperature mapping for ${model}`);
  const keys = { cpu: [...mapping.cpu], gpu: [...mapping.gpu] };
  if (generation === 'M4') keys.gpu = keys.gpu.filter(key => /Pro|Max|Ultra/.test(model) ? !['Tg0G', 'Tg0H'].includes(key) : !['Tg1U', 'Tg1k'].includes(key));
  return keys;
}
export function selectTemperatures(values, model) {
  const keys = temperatureKeys(model), result = { sources: {} };
  for (const sensor of ['cpu', 'gpu']) {
    const valid = keys[sensor].filter(key => Number.isFinite(values[key]) && values[key] > 0 && values[key] <= 130);
    const hottest = valid.reduce((best, key) => best == null || values[key] > values[best] ? key : best, null);
    result[sensor] = hottest == null ? null : values[hottest];
    const average = valid.length ? valid.reduce((sum, key) => sum + values[key], 0) / valid.length : null;
    result.sources[sensor] = { average, min: valid.length ? Math.min(...valid.map(key => values[key])) : null, max: result[sensor], values: Object.fromEntries(valid.map(key => [key, values[key]])), method: 'Average mapped SMC sensors', model, key: hottest, count: valid.length, keys: valid };
    result[sensor] = average;
  }
  return result;
}
export async function readMappedTemperatures(model = cpus()[0]?.model || 'Unknown chip') {
  const keys = temperatureKeys(model);
  let stdout;
  try { ({ stdout } = await exec(helper, [...keys.cpu, ...keys.gpu], { timeout: 3000 })); }
  catch (err) { if (err.code === 'ENOENT') throw new Error('Run npm run build:desktop to build the mapped temperature reader'); throw err; }
  return selectTemperatures(JSON.parse(stdout), model);
}
