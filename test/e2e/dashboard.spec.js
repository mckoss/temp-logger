// End-to-end tests for the dashboard — run with: npm run test:e2e
// Boots the app in --demo mode via playwright.config.js webServer.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test.describe('dashboard', () => {
  test('loads, shows demo status, and renders only temperature cards', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Thermals|Temperature/);
    await expect(page.locator('h1')).toContainText('Thermals');

    await expect(page.locator('#app-version')).toHaveText(`v${version}`);

    // Demo backend comes up and the pill reflects it.
    await expect(page.locator('#status-pill')).toContainText('Demo', {
      timeout: 15000,
    });

    // Cards appear: temps in °C and fans in RPM.
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15000 });
    const cardText = await page.locator('#cards').innerText();
    expect(cardText).toMatch(/°C/);
    expect(cardText).not.toMatch(/RPM/);
    await expect(page.locator('#cards .card')).toHaveCount(2);
  });

  test('combined history renders and range switching works', async ({
    page,
  }) => {
    await page.goto('/');
    // All sensors share a single history canvas.
    await expect(page.locator('#history-chart')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('canvas')).toHaveCount(8);

    // Wait for data to land in the stats table, then switch ranges.
    await expect(page.locator('#stats-table tbody tr').first()).toBeVisible({
      timeout: 15000,
    });
    await page.locator('#ranges').getByRole('button', { name: '1H' }).click();
    await expect(page.locator('#ranges button.active')).toHaveText('1H');
    await page.locator('#ranges').getByRole('button', { name: '7D' }).click();
    await expect(page.locator('#ranges button.active')).toHaveText('7D');
  });

  test('trend charts render min/max bands with legend chips', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('#trend-chart')).toBeVisible({ timeout: 15000 });
    // Per-sensor toggle chips exist under each trend chart.
    await expect(page.locator('#chips-trend-temperature .chip').first()).toBeVisible();
    await page.locator('#trend-ranges').getByRole('button', { name: '7D' }).click();
    await expect(page.locator('#trend-ranges button.active')).toHaveText('7D');
  });

  test('setup banner stays hidden when a backend is present', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('#status-pill')).toContainText('Demo', {
      timeout: 15000,
    });
    await expect(page.locator('#setup-banner')).toBeHidden();
  });
});

test.describe('api', () => {
  test('status endpoint reports the demo backend', async ({ request }) => {
    const res = await request.get('/api/status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.backend).toBe('demo');
    expect(body.version).toBe(version);
    expect(body.intervalMs).toBe(100);
    expect(typeof body.rows).toBe('number');
  });

  test('sensors endpoint reports units and labels', async ({ request }) => {
    const res = await request.get('/api/sensors');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const bySensor = Object.fromEntries(body.sensors.map((s) => [s.sensor, s]));
    expect(bySensor.cpu.unit).toBe('°C');
    expect(bySensor.fan1.unit).toBe('RPM');
    expect(bySensor.fan1.label).toBe('Fan 1');
  });

  test('history endpoint returns downsampled series', async ({ request }) => {
    await expect.poll(async () => (await (await request.get('/api/status')).json()).rows).toBeGreaterThan(0);
    const res = await request.get('/api/history?maxPoints=50');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const sensors = Object.keys(body.series);
    expect(sensors.length).toBeGreaterThan(0);
    for (const s of sensors) {
      expect(body.series[s].length).toBeLessThanOrEqual(50);
      if (body.series[s].length > 1) {
        expect(body.series[s][0].ts).toBeLessThan(
          body.series[s][body.series[s].length - 1].ts
        );
      }
    }
  });

  test('aggregate endpoint returns bucketed min/max/avg', async ({ request }) => {
    const res = await request.get('/api/aggregate?bucket=hour');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.bucket).toBe('hour');
    const sensors = Object.keys(body.series);
    expect(sensors.length).toBeGreaterThan(0);
    for (const s of sensors) {
      for (const p of body.series[s]) {
        expect(p.min).toBeLessThanOrEqual(p.avg);
        expect(p.avg).toBeLessThanOrEqual(p.max);
        expect(p.n).toBeGreaterThan(0);
      }
    }
  });

  test('stats endpoint returns per-sensor aggregates', async ({ request }) => {
    const res = await request.get('/api/stats');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const sensors = Object.keys(body.stats);
    expect(sensors.length).toBeGreaterThan(0);
    for (const s of sensors) {
      const st = body.stats[s];
      expect(st.min).toBeLessThanOrEqual(st.max);
      expect(st.n).toBeGreaterThan(0);
    }
  });

  test('unknown api routes return JSON 404', async ({ request }) => {
    const res = await request.get('/api/nope');
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toBe('not found');
  });
});


