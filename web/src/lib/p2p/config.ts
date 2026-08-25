// The signaling server is a separate deployable (signaling/, Fly.io in
// production; `go run ./cmd/signaling` locally on :8080) — this repo's Vite
// dev server never proxies it. VITE_SIGNALING_URL points at it; see
// web/.env.example.
export function signalingUrl(): string {
  return (import.meta.env.VITE_SIGNALING_URL as string | undefined) ?? 'ws://localhost:8080/ws'
}
