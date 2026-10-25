import { Page } from '@playwright/test';

/** Page objects shared by the mocked and integration suites, so selectors live in one place. */

export class KioskPage {
  constructor(readonly page: Page, private readonly tenant?: string) {}

  goto() {
    return this.page.goto(this.tenant ? `/kiosk?tenant=${this.tenant}` : '/kiosk');
  }

  get label() { return this.page.getByLabel('Label'); }
  get priority() { return this.page.getByLabel('Priority'); }
  get duration() { return this.page.getByLabel(/Estimated duration/); }
  get submit() { return this.page.getByRole('button', { name: /Add to queue|Adding/ }); }
  get notice() { return this.page.getByRole('status'); }
  get status() { return this.page.locator('header .status'); }
  get waitingSection() { return this.page.locator('section', { has: this.page.getByRole('heading', { name: /^Waiting/ }) }); }
  get processingSection() { return this.page.locator('section', { has: this.page.getByRole('heading', { name: /^Now processing/ }) }); }

  waitingRow(label: string) { return this.waitingSection.locator('.queue-item', { hasText: label }); }
  processingRow(label: string) { return this.processingSection.locator('.queue-item', { hasText: label }); }

  async enqueue(label: string, opts: { priority?: 'normal' | 'high'; seconds?: number } = {}) {
    await this.label.fill(label);
    if (opts.priority) await this.priority.selectOption(opts.priority);
    if (opts.seconds) await this.duration.fill(String(opts.seconds));
    await this.submit.click();
  }
}

export class DisplayPage {
  constructor(readonly page: Page, private readonly tenant?: string) {}

  goto() {
    return this.page.goto(this.tenant ? `/display?tenant=${this.tenant}` : '/display');
  }

  get waiting() { return this.page.locator('section:not(.processing)'); }
  get processing() { return this.page.locator('section.processing'); }
  get offlineBanner() { return this.page.locator('.offline'); }
  get footer() { return this.page.locator('footer'); }
}