for (const query of ['from=garbage', 'from=2&to=1', 'to=Infinity', 'from=1&from=2', 'to=']) {
  test(`rejects invalid ranges: ${query}`, async ({ request }) => {
    for (const endpoint of ['history', 'stats', 'aggregate']) {
      const response = await request.get(`/api/${endpoint}?${query}`);
      expect(response.status()).toBe(400);
      expect((await response.json()).error).toBeTruthy();
    }
  });
}

test('rejects invalid point limits and bucket sizes', async ({ request }) => {
  for (const query of ['maxPoints=-1', 'maxPoints=0', 'maxPoints=1.5', 'maxPoints=5001', 'maxPoints=nope']) {
    expect((await request.get(`/api/history?${query}`)).status()).toBe(400);
  }
  expect((await request.get('/api/aggregate?bucket=week')).status()).toBe(400);
});

test('charts handle a missing sensor and keep trend toggles aligned', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/history?*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    delete body.series.cpu;
    await route.fulfill({ json: body });
  });
  await page.route('**/api/aggregate?*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    delete body.series.cpu;
    await route.fulfill({ json: body });
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Chart.getChart('trend-chart')?.data.datasets.length)).toBe(6);
  await page.locator('#chips-trend-temperature').getByRole('button', { name: 'GPU', exact: true }).click();
  expect(await page.evaluate(() => Chart.getChart('trend-chart').isDatasetVisible(5))).toBe(false);
  await page.locator('#trend-ranges').getByRole('button', { name: '7D', exact: true }).click();
  await expect(page.locator('#trend-ranges button.active')).toHaveText('7D');
  await page.unrouteAll({ behavior: 'wait' });
  expect(errors).toEqual([]);
});

test('dashboard fits a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#cards .card')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});


test('single-sample charts show visible points and concise axis labels', async ({ page }) => {
  await page.route('**/api/live', route => route.fulfill({ json: { series: {}, power: {} } }));
  await page.route('**/api/history?*', route => route.fulfill({ json: {
    series: { cpu: [{ ts: Date.now() - 1000, value_c: 62.3 }], gpu: [{ ts: Date.now() - 1000, value_c: 60.5 }] },
  } }));
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Chart.getChart('history-chart')?.data.datasets.length)).toBe(2);
  const chart = await page.evaluate(() => {
    const chart = Chart.getChart('history-chart');
    return { radius: chart.data.datasets[0].pointRadius, labels: chart.scales.temperature.ticks.map(tick => String(tick.label)) };
  });
  expect(chart.radius).toBeGreaterThan(0);
  expect(chart.labels.every(label => label.length < 14)).toBeTruthy();
});

