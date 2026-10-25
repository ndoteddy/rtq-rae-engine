import { expect, test } from '@playwright/test';
import { mockBackend } from '../support/mock-backend';
import { DisplayPage, KioskPage } from '../support/pages';

test.describe('display (mocked backend)', () => {
  test('shows empty states when nothing is queued', async ({ page }) => {
    await mockBackend(page);
    const display = new DisplayPage(page);
    await display.goto();

    await expect(display.waiting).toContainText('No one waiting');
    await expect(display.processing).toContainText('Idle');
    await expect(display.offlineBanner).toHaveCount(0);
  });

  test('renders live updates into Waiting and Now Processing columns', async ({ page }) => {
    const backend = await mockBackend(page);
    const display = new DisplayPage(page);
    await display.goto();

    backend.add('Alice');
    backend.add('Bob', 'high');
    await expect(display.waiting.locator('li')).toHaveCount(2);
    await expect(display.waiting.locator('li').first()).toContainText('Bob');
    await expect(display.waiting.locator('li.high')).toContainText('Bob');
    await expect(display.waiting.locator('li').first()).toContainText('#1');

    backend.startNext();
    await expect(display.processing).toContainText('Bob');
    await expect(display.waiting).not.toContainText('Bob');
    await expect(display.waiting.locator('li')).toHaveCount(1);
  });

  test('lists recently completed jobs in the footer', async ({ page }) => {
    const backend = await mockBackend(page);
    const display = new DisplayPage(page);
    await display.goto();

    backend.add('Done deal');
    backend.startNext();
    backend.completeNext();

    await expect(display.footer).toContainText('Recently completed');
    await expect(display.footer).toContainText('Done deal');
    await expect(display.processing).toContainText('Idle');
  });

  test('shows a reconnect banner when the socket drops, then recovers and resyncs', async ({ page }) => {
    const backend = await mockBackend(page);
    const display = new DisplayPage(page);
    await display.goto();
    backend.add('Before drop');
    await expect(display.waiting).toContainText('Before drop');

    backend.dropSockets();
    await expect(display.offlineBanner).toBeVisible();

    // The app retries with backoff (1s first); the fake server accepts the new socket and sends a snapshot.
    await expect(display.offlineBanner).toHaveCount(0, { timeout: 10_000 });
    await expect(display.waiting).toContainText('Before drop');
  });

  test('a kiosk and a display in one browser stay in sync', async ({ context }) => {
    await mockBackend(context);
    const kioskPage = await context.newPage();
    const displayPage = await context.newPage();
    const kiosk = new KioskPage(kioskPage);
    const display = new DisplayPage(displayPage);
    await kiosk.goto();
    await display.goto();

    await kiosk.enqueue('Cross-screen');
    await expect(display.waiting).toContainText('Cross-screen');

    await kiosk.waitingRow('Cross-screen').getByRole('button', { name: 'Cancel' }).click();
    await expect(display.waiting).not.toContainText('Cross-screen');
    await expect(display.waiting).toContainText('No one waiting');
  });
});
