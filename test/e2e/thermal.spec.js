import { test, expect } from '@playwright/test';

test('guide zones appear on cards and temperature axes, convert units, and remain editable', async ({ page }) => {
  await page.route('**/api/thermal', route => route.fulfill({ json: { latest: { ts: Date.now(), readings: { cpu: 85, gpu: 65 } }, state: { level: 2, label: 'Serious' } } }));
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toContainText('Guide zone 3');
  await expect(page.locator('#cards .card').first()).toContainText('macOS: Serious');
  await expect.poll(() => page.evaluate(() => Chart.getChart('history-chart')?.scales.temperature.ticks.map(tick => tick.label).some(label => String(label).includes('80 · Z3')))).toBe(true);
  await page.getByRole('button', { name: 'Fahrenheit', exact: true }).click();
  await expect(page.locator('#cards .card').first()).toContainText('185.0 °F');
  await expect(page.locator('#cards .card').first()).toContainText('176–203.0 °F');
  await page.locator('summary').click();
  await expect(page.locator('#zone-1')).toHaveValue('140');
  await page.locator('#zone-1').fill('150');
  await page.locator('#zone-2').fill('190');
  await page.locator('#zone-3').fill('210');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('#cards .card').first()).toContainText('Guide zone 2');
  await expect(page.locator('#zone-error')).toContainText('not Apple temperature limits');
  await page.reload();
  await expect(page.locator('#cards .card').first()).toContainText('Guide zone 2');
});

test('OS pressure reports actual Critical state without claiming a numeric throttle threshold', async ({ page }) => {
  await page.route('**/api/thermal', route => route.fulfill({ json: { latest: { ts: Date.now(), readings: { cpu: 65, gpu: 60 } }, state: { level: 3, label: 'Critical' } } }));
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toContainText('Guide zone 2');
  await expect(page.locator('#cards .card').first()).toContainText('macOS: Critical · performance impacted');
});

test('temperature plots default to 30–80C, convert to F, and expand for hotter readings', async ({ page }) => {
  let value = 50;
  await page.route('**/api/live', route => route.fulfill({ json: { series: {}, power: {} } }));
  await page.route('**/api/history?*', route => route.fulfill({ json: { series: { cpu: [{ ts: Date.now() - 1000, value_c: value }] } } }));
  await page.goto('/');
  await expect(page).toHaveTitle('Mac Thermals');
  const bounds = () => page.evaluate(() => {
    const c = Chart.getChart('history-chart');
    return [c.options.scales.temperature.suggestedMin, c.options.scales.temperature.suggestedMax, c.scales.temperature.max];
  });
  await expect.poll(bounds).toEqual([30, 80, 80]);
  await page.getByRole('button', { name: 'Fahrenheit', exact: true }).click();
  expect((await bounds()).slice(0,2)).toEqual([86, 176]);
  value = 95;
  await page.getByRole('button', { name: 'Celsius', exact: true }).click();
  await page.locator('#ranges').getByRole('button', { name: '6H', exact: true }).click();
  await expect.poll(async () => (await bounds())[2]).toBeGreaterThanOrEqual(95);
});

test('average cards show smaller sensor ranges and min–max whiskers convert with the chart', async ({ page }) => {
  const ts = Date.now() - 1000;
  const readings = { cpu: 75, gpu: 60, cpu_min: 65, cpu_max: 95, gpu_min: 58, gpu_max: 62 };
  await page.route('**/api/thermal', route => route.fulfill({ json: { latest: { ts, readings, sources: {
    cpu: { min: 65, max: 95, average: 75, count: 15, method: 'Average mapped SMC sensors', key: 'Tp00' },
    gpu: { min: 58, max: 62, average: 60, count: 7, method: 'Average mapped SMC sensors', key: 'Tg0X' },
  } }, state: { level: 0, label: 'Nominal' } } }));
  await page.route('**/api/live', route => route.fulfill({ json: { series: {}, power: {} } }));
  await page.route('**/api/history?*', route => route.fulfill({ json: { series: Object.fromEntries(Object.entries(readings).map(([sensor, value_c]) => [sensor, [{ ts, value_c }]])) } }));
  await page.route('**/api/aggregate?*', route => route.fulfill({ json: { series: Object.fromEntries(Object.entries(readings).map(([sensor, avg]) => [sensor, [{ ts, min: avg, max: avg, avg, n: 1 }]])) } }));
  await page.goto('/');
  await expect(page.locator('#cards .temp').first()).toContainText('75.0');
  await expect(page.locator('#cards .sensor-range').first()).toContainText('65.0 °C–95.0 °C');
  const fonts = await page.locator('#cards .card').first().evaluate(card => [getComputedStyle(card.querySelector('.temp')).fontSize, getComputedStyle(card.querySelector('.sensor-range')).fontSize].map(parseFloat));
  expect(fonts[1]).toBeLessThan(fonts[0]);
  await expect.poll(() => page.evaluate(() => Chart.getChart('history-chart')?.data.datasets[0]?.data[0]?.high)).toBe(95);
  expect(await page.evaluate(() => Chart.getChart('history-chart').scales.temperature.max)).toBeGreaterThanOrEqual(95);
  await page.getByRole('button', { name: 'Fahrenheit', exact: true }).click();
  await expect(page.locator('#cards .temp').first()).toContainText('167.0');
  await expect(page.locator('#cards .sensor-range').first()).toContainText('149.0 °F–203.0 °F');
  for (const id of ['history-chart', 'trend-chart']) {
    expect(await page.evaluate(id => {
      const dataset = Chart.getChart(id).data.datasets.find(d => !d.band || d.band === 'avg');
      return [dataset.data[0].low, dataset.data[0].y, dataset.data[0].high];
    }, id)).toEqual([149, 167, 203]);
  }
});
