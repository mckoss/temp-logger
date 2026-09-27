import { test, expect } from '@playwright/test';

test('status confirms the live process and renders 30 days of logging counts', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Status', exact: true }).click();
  await expect(page.locator('#process-status')).toHaveText('Logger running');
  await expect(page.locator('#process-id')).toHaveText(/^\d+$/);
  await expect(page.locator('#daily-table tbody tr')).toHaveCount(30);
  const { days } = await (await request.get('/api/activity')).json();
  expect(days).toHaveLength(30);
  expect(days.at(-1).datapoints).toBeGreaterThan(0);
  expect(days.at(-1).samples).toBeGreaterThan(0);
  expect(days[0].datapoints).toBe(0);
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.locator('#temperature-units')).toBeVisible();
});

test('status clearly reports an unreachable logger rather than stale running status', async ({ page }) => {
  await page.route('**/api/status', route => route.abort());
  await page.goto('/status');
  await expect(page.locator('#process-status')).toHaveText('Logger unreachable');
  await expect(page.locator('#status-checked')).toContainText('Cannot confirm');
});
