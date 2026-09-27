import { test, expect } from '@playwright/test';

async function fixedReadings(page) {
  await page.route('**/api/live', route => route.fulfill({ json: { series: {}, power: {} } }));
  const ts = Date.now();
  const readings = { cpu: 20, gpu: 30, fan1: 2000, fan2: 2100 };
  await page.route('**/api/thermal', route => route.fulfill({ json: { latest: { ts, readings }, state: { label: 'Nominal', level: 0 } } }));
  await page.route('**/api/current', route => route.fulfill({ json: {
    latest: Object.entries(readings).map(([sensor, value_c]) => ({ sensor, value_c, ts })),
  } }));
  await page.route('**/api/history?*', route => route.fulfill({ json: {
    series: Object.fromEntries(Object.entries(readings).map(([sensor, value_c]) => [sensor, [{ ts, value_c }]])),
  } }));
  await page.route('**/api/aggregate?*', route => route.fulfill({ json: {
    bucket: 'day',
    series: Object.fromEntries(Object.entries(readings).map(([sensor, avg]) => [sensor, [{ ts, min: avg - 10, max: avg + 10, avg, n: 3 }]])),
  } }));
  await page.route('**/api/stats?*', route => route.fulfill({ json: {
    stats: Object.fromEntries(Object.entries(readings).map(([sensor, avg]) => [sensor, { min: avg - 10, max: avg + 10, avg, n: 3 }])),
  } }));
}

async function chartState(page) {
  return page.evaluate(() => {
    const history = Chart.getChart('history-chart');
    const trend = Chart.getChart('trend-chart');
    const fan = Chart.getChart('history-fans');
    return {
      history: history.data.datasets[0].data.map(point => point.y),
      trend: trend.data.datasets.slice(0, 3).map(dataset => dataset.data[0].y),
      axis: history.options.scales.temperature.title.text,
      trendAxis: trend.options.scales.temperature.title.text,
      tooltip: history.options.plugins.tooltip.callbacks.label({ dataset: { label: 'CPU', unit: '°C' }, parsed: { y: history.data.datasets[0].data[0].y } }),
      fan: fan.data.datasets.find(dataset => dataset.sensor === 'fan1').data.map(point => point.y),
      fanAxis: fan.options.scales.fans.title.text,
      hidden: !trend.isDatasetVisible(2),
    };
  });
}

test('unit toggle converts every temperature display, preserves RPM, and persists', async ({ page }) => {
  await fixedReadings(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Chart.getChart('trend-chart')?.data.datasets.length)).toBe(6);
  await expect(page.getByRole('button', { name: 'Celsius', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#cards .card').first()).toContainText('20.0 °C');
  await page.locator('#chips-trend-temperature').getByRole('button', { name: 'CPU', exact: true }).click();
  await page.getByRole('button', { name: 'Fahrenheit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Fahrenheit', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#cards .card').first()).toContainText('68.0 °F');
  await expect(page.locator('#stats-table tbody tr').first().locator('td')).toHaveText(['CPU', '68.0 °F', '50.0 °F', '86.0 °F', '68.0 °F', '3']);
  expect(await chartState(page)).toEqual({ history: [68], trend: [86, 50, 68], axis: 'Temperature (°F) · Temp Zones', trendAxis: 'Temperature (°F) · Temp Zones', tooltip: ' CPU: 68.0 °F', fan: [2000], fanAxis: 'Fans (RPM)', hidden: true });
  await expect(page.locator('#stats-table tbody tr').nth(2)).toContainText('2,000 RPM');

  // Subsequent API refreshes still arrive in Celsius and display correctly.
  const historyResponse = page.waitForResponse(response => response.url().includes('/api/history?'));
  await page.locator('#ranges').getByRole('button', { name: '1H', exact: true }).click();
  expect((await (await historyResponse).json()).series.cpu[0].value_c).toBe(20);
  await expect.poll(async () => (await chartState(page)).history).toEqual([68]);
  await page.reload();
  await expect(page.locator('#cards .card').first()).toContainText('68.0 °F');
  await expect.poll(() => page.evaluate(() => Chart.getChart('trend-chart')?.data.datasets.length)).toBe(6);
  await page.getByRole('button', { name: 'Celsius', exact: true }).click();
  await expect(page.locator('#cards .card').first()).toContainText('20.0 °C');
  expect((await chartState(page)).trend).toEqual([30, 10, 20]);
  await expect(page.locator('#stats-table tbody tr').first().locator('td')).toHaveText(['CPU', '20.0 °C', '10.0 °C', '30.0 °C', '20.0 °C', '3']);
});

test('unit toggle works when browser storage is disabled', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage blocked'); } });
  });
  await fixedReadings(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toContainText('20.0 °C');
  await page.getByRole('button', { name: 'Fahrenheit', exact: true }).click();
  await expect(page.locator('#cards .card').first()).toContainText('68.0 °F');
});
