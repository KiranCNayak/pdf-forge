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
//  - No pause/resume control frames beyond cancel.
//
// gzip IS implemented (gzipIfSmaller/gunzip below, via CompressionStream/
// DecompressionStream) and kept only when it actually shrinks the file —
// most PDFs are already partly compressed internally, so gzip on top loses
// more often than it wins, which is why this is a runtime check per file,
// not a blanket "always compress". Wire order is always encrypt(gzip(x)),
// so the receiver reverses it: decrypt, then decompress, then verify sha256
// against the original (pre-gzip) plaintext.
//
// Sequential multi-file transfer (sendFiles/receiveFiles below) is built as a
// thin orchestration layer on top of the single-file primitives, not a
// second protocol: every FileHeader already carries batchIndex/batchTotal
// (protocol.ts), so the wire format needs no new control-frame type. The
// receiver's accept/reject decision is only asked for once, on the first
// file — the batch is one commitment, not N re-prompts — and the same
// password (if any) is reused for every file after it, since SendPanel only
// exposes one password field for the whole transfer anyway. Cancelling
// mid-batch aborts the rest of it: sendFile's existing 'cancel' control frame
// and TransferCancelledError need no batch-awareness at all.
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

async function pipeThroughStream(buffer: ArrayBuffer, stream: TransformStream): Promise<ArrayBuffer> {
  const source = new Blob([buffer]).stream().pipeThrough(stream)
  return new Response(source).arrayBuffer()
}

/** Gzips `plaintext` via CompressionStream and keeps the result only if it's
 * actually smaller — most PDFs are already partly compressed internally
 * (FlateDecode streams, JPEG images), so gzip on top sometimes loses. Returns
 * null when compression isn't worth it, so the caller can fall back to
 * sending the original bytes untouched. Per docs/tools/p2p-share.md's
 * "Transfer" section. */
async function gzipIfSmaller(plaintext: ArrayBuffer): Promise<ArrayBuffer | null> {
  const compressed = await pipeThroughStream(plaintext, new CompressionStream('gzip'))
  return compressed.byteLength < plaintext.byteLength ? compressed : null
}

