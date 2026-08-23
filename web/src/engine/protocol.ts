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
