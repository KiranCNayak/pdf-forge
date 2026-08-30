// Redact is the first tool that draws over a live page render rather than
// just running a Go op — a Hybrid tool like OrganizePages, but with pixels
// this time instead of thumbnails-plus-page-ops.
//
// The design decision that shapes everything else here is recorded in
// docs/tools/redact.md: pdfcpu has no content-stream editor, so "just draw a
// black box over the vector text" (the classic, real-world redaction bug —
// the box is opaque to the eye but the text underneath is still selectable
// and extractable) was never on the table as a *safe* option. Instead every
// page — not just the ones with a box on them — is rasterized in the render
// worker, the box is composited directly onto the decoded pixels, and the
// whole document is rebuilt from those images via the engine. The output PDF
// has no vector text, no annotations, no embedded files, no XMP/Info
// metadata and no OCG layers anywhere, because none of that data survives
// the raster boundary. That's a real trade-off (the whole document loses
// text search/selection, not just the boxed regions, and file size goes up)
// stated up front in the UI, not just in the doc.
//
// `engine.imagesToPDF`'s new `pageSize: 'exact'` mode (added for this tool,
// see engine/internal/ops/imagestopdf.go) is what makes the rebuilt PDF the
// same physical page size as the original — the render worker's own
// `effectiveDpi` gives us points-per-pixel for free, independent of "fit"'s
// pixel-dimensions-as-points behaviour, which would otherwise blow every
// page up to an enormous physical size at any DPI above 72.

import { useEffect, useRef, useState } from 'react'
import { FilePicker } from '../../components/FilePicker'
import { FilenameField } from '../../components/FilenameField'
import { XIcon } from '../../components/icons'
import { engine } from '../../engine/EngineClient'
import { EngineError } from '../../engine/protocol'
import { checkBudget, deviceCaps, estimateRenderBytes, formatBytes } from '../../lib/device'
import { downloadBytes } from '../../lib/download'
import { sanitizeFilename } from '../../lib/filename'
import { render } from '../../lib/render/RenderClient'
import { RenderError } from '../../lib/render/protocol'

interface Staged {
  file: File
  docId?: string
  pageCount?: number
  needsPassword?: boolean
  error?: string
}

/** Normalized [0,1] fractions of the page's own width/height — independent
 * of whatever DPI the preview or the final output happens to render at. */
interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; done: number; total: number }
  | { kind: 'done'; bytes: Uint8Array }
  | { kind: 'error'; message: string; code: string }

// Fixed — this is only ever what the user *draws against*, not what ships.
// 110 keeps a Letter/A4 page comfortably under 1000px tall on an ordinary
// screen without a separate zoom control.
const PREVIEW_DPI = 110

const OUTPUT_DPI_OPTIONS = [150, 200, 300, 450]

// A box's fractional [0,1] boundary rarely lands on an exact device-pixel
// line once multiplied by canvas.width/height. `ctx.fillRect` anti-aliases
// that boundary — blending the edge row/column toward, but not fully to,
// black — and re-encoding as JPEG can spread a faint trace of that partial
// pixel across an adjacent 8×8 DCT block. Neither is anywhere close to
// reconstructing the covered content, but "close to" isn't the bar for this
// tool. Outsetting the actual fill by a few device pixels beyond the user's
// drawn rectangle costs nothing (the user already drew comfortable margin
// around real content in every test) and removes the edge case entirely.
const EDGE_MARGIN_PX = 3

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** Fills every box for the current draw pass, each outset by EDGE_MARGIN_PX
 * and clamped to the canvas bounds — shared by the live preview and the
 * final per-page compositing so what the user sees matches what ships. */
function fillBoxes(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, boxes: Box[], w: number, h: number) {
  ctx.fillStyle = '#000'
  for (const b of boxes) {
    const x0 = clamp(b.x0 * w - EDGE_MARGIN_PX, 0, w)
    const y0 = clamp(b.y0 * h - EDGE_MARGIN_PX, 0, h)
    const x1 = clamp(b.x1 * w + EDGE_MARGIN_PX, 0, w)
    const y1 = clamp(b.y1 * h + EDGE_MARGIN_PX, 0, h)
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
  }
}

