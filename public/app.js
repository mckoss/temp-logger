// Dashboard: live sensor cards, per-unit history charts, long-term
// min/max/avg trend bands, and range statistics.

const PALETTE = ['#ffb020', '#ff5d5d', '#4dd0e1', '#9ccc65', '#ba68c8', '#4db6ac'];
const SENSOR_ORDER = ['cpu', 'gpu', 'fan1', 'fan2', 'fan3', 'fan4'];
const RANGES = [
  { label: '1H', ms: 3600e3 },
  { label: '6H', ms: 6 * 3600e3 },
  { label: '24H', ms: 24 * 3600e3 },
  { label: '7D', ms: 7 * 24 * 3600e3 },
  { label: '30D', ms: 30 * 24 * 3600e3 },
];
const TREND_RANGES = [
  { label: '7D', ms: 7 * 24 * 3600e3 },
  { label: '30D', ms: 30 * 24 * 3600e3 },
  { label: '90D', ms: 90 * 24 * 3600e3 },
];

let rangeMs = RANGES[2].ms;
let trendMs = TREND_RANGES[1].ms;
let sensorsMeta = {}; // sensor -> { unit, label }
let sensorList = []; // ordered sensor keys
const charts = {}; // canvasId -> { chart, timestamps }

const $ = (id) => document.getElementById(id);

function sensorLabel(s) {
  return (sensorsMeta[s] && sensorsMeta[s].label) || s;
}
function sensorUnit(s) {
  return (sensorsMeta[s] && sensorsMeta[s].unit) || '';
}
function sensorColor(s) {
  const i = sensorList.indexOf(s);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}

function hexA(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function fmtValue(v, unit) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (unit === 'RPM') return `${Math.round(v).toLocaleString()} RPM`;
  return `${v.toFixed(1)} °C`;
}

function tickLabel(ts, ms, daily) {
  const d = new Date(ts);
  if (daily) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (ms <= 24 * 3600e3) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return (
    d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
}

function fullLabel(ts) {
  return new Date(ts).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function fmtInterval(ms) {
  if (ms >= 3600000) return `${Math.round(ms / 3600000)}h`;
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

// Sensors grouped by unit so each chart has a single honest y-axis.
function groups() {
  const temp = [], fans = [];
  for (const s of sensorList) {
    (sensorUnit(s) === 'RPM' ? fans : temp).push(s);
  }
  return [
    { key: 'temp', title: 'Temperature', unit: '°C', sensors: temp },
    { key: 'fan', title: 'Fan speed', unit: 'RPM', sensors: fans },
  ].filter((g) => g.sensors.length > 0);
}

function baseOptions(unit, tooltipTitle, tooltipLabel, tooltipFilter) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'top',
        labels: { color: '#c9d1d9', usePointStyle: true, pointStyle: 'line' },
      },
      tooltip: {
        callbacks: { title: tooltipTitle, label: tooltipLabel },
        filter: tooltipFilter,
      },
    },
    scales: {
      x: {
        ticks: { color: '#8b949e', maxTicksLimit: 10, maxRotation: 0 },
        grid: { color: 'rgba(48,54,61,0.55)' },
      },
      y: {
        ticks: {
          color: '#8b949e',
          callback: (v) =>
            unit === 'RPM' ? Math.round(v).toLocaleString() : v,
        },
        grid: { color: 'rgba(48,54,61,0.55)' },
        title: { display: true, text: unit, color: '#8b949e' },
      },
    },
  };
}

function makeHistoryChart(canvasId, unit) {
  const chart = new Chart(
    $(canvasId).getContext('2d'),
    {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: baseOptions(
        unit,
        (items) =>
          items.length ? fullLabel(charts[canvasId].timestamps[items[0].dataIndex]) : '',
        (item) => ` ${item.dataset.label}: ${fmtValue(item.parsed.y, unit)}`,
        undefined
      ),
    }
  );
  charts[canvasId] = { chart, timestamps: [] };
}

function makeTrendChart(canvasId, unit) {
  const chart = new Chart(
    $(canvasId).getContext('2d'),
    {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: baseOptions(
        unit,
        (items) =>
          items.length ? fullLabel(charts[canvasId].timestamps[items[0].dataIndex]) : '',
        (item) => ` ${item.dataset.label}: ${fmtValue(item.parsed.y, unit)}`,
        // Only the average lines appear in the tooltip; the band is visual.
        (item) => item.datasetIndex % 3 === 2
      ),
    }
  );
  chart.options.plugins.legend.display = false;
  chart.update();
  charts[canvasId] = { chart, timestamps: [] };
}

