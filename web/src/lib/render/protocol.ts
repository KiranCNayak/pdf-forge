// Wire protocol between the main thread and the render worker (Lane D).
//
// Deliberately independent of web/src/engine/protocol.ts, even though the
// shapes rhyme — Lane D never imports from the engine, and the engine never
// produces pixels. See docs/HLD.md §4 and docs/PARALLEL.md.

export type RenderErrorCode =
  | 'ERR_ENCRYPTED'
  | 'ERR_BAD_PASSWORD'
  | 'ERR_CORRUPT'
  | 'ERR_UNSUPPORTED'
  | 'ERR_CANCELLED'
  | 'ERR_INVALID_PARAMS'
  | 'ERR_INTERNAL'
  | 'ERR_WORKER_FAILED'

export type RenderOpName = 'open' | 'close' | 'renderPage' | 'extractText'

export interface RenderRequest {
  id: string
  op: RenderOpName
  params: unknown
  /** Transferred, not cloned. Empty for ops that only reference an already-open docId. */
  buffers: ArrayBuffer[]
}

export type RenderResponse =
  | { id: string; kind: 'ok'; result: unknown }
  | { id: string; kind: 'error'; code: RenderErrorCode; message: string; userMessage: string }
  // `data` carries per-page payloads for streaming ops (e.g. extractText),
  // so a caller can render a preview incrementally instead of waiting for
  // the whole document.
  | { id: string; kind: 'progress'; done: number; total: number; stage: string; data?: unknown }
  | { kind: 'ready' }

/** An error carrying the render worker's stable code. */
export class RenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    message: string,
    readonly userMessage: string,
  ) {
    super(message)
    this.name = 'RenderError'
  }
}

export interface OpenResult {
  docId: string
  pageCount: number
}

export interface RenderPageResult {
  /** Encoded image bytes (JPEG or PNG), transferred not cloned. */
  bytes: ArrayBuffer
  width: number
  height: number
  /** The DPI actually used — may be lower than requested if the 16,384px canvas limit clamped it. */
  effectiveDpi: number
  /** True when the requested DPI exceeded the canvas limit and was clamped down. */
  clamped: boolean
}

export interface ExtractedPage {
  pageNr: number
  text: string
}

export interface ExtractTextResult {
  pages: ExtractedPage[]
  fullText: string
  /** No text layer found on any requested page — most likely a scanned document. */
  isScanned: boolean
  /** A high proportion of unmapped glyphs — most likely missing `/ToUnicode`. */
  lowConfidence: boolean
}