export default function RedactTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [boxesByPage, setBoxesByPage] = useState<Record<number, Box[]>>({})
  const [previewBitmap, setPreviewBitmap] = useState<ImageBitmap | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  // PNG, not JPEG, is the default here — the one tool in the app where that
  // flips from every other render-worker tool's JPEG default. JPEG's 8×8 DCT
  // blocks can spread a faint trace of a sharp black/non-black edge into an
  // adjacent block; PNG is lossless, so a box's interior is exactly what was
  // painted, full stop. JPEG stays available for a smaller file once a user
  // has decided the size trade-off is worth it, not as the unexamined default.
  const [format, setFormat] = useState<'jpeg' | 'png'>('png')
  const [dpi, setDpi] = useState(200)
  const [filename, setFilename] = useState('redacted.pdf')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const caps = deviceCaps()

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const draggingRef = useRef(false)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const cancelRef = useRef(false)

  const availableDpis = OUTPUT_DPI_OPTIONS.filter((d) => d <= caps.maxDPI)

  const totalBoxes = Object.values(boxesByPage).reduce((n, list) => n + list.length, 0)
  const pageCount = staged?.pageCount ?? 0

  const scale = dpi / 72
  const budget = checkBudget(estimateRenderBytes(pageCount, scale, format), caps)

  // Loads the current page's preview whenever the doc or page changes.
  useEffect(() => {
    if (!staged?.docId) {
      setPreviewBitmap(null)
      return
    }
    let cancelled = false
    setPreviewError(null)
    ;(async () => {
      try {
        const r = await render.renderPage(staged.docId!, currentPage, { dpi: PREVIEW_DPI, format: 'jpeg', quality: 0.85 })
        const bmp = await createImageBitmap(new Blob([r.bytes as unknown as BlobPart], { type: 'image/jpeg' }))
        if (!cancelled) setPreviewBitmap((old) => (old?.close(), bmp))
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof RenderError ? err.userMessage : 'Could not render this page.'
          setPreviewError(msg)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [staged?.docId, currentPage])

  // Redraws the overlay canvas whenever the preview, boxes, or an in-progress
  // drag changes. Cheap — this is compositing already-decoded pixels, not
  // re-rendering the PDF, so it can run on the main thread every frame.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !previewBitmap) return
    canvas.width = previewBitmap.width
    canvas.height = previewBitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.drawImage(previewBitmap, 0, 0)
    fillBoxes(ctx, boxesByPage[currentPage] ?? [], canvas.width, canvas.height)
    if (draft) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.fillRect(draft.x0, draft.y0, draft.x1 - draft.x0, draft.y1 - draft.y0)
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1
      ctx.strokeRect(draft.x0, draft.y0, draft.x1 - draft.x0, draft.y1 - draft.y0)
    }
  }, [previewBitmap, boxesByPage, currentPage, draft])

  useEffect(() => () => void previewBitmap?.close(), [previewBitmap])

  async function addFile(list: FileList | null) {
    const file = list?.[0]
    if (!file) return
    if (staged?.docId) render.close(staged.docId)
    setStaged({ file })
    setBoxesByPage({})
    setCurrentPage(1)
    setStatus({ kind: 'idle' })
    setFilename(`${file.name.replace(/\.pdf$/i, '')}-redacted.pdf`)
    try {
      const { docId, pageCount } = await render.open(await file.arrayBuffer())
      setStaged((cur) => (cur && cur.file === file ? { ...cur, docId, pageCount } : cur))
    } catch (err) {
      if (err instanceof RenderError && err.code === 'ERR_ENCRYPTED') {
        setStaged((cur) => (cur && cur.file === file ? { ...cur, needsPassword: true } : cur))
      } else {
        const msg = err instanceof RenderError ? err.userMessage : 'Could not read this file.'
        setStaged((cur) => (cur && cur.file === file ? { ...cur, error: msg } : cur))
      }
    }
  }

  async function confirmPassword() {
    if (!staged) return
    try {
      const { docId, pageCount } = await render.open(await staged.file.arrayBuffer(), { password })
      setStaged((cur) => (cur ? { ...cur, docId, pageCount, needsPassword: false, error: undefined } : cur))
    } catch (err) {
      const msg = err instanceof RenderError ? err.userMessage : 'Could not read this file.'
      setStaged((cur) => (cur ? { ...cur, error: msg } : cur))
    }
  }

  function toCanvasCoords(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height
    return { x: clamp(x, 0, canvas.width), y: clamp(y, 0, canvas.height) }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    // apply() closes over the box set as it stood at the moment Redact was
    // clicked (see its own comment) — a drag started after that must not be
    // allowed to change what's on screen, or a user could watch a new box
    // appear, see "Redacted" succeed, and download a file that never
    // contained it. Silence, not a visible error, because this is a normal
    // thing to attempt (the canvas doesn't otherwise look locked) — the
    // whole edit surface is disabled in the JSX below for the same reason.
    if (!previewBitmap || status.kind === 'working') return
    const p = toCanvasCoords(e)
    draggingRef.current = true
    dragStartRef.current = p
    e.currentTarget.setPointerCapture(e.pointerId)
    setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!draggingRef.current || !dragStartRef.current) return
    const p = toCanvasCoords(e)
    const s = dragStartRef.current
    setDraft({ x0: Math.min(s.x, p.x), y0: Math.min(s.y, p.y), x1: Math.max(s.x, p.x), y1: Math.max(s.y, p.y) })
  }

  function onPointerUp() {
    if (!draggingRef.current) return
    draggingRef.current = false
    const canvas = canvasRef.current
    const d = draft
    setDraft(null)

    // A drag smaller than 4px in either dimension is almost certainly an
    // accidental click, not an intended (if tiny) box — drop it silently.
    // This reads `draft` directly rather than through setDraft's updater —
    // React StrictMode double-invokes updater functions in dev to catch
    // exactly this class of bug (a state setter as a side effect of another
    // state setter), which was silently committing every box twice.
    if (d && canvas && d.x1 - d.x0 > 4 && d.y1 - d.y0 > 4) {
      const box: Box = { x0: d.x0 / canvas.width, y0: d.y0 / canvas.height, x1: d.x1 / canvas.width, y1: d.y1 / canvas.height }
      setBoxesByPage((cur) => ({ ...cur, [currentPage]: [...(cur[currentPage] ?? []), box] }))
    }
  }

  function removeBox(pageNr: number, idx: number) {
    setBoxesByPage((cur) => {
      const list = (cur[pageNr] ?? []).filter((_, i) => i !== idx)
      return { ...cur, [pageNr]: list }
    })
  }

  function redactWholePage() {
    setBoxesByPage((cur) => ({ ...cur, [currentPage]: [...(cur[currentPage] ?? []), { x0: 0, y0: 0, x1: 1, y1: 1 }] }))
  }

  function clearPage() {
    setBoxesByPage((cur) => ({ ...cur, [currentPage]: [] }))
  }

  async function apply() {
    if (!staged?.docId || !pageCount) return
    cancelRef.current = false
    setStatus({ kind: 'working', done: 0, total: pageCount })

    // Snapshot the box set NOW, explicitly, rather than reading `boxesByPage`
    // (React state) from inside the loop below. JS closures already make
    // this the practical behaviour — this function's own `boxesByPage`
    // binding is fixed at the render that created it, unaffected by state
    // updates from renders after that — but that guarantee is easy to break
    // silently in a future refactor (e.g. switching to a ref, or splitting
    // this into a hook). Naming it here makes "what gets redacted is frozen
    // at the moment Redact was clicked" a decision, not an accident. The
    // canvas/box-editing controls are also disabled for the duration (see
    // the JSX below and onPointerDown) so the UI can't visibly diverge from
    // this snapshot while a run is in flight.
    const boxes = boxesByPage

    const mime = format === 'png' ? 'image/png' : 'image/jpeg'
    const pageImages: { bytes: ArrayBuffer; widthPt: number; heightPt: number }[] = []

    try {
      for (let pageNr = 1; pageNr <= pageCount; pageNr++) {
        if (cancelRef.current) {
          setStatus({ kind: 'error', message: 'Cancelled.', code: 'ERR_CANCELLED' })
          return
        }

        const r = await render.renderPage(staged.docId, pageNr, { dpi, format, quality: 0.92 })
        const bitmap = await createImageBitmap(new Blob([r.bytes as unknown as BlobPart], { type: mime }))
        const canvas = new OffscreenCanvas(r.width, r.height)
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('2d context unavailable')
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()

        fillBoxes(ctx, boxes[pageNr] ?? [], r.width, r.height)

        const blob = await canvas.convertToBlob({ type: mime, quality: format === 'jpeg' ? 0.92 : undefined })
        const bytes = await blob.arrayBuffer()

        // r.effectiveDpi (not the requested dpi) accounts for the render
        // worker clamping very large pages to a lower DPI — using the
        // requested value here would silently distort the page's physical
        // size on exactly those pages.
        pageImages.push({
          bytes,
          widthPt: (r.width * 72) / r.effectiveDpi,
          heightPt: (r.height * 72) / r.effectiveDpi,
        })
        setStatus({ kind: 'working', done: pageNr, total: pageCount })
      }

      // The common case (a document with one uniform page size) needs a
      // single engine call. Sub-point rounding differences between pages
      // (Math.ceil on device pixels) are tolerated rather than compared for
      // exact equality — pdfcpu's own fit-to-page math preserves aspect
      // ratio rather than stretching, so a hairline mismatch here produces
      // an imperceptible margin, never distortion. See
      // engine/internal/ops/imagestopdf.go's "exact" mode.
      const first = pageImages[0]
      const uniform = pageImages.every((p) => Math.abs(p.widthPt - first.widthPt) < 0.5 && Math.abs(p.heightPt - first.heightPt) < 0.5)

      let out: Uint8Array
      if (uniform) {
        out = await engine.imagesToPDF(
          pageImages.map((p) => p.bytes),
          { pageSize: 'exact', width: first.widthPt, height: first.heightPt },
        )
      } else {
        const perPagePdfs: ArrayBuffer[] = []
        for (const p of pageImages) {
          const pdf = await engine.imagesToPDF([p.bytes], { pageSize: 'exact', width: p.widthPt, height: p.heightPt })
          perPagePdfs.push(pdf.buffer as ArrayBuffer)
        }
        out = await engine.merge(perPagePdfs)
      }

      setStatus({ kind: 'done', bytes: out })
    } catch (err) {
      if (err instanceof RenderError || err instanceof EngineError) {
        setStatus({ kind: 'error', message: err.userMessage, code: err.code })
      } else {
        setStatus({ kind: 'error', message: String(err), code: 'ERR_INTERNAL' })
      }
    } finally {
      // A structural rebuild of every page at export DPI is the same cost
      // shape as PdfToImage's full-document run, plus the engine's own copy
      // — always respawn rather than carry a possibly very inflated heap
      // into the next job.
      engine.terminate()
    }
  }

  const currentBoxes = boxesByPage[currentPage] ?? []
  const blocked = !staged?.docId || staged.needsPassword || totalBoxes === 0 || !budget.ok || status.kind === 'working'

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, redacted region by region" />

      {staged && (
        <p className="muted">
          {staged.file.name} · {formatBytes(staged.file.size)}
          {staged.pageCount !== undefined && ` · ${staged.pageCount} page${staged.pageCount === 1 ? '' : 's'}`}
          {staged.error && <strong className="err"> · {staged.error}</strong>}
        </p>
      )}

      {staged?.needsPassword && (
        <p>
          <label>
            This file is password protected.{' '}
            <input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
            />
          </label>{' '}
          <button onClick={confirmPassword} disabled={!password}>
            Unlock
          </button>
        </p>
      )}

      {staged?.pageCount !== undefined && !staged.needsPassword && (
        <>
          <p className="warn">
            Every page is rebuilt as an image, not just the boxed area — nothing under a box, and no page's text,
            survives. This document will no longer be searchable or selectable after redaction.
          </p>

          <div className="actions actions--plain">
            <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}>
              Previous
            </button>
            <span className="muted">
              Page {currentPage}/{pageCount} · {currentBoxes.length} box{currentBoxes.length === 1 ? '' : 'es'}
            </span>
            <button onClick={() => setCurrentPage((p) => Math.min(pageCount, p + 1))} disabled={currentPage >= pageCount}>
              Next
            </button>
          </div>

          {previewError && <p className="err">{previewError}</p>}

          {previewBitmap && (
            <canvas
              ref={canvasRef}
              style={{
                maxWidth: '100%',
                maxHeight: '70vh',
                width: 'auto',
                height: 'auto',
                touchAction: 'none',
                cursor: 'crosshair',
                border: '1px solid var(--line)',
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              role="img"
              aria-label={`Page ${currentPage} preview — drag to draw a redaction box`}
            />
          )}

          <div className="actions actions--plain">
            <button onClick={redactWholePage} disabled={!previewBitmap || status.kind === 'working'}>
              Redact Entire Page
            </button>
            <button onClick={clearPage} disabled={currentBoxes.length === 0 || status.kind === 'working'}>
              Clear This Page
            </button>
            <button onClick={() => setBoxesByPage({})} disabled={totalBoxes === 0 || status.kind === 'working'}>
              Clear All
            </button>
          </div>

          {currentBoxes.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0' }}>
              {currentBoxes.map((b, i) => (
                <li key={i} style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                  <span className="muted">
                    Box {i + 1}: {(b.x0 * 100).toFixed(0)}%,{(b.y0 * 100).toFixed(0)}% → {(b.x1 * 100).toFixed(0)}%,
                    {(b.y1 * 100).toFixed(0)}%
                  </span>
                  <button
                    aria-label={`Remove box ${i + 1}`}
                    onClick={() => removeBox(currentPage, i)}
                    disabled={status.kind === 'working'}
                  >
                    <XIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <fieldset>
            <legend>Output quality</legend>
            <label>
              Resolution{' '}
              <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
                {availableDpis.map((d) => (
                  <option key={d} value={d}>
                    {d} DPI
                  </option>
                ))}
              </select>
            </label>
            <br />
            <label>
              <input type="radio" checked={format === 'png'} onChange={() => setFormat('png')} /> PNG (lossless, recommended)
            </label>
            <br />
            <label>
              <input type="radio" checked={format === 'jpeg'} onChange={() => setFormat('jpeg')} /> JPG (smaller file)
            </label>
          </fieldset>

          {!budget.ok && budget.message && <p className="err">{budget.message}</p>}
          {budget.degrade && budget.message && <p className="warn">{budget.message}</p>}
          {totalBoxes === 0 && <p className="muted">Draw at least one box before redacting.</p>}

          <div className="actions">
            <button onClick={apply} disabled={blocked}>
              {status.kind === 'working' ? 'Redacting…' : 'Redact'}
            </button>
            {status.kind === 'working' && <button onClick={() => (cancelRef.current = true)}>Cancel</button>}
          </div>
        </>
      )}

      {status.kind === 'working' && (
        <p className="muted">
          Rendering {status.done}/{status.total}
        </p>
      )}

      {status.kind === 'error' && (
        <p className="err">
          {status.message} <code>{status.code}</code>
        </p>
      )}

      {status.kind === 'done' && (
        <div className="result">
          <p>Redacted · {formatBytes(status.bytes.byteLength)}</p>
          <FilenameField value={filename} onChange={setFilename} />
          <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'redacted.pdf'))}>Download</button>
        </div>
      )}
    </>
  )
}