function buildChartBlocks() {
  for (const [containerId, prefix, withChips] of [
    ['history-charts', 'hist', false],
    ['trend-charts', 'trend', true],
  ]) {
    const container = $(containerId);
    container.innerHTML = '';
    for (const g of groups()) {
      const canvasId = `${prefix}-${g.key}`;
      const block = document.createElement('div');
      block.className = 'chart-block';
      block.innerHTML =
        `<h3>${g.title}</h3>` +
        `<div class="chart-wrap"><canvas id="${canvasId}"></canvas>` +
        `<div id="${canvasId}-empty" class="chart-empty hidden">No data in this range yet.</div></div>` +
        (withChips ? `<div class="chip-legend" id="chips-${canvasId}"></div>` : '');
      container.appendChild(block);
      if (prefix === 'hist') makeHistoryChart(canvasId, g.unit);
      else makeTrendChart(canvasId, g.unit);
    }
  }
  buildTrendChips();
}

function buildTrendChips() {
  for (const g of groups()) {
    const wrap = $(`chips-trend-${g.key}`);
    if (!wrap) continue;
    wrap.innerHTML = '';
    g.sensors.forEach((s, si) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.innerHTML =
        `<span class="swatch" style="background:${sensorColor(s)}"></span>${sensorLabel(s)}`;
      chip.addEventListener('click', () => {
        const entry = charts[`trend-${g.key}`];
        const base = si * 3;
        const next = !entry.chart.isDatasetVisible(base + 2);
        for (let k = 0; k < 3; k++) entry.chart.setDatasetVisibility(base + k, next);
        chip.classList.toggle('off', !next);
        entry.chart.update();
      });
      wrap.appendChild(chip);
    });
  }
}

function unionTimestamps(series, sensors, getTs) {
  return [
    ...new Set(sensors.flatMap((s) => (series[s] || []).map(getTs))),
  ].sort((a, b) => a - b);
}

async function refreshHistory() {
  const to = Date.now();
  const from = to - rangeMs;
  const res = await fetch(`/api/history?from=${from}&to=${to}&maxPoints=1200`);
  const { series } = await res.json();
  for (const g of groups()) {
    const canvasId = `hist-${g.key}`;
    const entry = charts[canvasId];
    if (!entry) continue;
    const sensors = g.sensors.filter((s) => series[s] && series[s].length);
    $(`${canvasId}-empty`).classList.toggle('hidden', sensors.length > 0);

    const allTs = unionTimestamps(series, g.sensors, (p) => p.ts);
    entry.timestamps = allTs;
    const byTs = {};
    for (const s of g.sensors) {
      byTs[s] = new Map(series[s].map((p) => [p.ts, p.value_c]));
    }
    entry.chart.data.labels = allTs.map((ts) => tickLabel(ts, rangeMs, false));
    entry.chart.data.datasets = sensors.map((s) => {
      const color = sensorColor(s);
      return {
        label: sensorLabel(s),
        data: allTs.map((ts) =>
          byTs[s].has(ts) ? byTs[s].get(ts) : null
        ),
        borderColor: color,
        backgroundColor: hexA(color, 0.07),
        fill: true,
        tension: 0.25,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        spanGaps: true,
      };
    });
    entry.chart.update();
  }
}

async function refreshTrends() {
  const to = Date.now();
  const from = to - trendMs;
  const res = await fetch(`/api/aggregate?from=${from}&to=${to}`);
  const { series, bucket } = await res.json();
  const daily = bucket === 'day';
  for (const g of groups()) {
    const canvasId = `trend-${g.key}`;
    const entry = charts[canvasId];
    if (!entry) continue;
    const sensors = g.sensors.filter((s) => series[s] && series[s].length);
    $(`${canvasId}-empty`).classList.toggle('hidden', sensors.length > 0);

    const allTs = unionTimestamps(series, g.sensors, (p) => p.ts);
    entry.timestamps = allTs;
    const datasets = [];
    for (const s of sensors) {
      const color = sensorColor(s);
      const byTs = new Map((series[s] || []).map((p) => [p.ts, p]));
      const col = (k) => allTs.map((ts) => (byTs.has(ts) ? byTs.get(ts)[k] : null));
      datasets.push(
        {
          label: `${sensorLabel(s)} max`,
          data: col('max'),
          borderColor: 'transparent',
          pointRadius: 0,
          spanGaps: true,
        },
        {
          label: `${sensorLabel(s)} min`,
          data: col('min'),
          borderColor: 'transparent',
          backgroundColor: hexA(color, 0.18),
          fill: '-1',
          pointRadius: 0,
          spanGaps: true,
        },
        {
          label: sensorLabel(s),
          data: col('avg'),
          borderColor: color,
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0,
          pointHoverRadius: 4,
          spanGaps: true,
        }
      );
    }
    entry.chart.data.labels = allTs.map((ts) => tickLabel(ts, trendMs, daily));
    entry.chart.data.datasets = datasets;
    entry.chart.update();
  }
}

function renderCards(latest) {
  const bySensor = Object.fromEntries(latest.map((r) => [r.sensor, r]));
  const wrap = $('cards');
  wrap.innerHTML = '';
  for (const s of sensorList) {
    const row = bySensor[s];
    const unit = sensorUnit(s);
    const el = document.createElement('div');
    el.className = 'card';
    el.style.borderTopColor = sensorColor(s);
    el.innerHTML =
      `<div class="sensor-name">${sensorLabel(s)}</div>` +
      (row
        ? `<div class="temp">${fmtValue(row.value_c, unit).replace(/ (RPM|°C)$/, '<small> $1</small>')}</div>` +
          `<div class="updated">updated ${ago(row.ts)}</div>`
        : `<div class="temp">&mdash;</div><div class="updated">no data yet</div>`);
    wrap.appendChild(el);
  }
}

