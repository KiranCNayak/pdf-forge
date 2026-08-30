// The manual-paste fallback for when the signaling server is unreachable —
// docs/tools/p2p-share.md's edge-case table calls this out by name: "Fall
// back to ihatepdf's manual paste flow. Worth keeping precisely because it
// needs no server." This is deliberately the same mechanism Part 1 of that
// doc reverse-engineers from ihatepdf's own code (`Te`/`De`, base64 over the
// whole SDP), not a new design — their version is correct, just clumsy on
// its own; here it only shows up when PeerLink's normal path can't reach
// signaling/ at all.
//
// Unlike PeerLink, there is no relay to send a late ICE candidate on, so
// this has to be vanilla ICE: create the offer/answer, then block until
// `iceGatheringState === 'complete'` or a timeout, then encode the WHOLE
// local description (candidates included) as one copy-pasteable string. The
// two sides exchange that string by any channel they like — chat, email,
// reading it aloud — since none of it is sensitive (it's connection
// metadata, not file contents).

import { ICE_SERVERS } from './config'

const ICE_GATHERING_TIMEOUT_MS = 7_000

function encodeSDP(desc: RTCSessionDescriptionInit): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(desc))))
}

function decodeSDP(code: string): RTCSessionDescriptionInit {
  return JSON.parse(decodeURIComponent(escape(atob(code.trim())))) as RTCSessionDescriptionInit
}

/** Resolves once ICE gathering finishes, or after `timeoutMs` — whichever
 * comes first. A slow or NAT-heavy network shouldn't block the paste flow
 * forever; whatever candidates gathered by the timeout are what gets sent,
 * same trade-off ihatepdf's own 7 s wait makes. */
function waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs = ICE_GATHERING_TIMEOUT_MS): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState !== 'complete') return
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }, timeoutMs)
    pc.addEventListener('icegatheringstatechange', onChange)
  })
}

export type ManualLinkState = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'

export class ManualLink {
  #pc: RTCPeerConnection

  onState: (s: ManualLinkState) => void = () => {}
  onChannel: (dc: RTCDataChannel) => void = () => {}

  constructor() {
    this.#pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this.#pc.oniceconnectionstatechange = () => {
      const s = this.#pc.iceConnectionState
      if (s === 'connected' || s === 'completed') this.onState('connected')
      else if (s === 'disconnected') this.onState('disconnected')
      else if (s === 'failed') this.onState('failed')
      else if (s === 'closed') this.onState('closed')
    }
  }

  /** Sender side: opens the data channel, creates the offer, and returns it
   * as a code to copy to the other person. Call `applyAnswer` once they
   * paste theirs back. */
  async createOfferCode(): Promise<{ dc: RTCDataChannel; code: string }> {
    const dc = this.#pc.createDataChannel('file', { ordered: true })
    const offer = await this.#pc.createOffer()
    await this.#pc.setLocalDescription(offer)
    await waitForIceGatheringComplete(this.#pc)
    return { dc, code: encodeSDP(this.#pc.localDescription!) }
  }

  /** Sender side: completes the handshake once the other person has pasted
   * their answer code back. */
  applyAnswerCode(code: string): Promise<void> {
    return this.#pc.setRemoteDescription(decodeSDP(code))
  }

  /** Receiver side: takes the code the sender gave out-of-band, wires
   * `onChannel` for when the resulting data channel opens, and returns the
   * answer as a code to paste back to them. `onChannel` must be assigned
   * before calling this — the data channel event can, in principle, fire as
   * soon as the descriptions are set, before this promise resolves. */
  async acceptOfferCode(offerCode: string): Promise<string> {
    this.#pc.ondatachannel = (e) => this.onChannel(e.channel)
    await this.#pc.setRemoteDescription(decodeSDP(offerCode))
    const answer = await this.#pc.createAnswer()
    await this.#pc.setLocalDescription(answer)
    await waitForIceGatheringComplete(this.#pc)
    return encodeSDP(this.#pc.localDescription!)
  }

  close() {
    this.#pc.close()
  }
}
