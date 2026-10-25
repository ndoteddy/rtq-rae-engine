import { DestroyRef, Signal, inject, signal } from '@angular/core';

import { JobPayload, ProcessingItem } from './queue.model';

/** A signal holding the current time, refreshed on an interval and cleaned up with the component. */
export function injectNow(intervalMs = 500): Signal<number> {
  const now = signal(Date.now());
  const timer = setInterval(() => now.set(Date.now()), intervalMs);
  inject(DestroyRef).onDestroy(() => clearInterval(timer));
  return now.asReadonly();
}

/** 0-100 progress of a processing item, estimated from its start time and requested duration. */
export function progressPct(item: ProcessingItem<JobPayload>, now: number): number {
  const total = item.payload?.durationMs;
  if (!total || total <= 0) return 0;
  const elapsed = now - new Date(item.startedAt).getTime();
  return Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
}

/** "5s" / "1m 05s" for a payload duration in milliseconds. */
export function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
