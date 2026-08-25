// File transfer over an already-open RTCDataChannel. Chunking, backpressure
// and the accept/reject handshake follow docs/tools/p2p-share.md's "Transfer"
// section; see the file's own comments for where this V1 cuts corners against
// that doc, and why.
//
// V1 departures from the doc, both documented rather than silent:
//  - Whole file in memory, not IndexedDB. The doc's "assemble into IndexedDB,
//    not RAM" is right for very large transfers, but a correct chunked-
//    IndexedDB implementation (append-only writes, cursor-based reassembly)
//    is its own piece of work. V1 buffers the whole file — sender reads it
//    via File.arrayBuffer() to hash and chunk, receiver accumulates incoming
//    ArrayBuffers into an array and Blob()s them at the end. Correct and
//    fully verified for realistic file sizes; revisit if huge transfers turn
//    out to matter.
//  - No gzip via CompressionStream, no pause/resume control frames beyond
//    cancel, single file per transfer (not sequential multi-file).
//
// The optional password layer (p2p/crypto.ts) IS implemented: when set, the
// sender encrypts the whole buffer before chunking, and the receiver
// decrypts the whole assembled buffer before verifying sha256 — encryption
// is a content-level concern applied once, chunking is a transport-level
// concern applied to whatever bytes result, and the two don't need to know
// about each other beyond the header's `encrypted` flag.

import { decryptBytes, encryptBytes, WrongPasswordError } from './crypto'
import type { ChannelControl, FileHeader } from './protocol'

const CHUNK_SIZE = 64 * 1024
const BUFFERED_AMOUNT_LOW_THRESHOLD = 1024 * 1024 // 1 MB
const BUFFERED_AMOUNT_HIGH_WATERMARK = 8 * 1024 * 1024 // 8 MB

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function sendControl(dc: RTCDataChannel, msg: ChannelControl) {
  dc.send(JSON.stringify(msg))
}

/** Waits for backpressure to clear before returning, if the channel's send
 * buffer has backed up past the high watermark. Without this, a fast sender
 * queues the entire file into the channel's internal buffer and the tab's
 * memory grows unbounded — "the single most common WebRTC file-transfer
 * bug", per the doc. */
function waitForDrain(dc: RTCDataChannel): Promise<void> {
  if (dc.bufferedAmount <= BUFFERED_AMOUNT_HIGH_WATERMARK) return Promise.resolve()
  return new Promise((resolve) => {
    const onLow = () => {
      dc.removeEventListener('bufferedamountlow', onLow)
      resolve()
    }
    dc.addEventListener('bufferedamountlow', onLow)
  })
}

export class TransferRejectedError extends Error {
  constructor() {
    super('The other side declined this file.')
    this.name = 'TransferRejectedError'
  }
}

export class TransferCancelledError extends Error {
  constructor() {
    super('Cancelled.')
    this.name = 'TransferCancelledError'
  }
}

/** Sender side: sends a header frame, waits for accept/reject, then streams
 * the file in chunks. Rejects with TransferRejectedError/CancelledError on
 * those specific outcomes so callers can tell them apart from a network
 * failure. If `password` is set, the whole file is encrypted (p2p/crypto.ts)
 * before chunking — the header's declared sha256 is always of the PLAINTEXT,
 * computed before encryption, so it verifies the full round trip including
 * decryption on the other end. */
