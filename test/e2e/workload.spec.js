import { test, expect } from '@playwright/test';

test('live CPU and GPU gauges share one row, update, and show missing data honestly', async ({ page }) => {
  let cpu = 3.33, gpu = 80;
  await page.route('**/api/workload', route => route.fulfill({ json: {
    intervalMs: 1000, coreCount: 30, lastSampleAt: Date.now(), current: { cpu, gpu },
  } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#cpu-live-value')).toHaveText('3.3%');
  await expect(page.locator('#gpu-live-value')).toHaveText('80.0%');
  const gauges = await page.locator('.workload-gauge').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
  expect(gauges[0]).toBe(gauges[1]);
  await expect(page.locator('#gpu-live-meter')).toHaveAttribute('max', '100');
  cpu = 100; gpu = null;
  await expect(page.locator('#cpu-live-value')).toHaveText('100.0%');
  await expect(page.locator('#gpu-live-value')).toHaveText('Unavailable');
  await expect(page.locator('#gpu-live-meter')).toBeHidden();
  gpu = 0;
  await expect(page.locator('#gpu-live-value')).toHaveText('0.0%');
  await page.getByRole('button', { name: 'Fahrenheit', exact: true }).click();
  await expect(page.locator('#cpu-live-value')).toHaveText('100.0%');
});

test('workload summaries are stored with thermal readings as percentages', async ({ request, page }) => {
  await expect.poll(async () => {
    const { latest } = await (await request.get('/api/current')).json();
    return latest.some(row => row.sensor === 'cpu_load');
  }).toBe(true);
  const { latest } = await (await request.get('/api/current')).json();
  for (const sensor of ['cpu_load', 'cpu_peak', 'gpu_load', 'gpu_peak']) {
    const row = latest.find(row => row.sensor === sensor);
    expect(row.value_c).toBeGreaterThanOrEqual(0);
    expect(row.value_c).toBeLessThanOrEqual(100);
    expect(latest.some(other => other.sensor === 'cpu' && other.ts === row.ts)).toBe(true);
  }
  await page.goto('/');
  await expect(page.locator('#history-chart')).toBeVisible();
  await expect.poll(() => page.evaluate(() => Chart.getChart('history-chart')?.data.datasets.length)).toBe(2);
  expect(await page.evaluate(() => Object.values(Chart.instances).flatMap(chart => chart.data.datasets.map(dataset => dataset.unit)))).not.toContain('%');
});
