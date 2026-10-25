import { Routes } from '@angular/router';

// Remember `provideHttpClient()` and `provideRouter(routes)` in app.config.ts.
export const routes: Routes = [
  { path: 'kiosk', loadComponent: () => import('./kiosk/kiosk.component').then((m) => m.KioskComponent) },
  { path: 'display', loadComponent: () => import('./display/display.component').then((m) => m.DisplayComponent) },
  { path: '', pathMatch: 'full', redirectTo: 'kiosk' },
];
