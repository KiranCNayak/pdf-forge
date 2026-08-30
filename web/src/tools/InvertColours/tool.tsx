// Invert Colours is Redact's rasterize-and-rebuild architecture minus the
// box editor: render every page in the render worker, transform the decoded
// pixels (here, a literal per-channel invert instead of compositing black
// boxes), and rebuild the whole document from images via the same
// imagesToPDF "exact" + merge fallback engine.crop/redact.tsx established.
// See docs/tools/invert-colours.md for why this is the same deliberate
// trade-off as Redact and Flatten: pdfcpu has no content-stream colour-
// operator rewriter, so "rewrite the vector colours, keep the text" was
// never on the table — this is a straightforward photo-negative, which
// costs the whole document's text search/selection, same as Redact.
//
// Selection lets a user invert only some pages, leaving the rest exactly as
// rendered (still rasterized — reconstructing the document at all means
// every page goes through the render→image→rebuild pipeline regardless —
// but with their ORIGINAL colours, not inverted ones).

import { useRef, useState } from 'react'
import { FilePicker } from '../../components/FilePicker'
import { FilenameField } from '../../components/FilenameField'
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

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; done: number; total: number }
  | { kind: 'done'; bytes: Uint8Array }
  | { kind: 'error'; message: string; code: string }

const DPI_OPTIONS = [150, 200, 300, 450]

/** Literal per-channel photo-negative — 255 minus each of R, G, B. Alpha and
 * every other channel are untouched. */
function invertPixels(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number) {
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i]
    d[i + 1] = 255 - d[i + 1]
    d[i + 2] = 255 - d[i + 2]
  }
  ctx.putImageData(img, 0, 0)
}

export default function InvertColoursTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [format, setFormat] = useState<'jpeg' | 'png'>('jpeg')
  const [dpi, setDpi] = useState(150)
  const [allPages, setAllPages] = useState(true)
  const [selectionText, setSelectionText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [filename, setFilename] = useState('inverted.pdf')
  const caps = deviceCaps()
  // A ref, not state — apply()'s closure is fixed at the render that created
  // it, so a state variable checked mid-loop would never see a later Cancel
  // click update it (the exact bug Redact's own apply() was built to avoid;
  // see docs/tools/redact.md and the "box editor frozen during a run" fix).
  const cancelRef = useRef(false)

  const availableDpis = DPI_OPTIONS.filter((d) => d <= caps.maxDPI)
  const pageCount = staged?.pageCount ?? 0
  const scale = dpi / 72
  const budget = checkBudget(estimateRenderBytes(pageCount, scale, format), caps)

  let selectedPages: Set<number> | null = null // null = every page
  let selectionError: string | undefined
  if (!allPages && pageCount) {
    selectedPages = new Set()
    for (const part of selectionText.split(',')) {
      const s = part.trim()
      if (!s) continue
      const m = /^(\d+)(?:-(\d+))?$/.exec(s)
      if (!m) {
        selectionError = `"${s}" isn't a page number or range`
        break
      }
      const lo = Number(m[1])
      const hi = m[2] ? Number(m[2]) : lo
      if (lo < 1 || hi > pageCount || lo > hi) {
        selectionError = `"${s}" is out of range (this document has ${pageCount} pages)`
        break
      }
      for (let p = lo; p <= hi; p++) selectedPages.add(p)
    }
  }

  async function addFile(list: FileList | null) {
    const file = list?.[0]
    if (!file) return
    if (staged?.docId) render.close(staged.docId)
    setStaged({ file })
    setStatus({ kind: 'idle' })
    setFilename(`${file.name.replace(/\.pdf$/i, '')}-inverted.pdf`)
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

  async function apply() {
    if (!staged?.docId || !pageCount) return
    cancelRef.current = false
    setStatus({ kind: 'working', done: 0, total: pageCount })

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

        if (!selectedPages || selectedPages.has(pageNr)) {
          invertPixels(ctx, r.width, r.height)
        }

        const blob = await canvas.convertToBlob({ type: mime, quality: format === 'jpeg' ? 0.92 : undefined })
        const bytes = await blob.arrayBuffer()

        pageImages.push({
          bytes,
          widthPt: (r.width * 72) / r.effectiveDpi,
          heightPt: (r.height * 72) / r.effectiveDpi,
        })
        setStatus({ kind: 'working', done: pageNr, total: pageCount })
      }

      // Same tolerance-based uniform-size check Redact uses — see
      // engine/internal/ops/imagestopdf.go's "exact" mode doc comment.
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
      engine.terminate()
    }
  }

  const blocked =
    !staged?.docId ||
    staged.needsPassword ||
    !!selectionError ||
    (!allPages && selectedPages?.size === 0) ||
    !budget.ok ||
    status.kind === 'working'

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, colours inverted" />

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
            Every page is rebuilt as an image, whether inverted or not — the whole document loses text search and
            selection, the same trade-off Redact and Flatten make.
          </p>

          <fieldset>
            <legend>Pages</legend>
            <label>
              <input type="radio" checked={allPages} onChange={() => setAllPages(true)} disabled={status.kind === 'working'} /> All pages
            </label>
            <br />
            <label>
              <input type="radio" checked={!allPages} onChange={() => setAllPages(false)} disabled={status.kind === 'working'} /> Selected pages (
              <code>1-3, 5</code>) — others keep their original colours
              <br />
              <input
                type="text"
                disabled={allPages || status.kind === 'working'}
                value={selectionText}
                onChange={(e) => setSelectionText(e.target.value)}
                placeholder="1-3, 5"
              />
            </label>
            {selectionError && <p className="err">{selectionError}</p>}
          </fieldset>

          <fieldset>
            <legend>Output quality</legend>
            <label>
              Resolution{' '}
              <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))} disabled={status.kind === 'working'}>
                {availableDpis.map((d) => (
                  <option key={d} value={d}>
                    {d} DPI
                  </option>
                ))}
              </select>
            </label>
            <br />
            <label>
              <input type="radio" checked={format === 'jpeg'} onChange={() => setFormat('jpeg')} disabled={status.kind === 'working'} /> JPG (smaller)
            </label>
            <br />
            <label>
              <input type="radio" checked={format === 'png'} onChange={() => setFormat('png')} disabled={status.kind === 'working'} /> PNG (lossless)
            </label>
          </fieldset>

          {!budget.ok && budget.message && <p className="err">{budget.message}</p>}
          {budget.degrade && budget.message && <p className="warn">{budget.message}</p>}

          <div className="actions">
            <button onClick={apply} disabled={blocked}>
              {status.kind === 'working' ? 'Inverting…' : 'Invert'}
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
          <p>Inverted · {formatBytes(status.bytes.byteLength)}</p>
          <FilenameField value={filename} onChange={setFilename} />
          <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'inverted.pdf'))}>
            Download
          </button>
        </div>
      )}
    </>
  )
}
