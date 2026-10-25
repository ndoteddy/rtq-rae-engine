import { DestroyRef, Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, Subscription, timer } from 'rxjs';
import { repeat, retry } from 'rxjs/operators';
import { WebSocketSubjectConfig, webSocket } from 'rxjs/webSocket';

import {
  ConnectionStatus,
  EnqueueRequest,
  EnqueueResponse,
  JobPayload,
  QueueSnapshot,
} from './queue.model';

// Move these into environment files per deployment.
const API_BASE = 'http://localhost:3000';
const WS_BASE = 'ws://localhost:3000';
/** Low-privilege key for this kiosk; must be listed in the backend's API_KEYS. */
const KIOSK_API_KEY = 'kiosk-key-123';

/** Factory for the WebSocket stream; overridden in tests so no real socket is opened. */
export type SocketFactory = (
  config: WebSocketSubjectConfig<QueueSnapshot<JobPayload>>,
) => Observable<QueueSnapshot<JobPayload>>;

export const SOCKET_FACTORY = new InjectionToken<SocketFactory>('SOCKET_FACTORY', {
  providedIn: 'root',
  factory: () => (config) => webSocket<QueueSnapshot<JobPayload>>(config),
});

/**
 * Single source of truth for queue state.
 * - Reads: one persistent WebSocket feeds a private writable signal; consumers get read-only views.
 * - Writes: HTTP calls only. The UI never mutates local state; it waits for the server's next
 *   snapshot, so every screen always shows what the server actually holds.
 */
@Injectable({ providedIn: 'root' })
export class QueueService {
  private readonly http = inject(HttpClient);
  private readonly socketFactory = inject(SOCKET_FACTORY);

  private readonly _snapshot = signal<QueueSnapshot<JobPayload> | null>(null);
  private readonly _status = signal<ConnectionStatus>('connecting');

  private socketSub?: Subscription;
  private lastVersion = -1;
  private tenant = 'default';

  /** Read-only signals: components cannot call `.set()` on these. */
  readonly snapshot = this._snapshot.asReadonly();
  readonly status = this._status.asReadonly();

  /** Derived, memoized slices; they recompute only when the snapshot changes. */
  readonly waiting = computed(() => this._snapshot()?.waiting ?? []);
  readonly processing = computed(() => this._snapshot()?.processing ?? []);
  readonly completed = computed(() => this._snapshot()?.completed ?? []);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.disconnect());
  }

  /** Idempotent: calling twice for the same tenant keeps the existing socket. */
  connect(tenant = 'default'): void {
    if (this.socketSub && !this.socketSub.closed && tenant === this.tenant) return;
    this.disconnect();
    this.tenant = tenant;
    this._status.set('connecting');

    const socket$ = this.socketFactory({
      url: `${WS_BASE}/ws/queue?tenant=${encodeURIComponent(tenant)}`,
      openObserver: {
        next: () => {
          // A restarted server restarts versions at 0, so forget the old high-water mark.
          this.lastVersion = -1;
          this._status.set('open');
        },
      },
    });

    this.socketSub = socket$
      .pipe(
        // Exponential backoff capped at 15s; the counter resets after a successful message.
        retry({
          resetOnSuccess: true,
          delay: (_err, attempt) => {
            this._status.set('reconnecting');
            return timer(Math.min(1000 * 2 ** (attempt - 1), 15_000));
          },
        }),
        // A clean close (e.g. server restart sending a Close frame) completes the stream instead of
        // erroring, so `retry` alone would leave the screen frozen. Resubscribe in that case too.
        repeat({
          delay: () => {
            this._status.set('reconnecting');
            return timer(1000);
          },
        }),
      )
      .subscribe((snap) => {
        if (snap.version <= this.lastVersion) return; // stale or duplicate
        this.lastVersion = snap.version;
        this._snapshot.set(snap);
      });
  }

  disconnect(): void {
    this.socketSub?.unsubscribe();
    this.socketSub = undefined;
  }

  // ---- commands (HTTP). The resulting state change arrives via the WebSocket. ----

  enqueue(req: EnqueueRequest<JobPayload>): Observable<EnqueueResponse> {
    return this.http.post<EnqueueResponse>(`${API_BASE}/api/enqueue`, req, { headers: this.headers() });
  }

  cancel(id: string): Observable<void> {
    return this.http.post<void>(`${API_BASE}/api/items/${id}/cancel`, null, { headers: this.headers() });
  }

  prioritize(id: string): Observable<{ id: string; position: number }> {
    return this.http.post<{ id: string; position: number }>(`${API_BASE}/api/items/${id}/prioritize`, null, {
      headers: this.headers(),
    });
  }

  private headers(): HttpHeaders {
    return new HttpHeaders({ 'x-api-key': KIOSK_API_KEY, 'x-tenant-id': this.tenant });
  }
}
