import { BrowserContext, Page, WebSocketRoute } from '@playwright/test';

/** Wire shapes the Angular app expects (mirrors src/app/queue/queue.model.ts). */
interface Item {
  id: string;
  label: string;
  priority: 'normal' | 'high';
  payload: { durationMs: number; notes?: string };
  enqueuedAt: string;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
};

/**
 * A tiny in-memory stand-in for the Rust server: same routes, same JSON, and it pushes a full
 * snapshot to every open socket after each change, just like the real one.
 * Register on a BrowserContext to share one fake backend between several pages.
 */
export async function mockBackend(target: Page | BrowserContext) {
  const sockets = new Set<WebSocketRoute>();
  const requests: RecordedRequest[] = [];
  let waiting: Item[] = [];
  let processing: (Item & { startedAt: string; worker: string })[] = [];
  let completed: (Item & { startedAt: string; completedAt: string; worker: string })[] = [];
  let version = 0;
  let nextId = 1;
  let failNextEnqueue: string | null = null;

  const snapshot = () => ({
    tenant: 'default',
    version,
    waiting: waiting.map((i) => ({ status: 'waiting', ...i })),
    processing: processing.map((i) => ({ status: 'processing', ...i })),
    completed: completed.map((i) => ({ status: 'completed', ...i })),
  });
  const broadcast = () => {
    version++;
    for (const ws of sockets) ws.send(JSON.stringify(snapshot()));
  };

  await target.routeWebSocket(/\/ws\/queue/, (ws) => {
    sockets.add(ws);
    ws.onClose(() => sockets.delete(ws));
    ws.send(JSON.stringify(snapshot()));
  });

  await target.route('http://localhost:3000/api/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });

    const path = new URL(req.url()).pathname;
    requests.push({
      method: req.method(),
      url: path,
      headers: req.headers(),
      body: req.postData() ? JSON.parse(req.postData()!) : null,
    });
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    if (path === '/api/enqueue') {
      if (failNextEnqueue) {
        const error = failNextEnqueue;
        failNextEnqueue = null;
        return json(400, { error });
      }
      const body = JSON.parse(req.postData()!);
      const item: Item = {
        id: `item-${nextId++}`,
        label: body.label,
        priority: body.priority ?? 'normal',
        payload: body.payload,
        enqueuedAt: new Date().toISOString(),
      };
      const at = item.priority === 'high' ? waiting.findIndex((i) => i.priority === 'normal') : -1;
      const position = at === -1 ? waiting.length : at;
      waiting.splice(position, 0, item);
      broadcast();
      return json(201, { id: item.id, position });
    }

    const m = path.match(/^\/api\/items\/([^/]+)\/(cancel|prioritize)$/);
    if (m) {
      const [, id, action] = m;
      const idx = waiting.findIndex((i) => i.id === id);
      if (idx === -1) return json(404, { error: `item ${id} not found in the waiting list` });
      const [item] = waiting.splice(idx, 1);
      if (action === 'cancel') {
        broadcast();
        return route.fulfill({ status: 204, headers: CORS });
      }
      item.priority = 'high';
      const at = waiting.findIndex((i) => i.priority === 'normal');
      const position = at === -1 ? waiting.length : at;
      waiting.splice(position, 0, item);
      broadcast();
      return json(200, { id, position });
    }
    return json(404, { error: 'unknown route' });
  });

  return {
    requests,
    /** The next POST /api/enqueue is rejected with HTTP 400 and this message. */
    failNextEnqueue: (message: string) => (failNextEnqueue = message),
    /** Seed an item directly (as if another client enqueued it). */
    add(label: string, priority: 'normal' | 'high' = 'normal') {
      const item: Item = { id: `item-${nextId++}`, label, priority, payload: { durationMs: 1000 }, enqueuedAt: new Date().toISOString() };
      const at = priority === 'high' ? waiting.findIndex((i) => i.priority === 'normal') : -1;
      waiting.splice(at === -1 ? waiting.length : at, 0, item);
      broadcast();
    },
    /** Simulates a resource claiming the head of the line. */
    startNext(worker = 'resource-1') {
      const item = waiting.shift();
      if (!item) return;
      processing.push({ ...item, startedAt: new Date().toISOString(), worker });
      broadcast();
    },
    /** Simulates the oldest processing item finishing. */
    completeNext() {
      const item = processing.shift();
      if (!item) return;
      completed.unshift({ ...item, completedAt: new Date().toISOString() });
      broadcast();
    },
    /** Drops every open WebSocket (the app should show "Reconnecting…" and recover). */
    dropSockets() {
      for (const ws of [...sockets]) ws.close();
    },
    socketCount: () => sockets.size,
  };
}
