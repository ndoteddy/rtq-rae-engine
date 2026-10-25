import { expect, test } from '@playwright/test';
import { mockBackend } from '../support/mock-backend';
import { KioskPage } from '../support/pages';

test.describe('kiosk (mocked backend)', () => {
  test('root redirects to the kiosk and connects the socket', async ({ page }) => {
    await mockBackend(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/kiosk$/);
    await expect(page.getByRole('heading', { name: 'Queue Operations' })).toBeVisible();
    await expect(new KioskPage(page).status).toHaveText('open');
  });

  test('submit is disabled until the form is valid', async ({ page }) => {
    await mockBackend(page);
    const kiosk = new KioskPage(page);
    await kiosk.goto();

    await expect(kiosk.submit).toBeDisabled();
    await kiosk.label.fill('A');
    await kiosk.label.blur();
    await expect(page.getByText('Enter 2–80 characters.')).toBeVisible();
    await kiosk.label.fill('Alice');
    await expect(kiosk.submit).toBeEnabled();
  });

  test('enqueues an item: sends key, tenant and payload, then shows it from the socket', async ({ page }) => {
    const backend = await mockBackend(page);
    const kiosk = new KioskPage(page);
    await kiosk.goto();

    await kiosk.enqueue('Order #1042', { priority: 'high', seconds: 7 });

    await expect(kiosk.notice).toContainText('Added "Order #1042" at position 1');
    await expect(kiosk.waitingRow('Order #1042')).toBeVisible();
    await expect(kiosk.waitingRow('Order #1042')).toContainText('HIGH');
    await expect(kiosk.label).toHaveValue('');

    const req = backend.requests.find((r) => r.url === '/api/enqueue')!;
    expect(req.headers['x-api-key']).toBeTruthy();
    expect(req.headers['x-tenant-id']).toBe('default');
    expect(req.body).toMatchObject({ label: 'Order #1042', priority: 'high', payload: { durationMs: 7000 } });
  });

  test('shows the server error message when enqueue is rejected', async ({ page }) => {
    const backend = await mockBackend(page);
    const kiosk = new KioskPage(page);
    await kiosk.goto();

    backend.failNextEnqueue('label must not be empty');
    await kiosk.enqueue('Bad one');

    await expect(kiosk.notice).toHaveText('label must not be empty');
    await expect(kiosk.submit).toBeEnabled();
  });

  test('prioritize moves an item ahead of normal ones and hides its button', async ({ page }) => {
    const backend = await mockBackend(page);
    const kiosk = new KioskPage(page);
    await kiosk.goto();
    backend.add('First');
    backend.add('Second');
    await expect(kiosk.waitingSection.locator('.queue-item')).toHaveCount(2);

    await kiosk.waitingRow('Second').getByRole('button', { name: 'Prioritize' }).click();

    await expect(kiosk.waitingSection.locator('.queue-item').first()).toContainText('Second');
    await expect(kiosk.waitingRow('Second')).toContainText('HIGH');
    await expect(kiosk.waitingRow('Second').getByRole('button', { name: 'Prioritize' })).toHaveCount(0);
  });

  test('cancel removes a waiting item', async ({ page }) => {
    const backend = await mockBackend(page);
    const kiosk = new KioskPage(page);
    await kiosk.goto();
    backend.add('Keep me');
    backend.add('Drop me');

    await kiosk.waitingRow('Drop me').getByRole('button', { name: 'Cancel' }).click();

    await expect(kiosk.waitingRow('Drop me')).toHaveCount(0);
    await expect(kiosk.waitingRow('Keep me')).toBeVisible();
  });

  test('moves items between Waiting and Now processing as the server reports', async ({ page }) => {
    const backend = await mockBackend(page);
    const kiosk = new KioskPage(page);
    await kiosk.goto();
    backend.add('Job A');

    backend.startNext();

    await expect(kiosk.processingRow('Job A')).toContainText('resource-1');
    await expect(kiosk.waitingRow('Job A')).toHaveCount(0);
    await expect(page.getByText('Nothing waiting.')).toBeVisible();
  });
});
