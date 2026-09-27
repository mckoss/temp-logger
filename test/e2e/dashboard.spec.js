// End-to-end tests for the dashboard — run with: npm run test:e2e
// Boots the app in --demo mode via playwright.config.js webServer.
import { test, expect } from '@playwright/test';

test.describe('dashboard', () => {
  test('loads, shows demo status, and renders sensor cards with units', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Thermals|Temperature/);
    await expect(page.locator('h1')).toContainText('Thermals');

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
    // Give the demo sampler a moment to write rows.
    await new Promise((r) => setTimeout(r, 4500));
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
