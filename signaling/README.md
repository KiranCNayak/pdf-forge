# signaling

The p2p-share WebSocket signaling server. It pairs two browsers by a
6-character room code and relays their SDP offer/answer and ICE candidates
so a WebRTC data channel can connect directly. Once that channel opens, this
server is out of the picture — file bytes never pass through it, and it
never has TURN to fall back to (see "No TURN" below).

Design background: `../docs/tools/p2p-share.md` §2 in the main repo.

## Why this exists

ihatepdf.cv's version of this tool has no signaling server at all — the
sender base64-encodes a full SDP (after blocking ~7s for ICE gathering) into
a URL fragment, and the receiver pastes an answer code back by hand. That's
genuinely serverless, but it's a clumsy two-way manual paste and a long
wait. This server exists to fix the UX with trickle ICE and one-way code
sharing, while giving up nothing on the "your bytes never touch a server"
promise — file bytes still go peer-to-peer.

## Privacy posture

Same rule as the rest of pdf-forge: **no telemetry that names a file or a
tool.** Concretely here:

- `Envelope.Data` is `json.RawMessage` everywhere in the server. It is
  relayed to the other peer without ever being parsed, logged, or inspected.
  The server cannot tell an SDP offer from an ICE candidate from a
  transferred filename embedded in one — it doesn't try to.
- Logs contain event names and room _counts_, never room codes, IPs, or
  payloads. Client IPs are held in memory only, for the rate limiter, and
  are never written to a log or persisted anywhere.
- No database, no disk writes, no file at all beyond the binary itself.
  Everything lives in one in-memory `map[string]*Room` for at most 10
  minutes.

## Protocol

One WebSocket endpoint, `/ws`. Every message in both directions is the same
envelope:

```go
type Envelope struct {
    Type string          `json:"type"` // create|created|join|joined|peer-joined|offer|answer|ice|bye|error
    Code string          `json:"code,omitempty"`
    Data json.RawMessage `json:"data,omitempty"`
}
```

Flow:

```
Sender                    Server                      Receiver
  │                          │                            │
  ├── create ───────────────▶│                            │
  │◀──────── created {code} ─┤   code = 6 chars, Crockford base32
  │                          │                            │
  │   (user shares code out-of-band)                      │
  │                          │◀──────────── join {code} ──┤
  │◀──────── peer-joined ────┼──── joined ───────────────▶│
  │                          │                            │
  ├── offer ────────────────▶│───── offer ───────────────▶│
  │◀──────── answer ─────────┼◀──────────────── answer ───┤
  ├── ice ──────────────────▶│───── ice ─────────────────▶│   (trickle, both ways)
  │◀──────── ice ────────────┼◀─────────────────── ice ───┤
  │                          │                            │
  │═════════ WebRTC data channel, server no longer involved ═══════▶
```

`offer`, `answer`, `ice` and `bye` are relayed verbatim to whichever other
connection occupies the room — the server routes purely on connection
identity plus room membership, never on `Data`'s contents.

### Room codes

6 characters of Crockford base32 with `I`, `L`, `O`, `U` removed (32-symbol
alphabet, unambiguous read aloud or typed by hand), drawn from
`crypto/rand` and checked against live rooms before being handed out.
32^6 ≈ 1.07 billion combinations; with a 10-minute TTL the live set stays
tiny, so both collisions and guessing are impractical.

### Room lifecycle

- A room is created with one peer (slot 0, the "sender"). A second peer
  (slot 1, the "receiver") may `join` it by code.
- TTL is 10 minutes from creation. A janitor goroutine sweeps expired rooms
  once a minute; any peer still connected to an expired room gets a
  `room_expired` error.
- A third `join` attempt on an already-paired room gets `room_full`.
- A room is evicted immediately, ahead of TTL, once **both** peers have
  disconnected. If only one leaves, the room and the remaining peer stay —
  the remaining peer is told via a `bye` envelope.
- Room creation is rate-limited per IP (token bucket, default 6/minute with
  a burst of 10) — it's the only unauthenticated write this server accepts,
  so it's the only abuse vector worth throttling. Joining and relaying are
  bounded by room membership instead.

### Error codes

`room_not_found`, `room_full`, `room_expired`, `invalid_code`,
`rate_limited`, `invalid_message`, `internal_error` — sent as
`{"type":"error","data":{"code":"..."}}`.

## No TURN

STUN-only, same as the rest of pdf-forge's p2p-share design. Roughly
10–15% of network pairings (symmetric NAT, strict corporate firewalls) will
fail to connect directly, and there is no fallback — adding TURN would mean
relaying file bytes through a server, which breaks the entire premise of
this tool. That's a deliberate, documented trade-off; see
`../CLAUDE.md` and `../docs/tools/p2p-share.md` §"No TURN". Don't add it
here without reading that reasoning first.

## Running it

```bash
cd signaling
go run ./cmd/signaling
```

Listens on `:8080` by default; override with `PORT`. Two endpoints:

- `GET /ws` — the signaling WebSocket.
- `GET /healthz` — plain `200 ok`, for platform health checks.

Build a binary:

```bash
go build -o signaling-server ./cmd/signaling
```

## Testing

```bash
go test ./...
gofmt -l .
go vet ./...
```

Coverage:

- `internal/roomcode` — code shape, alphabet exclusions, uniqueness over
  many draws.
- `internal/hub` — the pairing/relay state machine against a fake `Conn`,
  with no network involved: pairing, room-full, TTL expiry (both
  access-triggered and janitor-swept), relay routing (including rejecting
  a non-member and silently dropping to an empty peer slot), leave/bye
  semantics, and concurrent room creation racing for distinct codes.
- `internal/wsserver` — the per-IP token bucket in isolation, plus
  end-to-end tests that dial real WebSocket connections against an
  `httptest.Server` and drive a full create → join → offer → answer → ice
  exchange, an unknown-room join, an unrecognized message type, and the
  rate limiter tripping over real connections.

## Deployment

Designed for a small always-on box — the doc in the main repo suggests a
256 MB Fly.io machine, which is generous for a service that holds nothing
but a `map[string]*Room` with a 10-minute TTL. `clientIP` reads
`Fly-Client-IP` first for that reason, falling back to `X-Forwarded-For`
then the raw remote address for other hosts.

## Package layout

```
signaling/
  cmd/signaling/       main() — flags, HTTP server, signal handling
  internal/protocol/   the Envelope wire type and error-code constants
  internal/roomcode/   room code generation and validation
  internal/hub/        pairing/relay state machine (no network dependency)
  internal/wsserver/   WebSocket transport + per-IP rate limiter
```

`hub` and `wsserver` are split deliberately: `hub` is pure state and logic,
testable without opening a single socket; `wsserver` is the thin transport
adapter around it.
