// Wire protocol between the main thread and the engine worker.
// See docs/LLD.md §1.3.

/** Stable error identifiers. The UI switches on these and never parses messages. */
export type ErrorCode =
  | 'ERR_ENCRYPTED'
  | 'ERR_BAD_PASSWORD'
  | 'ERR_CORRUPT'
  | 'ERR_UNSUPPORTED'
  | 'ERR_TOO_LARGE'
  | 'ERR_OOM'
  | 'ERR_CANCELLED'
  | 'ERR_INVALID_PARAMS'
  | 'ERR_INTERNAL'
  | 'ERR_WORKER_FAILED'

export type OpName =
  | 'merge'
  | 'split'
  | 'rotate'
  | 'extractPages'
  | 'encrypt'
  | 'decrypt'
  | 'pageCount'
  | 'isEncrypted'
  | 'compress'
  | 'organize'
  | 'imagesToPDF'

export interface Request {
  id: string
  op: OpName
  params: unknown
  /** Transferred, not cloned — see the transfer list in EngineClient.call. */
  buffers: ArrayBuffer[]
}

export type Response =
  | { id: string; kind: 'ok'; result: unknown }
  | { id: string; kind: 'error'; code: ErrorCode; message: string; userMessage: string }
  | { id: string; kind: 'progress'; done: number; total: number; stage: string }
  | { kind: 'ready' }

/** An error carrying the engine's stable code. */
export class EngineError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly userMessage: string,
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

export interface SplitPart {
  name: string
  bytes: Uint8Array
}

/**
 * What compress returns. The skip counts are UI copy, not diagnostics:
 * "8 of 12 images compressed, 4 skipped (transparency)" is a far better answer
 * than a mysterious 3% saving. See docs/tools/compress.md.
 */
export interface CompressResult {
  bytes: Uint8Array
  originalSize: number
  resultSize: number
  /** Target mode only. False means "this is the best we managed" — say so. */
  reachedTarget: boolean
  /** Compression would have grown the file, so the original came back untouched. */
  fallback: boolean
  imagesTouched: number
  imagesSkipped: number
  /** Keys: transparency | stencil | thumbnail | jpeg2000 | unsupportedType | alreadyLowDPI | noGain */
  skipReasons: Record<string, number>
}

/**
 * One page in the FINAL document, mirroring engine/internal/ops.PageOp.
 * `source` is a 1-based page number in the ORIGINAL document — the same
 * source may repeat (duplicate) or be omitted (delete). `rotation` is a
 * relative delta, same convention as rotate. See docs/tools/organize-pages.md.
 */
export interface PageOp {
  source: number
  rotation: number
}