export async function sendFile(
  dc: RTCDataChannel,
  file: File,
  onProgress: (sent: number, total: number) => void,
  isCancelled: () => boolean,
  password?: string,
): Promise<void> {
  dc.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD

  const plaintext = await file.arrayBuffer()
  const sha256 = await sha256Hex(plaintext)
  const wireBuffer = password ? await encryptBytes(plaintext, password) : plaintext

  const header: FileHeader = {
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    sha256,
    encrypted: !!password,
  }
  sendControl(dc, { type: 'header', header })

  const accepted = await new Promise<boolean>((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') return
      const msg = JSON.parse(e.data) as ChannelControl
      if (msg.type === 'accept' || msg.type === 'reject') {
        dc.removeEventListener('message', onMessage)
        resolve(msg.type === 'accept')
      }
    }
    dc.addEventListener('message', onMessage)
  })
  if (!accepted) throw new TransferRejectedError()

  for (let offset = 0; offset < wireBuffer.byteLength; offset += CHUNK_SIZE) {
    if (isCancelled()) {
      sendControl(dc, { type: 'cancel' })
      throw new TransferCancelledError()
    }
    await waitForDrain(dc)
    const chunk = wireBuffer.slice(offset, Math.min(offset + CHUNK_SIZE, wireBuffer.byteLength))
    dc.send(chunk)
    onProgress(Math.min(offset + CHUNK_SIZE, wireBuffer.byteLength), wireBuffer.byteLength)
  }
  sendControl(dc, { type: 'end' })
}

export interface ReceivedFile {
  blob: Blob
  header: FileHeader
  /** False means the SHA-256 the sender declared doesn't match the
   * (decrypted, if applicable) plaintext that arrived — a hard failure per
   * the doc, not a warning. */
  verified: boolean
}

export interface OfferDecision {
  accept: boolean
  /** Required when the header says `encrypted: true`; ignored otherwise. */
  password?: string
}

/** Receiver side: waits for a header frame, hands it to `onOffer` for the
 * caller to accept/reject (and supply a password, if the header says the
 * file is encrypted), then receives chunks with progress until 'end' or
 * 'cancel'. Decryption happens once, after every chunk has arrived — GCM's
 * auth tag covers the whole ciphertext, so there's no way to verify a
 * password against a partial transfer. Rejects with WrongPasswordError
 * (distinguishable from a generic failure) if decryption's auth check
 * fails. */
export function receiveFile(
  dc: RTCDataChannel,
  onOffer: (header: FileHeader) => Promise<OfferDecision>,
  onProgress: (received: number, total: number) => void,
): Promise<ReceivedFile> {
  return new Promise((resolve, reject) => {
    let header: FileHeader | null = null
    let password: string | undefined
    const chunks: ArrayBuffer[] = []
    let received = 0

    const onMessage = (e: MessageEvent) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data) as ChannelControl
        if (msg.type === 'header') {
          header = msg.header
          void onOffer(msg.header).then((decision) => {
            password = decision.password
            sendControl(dc, { type: decision.accept ? 'accept' : 'reject' })
            if (!decision.accept) {
              dc.removeEventListener('message', onMessage)
              reject(new TransferRejectedError())
            }
          })
        } else if (msg.type === 'end') {
          dc.removeEventListener('message', onMessage)
          if (!header) {
            reject(new Error('Transfer ended before a file header arrived.'))
            return
          }
          const h = header
          void (async () => {
            try {
              const wireBuffer = await new Blob(chunks).arrayBuffer()
              const plaintext = h.encrypted ? await decryptBytes(wireBuffer, password ?? '') : wireBuffer
              const actual = await sha256Hex(plaintext)
              const blob = new Blob([plaintext], { type: h.mime })
              resolve({ blob, header: h, verified: actual === h.sha256 })
            } catch (err) {
              reject(err instanceof WrongPasswordError ? err : new Error('Could not assemble the received file.'))
            }
          })()
        } else if (msg.type === 'cancel') {
          dc.removeEventListener('message', onMessage)
          reject(new TransferCancelledError())
        }
        return
      }

      // Binary frame: a chunk. ArrayBuffer per RTCDataChannel's default
      // binaryType in every browser we target.
      const chunk = e.data as ArrayBuffer
      chunks.push(chunk)
      received += chunk.byteLength
      onProgress(received, header?.size ?? received)
    }

    dc.addEventListener('message', onMessage)
  })
}
