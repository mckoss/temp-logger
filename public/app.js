// Dashboard: live sensor cards, combined history charts, long-term
// min/max/avg trend bands, and range statistics.

const PALETTE = ['#ffb020', '#ff5d5d', '#4dd0e1', '#9ccc65', '#ba68c8', '#f48fb1', '#4db6ac', '#90a4ff'];
const SENSOR_ORDER = ['cpu', 'gpu', 'fan1', 'fan2', 'fan3', 'fan4', 'cpu_load', 'cpu_peak', 'gpu_load', 'gpu_peak'];
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
const UNIT_STORAGE_KEY = 'temp-logger.temperature-unit';
let temperatureUnit = '°C';
let currentReadings = [];
let rangeStats = null;
let thermalStatus = null;
let zoneBounds = [60, 80, 95];
try {
  const saved = JSON.parse(localStorage.getItem('temp-logger.zone-bounds'));
  if (Array.isArray(saved) && saved.length === 3 && saved.every((value, i) => Number.isFinite(value) && value > 0 && value < 200 && (!i || value > saved[i - 1]))) zoneBounds = saved;
} catch { /* Keep the display-guide defaults. */ }
try {
  if (localStorage.getItem(UNIT_STORAGE_KEY) === '°F') temperatureUnit = '°F';
} catch { /* Display preferences still work when storage is unavailable. */ }

function displayUnit(unit) {
  return unit === '°C' ? temperatureUnit : unit;
}

function displayValue(value, unit) {
  if (value == null || !Number.isFinite(value)) return null;
  return unit === '°C' && temperatureUnit === '°F' ? value * 9 / 5 + 32 : value;
}

