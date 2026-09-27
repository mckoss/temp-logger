const $ = id => document.getElementById(id);
const chart = new Chart($('daily-counts'), {
  type: 'bar',
  data: { labels: [], datasets: [{ label: 'Datapoints', data: [], backgroundColor: '#ffb020' }] },
  options: {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#8b949e', maxTicksLimit: 10 } },
      y: { beginAtZero: true, ticks: { color: '#8b949e', precision: 0 } },
    },
  },
});
function duration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${days}d ${hours}h ${minutes}m ${seconds % 60}s`;
}
async function get(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function refresh() {
  try {
    const status = await get('/api/status');
    const stale = status.lastSample && Date.now() - status.lastSample.ts > status.intervalMs * 2;
    $('process-status').className = `pill ${status.ok && !stale ? 'live' : 'error'}`;
    $('process-status').textContent = !status.ok ? 'Running · sensor error' : stale ? 'Running · logging overdue' : 'Logger running';
    $('status-version').textContent = `temp-logger v${status.version}`;
    $('process-id').textContent = status.pid;
    $('process-uptime').textContent = duration(status.uptimeSec);
    $('process-latest').textContent = status.lastSample ? new Date(status.lastSample.ts).toLocaleString() : 'No sample saved since startup';
    $('process-interval').textContent = `${status.intervalMs / 1000} seconds`;
    $('process-rows').textContent = status.rows.toLocaleString();
    $('process-thermal').textContent = status.thermal?.state?.label || 'Unavailable';
    $('process-backend').textContent = status.backendLabel;
    $('process-error').textContent = [status.lastError, status.workload?.lastError, status.thermal?.stateError, status.thermal?.sensorError].filter(Boolean).join(' · ');
    $('status-checked').textContent = `Confirmed at ${new Date().toLocaleTimeString()} · updates every 5 seconds`;
  } catch {
    $('process-status').className = 'pill error';
    $('process-status').textContent = 'Logger unreachable';
    $('status-checked').textContent = 'Cannot confirm the process is running. Displayed data is from the last successful check.';
  }
  try {
    const { days, timezone } = await get('/api/activity');
    chart.data.labels = days.map(day => day.day);
    chart.data.datasets[0].data = days.map(day => day.datapoints);
    chart.update();
    $('activity-explanation').textContent = `Each datapoint is one sensor value; a sampling cycle contains several datapoints. Calendar days use ${timezone}. Today is partial; zero marks days with no retained readings.`;
    $('daily-table').querySelector('tbody').replaceChildren(...[...days].reverse().map(day => {
      const row = document.createElement('tr');
      for (const value of [day.day, day.samples.toLocaleString(), day.datapoints.toLocaleString()]) {
        const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
      }
      return row;
    }));
  } catch {
    $('activity-explanation').textContent = 'Daily history is unavailable. Any displayed counts are from the last successful check.';
  } finally { setTimeout(refresh, 5000); }
}
refresh();
