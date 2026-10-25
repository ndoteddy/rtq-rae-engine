# Security review & hardening plan

Scope: `Backend/` (Rust, axum, utoipa) and `Frontend/` (Angular). Static review of the source as it stood on 2026-10-25, plus `npm audit --omit=dev` (0 vulnerabilities). No penetration test, no `cargo audit`/`cargo deny` run (not installed), and the backend tests could not be executed on the review machine, so every finding below comes from reading the code, not from exploiting it.

Context: this is a PoC for a multi-tenant queue shown on public screens (kiosk + wall display). The main security properties to protect are **tenant isolation**, **who may change the queue**, **availability** (workers and memory), and **privacy of what is displayed** (customer names).

## Summary

| # | Severity | Area | Finding |
|---|---|---|---|
| B1 | **High** | Backend | API keys are not bound to a tenant: any valid key can read/write **any** tenant |
| B2 | **High** | Backend | WebSocket is unauthenticated, accepts any tenant string, and creates tenants on read |
| B3 | **High** | Backend | Fail-open: empty `API_KEYS` disables all auth, and the server binds `0.0.0.0` |
| B4 | **High** | Backend | No size/count limits or rate limiting, so memory and CPU can be exhausted |
| B5 | Medium | Backend | A client can hold both workers for 60 s each (`durationMs`); no fairness between tenants |
| B6 | Medium | Backend | CORS allows every origin; no Origin check on WebSocket |
| B7 | Medium | Backend | Swagger UI and OpenAPI spec are public, unauthenticated |
| B8 | Medium | Backend | No TLS, no security headers, no auth-failure logging |
| B9 | Low | Backend | API key comparison is a plain hash lookup (not constant time); keys are never rotated |
| B10 | Low | Backend | Supply chain: no `cargo audit`/`deny`, pinned transitive `zip`, vendored Swagger assets |
| F1 | **High** | Frontend | The API key is hard-coded in the public JS bundle, and the bundle also serves the read-only display |
| F2 | **High** | Frontend | No user authentication; the tenant is chosen via `?tenant=` in the URL |
| F3 | Medium | Frontend | Customer labels are broadcast to everyone who knows a tenant id and shown on a public screen |
| F4 | Medium | Frontend | No CSP / clickjacking protection; plain `http://`/`ws://` hard-coded |
| F5 | Medium | Frontend | WebSocket messages are trusted without runtime validation |
| F6 | Low | Frontend | Reconnect has no jitter; HTTP calls have no timeout/401 handling |
| R1 | Medium | Repo | Not a git repository; no root `.gitignore` (Backend has none, so `target/` would be committed) |
| R2 | Low | Repo | Sample key `kiosk-key-123` is documented as the default and used by e2e config |

Fix order: **B1+F2 (identity), B2, B4, B3, F1, then the rest.**

---

## Backend

### B1 – API keys are not scoped to a tenant (High)
`require_api_key` (`src/api/middleware.rs`) only checks that the key is in the set. `tenant_from` then trusts the `x-tenant-id` header. Anyone holding *any* key (for example the kiosk key that ships in the browser, see F1) can enqueue, cancel and prioritize in every other tenant by changing a header. All keys also have the same privileges: the kiosk key is as powerful as a webhook key.

Fix:
- Replace `HashSet<String>` with a map of `key -> { tenants: Vec<String> | "*", role }` (roles such as `display`, `kiosk`, `integration`, `admin`).
- After resolving the tenant, reject with `403` unless the key is allowed for it.
- Give `cancel` / `prioritize` to a stricter role than `enqueue`.
- Longer term: short-lived signed tokens (JWT/OIDC) with `tenant` and `role` claims, validated in the same middleware.

```rust
pub struct Principal { pub tenants: TenantScope, pub role: Role }
// middleware inserts Principal into request extensions; handlers call
// principal.authorize(&tenant, Action::Cancel)?;
```
Add tests: key A on tenant B returns 403; kiosk role cannot cancel if you decide so.

