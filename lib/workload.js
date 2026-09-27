// Frequent workload samples are reduced in memory; only interval summaries persist.
import { cpus } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const round = value => Math.round(value * 100) / 100;

export const WORKLOAD_META = {
  cpu_load: { unit: '%', label: 'CPU average' },
  cpu_peak: { unit: '%', label: 'CPU peak' },
  gpu_load: { unit: '%', label: 'GPU average' },
  gpu_peak: { unit: '%', label: 'GPU peak' },
};

export function cpuUsage(previous, current) {
  if (!previous.length || previous.length !== current.length) return null;
  let idle = 0, total = 0;
  for (let i = 0; i < current.length; i++) {
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq']) {
      const delta = current[i].times[key] - previous[i].times[key];
      if (!Number.isFinite(delta) || delta < 0) return null;
      total += delta;
      if (key === 'idle') idle += delta;
    }
  }
  return total > 0 ? { value: 100 * (total - idle) / total, weight: total } : null;
}

export function parseGpuUsage(output) {
  const values = [...output.matchAll(/"Device Utilization %"\s*=\s*(\d+(?:\.\d+)?)/g)]
    .map(match => Number(match[1])).filter(value => value >= 0 && value <= 100);
  if (!values.length) throw new Error('GPU utilization is unavailable');
  return Math.max(...values);
}

export async function readGpuUsage() {
  if (process.platform !== 'darwin') throw new Error('GPU utilization requires macOS');
  const { stdout } = await execFileAsync('/usr/sbin/ioreg', ['-r', '-c', 'IOAccelerator', '-l'], {
    timeout: 4000, maxBuffer: 4 * 1024 * 1024,
  });
  return parseGpuUsage(stdout);
}

export function createWorkloadMonitor({ intervalMs = 1000, demo = false, readCpu = cpus, readGpu = readGpuUsage } = {}) {
  let previous = readCpu();
  let timer = null, running = false, pending = null;
  let buckets = {};
  let recentSamples = [];
  let lastSampleAt = null, lastError = null;
  let current = { cpu: null, gpu: null };
  const coreCount = previous.length;

  function add(sensor, value, weight = 1) {
    if (!Number.isFinite(value) || value < 0 || value > 100 || weight <= 0) return;
    const bucket = buckets[sensor] ||= { sum: 0, weight: 0, peak: 0, count: 0 };
    bucket.sum += value * weight;
    bucket.weight += weight;
    bucket.peak = Math.max(bucket.peak, value);
    bucket.count++;
  }

  async function sampleOnce() {
    const errors = [];
    const live = { cpu: null, gpu: null };
    if (demo) {
      const t = Date.now() / 1000;
      live.cpu = 45 + 30 * Math.sin(t / 90);
      live.gpu = 35 + 25 * Math.sin(t / 115);
      add('cpu', live.cpu);
      add('gpu', live.gpu);
    } else {
      try {
        const current = readCpu();
        const usage = cpuUsage(previous, current);
        previous = current;
        if (usage) { live.cpu = usage.value; add('cpu', usage.value, usage.weight); }
      } catch (err) { errors.push(`CPU: ${err.message}`); }
      try {
        const value = await readGpu();
        if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('Invalid utilization');
        live.gpu = value;
        add('gpu', value);
      }
      catch (err) { errors.push(`GPU: ${err.message}`); }
    }
    current = live;
    lastSampleAt = Date.now();
    recentSamples.push({ ts: lastSampleAt, ...live });
    recentSamples = recentSamples.filter(row => row.ts >= lastSampleAt - 3600000).slice(-3600);
    lastError = errors.join('; ') || null;
  }

  // Reuse the active read when a storage tick and workload tick coincide.
  function sample() {
    if (!pending) pending = sampleOnce().finally(() => { pending = null; });
    return pending;
  }
  function schedule(delay = intervalMs) {
    timer = setTimeout(async () => {
      const started = Date.now();
      await sample();
      if (running) schedule(Math.max(0, intervalMs - (Date.now() - started)));
    }, delay);
  }

  return {
    sample,
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      await pending;
    },
    async flush() {
      await pending;
      const readings = {};
      for (const [sensor, bucket] of Object.entries(buckets)) {
        readings[`${sensor}_load`] = round(bucket.sum / bucket.weight);
        readings[`${sensor}_peak`] = round(bucket.peak);
      }
      buckets = {};
      return { readings, meta: WORKLOAD_META };
    },
    recent() { return recentSamples.map(row => ({ ...row })); },
    status() {
      return { intervalMs, coreCount, lastSampleAt, lastError, current: { ...current } };
    },
  };
}
