import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';

import { JobPayload, Priority, ProcessingItem } from '../queue/queue.model';
import { QueueService } from '../queue/queue.service';
import { formatDuration, injectNow, progressPct } from '../queue/queue.util';

interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

/** Administrative / self-service view: append to the queue, and prioritize or cancel waiting items. */
@Component({
  selector: 'app-kiosk',
  standalone: true,
  imports: [ReactiveFormsModule, DatePipe],
  templateUrl: './kiosk.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KioskComponent {
  protected readonly queue = inject(QueueService);
  private readonly fb = inject(NonNullableFormBuilder);

  protected readonly now = injectNow();
  protected readonly duration = formatDuration;

  protected progress(item: ProcessingItem<JobPayload>): number {
    return progressPct(item, this.now());
  }

  protected readonly priorities: Priority[] = ['normal', 'high'];
  protected readonly submitting = signal(false);
  protected readonly notice = signal<Notice | null>(null);

  protected readonly form = this.fb.group({
    label: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
    priority: ['normal' as Priority],
    durationSeconds: [5, [Validators.required, Validators.min(1), Validators.max(60)]],
    notes: [''],
  });

  constructor() {
    // `/kiosk?tenant=acme` scopes this screen to one tenant; defaults to "default".
    this.queue.connect(inject(ActivatedRoute).snapshot.queryParamMap.get('tenant') ?? 'default');
  }

  protected submit(): void {
    if (this.form.invalid || this.submitting()) {
      this.form.markAllAsTouched();
      return;
    }
    const { label, priority, durationSeconds, notes } = this.form.getRawValue();
    this.submitting.set(true);
    // Lock the inputs while the request is in flight so a late response cannot reset text the user typed meanwhile.
    this.form.disable({ emitEvent: false });

    this.queue
      .enqueue({
        label: label.trim(),
        priority,
        payload: { durationMs: durationSeconds * 1000, notes: notes || undefined },
      })
      .subscribe({
        next: (res) => {
          this.notice.set({ kind: 'ok', text: `Added "${label.trim()}" at position ${res.position + 1}` });
          this.form.reset({ label: '', priority: 'normal', durationSeconds, notes: '' });
          this.form.enable({ emitEvent: false });
          this.submitting.set(false);
        },
        error: (err) => this.fail(err),
      });
  }

  protected prioritize(id: string): void {
    this.queue.prioritize(id).subscribe({ error: (err) => this.fail(err) });
  }

  protected cancel(id: string): void {
    this.queue.cancel(id).subscribe({ error: (err) => this.fail(err) });
  }

  private fail(err: unknown): void {
    const text =
      err instanceof HttpErrorResponse ? (err.error?.error ?? err.message) : 'Unexpected error';
    this.notice.set({ kind: 'error', text });
    if (this.submitting()) {
      this.form.enable({ emitEvent: false });
      this.submitting.set(false);
    }
  }
}
