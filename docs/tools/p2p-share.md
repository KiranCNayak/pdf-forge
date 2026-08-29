# P2P File Share

**Route** `/p2p-share` · **Phase** 3 · **Engine** JS (WebRTC) + Go signaling server

Send a file straight from one browser to another over a WebRTC data channel. No upload,
no storage, no link expiry — because there is nothing anywhere to expire.

## Status

**Shipped** (`web/src/tools/P2PShare/tool.tsx`, `web/src/lib/p2p/`): send/receive UI,
signaling via a real `signaling/` deployment (WS create/join/relay), trickle ICE with
candidate buffering for the race against `setRemoteDescription`, chunked transfer with
`bufferedAmountLowThreshold` backpressure, header/accept/reject/end control protocol,
SHA-256 verification, honest ICE-failure and room-error messaging, sequential multi-file
transfer, and the optional password layer (`p2p/crypto.ts`: PBKDF2-SHA256 → AES-256-GCM,
same envelope as ihatepdf's own construction). Verified with two live browser tabs
against a locally-run signaling server: full handshake, a transferred file confirmed
byte-identical via `diff` both unencrypted and through a full encrypt/decrypt round trip,
a wrong password correctly reported as "Wrong password." rather than "file corrupt",
invalid-code and peer-declined paths, zero console errors throughout.

**Multi-file transfer** (`sendFiles`/`receiveFiles` in `transfer.ts`) sends a whole batch
over one data channel with one accept: the sender tags each `FileHeader` with
`batchIndex`/`batchTotal` rather than the wire protocol growing a new control-frame type,
the receiver's `onOffer` is only invoked for the first file, and every file after that is
auto-accepted with the same password. Building it caught two real concurrency bugs, both
now regression-tested by `web/e2e/p2p-share.spec.ts`'s multi-file spec:

- Calling the single-file `receiveFile` once per file (the first working version) tears
  down and re-installs the data channel's message listener between files. The teardown
  for file N happens synchronously on `'end'`, while N's async decrypt-and-verify is
  still in flight — a fast sender can get file N+1's header onto the wire in that gap
  with nobody listening, hanging the transfer forever. Fixed by keeping one listener
  alive for the whole batch (`receiveFiles` is its own state machine now, not N calls to
  `receiveFile`).
- Even with one listener, resetting `received`/`header` in the _previous_ file's `'end'`
  continuation raced with the _next_ file's header/chunks, which can legitimately arrive
  before that continuation's `await`s resolve — the reset would zero an already-counting
  progress or null out an already-set header, surfacing as an intermittent "Transfer
  ended before a file header arrived." Fixed by resetting synchronously in the `'header'`
  handler itself, not asynchronously after the prior file finishes.

**Deferred:**

- IndexedDB assembly — V1 buffers the whole file in memory on both ends. See
  `web/src/lib/p2p/transfer.ts`'s header for what a correct chunked version needs.
- gzip via `CompressionStream`.
- The `BroadcastChannel` same-tab shortcut.
- The manual-paste fallback for when the signaling server is unreachable.
- Production deployment — V1 was only run against `go run ./cmd/signaling` locally, not
  Fly.io. `VITE_SIGNALING_URL` (`web/.env.example`) needs a real URL before this ships.
- QR code for the room code (text only, for now).

---

## Part 1 — How ihatepdf's version actually works

Reverse-engineered from `P2pShareTool1-PqvH6p8s.js` (43 KB), 2026-08-23. This matters
because **their blog post describes a system they did not build**, and we would design
the wrong thing by trusting it.

### What the blog claims

> "Only connection metadata passes through a signaling server momentarily; the file bytes
> go directly between the devices."

### What the code does

There is **no signaling server**. None. The relevant constants and functions:

```js
const Me = 65536; // chunk size: 64 KB
const xt = 7000; // ICE gathering timeout: 7 s
const Pe = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
};

const Te = (s) => btoa(unescape(encodeURIComponent(JSON.stringify(s)))); // encode
const De = (s) => JSON.parse(decodeURIComponent(escape(atob(s.trim())))); // decode

const je = (s) => `${origin}/p2p-share#o=${s}`; // share link
```

The flow:

1. `createOffer()` → `setLocalDescription()`
2. `await He(pc)` — block until `iceGatheringState === 'complete'`, or 7 s, whichever comes
   first. This is **vanilla ICE**: wait for every candidate, then send one fat SDP.
3. `Te(pc.localDescription)` — base64 the entire session description, candidates included.
4. Put it in a URL **fragment** (`#o=...`) so it never reaches a web server.
5. The receiver opens the link, creates an answer, and the sender **pastes the answer code
   back by hand**.

A `BroadcastChannel` shortcut exists for two tabs in the same browser, which is why it
feels seamless in a casual demo and clumsy in real use.

### Their crypto (this part is good)

```js
// PBKDF2-SHA256, 200k iterations → AES-256-GCM
deriveKey(
  { name: "PBKDF2", salt, iterations: 2e5, hash: "SHA-256" },
  keyMaterial,
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt", "decrypt"],
);

// envelope: salt(16) ‖ iv(12) ‖ ciphertext
const y = new Uint8Array(28 + ct.byteLength);
y.set(salt, 0);
y.set(iv, 16);
y.set(new Uint8Array(ct), 28);
```

Plus gzip via `CompressionStream` (kept only when the result is actually smaller),
SHA-256 integrity digest, a 3-second rolling-window speed meter, `PAUSE`/`RESUME`/`ACCEPT`
control frames over the data channel, and a 30-entry localStorage history holding metadata
only.

### Assessment

| Aspect                | Verdict                                                           |
| --------------------- | ----------------------------------------------------------------- |
| No signaling server   | Genuinely impressive, and genuinely bad UX — two-way manual paste |
| SDP in URL fragment   | Correct. Fragments are never sent to servers                      |
| 7 s vanilla-ICE block | Forced by having no channel for late candidates                   |
| Crypto envelope       | Sound construction, correctly implemented                         |
| STUN-only, no TURN    | Honest trade-off, poorly communicated to users                    |
| Blog vs code          | **Materially inaccurate.** Do not cite it as a reference          |

---

## Part 2 — Our design

Keep their transfer mechanics, which are good. Replace the signaling, which is the weak
part.

### Go signaling server

`signaling/`, deployed to Fly.io (256 MB machine). Single WebSocket endpoint `/ws`.

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

Message envelope:

```go
type Envelope struct {
    Type string          `json:"type"` // create|created|join|joined|peer-joined|offer|answer|ice|bye|error
    Code string          `json:"code,omitempty"`
    Data json.RawMessage `json:"data,omitempty"` // opaque — server NEVER parses this
}
```

`Data` stays `json.RawMessage` deliberately. The server relays SDP and ICE payloads
without ever understanding them. That is both a privacy property and a maintenance one —
WebRTC's payloads can change without touching the server.

State:

```go
type Room struct {
    Code    string
    Peers   [2]*Conn
    Created time.Time
}

type Hub struct {
    mu    sync.RWMutex
    rooms map[string]*Room
}
```

Rules:

- Room TTL 10 minutes; a janitor goroutine sweeps expired rooms.
- Evicted as soon as both peers disconnect.
- Third join attempt on a full room → `error{code: "room_full"}`.
- No persistence, no payload logging. Log room _counts_, never room codes or contents.
- Rate-limit room creation per IP — the only abuse vector the server has.

Room codes: 6 characters of Crockford base32 (no `I`, `L`, `O`, `U` — unambiguous when
read aloud over a phone), from `crypto/rand`, collision-checked against live rooms.
32^6 ≈ 1.07 billion, and with a 10-minute TTL the live set is tiny, so collisions are
negligible and guessing is impractical.

### Trickle ICE

The main UX win. ihatepdf blocks 7 s waiting for full gathering because it has nowhere to
send a late candidate. With a relay we send each candidate as it arrives:

```ts
pc.onicecandidate = (e) => {
  if (e.candidate) ws.send({ type: "ice", data: e.candidate });
};
```

Connection establishes in a few hundred milliseconds instead of seven-plus seconds, and
no one pastes anything.

### Transfer

Keep theirs, with backpressure made explicit:

- 64 KB chunks over an ordered, reliable data channel.
- **`bufferedAmountLowThreshold` + `onbufferedamountlow`.** Without it, a fast sender
  queues the entire file into the channel's buffer and the tab dies on large transfers.
  Set the threshold at ~1 MB, pause when `bufferedAmount` exceeds ~8 MB, resume on the
  event. This is the single most common WebRTC file-transfer bug.
- Header frame first: `{ name, size, type, sha256, compressed, encrypted }`.
- Receiver accepts or rejects before any bytes flow.
- SHA-256 verified on arrival; mismatch is a hard failure, not a warning.
- gzip via `CompressionStream`, retained only when smaller.
- Assemble into IndexedDB, not RAM — an 8 GB transfer must not need 8 GB of heap.

### Encryption — getting the threat model right

Optional password → PBKDF2-SHA256 (200k) → AES-256-GCM, envelope
`salt(16) ‖ iv(12) ‖ ciphertext`. Same construction as theirs.

**Why it exists, stated correctly.** WebRTC data channels are already DTLS-encrypted, so
this layer does nothing against a passive network observer. What it defends against is
**a malicious or compromised signaling server rewriting the SDP fingerprints to insert
itself as a man in the middle.**

That threat is _specific to our design_. ihatepdf has no signaling server, so for them the
password layer is close to redundant. We introduced the server, so we owe users the layer
that neutralises it. The UI should say this in one plain sentence rather than the usual
"military-grade encryption" noise.

The password must be shared out-of-band — a different channel from the room code. If both
travel together, the layer protects nothing.

### No TURN

STUN-only. Symmetric NAT and strict corporate firewalls will fail outright — roughly
10–15% of attempts by industry convention _(not measured by us; measure it)_.

TURN is the only fix, and it would relay every byte through a server, breaking the entire
premise. **We will not add TURN.**

What we owe users instead is an honest failure: after ICE reaches `failed`, say _"Your
network blocks direct connections — this usually means a corporate firewall or a mobile
carrier NAT. Try a different network, or use a regular file transfer."_ Not a spinner,
not a silent hang. ihatepdf's version leaves users staring at a dead progress bar.

---

## Edge cases

| Case                            | Behaviour                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| Receiver never joins            | Room expires at 10 min; sender told plainly                                                   |
| Sender closes tab mid-transfer  | Receiver gets `oniceconnectionstatechange → disconnected`; partial file discarded             |
| Signaling server unreachable    | Fall back to ihatepdf's manual paste flow. Worth keeping precisely because it needs no server |
| Both peers behind symmetric NAT | ICE fails; the message above                                                                  |
| Very large file (>4 GB)         | Works — chunked and streamed. Warn about the time and the need to keep both tabs open         |
| Wrong password                  | GCM auth tag fails. Report "wrong password", not "file corrupt" — the distinction matters     |
| Multiple files                  | Send sequentially over one channel with a header frame per file                               |
| Same-browser tabs               | `BroadcastChannel` shortcut, as theirs                                                        |

## UI states

**Sender:** idle → files staged → room created (code + QR, waiting) → peer joined →
transferring (per-file progress, speed, ETA, pause/cancel) → done → failed (specific
reason).

**Receiver:** enter code → connecting → incoming file offer (name, size, accept/reject) →
receiving → verifying → done → failed.

Show the connection state honestly at every step. "Connecting" that silently means
"probably never going to work" is the worst thing this tool can do.

## Fixtures & tests

- Signaling server: Go unit tests over the `Hub` — pairing, TTL expiry, room-full,
  concurrent creation, code collision.
- End-to-end: Playwright with two browser contexts, exercising transfer, wrong password,
  cancel mid-transfer, and receiver-rejects.
- Backpressure: a large file over a throttled channel, asserting `bufferedAmount` stays
  bounded.