function gunzip(compressed: ArrayBuffer): Promise<ArrayBuffer> {
  return pipeThroughStream(compressed, new DecompressionStream('gzip'))
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
  batchIndex = 1,
  batchTotal = 1,
): Promise<void> {
  dc.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD

  const plaintext = await file.arrayBuffer()
  const sha256 = await sha256Hex(plaintext)
  const gzipped = await gzipIfSmaller(plaintext)
  const content = gzipped ?? plaintext
  const wireBuffer = password ? await encryptBytes(content, password) : content

  const header: FileHeader = {
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    sha256,
    encrypted: !!password,
    compressed: !!gzipped,
    batchIndex,
    batchTotal,
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

/** Sends every file in `files`, in order, over one already-accepted batch —
 * see this file's header comment. `onProgress`'s first argument is the
 * 0-based index of the file currently in flight. A rejection or cancellation
 * on any file (in practice, only ever the first — see receiveFiles) aborts
 * the whole batch; files already sent stay sent, there's no rollback. */
export async function sendFiles(
  dc: RTCDataChannel,
  files: File[],
  onProgress: (fileIndex: number, sent: number, total: number) => void,
  isCancelled: () => boolean,
  password?: string,
): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    await sendFile(dc, files[i], (sent, total) => onProgress(i, sent, total), isCancelled, password, i + 1, files.length)
  }
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

/** Shared by receiveFile and receiveFiles: turns raw received chunks into a
 * verified Blob. Decryption happens once, after every chunk has arrived —
 * GCM's auth tag covers the whole ciphertext, so there's no way to verify a
 * password against a partial transfer. Throws WrongPasswordError
 * (distinguishable from a generic failure) if decryption's auth check
 * fails. */
async function assembleReceivedFile(
  chunks: ArrayBuffer[],
  header: FileHeader,
  password: string | undefined,
): Promise<ReceivedFile> {
  const wireBuffer = await new Blob(chunks).arrayBuffer()
  const decrypted = header.encrypted ? await decryptBytes(wireBuffer, password ?? '') : wireBuffer
  const plaintext = header.compressed ? await gunzip(decrypted) : decrypted
  const actual = await sha256Hex(plaintext)
  const blob = new Blob([plaintext], { type: header.mime })
  return { blob, header, verified: actual === header.sha256 }
}

/** Receiver side: waits for a header frame, hands it to `onOffer` for the
 * caller to accept/reject (and supply a password, if the header says the
 * file is encrypted), then receives chunks with progress until 'end' or
 * 'cancel'. */
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
          void assembleReceivedFile(chunks, h, password)
            .then(resolve)
            .catch((err: unknown) =>
              reject(err instanceof WrongPasswordError ? err : new Error('Could not assemble the received file.')),
            )
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

/** Receives a whole batch over ONE persistent message listener — deliberately
 * not N sequential calls to receiveFile. An earlier version called receiveFile
 * once per file; each call installs and tears down its own listener, and the
 * teardown for file N happens synchronously on 'end' while the (async)
 * decrypt-and-verify step for file N is still in flight. An eager sender can
 * — and in testing, reliably did — get file N+1's header onto the wire in
 * that gap, with nobody listening to catch it, hanging the transfer forever.
 * Keeping one listener alive for the whole batch removes the gap entirely.
 *
 * The first file goes through `onOffer` for a real accept/reject/password
 * decision, same as a single-file transfer. Every file after that is
 * auto-accepted with the same password — the user already committed to the
 * batch, and the sender only ever asks for consent once (see sendFiles) — so
 * there is nothing left to prompt for. A rejection on the first file rejects
 * the whole promise before any chunk of anything has been sent. */
export function receiveFiles(
  dc: RTCDataChannel,
  onOffer: (header: FileHeader) => Promise<OfferDecision>,
  onProgress: (fileIndex: number, received: number, total: number) => void,
): Promise<ReceivedFile[]> {
  return new Promise((resolve, reject) => {
    const results: ReceivedFile[] = []
    let fileIndex = 0
    let header: FileHeader | null = null
    let password: string | undefined
    let chunks: ArrayBuffer[] = []
    let received = 0
    // Set synchronously the instant the first 'header' is *seen*, not once
    // its onOffer decision resolves. The sender only sends header N+1 after
    // receiving file N's 'accept', which only happens after file N's onOffer
    // decision already resolved — so by the time any later header arrives,
    // this is safely true. Gating on `fileIndex` instead (only bumped once
    // file N's async decrypt-and-verify finishes) looked equivalent but
    // wasn't: header 2 can arrive and get processed before file 1's
    // assembly promise resolves, which made this a real bug caught by
    // e2e's multi-file test, not just a theoretical race.
    let sawFirstHeader = false

    const onMessage = (e: MessageEvent) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data) as ChannelControl
        if (msg.type === 'header') {
          // Reset synchronously, right here — not in the previous file's
          // 'end' continuation below. That continuation runs after an
          // async decrypt-and-verify step, by which point THIS header may
          // already have arrived and this file's own chunks may already be
          // accumulating; resetting `received`/`header` there raced with
          // and clobbered that in-progress state. Caught by e2e's
          // multi-file test as an intermittent "Transfer ended before a
          // file header arrived" — chunks counted as file 2's went into a
          // `received` counter that a late-resolving file-1 promise then
          // zeroed, or `header` got nulled out after already being set to
          // file 2's header.
          header = msg.header
          received = 0
          const isFirst = !sawFirstHeader
          sawFirstHeader = true
          const decisionPromise: Promise<OfferDecision> = isFirst
            ? onOffer(msg.header)
            : Promise.resolve({ accept: true, password })
          void decisionPromise.then((decision) => {
            if (isFirst) password = decision.password
            sendControl(dc, { type: decision.accept ? 'accept' : 'reject' })
            if (!decision.accept) {
              dc.removeEventListener('message', onMessage)
              reject(new TransferRejectedError())
            }
          })
        } else if (msg.type === 'end') {
          if (!header) {
            dc.removeEventListener('message', onMessage)
            reject(new Error('Transfer ended before a file header arrived.'))
            return
          }
          const h = header
          const finishedChunks = chunks
          chunks = []
          void assembleReceivedFile(finishedChunks, h, password)
            .then((result) => {
              results.push(result)
              fileIndex += 1
              if (fileIndex >= h.batchTotal) {
                dc.removeEventListener('message', onMessage)
                resolve(results)
              }
              // else: keep listening — the next file's header is still to come.
            })
            .catch((err: unknown) => {
              dc.removeEventListener('message', onMessage)
              reject(err instanceof WrongPasswordError ? err : new Error('Could not assemble the received file.'))
            })
        } else if (msg.type === 'cancel') {
          dc.removeEventListener('message', onMessage)
          reject(new TransferCancelledError())
        }
        return
      }

      const chunk = e.data as ArrayBuffer
      chunks.push(chunk)
      received += chunk.byteLength
      onProgress(fileIndex, received, header?.size ?? received)
    }

    dc.addEventListener('message', onMessage)
  })
}
