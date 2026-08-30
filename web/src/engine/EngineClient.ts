// EngineClient owns the engine worker's lifecycle and the request/response
// correlation. Tools call this; they never touch the worker directly.

import {
  type CompressResult,
  EngineError,
  type ErrorCode,
  type OpName,
  type PageOp,
  type Request,
  type Response,
  type SplitPart,
} from './protocol'

export type ProgressFn = (done: number, total: number, stage: string) => void

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  onProgress?: ProgressFn
}

/**
 * Bytes processed before the worker is torn down and rebuilt.
 *
 * WebAssembly.Memory grows and never shrinks, so a large document permanently
 * inflates the heap for the tab's lifetime. Termination is the only way to
 * reclaim it. See docs/LLD.md §2.1.
 *
 * PLACEHOLDER: 64 MB is a guess. Phase 0 should measure the real Go heap
 * multiplier and the actual respawn cost, then replace this.
 */
const RESPAWN_AFTER_BYTES = 64 * 1024 * 1024

export class EngineClient {
  #worker: Worker | null = null
  #pending = new Map<string, Pending>()
  #bytesSinceSpawn = 0
  #seq = 0

  #spawn(): Worker {
    if (this.#worker) return this.#worker

    const w = new Worker(new URL('../workers/engine.worker.ts', import.meta.url), {
      type: 'module',
    })

    w.onmessage = (e: MessageEvent<Response>) => {
      const msg = e.data
      if (msg.kind === 'ready') return

      const p = this.#pending.get(msg.id)
      if (!p) return // a stale job from a worker we already replaced

      switch (msg.kind) {
        case 'progress':
          p.onProgress?.(msg.done, msg.total, msg.stage)
          break
        case 'ok':
          this.#pending.delete(msg.id)
          p.resolve(msg.result)
          break
        case 'error':
          this.#pending.delete(msg.id)
          p.reject(new EngineError(msg.code, msg.message, msg.userMessage))
          break
      }
    }

    // A worker-level failure kills every job it was carrying. Failing them
    // individually is the difference between a visible error and a hung UI.
    w.onerror = () => this.#failAll('ERR_WORKER_FAILED', 'The engine stopped unexpectedly.')

    this.#worker = w
    this.#bytesSinceSpawn = 0
    return w
  }

