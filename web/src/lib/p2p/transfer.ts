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
//  - No PBKDF2/AES-GCM password layer yet, despite the doc calling it out as
//    earning its place specifically because we introduced a signaling server.
//    Deferred rather than rushed — a wrong crypto implementation is worse
//    than an honest gap. Transport is still DTLS-encrypted regardless.
//  - No gzip via CompressionStream, no pause/resume control frames beyond
//    cancel, single file per transfer (not sequential multi-file).

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
 * failure. */
export async function sendFile(
  dc: RTCDataChannel,
  file: File,
  onProgress: (sent: number, total: number) => void,
  isCancelled: () => boolean,
): Promise<void> {
  dc.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD

  const buffer = await file.arrayBuffer()
  const sha256 = await sha256Hex(buffer)
  const header: FileHeader = {
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    sha256,
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

  for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
    if (isCancelled()) {
      sendControl(dc, { type: 'cancel' })
      throw new TransferCancelledError()
    }
    await waitForDrain(dc)
    const chunk = buffer.slice(offset, Math.min(offset + CHUNK_SIZE, buffer.byteLength))
    dc.send(chunk)
    onProgress(Math.min(offset + CHUNK_SIZE, buffer.byteLength), buffer.byteLength)
  }
  sendControl(dc, { type: 'end' })
}

export interface ReceivedFile {
  blob: Blob
  header: FileHeader
  /** False means the SHA-256 the sender declared doesn't match what arrived
   * — a hard failure per the doc, not a warning. */
  verified: boolean
}

/** Receiver side: waits for a header frame, hands it to `onOffer` for the
 * caller to accept/reject (returns a boolean), then receives chunks with
 * progress until 'end' or 'cancel'. */
export function receiveFile(
  dc: RTCDataChannel,
  onOffer: (header: FileHeader) => Promise<boolean>,
  onProgress: (received: number, total: number) => void,
): Promise<ReceivedFile> {
  return new Promise((resolve, reject) => {
    let header: FileHeader | null = null
    const chunks: ArrayBuffer[] = []
    let received = 0

    const onMessage = (e: MessageEvent) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data) as ChannelControl
        if (msg.type === 'header') {
          header = msg.header
          void onOffer(msg.header).then((accept) => {
            sendControl(dc, { type: accept ? 'accept' : 'reject' })
            if (!accept) {
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
          const blob = new Blob(chunks, { type: header.mime })
          void blob.arrayBuffer().then(async (buf) => {
            const actual = await sha256Hex(buf)
            resolve({ blob, header: header as FileHeader, verified: actual === (header as FileHeader).sha256 })
          })
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
