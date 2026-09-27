// Sampling loop: polls the sensor backend on an interval and writes
// every reading into SQLite (with its unit/label metadata). Keeps the
// latest sample + error state in memory for the status API.

export function createLogger({ db, backend, intervalMs }) {
  let timer = null;
  let lastSample = null; // { ts, readings }
  let lastError = null;
  let failures = 0;
  let totalSamples = 0;
  const startedAt = Date.now();

  async function tick() {
    try {
      const { readings, meta } = await backend.sample();
      const ts = Date.now();
      for (const [sensor, value] of Object.entries(readings)) {
        db.insert(ts, sensor, value, meta?.[sensor] || backend.meta?.[sensor]);
      }
      lastSample = { ts, readings };
      lastError = null;
      failures = 0;
      totalSamples++;
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
      failures++;
    }
  }

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status() {
      return {
        backend: backend.name,
        backendLabel: backend.label,
        ok: backend.name !== 'none' && failures === 0,
        lastSample,
        lastError,
        consecutiveFailures: failures,
        totalSamples,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        intervalMs,
        hint: backend.hint || null,
      };
    },
  };
}