### B2 – WebSocket: no auth, unvalidated tenant, creates state (High)
`ws_queue` (`src/api/ws.rs`) takes `?tenant=` with **no** charset/length validation (the header path has it), and `snapshot_json` does `entry(tenant).or_default()`. Consequences:
1. Anyone who can reach the port can read any tenant's queue, including `label` and the free-form `payload` (potentially personal data).
2. Each connection with a new random tenant name inserts a permanent empty `QueueState` into the map: unbounded memory growth (see B4).
3. Tenant ids can be enumerated/guessed (`default`, company names).

Fix:
- Reuse one `validate_tenant()` for header and query param.
- Make **reads** non-creating: `snapshot_json` should use `get()` and return an empty snapshot without inserting.
- Authenticate the socket. Browsers can't set headers, so use a short-lived, tenant-scoped, single-use **ticket** obtained from an authenticated `POST /api/ws-ticket`, passed as `?ticket=...` (or `Sec-WebSocket-Protocol`). Never put the long-lived API key in the URL (it ends up in logs).
- If displays must stay public, make that an explicit decision per tenant and strip `payload` from public snapshots (send only what the screen needs, see F3).
- Add connection limits (global and per IP), an idle/ping timeout, and a maximum connection lifetime.

### B3 – Fail-open default (High)
`Config::from_env` accepts an empty `API_KEYS` and `require_api_key` then lets everything through; `BIND_ADDR` defaults to `0.0.0.0:3000`. A forgotten env var in production silently removes all protection and exposes it on every interface. Only a log warning is emitted.

Fix:
- Require auth by default; make open mode an explicit opt-in, e.g. `ALLOW_INSECURE_DEV=true`, which also forces binding `127.0.0.1`.
- Refuse to start in a "production" profile without keys.
- Default `BIND_ADDR` to `127.0.0.1:3000`.

