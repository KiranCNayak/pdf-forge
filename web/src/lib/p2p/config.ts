// The signaling server is a separate deployable (signaling/, Fly.io in
// production; `go run ./cmd/signaling` locally on :8080) — this repo's Vite
// dev server never proxies it. VITE_SIGNALING_URL points at it; see
// web/.env.example.
export function signalingUrl(): string {
  return (import.meta.env.VITE_SIGNALING_URL as string | undefined) ?? 'ws://localhost:8080/ws'
}

// Shared by PeerLink (trickle ICE, via signaling) and ManualLink (vanilla
// ICE, via copy-paste) — the choice of NAT-traversal helper doesn't depend
// on which transport carries the SDP.
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
]
