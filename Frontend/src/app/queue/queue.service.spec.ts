import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { vi } from 'vitest';

import { QueueService } from './queue.service';
import { FakeSocket, processingItem, snapshot, waitingItem } from './queue.testing';

describe('QueueService', () => {
  let service: QueueService;
  let socket: FakeSocket;
  let http: HttpTestingController;

  beforeEach(() => {
    socket = new FakeSocket();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), socket.provider],
    });
    service = TestBed.inject(QueueService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('starts empty and connecting', () => {
    expect(service.snapshot()).toBeNull();
    expect(service.waiting()).toEqual([]);
    expect(service.status()).toBe('connecting');
  });

  it('connects to the tenant-scoped WebSocket URL', () => {
    service.connect('acme corp');
    expect(socket.config?.url).toBe('ws://localhost:3000/ws/queue?tenant=acme%20corp');
  });

  it('is idempotent for the same tenant', () => {
    service.connect();
    service.connect();
    expect(socket.created).toBe(1);
  });

  it('reports open status once the socket opens', () => {
    service.connect();
    socket.open();
    expect(service.status()).toBe('open');
  });

  it('publishes snapshots through derived signals', () => {
    service.connect();
    socket.push(snapshot(1, { waiting: [waitingItem('a')], processing: [processingItem('b')] }));
    expect(service.waiting().map((i) => i.id)).toEqual(['a']);
    expect(service.processing().map((i) => i.id)).toEqual(['b']);
    expect(service.completed()).toEqual([]);
  });

  it('ignores stale and duplicate snapshots', () => {
    service.connect();
    socket.push(snapshot(5, { waiting: [waitingItem('new')] }));
    socket.push(snapshot(3, { waiting: [waitingItem('old')] }));
    socket.push(snapshot(5, { waiting: [waitingItem('dup')] }));
    expect(service.waiting().map((i) => i.id)).toEqual(['new']);
  });

  it('accepts a lower version after reconnect (server restart)', () => {
    service.connect();
    socket.push(snapshot(9, { waiting: [waitingItem('before')] }));
    socket.open();
    socket.push(snapshot(1, { waiting: [waitingItem('after')] }));
    expect(service.waiting().map((i) => i.id)).toEqual(['after']);
  });

  it('marks the connection as reconnecting after a socket error', () => {
    vi.useFakeTimers();
    try {
      service.connect();
      socket.messages.error(new Error('boom'));
      expect(service.status()).toBe('reconnecting');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects after a clean close (stream completes) instead of freezing', () => {
    vi.useFakeTimers();
    try {
      service.connect();
      socket.open();
      socket.messages.complete();
      expect(service.status()).toBe('reconnecting');
      expect(socket.subscriptions).toBe(1);
      vi.advanceTimersByTime(1000);
      expect(socket.subscriptions).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops receiving after disconnect', () => {
    service.connect();
    service.disconnect();
    socket.push(snapshot(1, { waiting: [waitingItem('x')] }));
    expect(service.snapshot()).toBeNull();
  });

  describe('commands', () => {
    it('POSTs enqueue with API key and tenant headers', () => {
      service.connect('shop-1');
      let result: unknown;
      service
        .enqueue({ label: 'Order 1', payload: { durationMs: 2000 }, priority: 'high' })
        .subscribe((r) => (result = r));

      const req = http.expectOne('http://localhost:3000/api/enqueue');
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('x-api-key')).toBeTruthy();
      expect(req.request.headers.get('x-tenant-id')).toBe('shop-1');
      expect(req.request.body).toEqual({ label: 'Order 1', payload: { durationMs: 2000 }, priority: 'high' });
      req.flush({ id: 'abc', position: 0 });
      expect(result).toEqual({ id: 'abc', position: 0 });
    });

    it('POSTs cancel and prioritize to item routes', () => {
      service.cancel('i1').subscribe();
      const c = http.expectOne('http://localhost:3000/api/items/i1/cancel');
      expect(c.request.method).toBe('POST');
      c.flush(null);

      service.prioritize('i2').subscribe();
      const p = http.expectOne('http://localhost:3000/api/items/i2/prioritize');
      expect(p.request.method).toBe('POST');
      p.flush({ id: 'i2', position: 0 });
    });

    it('does not mutate local state on command success (waits for the socket)', () => {
      service.connect();
      socket.push(snapshot(1, { waiting: [waitingItem('a')] }));
      service.cancel('a').subscribe();
      http.expectOne('http://localhost:3000/api/items/a/cancel').flush(null);
      expect(service.waiting().length).toBe(1);
    });
  });
});
