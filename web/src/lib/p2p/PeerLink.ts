// Wraps one RTCPeerConnection for one room, relaying SDP/ICE through a
// SignalingClient. This is the trickle-ICE half of docs/tools/p2p-share.md
// §2 — candidates are sent as they're discovered instead of ihatepdf's
// block-for-7-seconds-then-paste approach, because we have a channel to
// send late ones on.
//
// STUN only, no TURN — a deliberate, documented limitation (see the doc's
// "No TURN" section): symmetric NAT and strict firewalls will fail outright
// for roughly 10-15% of attempts, and the only fix relays bytes through a
// server, which breaks the point of this tool. onState reports 'failed' so
// the UI can say so honestly rather than hang on a spinner.

import type { SignalEnvelope } from './protocol'
import type { SignalingClient } from './SignalingClient'

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
]

export type LinkState = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'

export class PeerLink {
  #pc: RTCPeerConnection
  #signaling: SignalingClient
  #code: string
  #unsubscribe: () => void
  // ICE candidates can arrive (or even be generated locally) before the
  // remote description is set — a well-known WebRTC race, not a fluke.
  // addIceCandidate() throws if called too early, so anything that shows up
  // before setRemoteDescription resolves gets queued and flushed after.
  #pendingRemoteCandidates: RTCIceCandidateInit[] = []
  #remoteDescriptionSet = false

  onState: (s: LinkState) => void = () => {}
  onChannel: (dc: RTCDataChannel) => void = () => {}

  constructor(signaling: SignalingClient, code: string) {
    this.#signaling = signaling
    this.#code = code
    this.#pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    this.#pc.onicecandidate = (e) => {
      if (e.candidate) this.#signaling.send({ type: 'ice', code, data: e.candidate.toJSON() })
    }
    this.#pc.oniceconnectionstatechange = () => {
      const s = this.#pc.iceConnectionState
      if (s === 'connected' || s === 'completed') this.onState('connected')
      else if (s === 'disconnected') this.onState('disconnected')
      else if (s === 'failed') this.onState('failed')
      else if (s === 'closed') this.onState('closed')
    }

    this.#unsubscribe = signaling.onMessage((env) => {
      void this.#handle(env)
    })
  }

  /** Sender side: opens the data channel and sends the offer. Call once the
   * signaling server reports the other peer has joined — an offer sent
   * before that is relayed to no one (the hub drops it silently). */
  async startAsSender(): Promise<RTCDataChannel> {
    const dc = this.#pc.createDataChannel('file', { ordered: true })
    const offer = await this.#pc.createOffer()
    await this.#pc.setLocalDescription(offer)
    this.#signaling.send({ type: 'offer', code: this.#code, data: offer })
    return dc
  }

  /** Receiver side: waits for the data channel the sender creates. The
   * answer itself is sent from #handle('offer'), once it arrives. */
  startAsReceiver() {
    this.#pc.ondatachannel = (e) => this.onChannel(e.channel)
  }

  async #handle(env: SignalEnvelope) {
    if (env.code !== undefined && env.code !== this.#code) return

    switch (env.type) {
      case 'offer': {
        await this.#pc.setRemoteDescription(env.data as RTCSessionDescriptionInit)
        await this.#flushPendingCandidates()
        const answer = await this.#pc.createAnswer()
        await this.#pc.setLocalDescription(answer)
        this.#signaling.send({ type: 'answer', code: this.#code, data: answer })
        break
      }
      case 'answer':
        await this.#pc.setRemoteDescription(env.data as RTCSessionDescriptionInit)
        await this.#flushPendingCandidates()
        break
      case 'ice': {
        const candidate = env.data as RTCIceCandidateInit
        if (this.#remoteDescriptionSet) {
          await this.#pc.addIceCandidate(candidate)
        } else {
          this.#pendingRemoteCandidates.push(candidate)
        }
        break
      }
      case 'bye':
        this.onState('disconnected')
        break
    }
  }

  async #flushPendingCandidates() {
    this.#remoteDescriptionSet = true
    const pending = this.#pendingRemoteCandidates
    this.#pendingRemoteCandidates = []
    for (const c of pending) await this.#pc.addIceCandidate(c)
  }

  close() {
    this.#unsubscribe()
    this.#pc.close()
  }
}
