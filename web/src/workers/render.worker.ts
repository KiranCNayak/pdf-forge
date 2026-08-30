/// <reference lib="webworker" />
//
// Hosts pdf.js. This is the ONLY place pdf.js is imported — the main thread
// never touches it directly, matching engine.worker.ts's pattern for the Go
// engine. Independent of the engine by design: this worker never calls into
// Wasm, and the Go side never produces pixels. See docs/HLD.md §4 and
// docs/PARALLEL.md (Lane D).

import * as pdfjsLib from 'pdfjs-dist'
// `?url` makes Vite bundle this as a local asset and hand back its built
// URL — no CDN fetch, satisfying CLAUDE.md's hard constraint.
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

import type { RenderErrorCode, RenderRequest, RenderResponse } from '../lib/render/protocol'
import { getOptimalScale } from '../lib/render/scale'
import { reconstructPageText, type TextItemLike } from '../lib/render/textLayout'

declare const self: DedicatedWorkerGlobalScope

// pdf.js normally spawns its own internal Worker to parse documents off the
// calling thread. Inside a Worker there is no `window`, so pdf.js's
// worker-spawn path throws and it falls back to running that same code
// in-thread via a dynamic import of `workerSrc` — so this stays a single
// worker (no nested Worker), and still zero network requests, since Vite
// resolves the import to a locally bundled file.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc

const post = (msg: RenderResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer)

type LoadedDoc = pdfjsLib.PDFDocumentProxy
const docs = new Map<string, LoadedDoc>()
let nextDocId = 0

function classifyError(err: unknown): { code: RenderErrorCode; message: string; userMessage: string } {
  const e = err as { name?: string; message?: string; code?: unknown }
  // Only OUR own throws carry a `code` — always an `ERR_`-prefixed string,
  // attached via Object.assign below. pdf.js's PasswordException also has a
  // `code` (a NUMBER: PasswordResponses.NEED_PASSWORD === 1), so a bare
  // truthiness check here swallowed every encrypted document before the
  // `name === 'PasswordException'` branch could see it — the whole
  // render-worker password flow (Redact, PdfToImage, PdfToZip, ExtractText,
  // OrganizePages) surfaced "No password given" as a dead-end error instead
  // of prompting to unlock. Match on the shape we actually emit.
  if (typeof e?.code === 'string' && e.code.startsWith('ERR_')) {
    const code = e.code as RenderErrorCode
    return { code, message: e.message ?? String(err), userMessage: e.message ?? 'Something went wrong.' }
  }
  if (e?.name === 'PasswordException') {
    // pdf.js fires this with NEED_PASSWORD first, then INCORRECT_PASSWORD if
    // a wrong one was supplied — the message text is the only signal it gives us.
    const badPassword = /incorrect/i.test(e.message ?? '')
    return badPassword
      ? { code: 'ERR_BAD_PASSWORD', message: e.message ?? 'incorrect password', userMessage: 'That password is incorrect.' }
      : { code: 'ERR_ENCRYPTED', message: e.message ?? 'password required', userMessage: 'This PDF is password-protected.' }
  }
  if (e?.name === 'InvalidPDFException') {
    return { code: 'ERR_CORRUPT', message: e.message ?? 'invalid pdf', userMessage: "This file doesn't look like a valid PDF." }
  }
  if (e?.name === 'UnexpectedResponseException' || e?.name === 'UnknownErrorException') {
    return { code: 'ERR_UNSUPPORTED', message: e.message ?? 'unsupported', userMessage: "This PDF uses a feature we can't handle yet." }
  }
  return { code: 'ERR_INTERNAL', message: e?.message ?? String(err), userMessage: 'Something went wrong.' }
}

function requireDoc(docId: string): LoadedDoc {
  const doc = docs.get(docId)
  if (!doc) throw Object.assign(new Error(`unknown docId ${docId}`), { code: 'ERR_INVALID_PARAMS' })
  return doc
}

interface CanvasAndContext {
  canvas: OffscreenCanvas | null
  context: OffscreenCanvasRenderingContext2D | null
}

// pdf.js's own DOMCanvasFactory (its default `CanvasFactory`) calls
// `document.createElement('canvas')` — fine on the main thread, but `document`
// is undefined inside a Worker. Every render call already builds its own
// OffscreenCanvas explicitly (see opRenderPage below), so this never came up
// until a page needed a SECOND, internal canvas of pdf.js's own: certain
// small images get resampled by `_scaleImage` via a temporary canvas pdf.js
// creates for itself mid-render, entirely inside its own paint path — no
// caller-supplied canvas involved at all. That temporary canvas hit the same
// `document.createElement` call and threw `Cannot read properties of
// undefined (reading 'createElement')`, confirmed directly by instrumenting
// this file's own catch block against a real signature-watermarked PDF (an
// XObject image, not literally inline — pdf.js's own operator-list builder
// inlines small XObject images as an optimization, which is what actually
// routes them through this path) before this fix — not assumed from reading
// pdf.js's source alone. `getDocument()` accepts a pluggable `CanvasFactory`
// exactly for non-DOM environments — this app's own render calls never use
// it (they already own their canvas), but pdf.js's internal ones now do too.
// Node.js's own bundled `NodeCanvasFactory` is the same pattern, swapping in
// whatever canvas implementation the environment actually has.
class OffscreenCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size')
    const canvas = new OffscreenCanvas(width, height)
    return { canvas, context: canvas.getContext('2d') }
  }

  reset(canvasAndContext: CanvasAndContext, width: number, height: number) {
    if (!canvasAndContext.canvas) throw new Error('Canvas is not specified')
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size')
    canvasAndContext.canvas.width = width
    canvasAndContext.canvas.height = height
  }

  destroy(canvasAndContext: CanvasAndContext) {
    if (!canvasAndContext.canvas) throw new Error('Canvas is not specified')
    canvasAndContext.canvas.width = 0
    canvasAndContext.canvas.height = 0
    canvasAndContext.canvas = null
    canvasAndContext.context = null
  }
}

