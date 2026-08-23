// RenderClient owns the render worker's lifecycle and request/response
// correlation. Tools call this; they never import pdf.js or touch the
// worker directly — mirrors web/src/engine/EngineClient.ts's shape, but is
// independent of it. Lane D shares no code with Lane A's engine client,
// matching the boundary rule in docs/HLD.md §4: pixels never round-trip
// through Go, and this client never calls the Go engine.

import {
  RenderError,
  type ExtractTextResult,
  type OpenResult,
  type RenderErrorCode,
  type RenderOpName,
  type RenderPageResult,
  type RenderRequest,
  type RenderResponse,
} from './protocol'

export type RenderProgressFn = (done: number, total: number, stage: string, data?: unknown) => void

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  onProgress?: RenderProgressFn
}

export interface RenderPageOptions {
  dpi: number
  format: 'jpeg' | 'png'
  /** JPEG quality 0-1. Ignored for PNG. */
  quality?: number
}

export class RenderClient {
  #worker: Worker | null = null
  #pending = new Map<string, Pending>()
  #seq = 0

  #spawn(): Worker {
    if (this.#worker) return this.#worker

    const w = new Worker(new URL('../../workers/render.worker.ts', import.meta.url), {
      type: 'module',
    })

    w.onmessage = (e: MessageEvent<RenderResponse>) => {
      const msg = e.data
      if (msg.kind === 'ready') return

      const p = this.#pending.get(msg.id)
      if (!p) return // a stale job from a worker we already replaced

      switch (msg.kind) {
        case 'progress':
          p.onProgress?.(msg.done, msg.total, msg.stage, msg.data)
          break
        case 'ok':
          this.#pending.delete(msg.id)
          p.resolve(msg.result)
          break
        case 'error':
          this.#pending.delete(msg.id)
          p.reject(new RenderError(msg.code, msg.message, msg.userMessage))
          break
      }
    }

    // A worker-level failure kills every job it was carrying. Failing them
    // individually is the difference between a visible error and a hung UI.
    w.onerror = () => this.#failAll('ERR_WORKER_FAILED', 'The render worker stopped unexpectedly.')

    this.#worker = w
    return w
  }

  #failAll(code: RenderErrorCode, message: string) {
    for (const [, p] of this.#pending) p.reject(new RenderError(code, message, message))
    this.#pending.clear()
  }

  /** Terminate the worker, rejecting anything in flight. Also how cancel works. */
  terminate(reason: RenderErrorCode = 'ERR_CANCELLED') {
    this.#worker?.terminate()
    this.#worker = null
    this.#failAll(reason, reason === 'ERR_CANCELLED' ? 'Cancelled.' : 'The render worker was restarted.')
  }

  async #call<T>(
    op: RenderOpName,
    params: unknown,
    buffers: ArrayBuffer[],
    onProgress?: RenderProgressFn,
  ): Promise<T> {
    const worker = this.#spawn()
    const id = `render-${++this.#seq}`

    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress })
      const msg: RenderRequest = { id, op, params, buffers }
      // Transfer, don't clone — same reasoning as EngineClient.
      worker.postMessage(msg, buffers)
    })
  }

  // ------------------------------------------------------------------ ops

  /** Opens a document in the worker's memory. Always pair with `close` — pdf.js documents
   * aren't freed automatically. Rejects with `ERR_ENCRYPTED` / `ERR_BAD_PASSWORD` as needed. */
  open(file: ArrayBuffer, opts: { password?: string } = {}) {
    return this.#call<OpenResult>('open', { password: opts.password }, [file])
  }

  close(docId: string) {
    return this.#call<null>('close', { docId }, [])
  }

  /** Rasterizes one page to encoded image bytes. Used for both full-resolution export
   * (pdf-to-image, pdf-to-zip) and low-DPI thumbnails (organize-pages, extract-pages) —
   * callers choose the DPI; ~72 for a thumbnail grid per docs/tools/organize-pages.md. */
  renderPage(docId: string, pageNr: number, opts: RenderPageOptions) {
    return this.#call<RenderPageResult>('renderPage', { docId, pageNr, ...opts }, [])
  }

  /** Extracts text with line/paragraph/column reconstruction (docs/tools/extract-text.md).
   * `onPage` fires as each page completes, ahead of the aggregate result, so a caller can
   * stream a preview instead of waiting on the whole document. */
  extractText(docId: string, opts: { pages?: number[] } = {}, onPage?: (pageNr: number, text: string) => void) {
    return this.#call<ExtractTextResult>('extractText', { docId, ...opts }, [], (_done, _total, stage, data) => {
      if (stage === 'extracting' && data) {
        const { pageNr, text } = data as { pageNr: number; text: string }
        onPage?.(pageNr, text)
      }
    })
  }
}

/** Shared instance. One render worker per tab, mirroring `engine` from EngineClient.ts. */
export const render = new RenderClient()
