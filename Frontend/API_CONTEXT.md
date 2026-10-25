# Backend API context (for the Angular UI)

Single source of truth for **which backend endpoints this UI consumes**. The backend is the Rust `queue-engine` in `../Backend`.
Live, machine-readable contract: `http://localhost:3000/api-docs/openapi.json` (Swagger UI: `http://localhost:3000/swagger-ui`).

- **Base URL (HTTP):** `http://localhost:3000` — **WebSocket:** `ws://localhost:3000`
- Constants live in [`src/app/queue/queue.service.ts`](src/app/queue/queue.service.ts) (`API_BASE`, `WS_BASE`, `KIOSK_API_KEY`). Move to environment files per deployment.
- Types mirroring the wire JSON: [`src/app/queue/queue.model.ts`](src/app/queue/queue.model.ts).
- **Rule:** the UI never mutates local state. Writes go over HTTP; the resulting change arrives as a new snapshot over the WebSocket.

## Headers

| Header | Used on | Notes |
|---|---|---|
| `x-api-key` | all `POST /api/*` | Must be in the backend's `API_KEYS`. If the backend has no keys configured it is open (dev mode). Missing/wrong → `401`. |
| `x-tenant-id` | all `POST /api/*` | Optional, defaults to `default`. `[A-Za-z0-9_-]`, max 64 chars, else `400`. |
| `Content-Type: application/json` | requests with a body | Set automatically by `HttpClient`. |

## Endpoints consumed

### 1. `GET /ws/queue?tenant=<id>` (WebSocket, read-only, no API key)
Used by: `QueueService.connect()` → feeds Kiosk and Display screens.
Browsers can't set headers on WebSockets, so the tenant is a **query param** (default `default`).
Server sends a full `QueueSnapshot` immediately on connect, then again after every change. Anything the client sends is ignored.

```jsonc
{
  "tenant": "default",
  "version": 12,            // monotonic per tenant — drop snapshots with version <= last seen
  "waiting":    [{ "status": "waiting",    "id": "uuid", "label": "Order #1", "priority": "normal|high", "payload": {}, "enqueuedAt": "RFC3339" }],
  "processing": [{ "status": "processing", "...same fields", "startedAt": "RFC3339", "worker": "resource-1" }],
  "completed":  [{ "status": "completed",  "...same fields", "startedAt": "RFC3339", "completedAt": "RFC3339", "worker": "resource-1" }]  // newest first, max 20
}
```
Note: a restarted server resets `version` to 0 — reset the high-water mark on reconnect (already done in `QueueService`).

### 2. `POST /api/enqueue`
Used by: `QueueService.enqueue()` ← Kiosk form submit.

Request:
```json
{ "label": "Order #1042", "priority": "normal", "payload": { "durationMs": 5000, "notes": "optional" } }
```
- `label` required, non-blank. `priority`: `"normal"` (default) or `"high"`.
- `payload` is free-form JSON; `durationMs` (clamped 500–60000, default 5000) sets simulated processing time.

| Status | Body |
|---|---|
| `201` | `{ "id": "uuid", "position": 0 }` (position is zero-based) |
| `400` | `{ "error": "label must not be empty" }` or `"invalid x-tenant-id"` |
| `401` | `{ "error": "missing or invalid x-api-key" }` |

### 3. `POST /api/items/{id}/cancel`
Used by: `QueueService.cancel(id)` ← Kiosk "cancel" button. No request body.

| Status | Meaning |
|---|---|
| `204` | Removed from waiting list (no body) |
| `404` | Not in the waiting list |
| `409` | Already processing — cannot be cancelled |
| `401` | Bad/missing API key |

### 4. `POST /api/items/{id}/prioritize`
Used by: `QueueService.prioritize(id)` ← Kiosk "prioritize" button. No request body.

| Status | Body |
|---|---|
| `200` | `{ "id": "uuid", "position": 0 }` — new zero-based position (behind other high-priority items) |
| `404` | `{ "error": "..." }` not in the waiting list |
| `401` | Bad/missing API key |

## Error shape
Every failing REST call returns `{ "error": "<message>" }`. The Kiosk reads it with `err.error?.error` (see `KioskComponent.fail`).

## Not consumed by the UI
- `GET /health` — liveness probe for ops/monitoring.
- `GET /swagger-ui`, `GET /api-docs/openapi.json` — developer docs only.

## Screen → endpoint map

| Screen (route) | Reads | Writes |
|---|---|---|
| `/kiosk?tenant=acme` | WS `/ws/queue` | `POST /api/enqueue`, `/api/items/{id}/cancel`, `/api/items/{id}/prioritize` |
| `/display?tenant=acme` | WS `/ws/queue` | — |

## CORS
Backend currently allows any origin/method/header (dev). Tighten before production.
