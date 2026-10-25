# The Waiting Room Problem: How a Rust Engine and an Angular Screen Keep Everyone in Line

### A proof of concept for real-time queues, and the security lessons we found before anyone else did

*By nandoz (Hernando Ivan Teddy) · Engineering notes · October 2026 · 9 min read*

---

**Everyone has stood in a line and not known how long it would take.** A boutique check-in, a distributor's order desk, a factory floor waiting on a machine: the story is the same. People wait, a few resources work, and nobody can see the whole picture.

We built a proof of concept to fix that. It is a small, universal queue and resource-allocation engine, written in Rust, with an Angular front end that shows the same live state on a kiosk and on a wall-mounted TV. This article answers the questions any newsroom would ask first: **what** we built, **who** it is for, **when** it matters, **where** it runs, **why** we built it this way, and **how** it works.

It also tells you something most proofs of concept leave out: what a security review found when we pointed it at our own code.

---

## The 5 Ws and the H, in 60 seconds

| | |
|---|---|
| **What** | A multi-tenant, real-time queue engine. Items are added over a REST API, picked up by background workers, and every screen sees each change within moments over a WebSocket. |
| **Who** | Operators who add and reorder items (kiosk), the public who watch progress (display), and external systems such as web shops, ERPs or point-of-sale that add items automatically. Built as a PoC by nandoz (Hernando Ivan Teddy). |
| **When** | Whenever demand outruns capacity: store rush hours, order peaks, batch jobs that wait for a machine. |
| **Where** | One Rust service on port 3000, one Angular app in the browser. Tenants are separated by an identifier, so one deployment can serve many businesses. |
| **Why** | Queue state usually lives in someone's head, a spreadsheet or a paper ticket. We wanted one source of truth that every screen trusts. |
| **How** | The browser sends commands over plain HTTP. The server owns all state and pushes complete snapshots over a WebSocket. The UI never edits its own copy. |

---

## What: one queue, many screens

The product is deliberately small. An item has a label (such as "Order #1042"), a priority (`normal` or `high`) and an open-ended JSON payload that the engine never looks inside. An item moves through three states: **waiting**, **processing**, **completed**.

Two screens consume it:

- **`/kiosk`** is for staff and self-service. A form adds items, and buttons prioritize or cancel waiting ones.
- **`/display`** is read-only and made for a TV. It shows who is waiting, what is being processed, and the last few completions, with a "Reconnecting…" banner if the link drops.

Both accept `?tenant=<id>`, so the same build can show a different business's queue.

## Who: three kinds of users, one API

The engine was designed around three audiences, and it helps to name them because they want different things from the same system.

1. **The operator** needs control: add, bump to the front, cancel.
2. **The waiting public** needs only to read. Their screen must never be able to change anything.
3. **Other software** needs a dependable endpoint. A shop's webhook should be able to `POST` an order with the same call a human uses.

The last one is why the REST API is first-class and documented with Swagger, not an afterthought behind a UI.

## When and where: the moments a queue becomes a problem

A queue is invisible until demand exceeds capacity. That is exactly when information is most valuable, and when systems built on polling tend to fail: a hundred screens asking "anything new?" every second is the load you do not want during a rush.

So the design assumes the busy moment. Updates are pushed, not pulled. One change is serialized once and shared with every connected screen. A screen that falls behind is not queued up for catch-up; it simply gets the latest full picture.

## Why: three decisions that shaped everything

### 1. The server is the only source of truth

The most tempting thing in a UI is the optimistic update: click "Cancel", remove the row immediately, fix it later if the server disagrees. We refused. The Angular `QueueService` sends commands over HTTP and then **waits** for the next snapshot over the WebSocket. Nothing changes locally on its own.

The cost is a few milliseconds of delay on a click. The benefit is that the kiosk, the TV and a second kiosk in another room can never disagree.

### 2. Snapshots, not deltas

Each WebSocket message is the whole queue for one tenant, stamped with a version number that only grows. Deltas are smaller, but they need ordering, acknowledgements and replay logic. A snapshot is **idempotent**: lose one and the next repairs everything. The client simply drops anything with a version it has already seen. After a server restart the version starts again at zero, so the client resets its high-water mark on every reconnect.

This trades bandwidth for simplicity, which is the right trade for queues of tens or hundreds of items. It is also the first thing we would revisit at thousands (more on that below).

### 3. Keep the domain pure

The queue rules live in one file, `domain.rs`, which knows nothing about HTTP, locks or sockets. It is plain synchronous data: enqueue, claim, complete, cancel, prioritize. Because of that, the interesting rules can be tested in microseconds with no server running:

- High priority jumps ahead of normal items but **behind** other high-priority items.
- Every successful change bumps the version exactly once, and a failed change bumps it zero times.
- Work already in progress cannot be cancelled.
- Completed history is capped, newest first.

## How: the architecture

```
   HTTP POST (commands)                      WebSocket (state)
Kiosk ─────────────────► Rust API ─────────────────────────► Kiosk + Display
                            │
                   shared state (one lock)
                            │
                    background workers
```

The backend is a library with a thin `main.rs`, split into layers that only depend downward:

| Layer | Responsibility |
|---|---|
| `api/` | Routes, handlers, middleware (API key, tenant), WebSocket, OpenAPI docs |
| `worker` | Background resource processors that claim and complete jobs |
| `state` | Shared state: the per-tenant queues, a broadcast channel, a wake-up signal |
| `domain` | Pure queue logic |
| `config`, `error` | Environment settings; mapping errors to HTTP status codes |

A few details worth a closer look:

**One short lock.** All tenants live in one map behind a standard mutex. That sounds naive until you notice that every critical section is short, CPU-only and never waits on I/O. A snapshot is published *while the lock is held*, which guarantees subscribers see versions in order.

**Workers that never block the line.** A worker claims the next job under the lock, **releases it**, and only then does the slow work (a sleep standing in for a machine or a cook). A 30-second job never stops anyone from enqueueing. Idle workers sleep on a notification, with a one-second safety poll in case a wake-up is missed.

**A documented API from day one.** Using `utoipa`, the endpoints describe themselves. Run the server and open `/swagger-ui` to try `POST /api/enqueue` in the browser. The same specification is available as JSON at `/api-docs/openapi.json` for code generators and API gateways.

**The front end mirrors the wire.** The Angular app keeps a single signal holding the latest snapshot, exposes read-only views (`waiting`, `processing`, `completed`, `status`), and reconnects with exponential backoff capped at 15 seconds. Components are standalone, `OnPush`, with no manual subscriptions. A context file, `API_CONTEXT.md`, lists exactly which endpoints the UI uses so the contract is written down once.

---

## Proving it works

A PoC that cannot be trusted proves nothing, so testing was part of the architecture, not a final step.

| Layer | What exists |
|---|---|
| Backend unit tests | 22 tests in the modules: domain rules, state broadcast and tenant isolation, worker duration clamping and a job completed in virtual time, tenant-header validation, error-to-status mapping, config parsing |
| Backend integration tests | 9 tests that drive the real router in-process with no sockets: enqueue, cancel (204/404/409), prioritize, API-key enforcement, tenant isolation, and that the OpenAPI spec lists every route and Swagger UI is served |
| Frontend | 22 unit tests, 12 mocked end-to-end tests, and 10 end-to-end tests against the real backend |

**An honest note.** On the machine used to assemble this article, the Rust code type-checks for all targets (`cargo check --all-targets` passes), but the backend test binaries could not be executed: a Windows Application Control policy blocked one dependency's build script. We did not bypass it. The backend tests are written and compile; they have not yet been run end to end here, so run `cargo test` in your own environment before relying on them.

---

## The plot twist: we reviewed ourselves

Having built it, we did what a newsroom does with its own story: we checked it for what could go wrong. The full list is in `security.md`. The headlines are worth sharing because they are typical of almost every PoC.

**What worried us most**

- **Keys were not tied to tenants.** Any valid API key could act on any tenant by changing one header.
- **The live feed was open.** The WebSocket needed no credentials and would happily create state for any tenant name a stranger typed, which is both a privacy risk and a slow memory leak.
- **It failed open.** Forget to set `API_KEYS` and the server turns authentication off and listens on every network interface.
- **There were no limits.** Nothing capped label size, payload size, queue length or the number of tenants.
- **The browser held the key.** The kiosk's API key is a constant in the JavaScript bundle, and the public display page loads the same bundle.

**What we got right**

- Angular's templates escape everything, and a search found no `innerHTML`, `bypassSecurityTrust` or `eval`.
- The production dependency audit of the front end reported zero vulnerabilities.
- The domain's strict versioning makes stale-data bugs hard to introduce.

None of this is shameful. A PoC exists to answer "does the idea work?", and these are precisely the questions that come *after* a yes. The value is in writing them down while the code is still small enough to change cheaply.

## What comes next

The security notes translate into a short roadmap:

1. **Now:** enforce size limits, stop the WebSocket from creating tenants, default to closed and local-only, add `.gitignore`, and hide Swagger behind a flag.
2. **Next:** attach each key to a role and a list of tenants and return `403` outside it; give displays a read-only, short-lived ticket; add rate limits and per-tenant quotas; make worker scheduling fair.
3. **Before real customers:** TLS, a Content-Security-Policy, real operator login, a public view of the queue that hides personal details such as customer names, and continuous dependency and secret scanning.

On the scaling side, the "one global lock, full snapshots" design is the first thing to change at larger sizes: per-tenant locks, serializing outside the lock, and capped or delta snapshots.

## Try it

```bash
# Backend
cd Backend
API_KEYS=kiosk-key-123 cargo run        # Swagger UI: http://localhost:3000/swagger-ui

# Frontend
cd Frontend
npm install
npm start                               # http://localhost:4200  (/kiosk and /display)
```

*(On Windows PowerShell: `$env:API_KEYS="kiosk-key-123"; cargo run`.)*

---

## The takeaway

The most useful thing a queue can do is make waiting **legible**. The technical recipe was modest: one source of truth, idempotent snapshots, a pure core, tests next to the code. The lesson that stuck is about order of work. Build the smallest honest version, make it observable, then interrogate it yourself before anyone else does.

*The code, the Swagger documentation, the API context file for the Angular app and the full security review are in the repository.*