test('two groups have four non-overlapping plots with one y-axis each and exactly aligned time axes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  const ts = Date.now() - 60000;
  await page.route('**/api/live', route => route.fulfill({ json: { series: {}, power: {} } }));
  await page.route('**/api/history?*', route => route.fulfill({ json: { series: {
    cpu: [{ ts, value_c: 50 }, { ts: ts + 10000, value_c: 60 }, { ts: ts + 50000, value_c: 55 }],
    fan1: [{ ts, value_c: 2000 }], cpu_load: [{ ts, value_c: 75 }],
  } } }));
  await page.goto('/');
  await expect(page.locator('canvas')).toHaveCount(8);
  await expect.poll(() => page.evaluate(() => Chart.getChart('history-chart')?.data.datasets.length)).toBe(2);
  for (const group of ['history', 'trend']) {
    await expect.poll(() => page.evaluate(group => Chart.getChart(`${group}-utilization`)?.data.datasets.length, group)).toBe( group === 'history' ? 2 : 6 );
    const plots = await page.evaluate(group => ['chart', 'utilization', 'fans', 'power'].map(kind => {
      const chart = Chart.getChart(`${group}-${kind}`), rect = chart.canvas.getBoundingClientRect();
      return { axes: Object.keys(chart.scales), left: chart.chartArea.left, right: chart.chartArea.right, min: chart.scales.x.min, max: chart.scales.x.max, timeVisible: chart.options.scales.x.display, top: rect.top, bottom: rect.bottom, units: chart.data.datasets.map(dataset => dataset.unit) };
    }), group);
    expect(plots.map(plot => plot.axes)).toEqual([['x', 'temperature'], ['x', 'utilization'], ['x', 'fans'], ['x', 'power']]);
    expect(plots.map(plot => plot.timeVisible)).toEqual([false, false, false, true]);
    expect(new Set(plots.map(plot => plot.left)).size).toBe(1);
    expect(new Set(plots.map(plot => plot.right)).size).toBe(1);
    expect(new Set(plots.map(plot => plot.min)).size).toBe(1);
    expect(new Set(plots.map(plot => plot.max)).size).toBe(1);
    expect(plots[0].bottom).toBeLessThan(plots[1].top);
    expect(plots[1].bottom).toBeLessThan(plots[2].top);
    expect(plots[1].units).toEqual(expect.arrayContaining(['%']));
    expect(plots[2].bottom).toBeLessThan(plots[3].top);
  }
  const ratio = await page.evaluate(() => {
    const c = Chart.getChart('history-chart'), x = c.data.datasets[0].data.map(p => c.scales.x.getPixelForValue(p.x));
    return (x[2] - x[1]) / (x[1] - x[0]);
  });
  expect(ratio).toBeCloseTo(4);
});


test('display-scale changes repair chart sizes without losing series visibility', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Chart.getChart('trend-utilization')?.data.datasets.length)).toBe(6);
  await page.locator('#chips-history-temperature button').first().click();
  for (const ratio of [2, 1, 2]) {
    await page.evaluate(ratio => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: ratio });
      // Reproduce stale canvas sizing while its containing window stays the same size.
      for (const chart of Object.values(Chart.instances)) chart.resize(320, 100);
      window.dispatchEvent(new Event('mac-thermals-display-change'));
    }, ratio);
    await expect.poll(() => page.evaluate(() => Object.values(Chart.instances).every(chart => {
      const parent = chart.canvas.parentElement;
      return Math.abs(chart.width - parent.clientWidth) <= 1 &&
        Math.abs(chart.height - parent.clientHeight) <= 1 &&
        chart.currentDevicePixelRatio === window.devicePixelRatio &&
        chart.canvas.width === Math.floor(chart.width * window.devicePixelRatio);
    }))).toBe(true);
    expect(await page.evaluate(() => Chart.getChart('history-chart').isDatasetVisible(0))).toBe(false);
  }
});

test('redraw restores a lost Retina canvas transform even when dimensions have not changed', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 }));
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Chart.getChart('trend-utilization')?.data.datasets.length)).toBe(6);
  const scales = await page.evaluate(() => Object.values(Chart.instances).map(chart => {
    const width = chart.canvas.width, height = chart.canvas.height;
    // Model a canvas context reset during a display transition: dimensions and
    // Chart.js's cached DPR remain correct, but its drawing transform is lost.
    chart.ctx.resetTransform();
    chart.resize();
    chart.update('none');
    const matrix = chart.ctx.getTransform();
    return { x: matrix.a, y: matrix.d, ratio: chart.currentDevicePixelRatio,
      sameSize: width === chart.canvas.width && height === chart.canvas.height };
  }));
  expect(scales).toHaveLength(8);
  for (const scale of scales) expect(scale).toEqual({ x: 2, y: 2, ratio: 2, sameSize: true });
});
