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

let rangeMs = RANGES[0].ms;
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
let storageIntervalMs = 300000;
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
    data: dataset.data.map(point => ({ ...point, y: displayValue(point.y, dataset.unit), low: displayValue(point.low, dataset.unit), high: displayValue(point.high, dataset.unit) })),
  }));
  entry.chart.data.datasets.forEach((dataset, index) => {
    entry.chart.setDatasetVisibility(index, visibility.get(dataset.label) ?? true);
  });
  if (entry.chart.options.scales.temperature) {
    entry.chart.options.scales.temperature.title.text = `Temperature (${temperatureUnit}) · guide zones`;
    entry.chart.options.scales.temperature.suggestedMin = displayValue(Math.min(30, ...(entry.rangeExtent || [])), '°C');
    entry.chart.options.scales.temperature.suggestedMax = displayValue(Math.max(80, ...(entry.rangeExtent || [])), '°C');
  }
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
  const [a, b, c] = zoneBounds.map(value => fmtValue(value, '°C'));
  $('zone-legend').textContent = `Zone 1: below ${a} · Zone 2: ${a} to below ${b} · Zone 3: ${b} to below ${c} · Zone 4: ${c} and above`;
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
  updateZoneInputs();
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
    const colors = ['#32d74b', '#ffdd00', '#ff9500', '#ff453a'];
    const ctx = chart.ctx;
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
    for (let i = 0; i < 4; i++) {
      const low = Math.max(axis.min, limits[i]), high = Math.min(axis.max, limits[i + 1]);
      if (low >= high) continue;
      const yTop = axis.getPixelForValue(high), yBottom = axis.getPixelForValue(low);
      ctx.fillStyle = colors[i];
      ctx.globalAlpha = 0.2; ctx.fillRect(left, yTop, right - left, yBottom - yTop);
      ctx.globalAlpha = 1; ctx.fillRect(left, yTop, 8, yBottom - yTop);
      ctx.fillStyle = '#f0f6fc'; ctx.font = 'bold 10px -apple-system, sans-serif';
      ctx.fillText(`Z${i + 1}`, left + 13, Math.min(yBottom - 3, yTop + 12));
    }
    ctx.restore();
  },
};

