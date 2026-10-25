/**
 * TypeScript mirror of the Rust models in `backend/src/domain.rs`.
 * Field names are camelCase and `status` is the serde tag of `QueueItem<T>`, so these
 * interfaces describe the wire JSON exactly. Timestamps are RFC 3339 strings, ids are UUID strings.
 */

export type Priority = 'normal' | 'high';

export interface ItemMeta<T = unknown> {
  id: string;
  label: string;
  priority: Priority;
  payload: T;
  enqueuedAt: string;
}

export interface WaitingItem<T = unknown> extends ItemMeta<T> {
  status: 'waiting';
}

export interface ProcessingItem<T = unknown> extends ItemMeta<T> {
  status: 'processing';
  startedAt: string;
  worker: string;
}

export interface CompletedItem<T = unknown> extends ItemMeta<T> {
  status: 'completed';
  startedAt: string;
  completedAt: string;
  worker: string;
}

/** Discriminated union: narrow with `item.status`. */
export type QueueItem<T = unknown> = WaitingItem<T> | ProcessingItem<T> | CompletedItem<T>;

/** Message pushed over `/ws/queue` on every change. */
export interface QueueSnapshot<T = unknown> {
  tenant: string;
  /** Monotonic per tenant; used to discard stale snapshots. */
  version: number;
  waiting: WaitingItem<T>[];
  processing: ProcessingItem<T>[];
  completed: CompletedItem<T>[];
}

/** Body of `POST /api/enqueue`. */
export interface EnqueueRequest<T = unknown> {
  label: string;
  payload: T;
  priority?: Priority;
}

export interface EnqueueResponse {
  id: string;
  position: number;
}

/** Example payload for this deployment; the engine itself is payload-agnostic. */
export interface JobPayload {
  durationMs: number;
  notes?: string;
}

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';
