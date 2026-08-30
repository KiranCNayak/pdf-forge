// The "same browser, no server" shortcut from docs/tools/p2p-share.md's
// edge-case table — ihatepdf has one of these too (a BroadcastChannel, since
// it never has a real signaling server to fall back to), and it's worth
// keeping for exactly the reason their code has it: two tabs in the same
// browser can pair up with zero network round trips, which is both a nice
// demo path and a real fallback when `signaling/` is unreachable but both
// people happen to be sitting at the same machine.
//
// Implements SignalTransport with the exact same external shape as
// SignalingClient, so PeerLink and P2PShareTool need no branching beyond
// picking which class to `new` — see that interface's own comment. The
// difference is what's underneath: a same-origin BroadcastChannel instead of
// a WebSocket, which also means this never leaves the machine and needs no
// server at all.
//
// The real server pairs "create" and "join" itself (signaling/internal/hub).
// BroadcastChannel has no server-side process to do that, so this class
// simulates just enough of it locally: whichever instance sent "create"
// remembers its own generated code and watches the channel for a matching
// "join", then broadcasts "joined" (for the joiner) and delivers "peer-
// joined" to itself directly — no different, from PeerLink's point of view,
// than the real server doing the same two things from the other side of a
// socket. Everything after that (offer/answer/ice) is a plain broadcast;
// PeerLink already filters incoming envelopes by room code (see its
// `#handle`), so multiple pairs can coexist on the one channel without
// crosstalk, same as multiple rooms coexist on one real server.

import type { SignalEnvelope } from './protocol'
import type { SignalTransport } from './SignalTransport'

const CHANNEL_NAME = 'pdf-forge-p2p-share'
// Same alphabet as the Go server's Crockford base32 codes (no I/L/O/U) —
// not load-bearing here since there's no collision risk worth guarding
// against on a single BroadcastChannel, but keeping the same shape means the
// UI's "XXXXXX" room-code display and validation don't need a same-browser
// special case.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

export class BroadcastSignalingClient implements SignalTransport {
  #bc: BroadcastChannel | null = null
  #messageHandlers = new Set<(env: SignalEnvelope) => void>()
  #closeHandlers = new Set<() => void>()
  // Set only on the instance that sent 'create' — the local half of the
  // matchmaking the real server does for us over a socket.
  #pendingCreateCode: string | null = null

  connect(): Promise<void> {
    const bc = new BroadcastChannel(CHANNEL_NAME)
    this.#bc = bc
    bc.onmessage = (e) => this.#onBroadcast(e.data as SignalEnvelope)
    return Promise.resolve()
  }

  #onBroadcast(env: SignalEnvelope) {
    if (env.type === 'join' && this.#pendingCreateCode && env.code === this.#pendingCreateCode) {
      this.#bc?.postMessage({ type: 'joined', code: env.code } satisfies SignalEnvelope)
      this.#deliver({ type: 'peer-joined', code: env.code })
      return
    }
    this.#deliver(env)
  }

  #deliver(env: SignalEnvelope) {
    this.#messageHandlers.forEach((h) => h(env))
  }

  onMessage(fn: (env: SignalEnvelope) => void): () => void {
    this.#messageHandlers.add(fn)
    return () => this.#messageHandlers.delete(fn)
  }

  onClose(fn: () => void): () => void {
    this.#closeHandlers.add(fn)
    return () => this.#closeHandlers.delete(fn)
  }

  send(env: SignalEnvelope) {
    if (env.type === 'create') {
      const code = generateCode()
      this.#pendingCreateCode = code
      // The real server's 'created' reply is asynchronous (a socket round
      // trip); a microtask keeps this transport observably async too, so
      // callers can't accidentally depend on synchronous delivery.
      queueMicrotask(() => this.#deliver({ type: 'created', code }))
      return
    }
    this.#bc?.postMessage(env)
  }

  close() {
    this.#bc?.close()
    this.#bc = null
    this.#closeHandlers.forEach((h) => h())
  }
}
