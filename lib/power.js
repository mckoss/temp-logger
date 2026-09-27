import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const helper = fileURLToPath(new URL('../dist/power-status', import.meta.url));
export const POWER_SOURCE = 'Estimated input-rail power (PD0R); not calibrated wall power';
export async function readPower() {
  if (process.platform !== 'darwin') throw new Error('Power sensor requires macOS');
  const { stdout } = await exec(helper, [], { timeout: 2000 });
  const watts = Number(stdout.trim());
  if (!stdout.trim() || !Number.isFinite(watts) || watts <= 0 || watts > 2000) throw new Error('Invalid power reading');
  return watts;
}
export function dayStart(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return +d; }
export function nextDay(ts) { const d = new Date(dayStart(ts)); d.setDate(d.getDate() + 1); return +d; }

// Integrate only closely spaced valid observations. Never bridge sleep or outages.
export function createPowerMonitor({ intervalMs = 1000, demo = false, read = readPower, now = Date.now } = {}) {
  let previous = null, pending = null, timer = null, running = false, lastError = null;
  let intervals = [], recent = [];
  async function collect() {
    try {
      const watts = demo ? 80 + 30 * Math.sin(now() / 45000) : await read();
      if (!Number.isFinite(watts) || watts <= 0 || watts > 2000) throw new Error('Invalid power reading');
      const ts = now();
      if (previous && ts > previous.ts && ts - previous.ts <= intervalMs * 3) {
        let start = previous.ts;
        while (start < ts) {
          const end = Math.min(ts, nextDay(start));
          const fraction = t => (t - previous.ts) / (ts - previous.ts);
          const at = t => previous.watts + (watts - previous.watts) * fraction(t);
          const wh = (at(start) + at(end)) / 2 * (end - start) / 3600000;
          const last = intervals.at(-1);
          if (last && last.end === start && dayStart(last.start) === dayStart(start)) {
            last.end = end; last.wh += wh;
          } else intervals.push({ start, end, wh });
          start = end;
        }
      }
      previous = { ts, watts }; lastError = null;
      recent.push({ ts, value_c: watts });
      recent = recent.filter(point => point.ts >= ts - 3600000).slice(-3600);
    } catch (err) { previous = null; lastError = err.message; }
  }
  function sample() { if (!pending) pending = collect().finally(() => { pending = null; }); return pending; }
  function schedule() {
    timer = setTimeout(async () => { await sample(); if (running) schedule(); }, intervalMs);
  }
  return {
    sample,
    start() { if (!running) { running = true; schedule(); } },
    async stop() { running = false; clearTimeout(timer); await pending; },
    async flush() { await sample(); const result = intervals; intervals = []; return result; },
    status() { return { current: previous, lastError, intervalMs, source: demo ? 'Simulated power' : POWER_SOURCE }; },
    recent() { return recent.slice(); },
  };
}

// Calendar buckets preserve DST and Monday-start weeks. Missing coverage stays missing.
export function aggregateEnergy(intervals, from, to, bucket = 'day') {
  const startOf = ts => {
    const d = new Date(dayStart(ts));
    if (bucket === 'week') d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    return +d;
  };
  const next = ts => { const d = new Date(ts); d.setDate(d.getDate() + (bucket === 'week' ? 7 : 1)); return +d; };
  const points = [];
  for (let start = startOf(from); start < to; start = next(start)) {
    const end = next(start), lo = Math.max(from, start), hi = Math.min(to, end);
    let wh = 0, coveredMs = 0;
    for (const row of intervals) {
      const ms = Math.max(0, Math.min(hi, row.end) - Math.max(lo, row.start));
      if (ms > 0) { coveredMs += ms; wh += row.wh * ms / (row.end - row.start); }
    }
    points.push({ ts: (lo + hi) / 2, start, end, kwh: coveredMs ? wh / 1000 : null,
      avgWatts: coveredMs ? wh * 3600000 / coveredMs : null, coveredMs,
      coverage: coveredMs / (hi - lo), partial: lo > start || hi < end || coveredMs < (hi - lo) * 0.99 });
  }
  return points;
}
