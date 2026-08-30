// The structural contract PeerLink actually depends on — deliberately an
// interface, not `SignalingClient` itself, so BroadcastSignalingClient (the
// same-browser shortcut, see its own file) is a drop-in substitute. Both
// implement this with no shared base class; TypeScript's structural typing
// makes that enough, and it keeps each transport's file focused on its own
// medium (WebSocket vs. BroadcastChannel) rather than an inheritance
// hierarchy neither really needs.
import type { SignalEnvelope } from './protocol'

export interface SignalTransport {
  connect(url: string): Promise<void>
  onMessage(fn: (env: SignalEnvelope) => void): () => void
  onClose(fn: () => void): () => void
  send(env: SignalEnvelope): void
  close(): void
}
