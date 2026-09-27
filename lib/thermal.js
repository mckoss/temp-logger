import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execFileAsync = promisify(execFile);
const helper = fileURLToPath(new URL('../dist/thermal-status', import.meta.url));
const states = ['Nominal', 'Fair', 'Serious', 'Critical'];

export function parseThermalState(output) {
  const text = String(output).trim();
  if (!/^[0-3]$/.test(text)) throw new Error('Invalid macOS thermal state');
  return { level: Number(text), label: states[Number(text)] };
}
async function readThermalState() {
  if (process.platform !== 'darwin') throw new Error('macOS thermal state unavailable on this platform');
  try {
    const { stdout } = await execFileAsync(helper, [], { timeout: 3000 });
    return parseThermalState(stdout);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('Run npm run build:desktop to enable macOS thermal state');
    throw err;
  }
}

// Live temperatures/pressure update without writing extra database rows.
export function createThermalMonitor({ backend, intervalMs = 5000, demo = false, readState = readThermalState }) {
  let pending = null, timer = null, running = false;
  let latest = null, state = null, stateError = null, sensorError = null;
  async function collect() {
    const [sensorResult, stateResult] = await Promise.allSettled([
      backend.sample(), demo ? Promise.resolve({ level: 0, label: 'Nominal' }) : readState(),
    ]);
    if (stateResult.status === 'fulfilled') {
      state = { ...stateResult.value, sampledAt: Date.now(), demo };
      stateError = null;
    } else { state = null; stateError = stateResult.reason.message; }
    if (sensorResult.status === 'rejected') {
      sensorError = sensorResult.reason.message;
      throw sensorResult.reason;
    }
    sensorError = null;
    const result = sensorResult.value;
    latest = { ts: Date.now(), readings: result.readings };
    return result;
  }
  function sample() {
    if (!pending) pending = collect().finally(() => { pending = null; });
    return pending;
  }
  function schedule() {
    timer = setTimeout(async () => {
      try { await sample(); } catch { /* Errors are exposed in status. */ }
      if (running) schedule();
    }, intervalMs);
  }
  return {
    sample,
    start() { if (!running) { running = true; schedule(); } },
    async stop() { running = false; clearTimeout(timer); try { await pending; } catch {} },
    status() { return { latest, state, stateError, sensorError, intervalMs }; },
  };
}