  #failAll(code: ErrorCode, message: string) {
    for (const [, p] of this.#pending) {
      p.reject(new EngineError(code, message, message))
    }
    this.#pending.clear()
  }

  /** Terminate the worker, rejecting anything in flight. Also how cancel works. */
  terminate(reason: ErrorCode = 'ERR_CANCELLED') {
    this.#worker?.terminate()
    this.#worker = null
    this.#failAll(reason, reason === 'ERR_CANCELLED' ? 'Cancelled.' : 'The engine was restarted.')
  }

  async #call<T>(
    op: OpName,
    params: unknown,
    buffers: ArrayBuffer[],
    onProgress?: ProgressFn,
  ): Promise<T> {
    const worker = this.#spawn()
    const id = `job-${++this.#seq}`
    const size = buffers.reduce((n, b) => n + b.byteLength, 0)

    const result = await new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress })
      const msg: Request = { id, op, params, buffers }
      // Transfer, don't clone: structured-cloning a 150 MB buffer costs a full
      // copy and leaves the original alive on this thread.
      worker.postMessage(msg, buffers)
    })

    this.#bytesSinceSpawn += size
    if (this.#bytesSinceSpawn > RESPAWN_AFTER_BYTES && this.#pending.size === 0) {
      this.#worker?.terminate()
      this.#worker = null
    }

    return result
  }

  // ------------------------------------------------------------------ ops

  merge(files: ArrayBuffer[], opts: { dividerPage?: boolean } = {}, onProgress?: ProgressFn) {
    return this.#call<Uint8Array>('merge', { dividerPage: !!opts.dividerPage }, files, onProgress)
  }

  rotate(
    file: ArrayBuffer,
    opts: { rotation: number; selection?: string[]; password?: string },
    onProgress?: ProgressFn,
  ) {
    return this.#call<Uint8Array>('rotate', opts, [file], onProgress)
  }

  extractPages(
    file: ArrayBuffer,
    opts: { selection: string; password?: string },
    onProgress?: ProgressFn,
  ) {
    return this.#call<Uint8Array>('extractPages', opts, [file], onProgress)
  }

  split(
    file: ArrayBuffer,
    opts: { mode: 'each' | 'span' | 'ranges'; span?: number; ranges?: string[]; password?: string },
    onProgress?: ProgressFn,
  ) {
    return this.#call<SplitPart[]>('split', opts, [file], onProgress)
  }

  encrypt(
    file: ArrayBuffer,
    opts: { userPW: string; ownerPW: string; keyLength?: number; permissions?: number },
    onProgress?: ProgressFn,
  ) {
    return this.#call<Uint8Array>('encrypt', opts, [file], onProgress)
  }

  decrypt(file: ArrayBuffer, opts: { password: string }, onProgress?: ProgressFn) {
    return this.#call<Uint8Array>('decrypt', opts, [file], onProgress)
  }

  pageCount(file: ArrayBuffer, password = '') {
    return this.#call<number>('pageCount', { password }, [file])
  }

  isEncrypted(file: ArrayBuffer) {
    return this.#call<boolean>('isEncrypted', {}, [file])
  }

  /**
   * Shrink a PDF. Either pick a preset or give a target size; target mode
   * binary-searches a quality ladder and may return `reachedTarget: false`.
   *
   * This is the highest-water-mark op we run — peak memory is set by the
   * largest decoded image, not by the file size — so the caller should
   * `terminate()` afterwards regardless of input size. docs/tools/compress.md.
   */
  async compress(
    file: ArrayBuffer,
    opts:
      | { mode: 'preset'; preset: 'screen' | 'ebook' | 'printer' | 'prepress' }
      | { mode: 'target'; targetBytes: number },
    onProgress?: ProgressFn,
  ) {
    return this.#call<CompressResult>('compress', opts, [file], onProgress)
  }

  /**
   * Reorder, delete, duplicate and rotate pages in one call. `pages` gives the
   * final page order — a source page omitted from it is deleted, one repeated
   * is duplicated. docs/tools/organize-pages.md.
   */
  organize(file: ArrayBuffer, opts: { pages: PageOp[]; password?: string }, onProgress?: ProgressFn) {
    return this.#call<Uint8Array>('organize', opts, [file], onProgress)
  }

  /**
   * Combines images (JPEG/PNG/TIFF/WebP) into one PDF, one page per image, in
   * the order given. `pageSize: 'fit'` sizes each page to match its own
   * image exactly; `'A4'`/`'Letter'` use a shared page size and `orientation`.
   * See docs/tools/images-to-pdf.md.
   */
  imagesToPDF(
    images: ArrayBuffer[],
    opts: { pageSize: 'A4' | 'Letter' | 'fit'; orientation?: 'portrait' | 'landscape' },
    onProgress?: ProgressFn,
  ) {
    return this.#call<Uint8Array>('imagesToPDF', opts, images, onProgress)
  }

  /**
   * Stamps text onto every page, or a selection. `onTop: true` draws over
   * page content (a "stamp"); `false` draws behind it (a true watermark).
   * `rotation` is always sent explicitly — 0 means horizontal, not "use
   * pdfcpu's diagonal default". See docs/tools/add-watermark.md.
   */
  addWatermark(
    file: ArrayBuffer,
    opts: {
      text: string
      selection?: string[]
      fontSize: number
      color: string
      position: string
      rotation: number
      opacity: number
      onTop: boolean
      password?: string
    },
    onProgress?: ProgressFn,
  ) {
    return this.#call<Uint8Array>('addWatermark', opts, [file], onProgress)
  }

  /**
   * Strips watermarks pdfcpu itself (or anything using the same
   * /Artifact-tagged form-XObject mechanism) can recognise. `selection` uses
   * pdfcpu's raw page-selection tokens — ranges, `even`, `odd`, `!` exclusion
   * — with no special handling needed on this side. See
   * docs/tools/remove-watermark.md.
   */
  removeWatermark(
    file: ArrayBuffer,
    opts: { selection?: string[]; password?: string },
    onProgress?: ProgressFn,
  ) {
    return this.#call<Uint8Array>('removeWatermark', opts, [file], onProgress)
  }

  /** Cheap pre-flight check, same role as isEncrypted/pageCount: answer a
   * question before the user commits to running removal. */
  hasWatermarks(file: ArrayBuffer, password = '') {
    return this.#call<boolean>('hasWatermarks', { password }, [file])
  }

  /**
   * Sets /CropBox via a margin definition relative to the existing media
   * box. Does not touch page content — see docs/tools/crop-resize.md.
   */
  crop(
    file: ArrayBuffer,
    opts: {
      top: number
      right: number
      bottom: number
      left: number
      selection?: string[]
      password?: string
    },
    onProgress?: ProgressFn,
  ) {
    return this.#call<Uint8Array>('crop', opts, [file], onProgress)
  }

  /**
   * Scales /MediaBox and page content — an actual reflow, unlike crop's
   * viewport-only change. See docs/tools/crop-resize.md.
   */
  resize(
    file: ArrayBuffer,
    opts:
      | { mode: 'scale'; scale: number; selection?: string[]; password?: string }
      | { mode: 'pageSize'; pageSize: string; selection?: string[]; password?: string }
      | { mode: 'dimensions'; width: number; height: number; selection?: string[]; password?: string },
    onProgress?: ProgressFn,
  ) {
    return this.#call<Uint8Array>('resize', opts, [file], onProgress)
  }
}

/** Shared instance. One engine worker per tab is the intended shape. */
export const engine = new EngineClient()
