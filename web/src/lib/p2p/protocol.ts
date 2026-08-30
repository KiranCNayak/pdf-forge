// Client-side mirror of signaling/internal/protocol/envelope.go. Kept as a
// plain structural type, not imported from the Go side — the two are
// deliberately independent, same reasoning as web/src/lib/render/protocol.ts
// staying independent of the engine's. Data stays `unknown`: this client
// never needs the server to understand it either, only the two peers do.
export interface SignalEnvelope {
  type:
    | 'create'
    | 'created'
    | 'join'
    | 'joined'
    | 'peer-joined'
    | 'offer'
    | 'answer'
    | 'ice'
    | 'bye'
    | 'error'
  code?: string
  data?: unknown
}

/** Error codes the server sends in a `type: 'error'` envelope's `data.code`. */
export type SignalErrorCode =
  | 'room_not_found'
  | 'room_full'
  | 'room_expired'
  | 'invalid_code'
  | 'rate_limited'
  | 'invalid_message'
  | 'internal_error'

/**
 * Control frames sent over the RTCDataChannel itself, once it's open — a
 * separate, smaller protocol from the signaling envelope above. Distinguished
 * on the wire by type: these are JSON strings; chunks are raw ArrayBuffers.
 * See docs/tools/p2p-share.md's "Transfer" section.
 */
export interface FileHeader {
  name: string
  size: number
  mime: string
  /** SHA-256 of the PLAINTEXT file, hex-encoded — computed before encryption
   * on the sender side, checked after decryption on the receiver side, so it
   * verifies the whole round trip rather than just the ciphertext arriving
   * intact. See docs/tools/p2p-share.md's edge case table: report "wrong
   * password"/"corrupt" as distinguishable outcomes, not a shrug. */
  sha256: string
  /** True if the bytes on the wire are the AES-GCM envelope from p2p/crypto.ts,
   * not the plaintext file. The receiver needs a password before it can even
   * attempt decryption, let alone verify sha256. */
  encrypted: boolean
  /** True if the content was gzipped (via CompressionStream) before any
   * encryption. Only set when compression actually made the bytes smaller —
   * see transfer.ts's gzipIfSmaller. Order on the wire is always
   * encrypt(gzip(plaintext)), so the receiver must decrypt first, then
   * decompress, mirroring the sender exactly in reverse. */
  compressed: boolean
  /** 1-based position of this file within its transfer batch. */
  batchIndex: number
  /** Total files in this batch. 1 for an ordinary single-file transfer — every
   * header carries these two fields rather than making them optional, so
   * receiveFile/receiveFiles never need an "is this a batch?" branch. See
   * transfer.ts's header comment for how sequential multi-file transfer is
   * built on top of the single-file primitives with no new control-frame
   * type. */
  batchTotal: number
}

export type ChannelControl =
  | { type: 'header'; header: FileHeader }
  | { type: 'accept' }
  | { type: 'reject' }
  | { type: 'end' }
  | { type: 'cancel' }