async function refreshStats() {
  const to = Date.now();
  const from = to - rangeMs;
  const [statsRes, currentRes] = await Promise.all([
    fetch(`/api/stats?from=${from}&to=${to}`),
    fetch('/api/current'),
  ]);
  const { stats } = await statsRes.json();
  const { latest } = await currentRes.json();
  const currentBySensor = Object.fromEntries(latest.map((r) => [r.sensor, r.value_c]));

  const tbody = $('stats-table').querySelector('tbody');
  tbody.innerHTML = '';
  const sensors = sensorList.filter((s) => stats[s]);
  if (!sensors.length) {
    tbody.innerHTML =
      '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No readings in this range yet.</td></tr>';
    return;
  }
  for (const s of sensors) {
    const st = stats[s];
    const unit = sensorUnit(s);
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><span class="swatch" style="background:${sensorColor(s)}"></span>${sensorLabel(s)}</td>` +
      `<td>${fmtValue(currentBySensor[s], unit)}</td>` +
      `<td>${fmtValue(st.min, unit)}</td>` +
      `<td>${fmtValue(st.max, unit)}</td>` +
      `<td>${fmtValue(st.avg, unit)}</td>` +
      `<td>${st.n.toLocaleString()}</td>`;
    tbody.appendChild(tr);
  }
}

async function refreshStatus() {
  const res = await fetch('/api/status');
  const status = await res.json();
  updatePill(status);
  $('sample-info').textContent =
    status.backend === 'none'
      ? 'no backend'
      : `sampling every ${fmtInterval(status.intervalMs)}` +
        (status.rows ? ` · ${status.rows.toLocaleString()} readings stored` : '');
  $('footer-meta').textContent =
    `backend: ${status.backendLabel} · retention: ${status.retentionDays}d`;
}

function updatePill(status) {
  const pill = $('status-pill');
  const text = $('status-text');
  pill.classList.remove('live', 'demo', 'error', 'unknown');
  if (status.backend === 'demo') {
    pill.classList.add('demo');
    text.textContent = 'Demo data';
  } else if (status.backend === 'none') {
    pill.classList.add('error');
    text.textContent = 'Setup needed';
  } else if (status.ok) {
    pill.classList.add('live');
    text.textContent = 'Live';
  } else {
    pill.classList.add('error');
    text.textContent = 'Sensor error';
  }
  $('setup-banner').classList.toggle('hidden', status.backend !== 'none');
}

function buildRanges() {
  const mk = (wrapId, ranges, defIdx, onPick) => {
    const wrap = $(wrapId);
    wrap.innerHTML = '';
    ranges.forEach((r, i) => {
      const b = document.createElement('button');
      b.textContent = r.label;
      if (i === defIdx) b.classList.add('active');
      b.addEventListener('click', () => {
        wrap.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        onPick(r.ms);
      });
      wrap.appendChild(b);
    });
  };
  mk('ranges', RANGES, 2, (ms) => {
    rangeMs = ms;
    refreshHistory();
    refreshStats();
  });
  mk('trend-ranges', TREND_RANGES, 1, (ms) => {
    trendMs = ms;
    refreshTrends();
  });
}

function orderSensors(keys) {
  const ordered = SENSOR_ORDER.filter((s) => keys.includes(s));
  const rest = keys.filter((s) => !SENSOR_ORDER.includes(s)).sort();
  return [...ordered, ...rest];
}

$('copy-btn').addEventListener('click', async () => {
  const cmd = $('install-cmd').textContent;
  try {
    await navigator.clipboard.writeText(cmd);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = cmd;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  $('copy-btn').textContent = 'Copied';
  setTimeout(() => ($('copy-btn').textContent = 'Copy command'), 2000);
});

async function init() {
  buildRanges();
  const { sensors } = await (await fetch('/api/sensors')).json();
  for (const s of sensors) {
    sensorsMeta[s.sensor] = { unit: s.unit, label: s.label };
  }
  sensorList = orderSensors(sensors.map((s) => s.sensor));
  buildChartBlocks();
  await refreshStatus();
  const { latest } = await (await fetch('/api/current')).json();
  renderCards(latest);
  await refreshHistory();
  await refreshStats();
  await refreshTrends();

  setInterval(refreshStatus, 15000);
  setInterval(async () => {
    const { latest } = await (await fetch('/api/current')).json();
    renderCards(latest);
  }, 15000);
  setInterval(() => {
    refreshHistory();
    refreshStats();
  }, 30000);
  setInterval(refreshTrends, 60000);
}

init().catch((err) => {
  $('status-text').textContent = 'Cannot reach server';
  console.error(err);
});
