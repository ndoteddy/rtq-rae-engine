import { Subject, defer } from 'rxjs';
import { WebSocketSubjectConfig } from 'rxjs/webSocket';

import { JobPayload, ProcessingItem, QueueSnapshot, WaitingItem } from './queue.model';
import { SOCKET_FACTORY } from './queue.service';

/** Test double for the WebSocket: lets a test push snapshots, simulate open/close and errors. */
export class FakeSocket {
  readonly messages = new Subject<QueueSnapshot<JobPayload>>();
  config?: WebSocketSubjectConfig<QueueSnapshot<JobPayload>>;
  created = 0;
  /** How many times the service (re)subscribed to the stream, i.e. connection attempts. */
  subscriptions = 0;

  readonly provider = {
    provide: SOCKET_FACTORY,
    useValue: (config: WebSocketSubjectConfig<QueueSnapshot<JobPayload>>) => {
      this.config = config;
      this.created++;
      return defer(() => {
        this.subscriptions++;
        return this.messages;
      });
    },
  };

  open(): void {
    this.config?.openObserver?.next(new Event('open'));
  }
  push(s: QueueSnapshot<JobPayload>): void {
    this.messages.next(s);
  }
}

export const waitingItem = (
  id: string,
  label = id,
  priority: 'normal' | 'high' = 'normal',
): WaitingItem<JobPayload> => ({
  status: 'waiting',
  id,
  label,
  priority,
  payload: { durationMs: 1000 },
  enqueuedAt: '2026-01-01T00:00:00Z',
});

export const processingItem = (id: string, label = id): ProcessingItem<JobPayload> => ({
  status: 'processing',
  id,
  label,
  priority: 'normal',
  payload: { durationMs: 1000 },
  enqueuedAt: '2026-01-01T00:00:00Z',
  startedAt: '2026-01-01T00:00:05Z',
  worker: 'resource-1',
});

export const snapshot = (
  version: number,
  parts: Partial<Omit<QueueSnapshot<JobPayload>, 'version'>> = {},
): QueueSnapshot<JobPayload> => ({ tenant: 'default', version, waiting: [], processing: [], completed: [], ...parts });
