// Thin wrapper around the WebSocket to signaling/'s /ws endpoint. Unlike
// EngineClient/RenderClient, this isn't a request/response RPC client — the
// server pushes envelopes (peer-joined, offer, answer, ice, bye) at any
// time, driven by the OTHER browser's actions, not this one's calls. So the
// shape here is connect-once, send imperatively, subscribe to everything
// that arrives — closer to a plain EventTarget than the promisified call()
// pattern the other two clients use.
//
// The server never understands `data` (see signaling/internal/protocol —
// it's json.RawMessage there too), so neither does this client; SDP/ICE
// payloads pass through as opaque `unknown` for PeerLink to interpret.

import type { SignalEnvelope } from './protocol'

export class SignalingClient {
  #ws: WebSocket | null = null
  #messageHandlers = new Set<(env: SignalEnvelope) => void>()
  #closeHandlers = new Set<() => void>()

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      this.#ws = ws

      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('Could not reach the signaling server.'))
      ws.onclose = () => this.#closeHandlers.forEach((h) => h())
      ws.onmessage = (e) => {
        let env: SignalEnvelope
        try {
          env = JSON.parse(e.data as string)
        } catch {
          return // malformed frame — nothing a client can do but ignore it
        }
        this.#messageHandlers.forEach((h) => h(env))
      }
    })
  }

  /** Returns an unsubscribe function, same shape as DOM/React listener helpers. */
  onMessage(fn: (env: SignalEnvelope) => void): () => void {
    this.#messageHandlers.add(fn)
    return () => this.#messageHandlers.delete(fn)
  }

  onClose(fn: () => void): () => void {
    this.#closeHandlers.add(fn)
    return () => this.#closeHandlers.delete(fn)
  }

  send(env: SignalEnvelope) {
    this.#ws?.send(JSON.stringify(env))
  }

  close() {
    this.#ws?.close()
    this.#ws = null
  }
}
