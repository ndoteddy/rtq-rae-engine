import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';

import { DisplayComponent } from './display.component';
import { FakeSocket, processingItem, snapshot, waitingItem } from '../queue/queue.testing';

describe('DisplayComponent', () => {
  let socket: FakeSocket;

  const render = async () => {
    const fixture = TestBed.createComponent(DisplayComponent);
    await fixture.whenStable();
    return fixture;
  };

  beforeEach(() => {
    socket = new FakeSocket();
    TestBed.configureTestingModule({
      imports: [DisplayComponent],
      providers: [provideHttpClient(), provideRouter([]), socket.provider],
    });
  });

  it('shows empty states and a reconnect banner before connecting', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('No one waiting');
    expect(el.textContent).toContain('Idle');
    expect(el.querySelector('.offline')).not.toBeNull();
  });

  it('renders waiting and processing columns from pushed snapshots', async () => {
    const fixture = await render();
    socket.open();
    socket.push(
      snapshot(1, {
        waiting: [waitingItem('a', 'Alice'), waitingItem('b', 'Bob', 'high')],
        processing: [processingItem('c', 'Carol')],
      }),
    );
    await fixture.whenStable();

    const el = fixture.nativeElement as HTMLElement;
    const waiting = el.querySelector('section:not(.processing)')!.textContent;
    const processing = el.querySelector('section.processing')!.textContent;
    expect(waiting).toContain('Alice');
    expect(waiting).toContain('Bob');
    expect(waiting).not.toContain('Carol');
    expect(processing).toContain('Carol');
    expect(el.querySelector('li.high')?.textContent).toContain('Bob');
    expect(el.querySelector('.offline')).toBeNull();
  });
});