// Independent vertical scales, with exactly aligned plot areas and time bounds.
const GROUP_KINDS = ['temperature', 'utilization', 'fans', 'power'];
const chartId = (group, kind) => kind === 'temperature' ? `${group}-chart` : `${group}-${kind}`;
const groupSensors = kind => sensorList.filter(sensor => kind === 'temperature' ? ['cpu', 'gpu'].includes(sensor) : kind === 'utilization' ? ['cpu_load', 'gpu_load'].includes(sensor) : sensorUnit(sensor) === 'RPM');
const cursorTimes = {};
const sharedCursor = {
  id: 'sharedCursor',
  afterEvent(chart, args) {
    const group = chart.$group;
    cursorTimes[group] = args.event.type === 'mouseout' || !args.inChartArea ? null : chart.scales.x.getValueForPixel(args.event.x);
    for (const entry of Object.values(charts)) if (entry.group === group) entry.chart.draw();
  },
  afterDraw(chart) {
    const time = cursorTimes[chart.$group];
    if (time == null || !chart.chartArea) return;
    const x = chart.scales.x.getPixelForValue(time), { top, bottom } = chart.chartArea;
    chart.ctx.save(); chart.ctx.strokeStyle = '#b1bac4'; chart.ctx.setLineDash([3, 3]);
    chart.ctx.beginPath(); chart.ctx.moveTo(x, top); chart.ctx.lineTo(x, bottom); chart.ctx.stroke(); chart.ctx.restore();
  },
};
// Min–max whiskers show the sensor spread, not statistical confidence.
const sensorRanges = {
  id: 'sensorRanges',
  afterDatasetsDraw(chart) {
    const axis = chart.scales.temperature;
    if (!axis) return;
    const { left, right, top, bottom } = chart.chartArea, ctx = chart.ctx;
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
    chart.data.datasets.forEach((dataset, index) => {
      if (!chart.isDatasetVisible(index) || dataset.band && dataset.band !== 'avg') return;
      ctx.strokeStyle = dataset.borderColor; ctx.globalAlpha = 0.45; ctx.lineWidth = 1;
      const step = Math.max(1, Math.ceil(dataset.data.length / Math.max(1, (right - left) / 12)));
      dataset.data.forEach((point, i) => {
        if (i % step && i !== dataset.data.length - 1 || point.low == null || point.high == null) return;
        const x = chart.scales.x.getPixelForValue(point.x), lo = axis.getPixelForValue(point.low), hi = axis.getPixelForValue(point.high);
        ctx.beginPath(); ctx.moveTo(x, lo); ctx.lineTo(x, hi);
        ctx.moveTo(x - 3, lo); ctx.lineTo(x + 3, lo); ctx.moveTo(x - 3, hi); ctx.lineTo(x + 3, hi); ctx.stroke();
      });
    });
    ctx.restore();
  },
};
function chartOptions(group, kind) {
  const trends = group === 'trend';
  const y = {
    type: 'linear', position: 'left', afterFit: scale => { scale.width = 92; },
    ticks: { color: '#8b949e', maxTicksLimit: kind === 'temperature' ? 7 : 4, callback: value => kind === 'power' && trends ? value.toLocaleString(undefined, { maximumSignificantDigits: 3 }) : Number(value.toFixed(2)).toLocaleString() },
    grid: { color: 'rgba(48,54,61,0.55)' },
    title: { display: true, color: '#8b949e', text: kind === 'temperature' ? `Temperature (${temperatureUnit}) · guide zones` : kind === 'utilization' ? 'Utilization (%)' : kind === 'fans' ? 'Fans (RPM)' : trends ? 'Energy (kWh)' : 'Power (W)' },
  };
  if (kind === 'temperature') {
    y.suggestedMin = displayValue(30, '°C'); y.suggestedMax = displayValue(80, '°C');
    y.afterBuildTicks = scale => {
      const boundaries = zoneBounds.map(value => displayValue(value, '°C'));
      const spacing = (scale.max - scale.min) * 0.07;
      const regular = scale.ticks.map(tick => tick.value).filter(value => boundaries.every(bound => Math.abs(bound - value) >= spacing));
      scale.ticks = [...new Set([...regular, ...boundaries])].filter(value => value >= scale.min && value <= scale.max).sort((a, b) => a - b).map(value => ({ value }));
    };
    y.ticks.autoSkip = false;
    y.ticks.callback = value => {
      const index = zoneBounds.findIndex(bound => Math.abs(displayValue(bound, '°C') - value) < 0.01);
      return `${Number(value.toFixed(1))}${index >= 0 ? ` · Z${index + 2}` : ''}`;
    };
  } else y.beginAtZero = true;
  if (kind === 'utilization') { y.min = 0; y.max = 100; }
  return {
    responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
    layout: { padding: { right: 12 } },
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: { legend: { display: false }, tooltip: {
      filter: item => !item.dataset.band || item.dataset.band === 'avg',
      callbacks: {
        title: items => items.length ? fullLabel(items[0].parsed.x) : '',
        label: item => {
          if (item.dataset.unit === 'kWh') {
            const p = item.raw;
            return [` ${p.y.toFixed(3)} kWh${p.partial ? ' · partial period' : ''}`, ` Average: ${p.avgWatts.toFixed(1)} W`, ` Coverage: ${(p.coverage * 100).toFixed(1)}%`];
          }
          const range = item.raw?.low != null && item.raw?.high != null ? ` · range ${fmtValue(item.raw.low, displayUnit(item.dataset.unit))}–${fmtValue(item.raw.high, displayUnit(item.dataset.unit))}` : '';
          return ` ${item.dataset.label}: ${fmtValue(item.parsed.y, displayUnit(item.dataset.unit))}${range}`;
        },
      },
    } },
    scales: {
      x: { type: 'linear', offset: false, display: kind === 'power',
        ticks: { color: '#8b949e', maxTicksLimit: 6, maxRotation: 0, align: 'inner', callback: value => tickLabel(value, trends ? trendMs : rangeMs, trends) },
        grid: { color: 'rgba(48,54,61,0.55)' },
      },
      [kind]: y,
    },
  };
}
function buildChartBlocks() {
  for (const group of ['history', 'trend']) {
    const container = $(`${group}-charts`);
    container.className = 'chart-stack';
    for (const kind of GROUP_KINDS) {
      const id = chartId(group, kind), trends = group === 'trend';
      const zone = document.createElement('div'); zone.className = `plot-zone plot-${kind}`;
      zone.innerHTML = `<div class="plot-heading"><h3>${kind === 'temperature' ? 'Temperatures' : kind === 'utilization' ? 'CPU / GPU utilization' : kind === 'fans' ? 'Fans' : 'Power'}</h3><div class="chip-legend" id="chips-${group}-${kind}"></div></div><div class="chart-wrap"><canvas id="${id}" role="img" aria-label="${trends ? 'Long-term' : 'Real-time'} ${kind}"></canvas><div id="${id}-empty" class="chart-empty hidden">No readings in this period</div></div>`;
      if (kind === 'utilization') {
        const note = document.createElement('p'); note.className = 'fine';
        note.textContent = trends ? 'Daily averages and min–max bands of saved interval averages · 100% CPU = all cores busy' : 'Recent one-second samples · earlier five-minute averages · 100% CPU = all cores busy';
        zone.querySelector('.plot-heading').after(note);
      }
      container.appendChild(zone);
      const chart = new Chart($(id).getContext('2d'), { type: kind === 'power' && trends ? 'bar' : 'line', data: { datasets: [] }, options: chartOptions(group, kind), plugins: [guideZones, sharedCursor, sensorRanges] });
      chart.$group = group;
      charts[id] = { chart, group, kind };
      if (kind === 'power') {
        $(`chips-${group}-${kind}`).textContent = trends ? 'Estimated energy · daily / weekly totals' : 'Estimated watts · saved interval averages + live samples';
        continue;
      }
      for (const sensor of groupSensors(kind)) {
        const chip = document.createElement('button'); chip.className = 'chip'; chip.setAttribute('aria-pressed', 'true');
        chip.innerHTML = `<span class="swatch" style="background:${sensorColor(sensor)}"></span>${sensorLabel(sensor)}`;
        chip.onclick = () => {
          const visible = chip.getAttribute('aria-pressed') !== 'true';
          chart.data.datasets.forEach((dataset, index) => { if (dataset.sensor === sensor) chart.setDatasetVisibility(index, visible); });
          chip.setAttribute('aria-pressed', String(visible)); chip.classList.toggle('off', !visible); chart.update();
        };
        $(`chips-${group}-${kind}`).appendChild(chip);
      }
    }
  }
}
function datasetStyle(sensor, kind) {
  return { sensor, unit: sensorUnit(sensor), yAxisID: kind, label: sensorLabel(sensor), borderColor: sensorColor(sensor), borderWidth: 2, pointBackgroundColor: sensorColor(sensor), pointHoverRadius: 4, tension: 0, spanGaps: false };
}
function updatePlot(group, kind, from, to, datasets) {
  const id = chartId(group, kind), entry = charts[id];
  entry.chart.options.scales.x.min = from; entry.chart.options.scales.x.max = to;
  entry.rangeExtent = datasets.flatMap(dataset => dataset.data.flatMap(point => [point.low, point.high])).filter(Number.isFinite);
  $(`${id}-empty`).classList.toggle('hidden', datasets.some(dataset => dataset.data.some(point => point.y != null)));
  setChartDatasets(entry, datasets);
}
function mergeLive(points, live, from, to) {
  const recent = (live || []).filter(point => point.ts >= from && point.ts <= to);
  const firstLive = recent[0]?.ts ?? Infinity;
  return [...points.filter(point => point.ts < firstLive), ...recent].filter(point => point.ts >= from && point.ts <= to).sort((a, b) => a.ts - b.ts);
}
let historyRequest = 0;
async function refreshHistory() {
  const request = ++historyRequest, to = Date.now(), from = to - rangeMs;
  try {
    const [history, live, power] = await Promise.all([
      fetch(`/api/history?from=${from}&to=${to}&maxPoints=5000`).then(res => res.json()),
      fetch('/api/live').then(res => res.json()),
      fetch(`/api/power?from=${from}&to=${to}`).then(res => res.json()),
    ]);
    if (request !== historyRequest) return;
    for (const kind of ['temperature', 'utilization', 'fans']) {
      updatePlot('history', kind, from, to, groupSensors(kind).map(sensor => {
        const points = mergeLive(history.series[sensor] || [], live.series[sensor], from, to);
        const bounds = {};
        for (const bound of ['min', 'max']) bounds[bound] = new Map(mergeLive(history.series[`${sensor}_${bound}`] || [], live.series[`${sensor}_${bound}`], from, to).map(point => [point.ts, point.value_c]));
        const data = points.map(point => ({ x: point.ts, y: point.value_c, low: bounds.min.get(point.ts), high: bounds.max.get(point.ts) }));
        return { ...datasetStyle(sensor, kind), fill: false, pointRadius: points.length === 1 ? 3 : 0, data };

      }));
    }
    const points = [];
    const recentPower = (live.series.power || []).filter(point => point.ts >= from && point.ts <= to);
    const firstLive = recentPower[0]?.ts ?? Infinity;
    for (const row of power.intervals) {
      if (row.start >= firstLive) continue;
      if (points.length && row.start > points.at(-1).ts) points.push({ ts: row.start, value_c: null });
      const value_c = row.wh * 3600000 / (row.end - row.start);
      points.push({ ts: Math.max(from, row.start), value_c }, { ts: Math.min(to, row.end, firstLive), value_c });
    }
    const cutoff = points.at(-1)?.ts ?? from;
    for (const point of recentPower) {
      if (point.ts <= cutoff || point.ts > to || point.ts < from) continue;
      if (points.length && point.ts - points.at(-1).ts > 4000) points.push({ ts: point.ts - 1, value_c: null });
      points.push(point);
    }
    updatePlot('history', 'power', from, to, [{ label: 'Estimated input-rail power', unit: 'W', yAxisID: 'power', borderColor: '#ba68c8', backgroundColor: 'rgba(186,104,200,0.10)', fill: true, borderWidth: 2, pointRadius: points.length === 1 ? 3 : 0, spanGaps: false, data: points.map(point => ({ x: point.ts, y: point.value_c })) }]);
    const current = live.power.current;
    $('power-info').textContent = `${live.power.source} · ${current && to - current.ts < 5000 ? current.watts.toFixed(1) + ' W now' : 'live reading unavailable'} · energy saved every ${fmtInterval(storageIntervalMs)}`;
    $('history-error').textContent = '';
  } catch { $('history-error').textContent = 'Could not refresh charts. Showing previous data.'; }
}
let trendRequest = 0;
async function refreshTrends() {
  const request = ++trendRequest, to = Date.now(), from = to - trendMs;
  const bucket = $('energy-bucket').value;
  try {
    const [aggregate, power] = await Promise.all([
      fetch(`/api/aggregate?from=${from}&to=${to}`).then(res => res.json()),
      fetch(`/api/power?from=${from}&to=${to}&bucket=${bucket}`).then(res => res.json()),
    ]);
    if (request !== trendRequest) return;
    for (const kind of ['temperature', 'utilization', 'fans']) {
      const datasets = [];
      for (const sensor of groupSensors(kind)) {
        const points = aggregate.series[sensor] || [];
        const calendarKey = ts => new Date(ts).toLocaleDateString();
        const lows = new Map((aggregate.series[`${sensor}_min`] || []).map(point => [calendarKey(point.ts), point.min]));
        const highs = new Map((aggregate.series[`${sensor}_max`] || []).map(point => [calendarKey(point.ts), point.max]));
        for (const band of ['max', 'min', 'avg']) datasets.push({ ...datasetStyle(sensor, kind), band, label: band === 'avg' ? sensorLabel(sensor) : `${sensorLabel(sensor)} ${band}`,
          data: points.map(point => ({ x: point.ts, y: point[band], low: band === 'avg' ? lows.get(calendarKey(point.ts)) : null, high: band === 'avg' ? highs.get(calendarKey(point.ts)) : null })),
          borderColor: band === 'avg' ? sensorColor(sensor) : 'transparent', backgroundColor: hexA(sensorColor(sensor), 0.08),
          fill: band === 'min' ? '-1' : false, pointRadius: band === 'avg' && points.length === 1 ? 3 : 0,
        });
      }
      updatePlot('trend', kind, from, to, datasets);
    }
    updatePlot('trend', 'power', from, to, [{ label: 'Estimated energy', unit: 'kWh', yAxisID: 'power', backgroundColor: power.points.map(point => point.partial ? 'rgba(186,104,200,0.35)' : '#ba68c8'), borderColor: '#ba68c8', borderWidth: 1,
      data: power.points.map(point => ({ ...point, x: point.ts, y: point.kwh })),
    }]);
    const measured = power.points.filter(point => point.kwh != null);
    $('energy-info').textContent = measured.length ? `${measured.reduce((sum, point) => sum + point.kwh, 0).toFixed(3)} kWh measured in this range · pale bars are incomplete periods · unmeasured time is excluded` : 'No measured energy yet. Totals begin with power logging; earlier history is unavailable.';
    $('trend-error').textContent = '';
  } catch { $('trend-error').textContent = 'Could not refresh trends. Showing previous data.'; }
}
$('energy-bucket').addEventListener('change', refreshTrends);

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
    const source = thermalStatus?.latest?.sources?.[s];
    el.title = source ? `${source.method} · hottest: ${source.key || 'unavailable'} · ${source.count} mapped sensors read` : '';
    el.innerHTML =
      `<div class="sensor-name">${sensorLabel(s)}</div>` +
      (row
        ? `<div class="temp">${fmtValue(row.value_c, unit).replace(/ (RPM|°C|°F|%)$/, '<small> $1</small>')}</div>` +
          `<div class="updated">updated ${ago(row.ts)}</div>` +
          (source?.min != null ? `<div class="sensor-range">Average · range ${fmtValue(source.min, '°C')}–${fmtValue(source.max, '°C')} · ${source.count} sensors</div>` : '') +
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
    const mapped = thermalStatus.latest?.sources;
    $('temperature-source-note').textContent = mapped ? 'CPU/GPU: average of available mapped SMC sensors; whiskers show min–max. History recorded before v1.5.0 used broad PMU readings and is not directly comparable.' : '';
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
  storageIntervalMs = status.intervalMs;
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
  mk('ranges', RANGES, 0, (ms) => {
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
  }, 5000);
  setInterval(refreshTrends, 60000);
}

init().catch((err) => {
  $('status-text').textContent = 'Cannot reach server';
  console.error(err);
});