async function opOpen(bytes: Uint8Array, params: { password?: string }) {
  // pdf.js takes ownership of this buffer; it must not be a view into a
  // transferred ArrayBuffer that anything else still references.
  const task = pdfjsLib.getDocument({
    data: bytes,
    password: params.password,
    CanvasFactory: OffscreenCanvasFactory,
  })
  const doc = await task.promise
  const id = `doc-${++nextDocId}`
  docs.set(id, doc)
  return { docId: id, pageCount: doc.numPages }
}

async function opClose(params: { docId: string }) {
  const doc = docs.get(params.docId)
  docs.delete(params.docId)
  // PDFDocumentProxy has no destroy() of its own — the loading task owns
  // teardown of the underlying worker transport and cached page/object data.
  await doc?.loadingTask.destroy()
  return null
}

interface RenderPageParams {
  docId: string
  pageNr: number
  dpi: number
  format: 'jpeg' | 'png'
  quality?: number
}

async function opRenderPage(params: RenderPageParams) {
  const doc = requireDoc(params.docId)
  const page = await doc.getPage(params.pageNr)

  const requestedScale = params.dpi / 72
  const baseViewport = page.getViewport({ scale: 1 })
  const scale = getOptimalScale(baseViewport, requestedScale)
  const clamped = scale < requestedScale
  const viewport = page.getViewport({ scale })

  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)))
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false })
  if (!ctx) throw Object.assign(new Error('2d context unavailable'), { code: 'ERR_INTERNAL' })

  // Transparent canvases cost more and export JPEGs with a black background —
  // the single most common bug in this kind of tool. See docs/tools/pdf-to-image.md.
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingQuality = 'high'

  try {
    // pdf.js's type declares canvasContext as CanvasRenderingContext2D, but
    // it also supports OffscreenCanvasRenderingContext2D at runtime — which
    // is required here, since a DedicatedWorker has no HTMLCanvasElement.
    // `canvas: null` is required whenever rendering directly against a
    // context rather than letting pdf.js own the canvas (see the API's own
    // "canvas must be null" note).
    const renderCtx = ctx as unknown as CanvasRenderingContext2D
    // `intent: 'print'` renders at print fidelity rather than screen fidelity.
    await page.render({ canvas: null, canvasContext: renderCtx, viewport, intent: 'print' }).promise

    const mime = params.format === 'png' ? 'image/png' : 'image/jpeg'
    const blob = await canvas.convertToBlob({
      type: mime,
      quality: params.format === 'jpeg' ? (params.quality ?? 0.9) : undefined,
    })
    const bytes = await blob.arrayBuffer()

    return {
      bytes,
      width: canvas.width,
      height: canvas.height,
      effectiveDpi: Math.round(72 * scale),
      clamped,
    }
  } finally {
    // Releases the GPU texture. Nulling the reference alone does not —
    // see docs/LLD.md §2.3.
    canvas.width = 0
    canvas.height = 0
    page.cleanup()
  }
}

async function opExtractText(id: string, params: { docId: string; pages?: number[] }) {
  const doc = requireDoc(params.docId)
  const pageNumbers = params.pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1)

  const pages: { pageNr: number; text: string }[] = []
  let totalItems = 0
  let totalChars = 0
  let totalReplacement = 0

  for (let i = 0; i < pageNumbers.length; i++) {
    const pageNr = pageNumbers[i]
    const page = await doc.getPage(pageNr)
    const content = await page.getTextContent()
    // pdf.js's TextContent mixes glyph runs with TextMarkedContent markers;
    // only the former carry `str`/`transform`.
    const items = (content.items as unknown as TextItemLike[]).filter((it) => typeof it.str === 'string')
    const result = reconstructPageText(items)

    totalItems += result.itemCount
    totalChars += result.charCount
    totalReplacement += result.replacementCharCount

    pages.push({ pageNr, text: result.text })
    page.cleanup()

    // Stream per-page results so a caller can render a preview incrementally
    // instead of building one giant string up front — see docs/tools/extract-text.md.
    post({ id, kind: 'progress', done: i + 1, total: pageNumbers.length, stage: 'extracting', data: { pageNr, text: result.text } })
  }

  const isScanned = totalItems === 0
  const lowConfidence = !isScanned && totalChars > 0 && totalReplacement / totalChars > 0.15

  return {
    pages,
    fullText: pages.map((p) => p.text).join('\n\n'),
    isScanned,
    lowConfidence,
  }
}

self.onmessage = async (e: MessageEvent<RenderRequest>) => {
  const { id, op, params, buffers } = e.data

  try {
    let result: unknown
    let transfer: Transferable[] = []

    switch (op) {
      case 'open':
        result = await opOpen(new Uint8Array(buffers[0]), params as { password?: string })
        break
      case 'close':
        result = await opClose(params as { docId: string })
        break
      case 'renderPage': {
        const r = await opRenderPage(params as RenderPageParams)
        transfer = [r.bytes]
        result = r
        break
      }
      case 'extractText':
        result = await opExtractText(id, params as { docId: string; pages?: number[] })
        break
      default:
        throw Object.assign(new Error(`unknown op ${op as string}`), { code: 'ERR_INVALID_PARAMS' })
    }

    post({ id, kind: 'ok', result }, transfer)
  } catch (err: unknown) {
    const { code, message, userMessage } = classifyError(err)
    post({ id, kind: 'error', code, message, userMessage })
  }
}

// Tell the client the worker itself is alive.
post({ kind: 'ready' })
