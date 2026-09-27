// End-to-end tests for the dashboard — run with: npm run test:e2e
// Boots the app in --demo mode via playwright.config.js webServer.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test.describe('dashboard', () => {
  test('loads, shows demo status, and renders sensor cards with units', async ({
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
    expect(cardText).toMatch(/RPM/);
  });

  test('history charts render per unit group and range switching works', async ({
    page,
  }) => {
    await page.goto('/');
    // Temperature chart and fan chart render as separate canvases.
    await expect(page.locator('#hist-temp')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#hist-fan')).toBeVisible({ timeout: 15000 });

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
    await expect(page.locator('#trend-temp')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#trend-fan')).toBeVisible({ timeout: 15000 });
    // Per-sensor toggle chips exist under each trend chart.
    await expect(page.locator('#chips-trend-temp .chip').first()).toBeVisible();
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
  await expect.poll(() => page.evaluate(() => Chart.getChart('trend-temp')?.data.datasets.length)).toBe(6);
  await page.locator('#chips-trend-temp').getByRole('button', { name: 'GPU', exact: true }).click();
  expect(await page.evaluate(() => Chart.getChart('trend-temp').isDatasetVisible(5))).toBe(false);
  await page.locator('#trend-ranges').getByRole('button', { name: '7D', exact: true }).click();
  await expect(page.locator('#trend-ranges button.active')).toHaveText('7D');
  await page.unrouteAll({ behavior: 'wait' });
  expect(errors).toEqual([]);
});

test('dashboard fits a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#cards .card')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});


test('single-sample charts show visible points and concise axis labels', async ({ page }) => {
  await page.route('**/api/history?*', route => route.fulfill({ json: {
    series: { cpu: [{ ts: Date.now(), value_c: 62.3 }], gpu: [{ ts: Date.now(), value_c: 60.5 }] },
  } }));
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Chart.getChart('hist-temp')?.data.datasets.length)).toBe(2);
  const chart = await page.evaluate(() => {
    const chart = Chart.getChart('hist-temp');
    return { radius: chart.data.datasets[0].pointRadius, labels: chart.scales.y.ticks.map(tick => String(tick.label)) };
  });
  expect(chart.radius).toBeGreaterThan(0);
  expect(chart.labels.every(label => label.length < 8)).toBeTruthy();
});
