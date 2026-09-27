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
  expect(await page.evaluate(() => Object.values(Chart.instances).flatMap(chart => chart.data.datasets.map(dataset => dataset.unit)))).toContain('%');
});


test('utilization history preserves live fluctuations, missing data, percent units and daily averages', async ({ page }) => {
  const ts = Date.now() - 60000;
  await page.route('**/api/history?*', route => route.fulfill({ json: { series: {
    cpu_load: [{ ts: ts - 300000, value_c: 25 }], gpu_load: [{ ts: ts - 300000, value_c: 15 }],
  } } }));
  await page.route('**/api/live', route => route.fulfill({ json: { power: {}, series: {
    cpu_load: [10, 95, 20].map((value_c, i) => ({ ts: ts + i * 1000, value_c })),
    gpu_load: [0, null, 70].map((value_c, i) => ({ ts: ts + i * 1000, value_c })),
  } } }));
  await page.route('**/api/aggregate?*', route => route.fulfill({ json: { series: {
    cpu_load: [{ ts, avg: 40, min: 5, max: 90 }], gpu_load: [{ ts, avg: 20, min: 0, max: 60 }],
  } } }));
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Chart.getChart('history-utilization')?.data.datasets[0]?.data.map(p => p.y))).toEqual([25, 10, 95, 20]);
  expect(await page.evaluate(() => Chart.getChart('history-utilization').data.datasets[1].data.map(p => p.y))).toEqual([15, 0, null, 70]);
  const inspect = () => page.evaluate(() => ['history', 'trend'].map(group => {
    const c = Chart.getChart(`${group}-utilization`);
    return { min: c.scales.utilization.min, max: c.scales.utilization.max, values: c.data.datasets.map(d => d.data.map(p => p.y)) };
  }));
  const before = await inspect();
  expect(before.every(c => c.min === 0 && c.max === 100)).toBe(true);
  expect(before[1].values).toEqual([[90], [5], [40], [60], [0], [20]]);
  await page.getByRole('button', { name: 'Fahrenheit', exact: true }).click();
  expect(await inspect()).toEqual(before);
});
