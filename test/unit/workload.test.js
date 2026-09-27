import { it } from 'node:test';
import assert from 'node:assert/strict';
import { cpuUsage, parseGpuUsage, createWorkloadMonitor } from '../../lib/workload.js';
const cores = (busy, idle, count = 30) => Array.from({ length: count }, () => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }));

it('normalizes busy time across all 30 CPU cores', () => {
  const previous = cores(0, 0);
  const current = cores(0, 100);
  current[0] = cores(100, 0, 1)[0];
  assert.ok(Math.abs(cpuUsage(previous, current).value - 100 / 30) < 1e-9);
  assert.equal(cpuUsage(previous, cores(100, 0)).value, 100);
  assert.equal(cpuUsage(previous, cores(0, 100)).value, 0);
  assert.equal(cpuUsage(previous, cores(50, 50)).value, 50);
  assert.equal(cpuUsage(previous, previous), null);
  assert.equal(cpuUsage(cores(100, 100), previous), null);
});

it('parses GPU utilization and distinguishes zero from unavailable', () => {
  assert.equal(parseGpuUsage('"Device Utilization %"=0'), 0);
  assert.equal(parseGpuUsage('"Device Utilization %" = 32.5'), 32.5);
  assert.throws(() => parseGpuUsage('"Renderer Utilization %"=20'), /unavailable/);
  assert.throws(() => parseGpuUsage('"Device Utilization %"=101'), /unavailable/);
});

it('reduces frequent samples into weighted CPU averages and sampled peaks without retaining old windows', async () => {
  const cpu = [cores(0, 0), cores(50, 50), cores(50, 250)];
  const gpu = [20, 80];
  const monitor = createWorkloadMonitor({ readCpu: () => cpu.shift(), readGpu: async () => gpu.shift() });
  await monitor.sample();
  await monitor.sample();
  const summary = await monitor.flush();
  assert.deepEqual(summary.readings, { cpu_load: 16.67, cpu_peak: 50, gpu_load: 50, gpu_peak: 80 });
  assert.equal(summary.meta.cpu_load.unit, '%');
  assert.deepEqual((await monitor.flush()).readings, {});
  assert.deepEqual(monitor.status().current, { cpu: 0, gpu: 80 });
  assert.equal(monitor.status().coreCount, 30);
});

it('keeps CPU samples when GPU is unavailable without inventing idle GPU readings', async () => {
  let n = 0;
  const monitor = createWorkloadMonitor({ readCpu: () => cores(n++ * 50, n * 50), readGpu: async () => { throw new Error('missing'); } });
  await monitor.sample();
  const summary = await monitor.flush();
  assert.equal(summary.readings.cpu_load, 50);
  assert.equal(summary.readings.gpu_load, undefined);
  assert.equal(monitor.status().current.gpu, null);
  assert.match(monitor.status().lastError, /GPU: missing/);
});

it('serializes pending samples and drains them before stopping', async () => {
  let resolve;
  const gpu = new Promise(done => { resolve = done; });
  let calls = 0;
  const monitor = createWorkloadMonitor({ intervalMs: 5, readGpu: () => { calls++; return gpu; } });
  const first = monitor.sample();
  assert.equal(first, monitor.sample());
  let stopped = false;
  const stop = monitor.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  resolve(25);
  await stop;
  assert.equal(calls, 1);
  assert.equal((await monitor.flush()).readings.gpu_load, 25);
});
