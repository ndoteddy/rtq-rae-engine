import { expect, test } from '@playwright/test';
import { DisplayPage, KioskPage } from '../support/pages';

/**
 * These tests drive the REAL Rust backend (see playwright.integration.config.ts).
 * Every test gets its own tenant (?tenant=...), so tests are isolated even though they share a server.
 * The backend runs 2 resource workers; jobs take `durationSeconds` to process.
 */

const API = 'http://localhost:3000';
const KIOSK_KEY = 'kiosk-key-123';
const uniqueTenant = () => `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

test.describe('frontend <-> Rust backend', () => {
  test('backend is healthy', async ({ request }) => {
    const res = await request.get(`${API}/health`);
    expect(res.ok()).toBe(true);
  });

  test('kiosk connects to the real WebSocket', async ({ page }) => {
    const kiosk = new KioskPage(page, uniqueTenant());
    await kiosk.goto();
    await expect(kiosk.status).toHaveText('open');
  });

  test('enqueue from the kiosk shows up on the display in real time', async ({ browser }) => {
    const tenant = uniqueTenant();
    const kioskPage = await (await browser.newContext()).newPage();
    const displayPage = await (await browser.newContext()).newPage();
    const kiosk = new KioskPage(kioskPage, tenant);
    const display = new DisplayPage(displayPage, tenant);
    await kiosk.goto();
    await display.goto();
    await expect(display.waiting).toContainText('No one waiting');

    await kiosk.enqueue('Real order', { seconds: 3 });

    await expect(kiosk.notice).toContainText('Added "Real order"');
    // A free resource claims it immediately, so it appears under "Now Processing" on the wall display.
    await expect(display.processing).toContainText('Real order');
    // ...and after ~3s the real worker completes it.
    await expect(display.footer).toContainText('Real order', { timeout: 20_000 });
    await expect(display.processing).toContainText('Idle');
  });

  test('queue overflow: with 2 workers busy, the third job waits, then gets processed', async ({ page }) => {
    const kiosk = new KioskPage(page, uniqueTenant());
    await kiosk.goto();

    await kiosk.enqueue('Job 1', { seconds: 3 });
    await kiosk.enqueue('Job 2', { seconds: 3 });
    await kiosk.enqueue('Job 3', { seconds: 3 });

    await expect(kiosk.processingSection.locator('.queue-item')).toHaveCount(2);
    await expect(kiosk.waitingRow('Job 3')).toBeVisible();
    // A worker frees up after ~3s and picks the waiting job.
    await expect(kiosk.processingRow('Job 3')).toBeVisible({ timeout: 20_000 });
    await expect(kiosk.waitingRow('Job 3')).toHaveCount(0);
  });

  test('prioritize and cancel go through the real API', async ({ page }) => {
    const kiosk = new KioskPage(page, uniqueTenant());
    await kiosk.goto();

    // Occupy both workers so the rest stay waiting.
    await kiosk.enqueue('Busy 1', { seconds: 8 });
    await kiosk.enqueue('Busy 2', { seconds: 8 });
    await expect(kiosk.processingSection.locator('.queue-item')).toHaveCount(2);

    await kiosk.enqueue('Normal A');
    await kiosk.enqueue('Normal B');
    await expect(kiosk.waitingSection.locator('.queue-item')).toHaveCount(2);

    await kiosk.waitingRow('Normal B').getByRole('button', { name: 'Prioritize' }).click();
    await expect(kiosk.waitingSection.locator('.queue-item').first()).toContainText('Normal B');
    await expect(kiosk.waitingRow('Normal B')).toContainText('HIGH');

    await kiosk.waitingRow('Normal A').getByRole('button', { name: 'Cancel' }).click();
    await expect(kiosk.waitingRow('Normal A')).toHaveCount(0);
    await expect(kiosk.waitingSection.locator('.queue-item')).toHaveCount(1);
  });

  test('a high-priority enqueue jumps ahead of waiting normal items', async ({ page }) => {
    const kiosk = new KioskPage(page, uniqueTenant());
    await kiosk.goto();
    await kiosk.enqueue('Busy 1', { seconds: 8 });
    await kiosk.enqueue('Busy 2', { seconds: 8 });
    await expect(kiosk.processingSection.locator('.queue-item')).toHaveCount(2);

    await kiosk.enqueue('Regular');
    await kiosk.enqueue('VIP', { priority: 'high' });

    await expect(kiosk.waitingSection.locator('.queue-item').first()).toContainText('VIP');
  });

  test('tenants are isolated from each other', async ({ browser }) => {
    const a = new DisplayPage(await (await browser.newContext()).newPage(), uniqueTenant());
    const b = new DisplayPage(await (await browser.newContext()).newPage(), uniqueTenant());
    await a.goto();
    await b.goto();

    const kioskA = new KioskPage(await (await browser.newContext()).newPage(), new URL(a.page.url()).searchParams.get('tenant')!);
    await kioskA.goto();
    await kioskA.enqueue('Only for A', { seconds: 3 });

    await expect(a.processing).toContainText('Only for A');
    await expect(b.processing).not.toContainText('Only for A');
    await expect(b.waiting).not.toContainText('Only for A');
  });

  test.describe('headless API (external systems)', () => {
    test('a webhook-style POST with an API key appears on the display with no UI interaction', async ({ page, request }) => {
      const tenant = uniqueTenant();
      const display = new DisplayPage(page, tenant);
      await display.goto();

      const res = await request.post(`${API}/api/enqueue`, {
        headers: { 'x-api-key': KIOSK_KEY, 'x-tenant-id': tenant },
        data: { label: 'Shopify #9001', payload: { durationMs: 3000, source: 'shopify' }, priority: 'normal' },
      });
      expect(res.status()).toBe(201);
      expect(await res.json()).toMatchObject({ position: 0 });

      await expect(display.processing).toContainText('Shopify #9001');
    });

    test('rejects writes without a valid API key and bad input', async ({ request }) => {
      const tenant = uniqueTenant();
      const probe = await request.post(`${API}/api/enqueue`, {
        headers: { 'x-tenant-id': tenant },
        data: { label: 'probe', payload: {} },
      });
      // When a dev backend without API_KEYS is reused, auth checks cannot be asserted.
      test.skip(probe.status() === 201, 'backend is running in open dev mode (API_KEYS not set)');

      expect(probe.status()).toBe(401);

      const wrongKey = await request.post(`${API}/api/enqueue`, {
        headers: { 'x-api-key': 'nope', 'x-tenant-id': tenant },
        data: { label: 'x', payload: {} },
      });
      expect(wrongKey.status()).toBe(401);

      const blank = await request.post(`${API}/api/enqueue`, {
        headers: { 'x-api-key': KIOSK_KEY, 'x-tenant-id': tenant },
        data: { label: '   ', payload: {} },
      });
      expect(blank.status()).toBe(400);
      expect((await blank.json()).error).toMatch(/label/i);

      const badTenant = await request.post(`${API}/api/enqueue`, {
        headers: { 'x-api-key': KIOSK_KEY, 'x-tenant-id': 'bad tenant!' },
        data: { label: 'x', payload: {} },
      });
      expect(badTenant.status()).toBe(400);
    });

    test('cancelling an unknown item returns 404', async ({ request }) => {
      const res = await request.post(`${API}/api/items/00000000-0000-4000-8000-000000000000/cancel`, {
        headers: { 'x-api-key': KIOSK_KEY, 'x-tenant-id': uniqueTenant() },
      });
      expect(res.status()).toBe(404);
    });
  });
});
