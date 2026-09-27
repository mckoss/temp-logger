// Sensor backends for Apple Silicon Macs.
//
// Priority:
//   0. npm-managed `macos-temperature-sensor` — Apple Silicon temps + fans.
//   1. `macthermal` (brew install guillerDev/tap/macthermal) — CPU/GPU
//      temperatures + fan RPMs via `macthermal --json`, no sudo needed.
//   2. `smctemp` (brew install narugit/tap/smctemp) — CPU/GPU temps only.
//   3. demo mode (--demo) — synthetic data for preview/testing.
//   4. none — the dashboard shows setup instructions.
//
// sample() resolves to { readings, meta } where readings is
// { sensorKey: numericValue } and meta is { sensorKey: { unit, label } }.
// Units are "°C" for temperatures and "RPM" for fans.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const round1 = (n) => Math.round(n * 10) / 10;

async function commandExists(cmd) {
  try {
    await execFileAsync('which', [cmd], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function parseTemp(output) {
  const v = parseFloat(String(output).trim().split(/\s+/)[0]);
  return Number.isFinite(v) ? v : null;
}

// Exported for unit tests.
export { parseTemp };

const TEMP_META = {
  cpu: { unit: '°C', label: 'CPU' },
  gpu: { unit: '°C', label: 'GPU' },
};

// Parse `macthermal --json` output.
// Schema: { temperatures: [{ key, label, category, celsius }],
//           fans: [{ fan, rpm, min, max, target, utilization }] }
// (Sources/MacThermalCore/JSONReport.swift in ulzuhan/macthermal)
export function parseMacthermalReport(jsonText) {
  const report = JSON.parse(jsonText);
  const readings = {};
  const meta = {};

  const hottestByCategory = {};
  for (const t of report.temperatures || []) {
    const cat = String(t.category || '').toUpperCase();
    if (
      Number.isFinite(t.celsius) &&
      (hottestByCategory[cat] == null || t.celsius > hottestByCategory[cat])
    ) {
      hottestByCategory[cat] = t.celsius;
    }
  }
  if (hottestByCategory.CPU != null) {
    readings.cpu = round1(hottestByCategory.CPU);
    meta.cpu = { ...TEMP_META.cpu };
  }
  if (hottestByCategory.GPU != null) {
    readings.gpu = round1(hottestByCategory.GPU);
    meta.gpu = { ...TEMP_META.gpu };
  }

  for (const f of report.fans || []) {
    const idx = Math.trunc(Number(f.fan));
    if (!(idx > 0) || !Number.isFinite(f.rpm)) continue;
    const key = `fan${idx}`;
    readings[key] = Math.round(f.rpm);
    meta[key] = { unit: 'RPM', label: `Fan ${idx}` };
  }

  return { readings, meta };
}

async function sampleMacthermal() {
  const { stdout } = await execFileAsync('macthermal', ['--json'], {
    timeout: 30000,
  });
  const { readings, meta } = parseMacthermalReport(stdout);
  if (Object.keys(readings).length === 0) {
    throw new Error('macthermal returned no usable readings');
  }
  return { readings, meta };
}

// smctemp -c / -g print a single Celsius value each, e.g. "64.2".
// -f = fail-soft: repeat the last good value if a read fails.
async function sampleSmctemp() {
  const [cpu, gpu] = await Promise.all([
    execFileAsync('smctemp', ['-c', '-f'], { timeout: 10000 }).then(
      (r) => parseTemp(r.stdout),
      () => null
    ),
    execFileAsync('smctemp', ['-g', '-f'], { timeout: 10000 }).then(
      (r) => parseTemp(r.stdout),
      () => null
    ),
  ]);
  const readings = {};
  if (cpu != null) readings.cpu = cpu;
  if (gpu != null) readings.gpu = gpu;
  if (Object.keys(readings).length === 0) {
    throw new Error('smctemp returned no usable readings');
  }
  return { readings, meta: { ...TEMP_META } };
}

// Synthetic data so the dashboard can be previewed/tested anywhere.
// Fan RPM tracks CPU temperature the way real fans do.
function makeDemoSampler() {
  const t0 = Date.now();
  const meta = {
    cpu: { unit: '°C', label: 'CPU' },
    gpu: { unit: '°C', label: 'GPU' },
    fan1: { unit: 'RPM', label: 'Fan 1' },
    fan2: { unit: 'RPM', label: 'Fan 2' },
  };
  return async () => {
    const t = (Date.now() - t0) / 1000;
    const noise = (a) => (Math.random() - 0.5) * a;
    const cpu = 54 + 13 * Math.sin(t / 90) + 6 * Math.sin(t / 23 + 1) + noise(1.6);
    const gpu =
      48 + 10 * Math.sin(t / 115 + 1.4) + 5 * Math.sin(t / 31) + noise(1.6);
    const fanTarget = (temp) => 1100 + Math.max(0, temp - 45) * 38;
    return {
      readings: {
        cpu: round1(cpu),
        gpu: round1(gpu),
        fan1: Math.max(0, Math.round(fanTarget(cpu) + noise(60))),
        fan2: Math.max(0, Math.round(fanTarget(cpu) * 1.04 + noise(60))),
      },
      meta,
    };
  };
}

export const INSTALL_HINT = 'npm ci --include=optional';

async function loadNative() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return null;
  return (await import('macos-temperature-sensor')).default;
}

export function sampleNativeSensors(native) {
  const temperatures = native.temperature();
  const readings = {};
  const meta = {};
  for (const sensor of ['cpu', 'gpu']) {
    const value = temperatures[sensor];
    if (Number.isFinite(value) && value > 0) {
      readings[sensor] = round1(value);
      meta[sensor] = { ...TEMP_META[sensor] };
    }
  }
  native.fans().forEach((fan, index) => {
    if (!Number.isFinite(fan.rpm) || fan.rpm < 0) return;
    const sensor = `fan${index + 1}`;
    readings[sensor] = Math.round(fan.rpm);
    meta[sensor] = { unit: 'RPM', label: `Fan ${index + 1}` };
  });
  if (!Object.keys(readings).length) throw new Error('Native sensors returned no usable readings');
  return { readings, meta };
}

export async function detectBackend({ demo = false, nativeLoader = loadNative } = {}) {
  if (demo) {
    const sample = makeDemoSampler();
    return {
      name: 'demo',
      label: 'demo data',
      sample,
      meta: {
        cpu: { unit: '°C', label: 'CPU' },
        gpu: { unit: '°C', label: 'GPU' },
        fan1: { unit: 'RPM', label: 'Fan 1' },
        fan2: { unit: 'RPM', label: 'Fan 2' },
      },
      hint: null,
    };
  }

  try {
    const native = await nativeLoader();
    if (native) {
      const sample = async () => sampleNativeSensors(native);
      const { meta } = await sample();
      return { name: 'native', label: 'macOS sensors', sample, meta, hint: null };
    }
  } catch (err) {
    console.error(`[temp-logger] native sensor probe failed: ${err.message}`);
  }

  if (await commandExists('macthermal')) {
    try {
      // Probe once at startup: validates the tool works and discovers fans.
      const { meta } = await sampleMacthermal();
      return {
        name: 'macthermal',
        label: 'macthermal',
        sample: sampleMacthermal,
        meta,
        hint: null,
      };
    } catch (err) {
      console.error(`[temp-logger] macthermal probe failed: ${err.message}`);
    }
  }

  if (await commandExists('smctemp')) {
    return {
      name: 'smctemp',
      label: 'smctemp (temperatures only)',
      sample: sampleSmctemp,
      meta: { ...TEMP_META },
      hint: null,
    };
  }

  return {
    name: 'none',
    label: 'not configured',
    sample: async () => {
      throw new Error('no sensor backend available');
    },
    meta: {},
    hint: INSTALL_HINT,
  };
}