### B4 – No limits: memory/CPU exhaustion (High)
- Nothing caps the **waiting list** per tenant, the **number of tenants** (the map is never evicted), the `label` length (only "not blank" is checked server-side; the 80-char limit exists only in the Angular form), or the `payload` size/shape (axum's default 2 MB body limit is the only bound).
- Every mutation serializes the **entire** snapshot (`publish`) **while holding the global mutex**, so cost per request grows with queue size and one big tenant slows all tenants. The broadcast then clones that JSON to every subscriber of every tenant.
- No rate limiting, no concurrency limit, no request timeout.

Fix:
- Validate in the handler: `label` ≤ 80 chars and no control characters; `payload` serialized ≤ e.g. 4 KB; `notes` ≤ N chars. Add `DefaultBodyLimit::max(16 * 1024)`.
- Cap waiting items per tenant (e.g. 1000 -> `429`/`409`) and total tenants; evict idle empty tenants.
- Add `tower` layers: `TimeoutLayer`, `ConcurrencyLimitLayer`, and per-IP/per-key rate limiting (`tower_governor`).
- Serialize snapshots outside the lock (clone the small state, drop the guard, then serialize), or per-tenant locks (`DashMap`/`RwLock<HashMap<_, Mutex<_>>>`) so tenants do not contend.
- Consider sending deltas or capping the snapshot (e.g. first 100 waiting) for large queues.

### B5 – Worker starvation / noisy neighbour (Medium)
`durationMs` (up to 60 000) is fully client-controlled and there are only 2 workers. Two requests with `durationMs: 60000` block every tenant for a minute, repeatedly. `claim_next` also iterates a `HashMap` in arbitrary order, so no tenant gets a fair turn.

Fix: treat `durationMs` as untrusted (only trusted roles may set it, or ignore it in production and use a server-side job type -> duration table), claim round-robin across tenants, add per-tenant concurrency quotas, and make real work cancellable with a timeout.

### B6 – CORS and WebSocket origin (Medium)
`CorsLayer::new().allow_origin(Any)...` (`src/api/mod.rs`). There are no cookies today so classic CSRF is not exploitable, but this will become unsafe the day cookie/session auth is added, and it lets any website drive the API from a visitor's network position (e.g. a kiosk on a LAN). The WebSocket handler does not check the `Origin` header.

Fix: configurable allow-list (`CORS_ORIGINS`), only the needed methods/headers (`content-type`, `x-api-key`, `x-tenant-id`), and an explicit `Origin` check in `ws_queue`.

### B7 – Public API docs (Medium)
`/swagger-ui` and `/api-docs/openapi.json` are always served. They are great for development but give attackers a full map, including auth scheme and header names.

Fix: serve them only when `ENABLE_DOCS=true` (default off outside dev), or put them behind auth / an internal-only listener.

### B8 – Transport, headers, logging (Medium)
- Plain HTTP/WS: the `x-api-key` header travels in clear text. Terminate TLS at a reverse proxy (or use `axum-server` + rustls) and use `wss://`; add HSTS.
- No response hardening headers: add `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on API responses (`tower-http` `SetResponseHeaderLayer`).
- Log auth failures (without the submitted key), include a request id, and alert on bursts of `401`/`403`.
- `tracing::info!` logs the item `label` (can be a customer name). Log ids, not labels, or redact in production. Keep `RUST_LOG` at `info` in production (`tower_http=debug` is the dev default in `main.rs`).
- Add graceful shutdown (`with_graceful_shutdown`) so in-flight work and sockets close cleanly.

### B9 – Key handling (Low)
- `HashSet::contains` is not constant time; use `subtle::ConstantTimeEq` over hashed keys (compare SHA-256 digests) or look keys up by a non-secret key id.
- Keys come only from an env var: no rotation, no per-key revocation, no expiry, no audit of which key did what. Store keys hashed, support two active keys during rotation, and log the key id (not value) on each write.
- Throttle repeated failures per IP.

### B10 – Supply chain (Low)
- Run `cargo audit` and `cargo deny` (advisories, licenses, duplicate crates) in CI; commit `Cargo.lock` (done) and build with `--locked`.
- `zip` was pinned to 2.4.2 because 2.6.1 breaks `utoipa-swagger-ui` 8.1's build script. Revisit when upgrading to `utoipa-swagger-ui` 9 / axum 0.8.
- `utoipa-swagger-ui` vendors Swagger UI JS: keep it updated, and do not serve it in production (B7).
- Add `rust-toolchain.toml` to pin the compiler. Build with `cargo build --release --locked` in a minimal, non-root container (distroless/scratch, read-only filesystem).

---

## Frontend

### F1 – API key shipped in the bundle (High)
`KIOSK_API_KEY = 'kiosk-key-123'` is a constant in `src/app/queue/queue.service.ts`. Anyone who opens the site (including the **display** route, which only needs read access) can read it from DevTools and then call the write API directly, for any tenant (B1). The README acknowledges this and recommends a "low-privilege key", but no such privilege separation exists in the backend yet.

Fix (pick one, in order of preference):
1. Real user login (OIDC/OAuth) for the kiosk; the SPA sends a short-lived access token, not a static key. The display uses no credential or a read-only ticket (B2).
2. A small backend-for-frontend that holds the key server-side and exposes only the kiosk actions to authenticated operators.
3. If the kiosk is a managed device: per-device key provisioned at deploy time (not in the repo/bundle), restricted by network allow-list, rotated, and scoped to one tenant and role (B1).

Also: split the display and kiosk into separately built entry points or at least separate API credentials, so the public TV page never carries write capability.

### F2 – No authentication; tenant from the URL (High)
`/kiosk?tenant=acme` and `/display?tenant=acme` let any visitor pick any tenant (`kiosk.component.ts` reads `queryParamMap`). There is no login, route guard or role check, so UI access control is nonexistent, and the server cannot tell tenants apart (B1/B2).

Fix: derive the tenant from the authenticated session/token; add `CanActivate` guards for `/kiosk`; keep `?tenant=` only for authorized super-users. UI guards are convenience only: the real enforcement must be on the backend.

### F3 – Privacy of displayed data (Medium)
Labels such as customer names are pushed to every subscriber and rendered on a TV in a public space, and the snapshot also carries the whole `payload` (including `notes`) to the display although the display never uses it.

Fix: show ticket numbers or initials by default; let the backend produce a **public view** of the snapshot (no `payload`, minimal label) for display clients; keep full data for authenticated operators. Document retention for the "recently completed" list.

### F4 – CSP, framing and transport (Medium)
`src/index.html` has no Content-Security-Policy and the app has no way to set response headers by itself, so the hosting layer must. `API_BASE`/`WS_BASE` are hard-coded `http://localhost:3000` / `ws://localhost:3000`.

Fix:
- Send these headers from the static host/CDN: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://api.example.com wss://api.example.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`, plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, HSTS. `frame-ancestors 'none'` prevents clickjacking of the kiosk buttons. Test the CSP with the Angular production build (Angular's `security.autoCsp` option can add hashes/nonces for inline scripts).
- Move URLs/keys to `environment.*.ts` and use `https`/`wss` outside local development.

What is already good: Angular's template interpolation HTML-escapes everything; a search of `src/` found **no** `innerHTML`, `bypassSecurityTrust*` or `eval`. Keep it that way, for example with an ESLint rule banning `bypassSecurityTrust*` and `[innerHTML]`.

### F5 – Untrusted WebSocket input (Medium)
`webSocket<QueueSnapshot<JobPayload>>` only casts the parsed JSON. A malformed or hostile frame (wrong types, huge arrays, `version` as a string, `null` lists) is accepted and then flows into templates and `computed()`s. A compromised or spoofed server (plain `ws://`, see F4) can also push arbitrary labels.

Fix: validate each message with a type guard or schema (e.g. zod/valibot) before `_snapshot.set`, cap list lengths rendered, ignore frames that fail validation and log a metric. Enforce `wss://` outside localhost.

### F6 – Robustness (Low)
- `retry` backoff has no random jitter, so after a server restart all kiosks and displays reconnect in lockstep. Add 0-30 % jitter.
- HTTP calls have no timeout and there is no `HttpInterceptor` that handles `401/403/429` (for example redirect to login, show "too many requests"). Add one, and attach credentials in the interceptor instead of per call.
- Client-side validation (2-80 chars, 1-60 s) is only UX. Make sure the backend enforces the same rules (B4).

### Dependencies / build (Frontend)
- `npm audit --omit=dev`: 0 vulnerabilities. Also run plain `npm audit` in CI (dev tooling), use `npm ci`, and enable Dependabot/Renovate.
- Production builds only: `ng build` (default optimization) and never deploy `ng serve` or source maps publicly.
- Playwright reports (`playwright-report*`, `test-results`) can contain traces with request headers, including the API key. Do not commit or publish them.

---

## Repository & process

- **R1:** the project is not under version control and there is no root `.gitignore`; `Backend/` has none either, so `target/` (build output, GBs) would be committed. `Frontend/.gitignore` exists, but confirm it also lists `playwright-report*/`, `test-results/`, `.angular/` and `dist/`. Run `git init`, add ignore files, and enable secret scanning (`gitleaks`) as a pre-commit hook and in CI.
- **R2:** `kiosk-key-123` appears in README, `queue.service.ts` and `playwright.integration.config.ts`. Treat it strictly as a local-dev value, reject known sample keys at startup in non-dev profiles, and enforce a minimum key length (≥ 32 random bytes).
- **CI gates to add:** `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test --locked`, `cargo audit`, `cargo deny check`, `npm ci && npm run test:unit && npm audit`, `gitleaks`, and a container image scan (Trivy).
- **Security tests to add:** cross-tenant access denied (B1), oversized label/payload rejected (B4), unknown tenant over WS does not create state (B2), `durationMs` ignored for untrusted roles (B5), CORS/Origin rejected, auth failure returns the same body for "missing" and "wrong" key.

## Suggested roadmap

1. **Now (small, high value):** server-side `label`/`payload` limits and `DefaultBodyLimit` (B4), validate and stop creating tenants from the WebSocket path (B2), default to closed + `127.0.0.1` (B3), `.gitignore` and `git init` (R1), gate Swagger behind `ENABLE_DOCS` (B7).
2. **Next:** key -> `{tenants, role}` model with `403` and tests (B1), separate read-only display access / WS tickets (B2, F1), per-tenant queue/tenant caps, rate limiting and timeouts (B4), worker fairness and `durationMs` policy (B5), CORS/Origin allow-list (B6).
3. **Before any real deployment:** TLS + security headers + CSP (B8, F4), real user auth for the kiosk (F1, F2), public-view snapshots without PII (F3), runtime validation of WS frames (F5), CI security gates, key rotation and audit logging (B9, B10).
