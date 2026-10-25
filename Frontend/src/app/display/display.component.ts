import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute } from '@angular/router';

import { JobPayload, ProcessingItem } from '../queue/queue.model';
import { QueueService } from '../queue/queue.service';
import { injectNow, progressPct } from '../queue/queue.util';

/**
 * Read-only wall display. It holds no state of its own: the template reads the service signals,
 * so with OnPush Angular re-renders only when a new snapshot arrives (or the clock ticks).
 * Styling lives in `styles.css` (`.tv*`), on top of Bootstrap's grid and dark theme.
 */
@Component({
  selector: 'app-display',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './display.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DisplayComponent {
  protected readonly queue = inject(QueueService);
  protected readonly now = injectNow();

  constructor() {
    // `/display?tenant=acme` scopes this screen to one tenant; defaults to "default".
    this.queue.connect(inject(ActivatedRoute).snapshot.queryParamMap.get('tenant') ?? 'default');
  }

  protected progress(item: ProcessingItem<JobPayload>): number {
    return progressPct(item, this.now());
  }
}