function updateUnitButtons() {
  $('temperature-units').querySelectorAll('button').forEach(button => {
    const selected = button.dataset.unit === temperatureUnit;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

$('temperature-units').addEventListener('click', event => {
  const button = event.target.closest('button[data-unit]');
  if (!button || button.dataset.unit === temperatureUnit) return;
  temperatureUnit = button.dataset.unit;
  try { localStorage.setItem(UNIT_STORAGE_KEY, temperatureUnit); } catch { /* Optional persistence. */ }
  updateUnitButtons();
  updateZoneInputs();
  renderCards(currentReadings);
  if (rangeStats) renderStats(rangeStats.stats, rangeStats.latest);
  for (const entry of Object.values(charts)) {
    if (entry.sourceDatasets) renderChartUnits(entry);
  }
});
updateUnitButtons();

// Keep original API values so switching units never compounds rounding errors.
function setChartDatasets(entry, datasets) {
  entry.sourceDatasets = datasets;
  renderChartUnits(entry);
}

function renderChartUnits(entry) {
  const visibility = new Map(entry.chart.data.datasets.map((dataset, index) =>
    [dataset.label, entry.chart.isDatasetVisible(index)]));
  entry.chart.data.datasets = entry.sourceDatasets.map(dataset => ({
    ...dataset,
    data: dataset.data.map(point => ({ ...point, y: displayValue(point.y, dataset.unit) })),
  }));
  entry.chart.data.datasets.forEach((dataset, index) => {
    entry.chart.setDatasetVisibility(index, visibility.get(dataset.label) ?? true);
  });
  entry.chart.options.scales.temperature.title.text = `Temperature (${temperatureUnit}) · guide zones`;
  entry.chart.options.scales.temperature.suggestedMin = displayValue(20, '°C');
  entry.chart.options.scales.temperature.suggestedMax = displayValue(Math.max(100, zoneBounds[2] + 5), '°C');
  entry.chart.update();
}

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
  return `${displayValue(v, unit).toFixed(1)} ${displayUnit(unit)}`;
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

function updateZoneInputs() {
  zoneBounds.forEach((value, index) => { $(`zone-${index + 1}`).value = Number(displayValue(value, '°C').toFixed(1)); });
  $('zone-unit').textContent = temperatureUnit;
}
updateZoneInputs();
$('zone-form').addEventListener('submit', event => {
  event.preventDefault();
  const values = [1, 2, 3].map(index => {
    const number = Number($(`zone-${index}`).value);
    return temperatureUnit === '°F' ? (number - 32) * 5 / 9 : number;
  });
  if (values.some((value, index) => !Number.isFinite(value) || value <= 0 || value >= 200 || (index && value <= values[index - 1]))) {
    $('zone-error').textContent = 'Enter three increasing boundaries between 0°C and 200°C (32°F and 392°F).';
    return;
  }
  zoneBounds = values;
  try { localStorage.setItem('temp-logger.zone-bounds', JSON.stringify(values)); } catch {}
  $('zone-error').textContent = 'Display guides saved. These are not Apple temperature limits.';
  renderCards(currentReadings);
  Object.values(charts).forEach(entry => { if (entry.sourceDatasets) renderChartUnits(entry); });
});

function zoneText(value) {
  const index = zoneBounds.findIndex(bound => value < bound);
  const zone = index < 0 ? 3 : index;
  const label = zone === 0 ? `< ${fmtValue(zoneBounds[0], '°C')}` : zone === 3 ? `≥ ${fmtValue(zoneBounds[2], '°C')}` : `${displayValue(zoneBounds[zone - 1], '°C').toFixed(0)}–${fmtValue(zoneBounds[zone], '°C')}`;
  return `Guide zone ${zone + 1} · ${label}`;
}

const guideZones = {
  id: 'temperatureGuideZones',
  beforeDraw(chart) {
    const axis = chart.scales.temperature;
    if (!axis || !chart.chartArea) return;
    const { left, right, top, bottom } = chart.chartArea;
    const limits = [axis.min, ...zoneBounds.map(value => displayValue(value, '°C')), axis.max];
    const colors = ['rgba(77,208,225,0.025)', 'rgba(156,204,101,0.035)', 'rgba(255,176,32,0.06)', 'rgba(255,93,93,0.08)'];
    const ctx = chart.ctx;
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
    for (let i = 0; i < 4; i++) {
      const low = Math.max(axis.min, limits[i]), high = Math.min(axis.max, limits[i + 1]);
      if (low >= high) continue;
      const yTop = axis.getPixelForValue(high), yBottom = axis.getPixelForValue(low);
      ctx.fillStyle = colors[i]; ctx.fillRect(left, yTop, right - left, yBottom - yTop);
      ctx.fillStyle = '#8b949e'; ctx.font = '10px -apple-system, sans-serif';
      ctx.fillText(`Z${i + 1}`, left + 5, Math.min(yBottom - 3, yTop + 12));
    }
    ctx.restore();
  },
};

// One shared time axis, with separate scales for each physical unit.
function sensorAxis(sensor) {
  return sensorUnit(sensor) === 'RPM' ? 'fans' : sensorUnit(sensor) === '%' ? 'load' : 'temperature';
}

function chartOptions(trends) {
  const axis = (title, position, grid = false) => ({
    type: 'linear', position,
    ticks: { color: '#8b949e', maxTicksLimit: 7, callback: value => Number(value.toFixed(1)).toLocaleString() },
    grid: { drawOnChartArea: grid, color: 'rgba(48,54,61,0.55)' },
    title: { display: true, text: title, color: '#8b949e' },
  });
  return {
    responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
    parsing: false,
    interaction: { mode: 'index', axis: 'x', intersect: false },
    plugins: {
      legend: { display: !trends, position: 'top', labels: { color: '#c9d1d9', usePointStyle: true, pointStyle: 'line' } },
      tooltip: {
        callbacks: {
          title: items => items.length ? fullLabel(items[0].parsed.x) : '',
          label: item => ` ${item.dataset.label}: ${fmtValue(item.parsed.y, displayUnit(item.dataset.unit))}`,
        },
        filter: item => !trends || item.dataset.band === 'avg',
      },
    },
    scales: {
      x: {
        type: 'linear',
        ticks: { color: '#8b949e', maxTicksLimit: 8, maxRotation: 0,
          callback: value => tickLabel(value, trends ? trendMs : rangeMs, trends) },
        grid: { color: 'rgba(48,54,61,0.55)' },
      },
      temperature: {
        ...axis(`Temperature (${temperatureUnit}) · guide zones`, 'left', true),
        suggestedMin: displayValue(20, '°C'), suggestedMax: displayValue(Math.max(100, zoneBounds[2] + 5), '°C'),
        afterBuildTicks: scale => {
          const boundaries = zoneBounds.map(value => displayValue(value, '°C'));
          // Preserve guide labels without crowding a nearby automatic tick.
          const spacing = (scale.max - scale.min) * 0.045;
          const regular = scale.ticks.map(tick => tick.value).filter(value =>
            boundaries.every(boundary => Math.abs(boundary - value) >= spacing));
          const values = [...new Set([...regular, ...boundaries])];
          scale.ticks = values.filter(value => value >= scale.min && value <= scale.max).sort((a, b) => a - b).map(value => ({ value }));
        },
        ticks: {
          color: '#8b949e', autoSkip: false,
          callback: value => {
            const index = zoneBounds.findIndex(bound => Math.abs(displayValue(bound, '°C') - value) < 0.01);
            return `${Number(value.toFixed(1))}${index >= 0 ? ` · Z${index + 2}` : ''}`;
          },
        },
      },
      fans: { ...axis('Fans (RPM)', 'right'), beginAtZero: true },
      load: { ...axis('Workload (%)', 'right'), min: 0, max: 100 },
    },
  };
}

function buildChartBlocks() {
  for (const [containerId, canvasId, trends] of [
    ['history-charts', 'history-chart', false],
    ['trend-charts', 'trend-chart', true],
  ]) {
    const container = $(containerId);
    container.innerHTML = `<div class="chart-wrap combined-chart"><canvas id="${canvasId}" aria-label="${trends ? 'Long-term trends' : 'Detailed history'} for temperature, fans, and workload" role="img"></canvas>` +
      `<div id="${canvasId}-empty" class="chart-empty hidden">No data in this range yet.</div></div>` +
      (trends ? '<div class="chip-legend" id="chips-trend"></div>' : '');
    charts[canvasId] = {
      chart: new Chart($(canvasId).getContext('2d'), {
        type: 'line', data: { datasets: [] }, options: chartOptions(trends), plugins: [guideZones],
      }),
    };
  }
  const wrap = $('chips-trend');
  sensorList.forEach((sensor, index) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.setAttribute('aria-pressed', 'true');
    const swatch = document.createElement('span');
    swatch.className = 'swatch'; swatch.style.background = sensorColor(sensor);
    chip.append(swatch, document.createTextNode(sensorLabel(sensor)));
    chip.addEventListener('click', () => {
      const chart = charts['trend-chart'].chart;
      const base = index * 3;
      const visible = !chart.isDatasetVisible(base + 2);
      for (let k = 0; k < 3; k++) chart.setDatasetVisibility(base + k, visible);
      chip.classList.toggle('off', !visible);
      chip.setAttribute('aria-pressed', String(visible));
      chart.update();
    });
    wrap.appendChild(chip);
  });
}

function unionTimestamps(series) {
  return [...new Set(sensorList.flatMap(sensor => (series[sensor] || []).map(point => point.ts)))].sort((a, b) => a - b);
}

function datasetStyle(sensor) {
  return {
    sensor, unit: sensorUnit(sensor), yAxisID: sensorAxis(sensor),
    label: sensorLabel(sensor), borderColor: sensorColor(sensor),
    borderWidth: sensor.endsWith('_peak') ? 1 : 2,
    borderDash: sensor.endsWith('_peak') ? [4, 4] : [],
    pointBackgroundColor: sensorColor(sensor), pointHoverRadius: 4,
    tension: 0, spanGaps: true,
  };
}

let historyRequest = 0;
async function refreshHistory() {
  const request = ++historyRequest;
  const to = Date.now(), from = to - rangeMs;
  const res = await fetch(`/api/history?from=${from}&to=${to}&maxPoints=5000`);
  const { series } = await res.json();
  if (request !== historyRequest) return;
  const timestamps = unionTimestamps(series);
  const entry = charts['history-chart'];
  $('history-chart-empty').classList.toggle('hidden', timestamps.length > 0);
  entry.chart.options.scales.x.min = from;
  entry.chart.options.scales.x.max = to;
  const datasets = sensorList.map(sensor => {
    const points = series[sensor] || [];
    const values = new Map(points.map(point => [point.ts, point.value_c]));
    return {
      ...datasetStyle(sensor), fill: false,
      data: timestamps.map(x => ({ x, y: values.get(x) ?? null })),
      pointRadius: points.length === 1 ? 3 : 0,
    };
  });
  setChartDatasets(entry, datasets);
}

let trendRequest = 0;
async function refreshTrends() {
  const request = ++trendRequest;
  const to = Date.now(), from = to - trendMs;
  const res = await fetch(`/api/aggregate?from=${from}&to=${to}`);
  const { series } = await res.json();
  if (request !== trendRequest) return;
  const timestamps = unionTimestamps(series);
  const entry = charts['trend-chart'];
  $('trend-chart-empty').classList.toggle('hidden', timestamps.length > 0);
  entry.chart.options.scales.x.min = from;
  entry.chart.options.scales.x.max = to;
  const datasets = [];
  for (const sensor of sensorList) {
    const points = series[sensor] || [];
    const values = new Map(points.map(point => [point.ts, point]));
    for (const band of ['max', 'min', 'avg']) {
      datasets.push({
        ...datasetStyle(sensor), band,
        label: band === 'avg' ? sensorLabel(sensor) : `${sensorLabel(sensor)} ${band}`,
        data: timestamps.map(x => ({ x, y: values.get(x)?.[band] ?? null })),
        borderColor: band === 'avg' ? sensorColor(sensor) : 'transparent',
        backgroundColor: hexA(sensorColor(sensor), 0.08),
        fill: band === 'min' ? '-1' : false,
        pointRadius: band === 'avg' && points.length === 1 ? 3 : 0,
      });
    }
  }
  setChartDatasets(entry, datasets);
}

function renderCards(latest) {
  currentReadings = latest;
  const bySensor = Object.fromEntries(latest.map((r) => [r.sensor, r]));
  const wrap = $('cards');
  wrap.innerHTML = '';
  for (const s of sensorList.filter(sensor => sensor === 'cpu' || sensor === 'gpu')) {
    const row = bySensor[s];
    const unit = sensorUnit(s);
    const el = document.createElement('div');
    el.className = 'card';
    el.style.borderTopColor = sensorColor(s);
    el.innerHTML =
      `<div class="sensor-name">${sensorLabel(s)}</div>` +
      (row
        ? `<div class="temp">${fmtValue(row.value_c, unit).replace(/ (RPM|°C|°F|%)$/, '<small> $1</small>')}</div>` +
          `<div class="updated">updated ${ago(row.ts)}</div>` +
          `<div class="thermal-zone">${zoneText(row.value_c)}</div>` +
          `<div class="thermal-state">macOS: ${thermalStatus?.state?.label || 'Unavailable'}${thermalStatus?.state?.level === 3 ? ' · performance impacted' : thermalStatus?.state?.level === 2 ? ' · high thermal pressure' : ''}</div>`
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
  renderStats(stats, latest);
}

function renderStats(stats, latest) {
  rangeStats = { stats, latest };
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

async function refreshThermal() {
  try {
    const response = await fetch('/api/thermal', { cache: 'no-store' });
    if (!response.ok) throw new Error('Thermals unavailable');
    thermalStatus = await response.json();
    if (thermalStatus.latest) {
      renderCards(Object.entries(thermalStatus.latest.readings).map(([sensor, value_c]) => ({ sensor, value_c, ts: thermalStatus.latest.ts })));
    }
  } catch { thermalStatus = null; renderCards(currentReadings); }
}

function renderLiveWorkload(status) {
  const stale = !status.lastSampleAt || Date.now() - status.lastSampleAt > Math.max(5000, status.intervalMs * 3);
  for (const sensor of ['cpu', 'gpu']) {
    const value = status.current?.[sensor];
    const available = !stale && Number.isFinite(value);
    $(`${sensor}-live-value`).textContent = available ? `${value.toFixed(1)}%` : 'Unavailable';
    const meter = $(`${sensor}-live-meter`);
    meter.hidden = !available;
    if (available) meter.value = value;
  }
}

async function refreshLiveWorkload() {
  try {
    const response = await fetch('/api/workload', { cache: 'no-store' });
    if (!response.ok) throw new Error('Workload unavailable');
    renderLiveWorkload(await response.json());
  } catch {
    renderLiveWorkload({ current: {}, lastSampleAt: null });
  } finally {
    setTimeout(refreshLiveWorkload, 1000);
  }
}
refreshLiveWorkload();

async function refreshStatus() {
  const res = await fetch('/api/status');
  const status = await res.json();
  updatePill(status);
  $('app-version').textContent = `v${status.version}`;
  $('sample-info').textContent =
    status.backend === 'none'
      ? 'no backend'
      : `sampling every ${fmtInterval(status.intervalMs)}` +
        (status.rows ? ` · ${status.rows.toLocaleString()} readings stored` : '');
  $('workload-info').textContent = `Workload sampled every ${fmtInterval(status.workload.intervalMs)} · averages and peaks saved every ${fmtInterval(status.intervalMs)} · CPU: 100% = all ${status.workload.coreCount} cores busy`;
  $('workload-info').title = status.workload.lastError || 'GPU values are sampled utilization; brief bursts between samples may be missed.';
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
  await refreshThermal();
  await refreshHistory();
  await refreshStats();
  await refreshTrends();

  setInterval(refreshStatus, 15000);
  setInterval(refreshThermal, 5000);
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
