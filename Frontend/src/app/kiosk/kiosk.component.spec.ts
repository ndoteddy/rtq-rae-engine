import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { KioskComponent } from './kiosk.component';
import { FakeSocket, snapshot, waitingItem } from '../queue/queue.testing';

describe('KioskComponent', () => {
  let socket: FakeSocket;
  let http: HttpTestingController;

  // Template-bound members are `protected`, so tests reach them through an untyped view.
  const create = async () => {
    const fixture = TestBed.createComponent(KioskComponent);
    await fixture.whenStable();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { fixture, cmp: fixture.componentInstance as any };
  };

  beforeEach(() => {
    socket = new FakeSocket();
    TestBed.configureTestingModule({
      imports: [KioskComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), socket.provider],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('disables submit while the form is invalid', async () => {
    const { fixture } = await create();
    const btn = fixture.nativeElement.querySelector('button[type=submit]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('does not call the API for an invalid form', async () => {
    const { cmp } = await create();
    cmp.submit();
    http.expectNone('http://localhost:3000/api/enqueue');
  });

  it('submits a valid form as an enqueue request and resets the label', async () => {
    const { cmp } = await create();
    cmp.form.patchValue({ label: '  Order 42 ', priority: 'high', durationSeconds: 7, notes: '' });
    cmp.submit();

    const req = http.expectOne('http://localhost:3000/api/enqueue');
    expect(req.request.body).toEqual({
      label: 'Order 42',
      priority: 'high',
      payload: { durationMs: 7000, notes: undefined },
    });
    req.flush({ id: 'x', position: 0 });

    expect(cmp.notice()).toEqual({ kind: 'ok', text: 'Added "Order 42" at position 1' });
    expect(cmp.form.getRawValue().label).toBe('');
    expect(cmp.submitting()).toBe(false);
  });

  it('locks the form while a request is in flight and unlocks it afterwards', async () => {
    const { cmp } = await create();
    cmp.form.patchValue({ label: 'Order', durationSeconds: 5 });
    cmp.submit();
    expect(cmp.form.disabled).toBe(true);

    http.expectOne('http://localhost:3000/api/enqueue').flush({ id: 'x', position: 0 });
    expect(cmp.form.enabled).toBe(true);
    expect(cmp.form.getRawValue().label).toBe('');
  });

  it('unlocks the form after a failed request so the user can retry', async () => {
    const { cmp } = await create();
    cmp.form.patchValue({ label: 'Order', durationSeconds: 5 });
    cmp.submit();
    http.expectOne('http://localhost:3000/api/enqueue').flush({ error: 'nope' }, { status: 500, statusText: 'x' });
    expect(cmp.form.enabled).toBe(true);
    expect(cmp.form.getRawValue().label).toBe('Order');
  });

  it('surfaces the server error message', async () => {
    const { cmp } = await create();
    cmp.form.patchValue({ label: 'Bad', durationSeconds: 5 });
    cmp.submit();
    http
      .expectOne('http://localhost:3000/api/enqueue')
      .flush({ error: 'label must not be empty' }, { status: 400, statusText: 'Bad Request' });

    expect(cmp.notice()).toEqual({ kind: 'error', text: 'label must not be empty' });
    expect(cmp.submitting()).toBe(false);
  });

  it('lists waiting items and wires Prioritize / Cancel buttons', async () => {
    const { fixture } = await create();
    socket.push(snapshot(1, { waiting: [waitingItem('n1', 'Normal'), waitingItem('h1', 'Urgent', 'high')] }));
    await fixture.whenStable();

    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('section:nth-of-type(1) .queue-item');
    expect(rows.length).toBe(2);
    // The high-priority row has no Prioritize button; the normal row does.
    expect(rows[0].textContent).toContain('Prioritize');
    expect(rows[1].textContent).not.toContain('Prioritize');

    rows[0].querySelectorAll('button')[0].click();
    http.expectOne('http://localhost:3000/api/items/n1/prioritize').flush({ id: 'n1', position: 0 });

    const cancel = Array.from(rows[1].querySelectorAll('button')).find((b) => b.textContent?.includes('Cancel'))!;
    cancel.click();
    http.expectOne('http://localhost:3000/api/items/h1/cancel').flush(null);
  });
});
