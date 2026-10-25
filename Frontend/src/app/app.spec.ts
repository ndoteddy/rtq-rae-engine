import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  it('creates the root component', () => {
    TestBed.configureTestingModule({ imports: [App], providers: [provideRouter(routes)] });
    expect(TestBed.createComponent(App).componentInstance).toBeTruthy();
  });

  it('declares /kiosk and /display routes', () => {
    const paths = routes.map((r) => r.path);
    expect(paths).toContain('kiosk');
    expect(paths).toContain('display');
  });
});
