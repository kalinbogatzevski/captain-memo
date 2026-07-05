# Local device-pairing surface (no hub required) — Design

**Date:** 2026-07-05
**Status:** Design approved, ready for implementation plan.
**Tracks:** GitHub issue [#6](https://github.com/kalinbogatzevski/captain-memo/issues/6) — "Local device-pairing surface (no hub required)".
**Target:** `captain-memo` (OSS master) only. Zero federation coupling by design — see §2.

## 1. Goal

Let an operator pair a second device (a phone, tablet, or another machine) to their captain's *existing* memory corpus, self-hosted, with no external relay/hub/third-party service. `captain-memo connect`'s existing cross-AI wiring only reaches MCP tools on the *same* machine as the worker; this closes that gap for a different machine.

**Positioning note:** this OSS feature is deliberately small and clean — it should read as a polished, low-resource capability in its own right (the "advertisement" for what a fuller, multi-device federation/hub product can do), not a stripped-down placeholder. Every design choice below favors fewer moving parts over more flexibility.

## 2. Scope and the architectural fork this resolves

Federation already has a mature device-pairing subsystem (`src/gateway/` in `captain-memo-fed`), but its model is: spin up a **separate worker process per paired device**, then federate that device in as its own `cap_*` identity — a restricted-reader **peer** in the federation-trust sense (`peer_keys`, `restricted_reader_ids`, owner-signed manifests).

OSS has **zero** peer/federation concepts anywhere (confirmed — no `restricted_reader`, `peer_keys`, or `PeerRegistry` reference exists in `captain-memo`'s `src/`). Porting federation's device-captain architecture would mean introducing peer-trust plumbing to OSS for the first time, which cuts against "the OSS is entirely federation code free."

**Resolved design:** OSS's pairing is architecturally simpler and genuinely different from federation's — there is no separate device, no separate identity, no peer relationship. A "paired device" is just an authenticated client of the **same single worker and corpus** every local session already uses. This matches the issue's own language ("a captain's memory," singular) more directly than federation's model does.

**Explicitly out of scope for this round** (each is its own future decision, not a gap in this spec):
- OAuth 2.1 / JWT / PKCE (federation's `oauth.ts`) — built for the Claude mobile app's official connector flow; this design uses a plain bearer token instead (§4).
- Per-device scopes (read-only vs read-write) — every paired device gets full tool access in v1.
- A separate `gateway run` process — the listener lives inside the existing worker process.
- A local web console — CLI (`pair|list|revoke`) is the complete surface for this round.
- A QR code for handoff — text output only (connector URL + token).

## 3. Architecture

The existing worker (`src/worker/index.ts`, `startWorker()`) gains an **optional second HTTP listener** — a new port, bound to `127.0.0.1` only, started *only if* at least one device is paired. It speaks MCP over HTTP via the SDK's `WebStandardStreamableHTTPServerTransport` (the same transport class federation's `mcp-http.ts` already uses and has proven in production). Every request must carry `Authorization: Bearer <token>`, checked against a local token store before any MCP handling occurs.

The operator is responsible for reverse-proxying this localhost port to a public address with TLS (nginx, Caddy, a tunnel, etc.) — captain-memo never binds a public interface itself and is never responsible for certificate management. This matches the issue's own framing ("a reverse proxy the operator already runs") and keeps the security boundary simple: a bearer token only ever needs to survive on `127.0.0.1` plus whatever transport the operator's own proxy provides.

**One in-scope refactor:** `src/mcp-server.ts`'s tool dispatch is currently a single inline `switch` inside `runMcpServer()` (stdio-transport-only). It gets extracted into a shared `dispatchTool(name, args)` function so both the existing stdio path and the new HTTP gateway listener call identical logic — mirroring the `createToolDispatcher` pattern federation already validated for the same problem. `dispatchTool()` still calls the worker's own HTTP routes via loopback `fetch`, exactly as the stdio path does today — no new internal API surface, no tangling of worker route handlers with MCP-specific tool shapes.

## 4. Components

- **`~/.captain-memo/gateway.json`** — the token store: `{ devices: [{ id, label, token_hash, created_at_epoch }] }`. Tokens are hashed at rest (SHA-256 is sufficient here — this is a lookup credential, not a password needing bcrypt-style slow hashing) so a leaked config file doesn't hand over live access.
- **`captain-memo gateway pair --label <name>`** — mints a random token (32 bytes, base64url), stores its hash, prints the token **once** (never shown again) plus the connector URL and a short "what to do next" note.
- **`captain-memo gateway list`** — table of paired devices: label, id, paired-since.
- **`captain-memo gateway revoke <id>`** — deletes the entry; that token 401s immediately on the next request.
- **`dispatchTool(name, args)`** (extracted from `mcp-server.ts`) — the shared tool-call logic, used by both the stdio transport and the new gateway listener.
- **Gateway listener** (new, inside `startWorker()`) — one `Bun.serve()`, started only when `gateway.json` has ≥1 paired device (checked once at worker startup). Port is configurable (`CAPTAIN_MEMO_GATEWAY_PORT`, defaulting to the worker's own port + 1) but the trigger to start at all is purely "a device is paired" — no separate on/off switch to forget to flip. Bearer-auth gate, then a per-connection MCP `Server` wired to `dispatchTool()` via `WebStandardStreamableHTTPServerTransport`.

## 5. Data flow

1. `captain-memo gateway pair --label "phone"` → generates + hashes a token → stores it in `gateway.json` → prints the token and connector URL once, plus a reminder to restart the worker (`captain-memo restart`) if it's already running so the new pairing takes effect.
2. Worker startup (`startWorker()`) reads `gateway.json`; if it lists ≥1 device, opens the second listener on `CAPTAIN_MEMO_GATEWAY_PORT` (default: worker port + 1). Pairing a device while the worker is stopped, then starting it, is the common path — no hot-reload of a running listener is needed for v1.
3. A remote MCP client (via the operator's reverse proxy) connects to the gateway port with `Authorization: Bearer <token>`. The listener hashes the presented token and compares against stored hashes *before* touching the MCP transport layer.
4. On a valid token, an MCP session is established (`WebStandardStreamableHTTPServerTransport`); every `tools/call` dispatches through `dispatchTool()` → the same loopback HTTP calls (`/search/all`, `/get_full`, `/remember`, etc.) the stdio path already makes.

## 6. Error handling

- Missing/invalid/revoked token → `401`, request never reaches MCP handling, response never reveals whether a device id exists (constant-shape error regardless of *why* auth failed).
- Gateway listener fails to bind (port in use, permission denied) → log a warning, disable the gateway feature for this run, **the core worker keeps running** — this is an optional feature that must never be able to take down local usage.
- No device paired (`gateway.json` empty/absent) → listener never starts; zero idle resources, zero behavior change from today's worker.

## 7. Testing

- **Unit:** token generation + hashing (`gateway.json` read/write roundtrip); `pair`/`list`/`revoke` CLI logic; confirm `dispatchTool()`'s extraction is behavior-preserving (existing `mcp-server.ts` tests stay green unchanged).
- **Integration:** pair a device, start a worker, make an authenticated HTTP-MCP request (`tools/list`, `tools/call`) and confirm it reaches the same state a local stdio call would; confirm a missing/garbage/revoked token 401s; confirm `revoke` immediately invalidates a previously-valid token (no caching/staleness window).

## 8. Rollout

Purely additive and off-by-default (no device paired ⇒ zero behavior change, zero new resource usage). No migration, no config changes required for existing installs. Documented in README/`docs/` as a first-class capability once shipped, consistent with the "OSS as a clean advertisement" goal — the feature should read as a complete, polished offering in its own right, not a teaser missing obvious pieces.
