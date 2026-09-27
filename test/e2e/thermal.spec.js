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
