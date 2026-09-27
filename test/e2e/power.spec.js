import { test, expect } from '@playwright/test';
test('energy API exposes measured intervals, daily and weekly totals, and rejects invalid queries', async ({ request }) => {
  await expect.poll(async () => (await (await request.get('/api/power')).json()).intervals.length).toBeGreaterThan(0);
  const daily = await (await request.get('/api/power')).json();
  expect(daily.points.some(point => point.kwh > 0 && point.avgWatts > 0)).toBe(true);
  expect(daily.points.every(point => point.coverage >= 0 && point.coverage <= 1)).toBe(true);
  expect((await (await request.get('/api/power?bucket=week')).json()).bucket).toBe('week');
  for (const query of ['bucket=hour', 'from=nope', 'from=2&to=1']) expect((await request.get(`/api/power?${query}`)).status()).toBe(400);
});
test('watts remain unchanged by temperature units, weekly energy switches and partial periods are labeled', async ({ page }) => {
  const ts = Date.now() - 1000;
  await page.route('**/api/live', route => route.fulfill({ json: { series: {}, power: { current: { ts: Date.now(), watts: 125 }, source: 'Estimated input-rail power' } } }));
  await page.route('**/api/power?*', route => route.fulfill({ json: {
    intervals: [{ start: ts - 3600000, end: ts, wh: 125 }],
    points: [{ ts, start: ts - 3600000, end: ts, kwh: 0.125, avgWatts: 125, coverage: 0.5, partial: true }],
  } }));
  await page.goto('/');
  await expect(page.locator('#power-info')).toContainText('125.0 W');
  await expect(page.locator('#energy-info')).toContainText('0.125 kWh');
  const watts = () => page.evaluate(() => Chart.getChart('history-power').data.datasets[0].data.map(point => point.y));
  const before = await watts();
  await page.getByRole('button', { name: 'Fahrenheit', exact: true }).click();
  expect(await watts()).toEqual(before);
  const response = page.waitForResponse(response => response.url().includes('bucket=week'));
  await page.locator('#energy-bucket').selectOption('week'); await response;
  expect(await page.evaluate(() => {
    const c = Chart.getChart('trend-power'), dataset = c.data.datasets[0];
    return c.options.plugins.tooltip.callbacks.label({ dataset, raw: dataset.data[0] });
  })).toEqual([' 0.125 kWh · partial period', ' Average: 125.0 W', ' Coverage: 50.0%']);
});

test('recent high-resolution points survive later saved interval summaries', async ({ page }) => {
  const ts = Date.now() - 60000;
  await page.route('**/api/history?*', route => route.fulfill({ json: { series: { cpu: [{ ts: ts - 300000, value_c: 40 }, { ts: ts + 30000, value_c: 50 }] } } }));
  await page.route('**/api/live', route => route.fulfill({ json: { power: {}, series: { cpu: [0, 5000, 10000, 15000, 20000, 25000, 30000].map(t => ({ ts: ts + t, value_c: 60 })) } } }));
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Chart.getChart('history-chart')?.data.datasets[0]?.data.length)).toBe(8);
});
