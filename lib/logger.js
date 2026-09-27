// Serialize samples and let shutdown wait for any pending database write.
export function createLogger({ db, backend, intervalMs }) {
  let timer = null;
  let running = false;
  let pending = Promise.resolve();
  let lastSample = null;
  let lastError = null;
  let failures = 0;
  let totalSamples = 0;
  const startedAt = Date.now();

  async function tick() {
    try {
      const { readings, meta } = await backend.sample();
      const entries = Object.entries(readings);
      if (!entries.length || entries.some(([, value]) => !Number.isFinite(value))) {
        throw new Error('Sensor sample contains no readings or invalid values');
      }
      const ts = Date.now();
      for (const [sensor, value] of entries) {
        db.insert(ts, sensor, value, meta?.[sensor] || backend.meta?.[sensor]);
      }
      lastSample = { ts, readings };
      lastError = null;
      failures = 0;
      totalSamples++;
    } catch (err) {
      lastError = err?.message || String(err);
      failures++;
    }
  }

  function schedule() {
    const started = Date.now();
    pending = tick().finally(() => {
      if (running) timer = setTimeout(schedule, Math.max(0, intervalMs - (Date.now() - started)));
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      timer = null;
      await pending;
    },
    status() {
      return {
        backend: backend.name,
        backendLabel: backend.label,
        ok: backend.name !== 'none' && totalSamples > 0 && failures === 0,
        lastSample, lastError,
        consecutiveFailures: failures,
        totalSamples,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        intervalMs,
        hint: backend.hint || null,
      };
    },
  };
}
