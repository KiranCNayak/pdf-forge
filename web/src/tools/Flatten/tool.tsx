// Flatten is Redact/InvertColours' rasterize-and-rebuild architecture with
// no transform at all: render every page, rebuild the document from the
// images, unchanged pixels. See docs/tools/flatten.md for why that's the
// whole tool — pdfcpu has no API to bake a form field's or annotation's
// current appearance into a page's own content stream while leaving
// everything else on that page as real vector content (the catalog's own
// spec, `api.RemoveFormFields` + "annotation flattening"): RemoveFormFields
// only DELETES field objects, it never merges their appearance into the
// page first, so a filled-in field would simply vanish, not "flatten".
// Confirmed directly, not assumed, that this rebuild approach actually
// captures filled values: pdf.js's render worker bakes annotation/form-
// field appearances into the canvas by default (AnnotationMode.ENABLE,
// pdf.js's own documented default) — verified against a real AcroForm text
// field fixture before writing this file, not just cited from pdf.js's own
// docs. See web/e2e/flatten.spec.ts.
//
// No page selection, unlike Redact/InvertColours — "flatten some pages" is
// not a request this tool's own purpose (finalize a filled form, lock it
// from further editing) has any real use for; the whole document goes
// through the same pipeline regardless of which pages actually had a form
// field or annotation on them.

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

export default function FlattenTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [format, setFormat] = useState<'jpeg' | 'png'>('jpeg')
  const [dpi, setDpi] = useState(200)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [filename, setFilename] = useState('flattened.pdf')
  const caps = deviceCaps()
  const cancelRef = useRef(false)

  const availableDpis = DPI_OPTIONS.filter((d) => d <= caps.maxDPI)
  const pageCount = staged?.pageCount ?? 0
  const scale = dpi / 72
  const budget = checkBudget(estimateRenderBytes(pageCount, scale, format), caps)

  async function addFile(list: FileList | null) {
    const file = list?.[0]
    if (!file) return
    if (staged?.docId) render.close(staged.docId)
    setStaged({ file })
    setStatus({ kind: 'idle' })
    setFilename(`${file.name.replace(/\.pdf$/i, '')}-flattened.pdf`)
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

    const pageImages: { bytes: ArrayBuffer; widthPt: number; heightPt: number }[] = []

    try {
      for (let pageNr = 1; pageNr <= pageCount; pageNr++) {
        if (cancelRef.current) {
          setStatus({ kind: 'error', message: 'Cancelled.', code: 'ERR_CANCELLED' })
          return
        }

        const r = await render.renderPage(staged.docId, pageNr, { dpi, format, quality: 0.92 })
        // No decode → canvas → re-encode roundtrip needed, unlike Redact
        // (compositing boxes) or InvertColours (inverting pixels) — with no
        // pixel transform to apply, the render worker's own encoded bytes
        // go straight to imagesToPDF unchanged.
        pageImages.push({
          bytes: r.bytes,
          widthPt: (r.width * 72) / r.effectiveDpi,
          heightPt: (r.height * 72) / r.effectiveDpi,
        })
        setStatus({ kind: 'working', done: pageNr, total: pageCount })
      }

      // Same tolerance-based uniform-size check Redact/InvertColours use —
      // see engine/internal/ops/imagestopdf.go's "exact" mode doc comment.
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

  const blocked = !staged?.docId || staged.needsPassword || !budget.ok || status.kind === 'working'

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, form fields and annotations flattened" />

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
            Every page is rebuilt as an image — filled fields keep their values, but the whole document loses text
            search and selection, the same trade-off Redact and Invert Colours make.
          </p>

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
              <input
                type="radio"
                checked={format === 'jpeg'}
                onChange={() => setFormat('jpeg')}
                disabled={status.kind === 'working'}
              />{' '}
              JPG (smaller)
            </label>
            <br />
            <label>
              <input
                type="radio"
                checked={format === 'png'}
                onChange={() => setFormat('png')}
                disabled={status.kind === 'working'}
              />{' '}
              PNG (lossless)
            </label>
          </fieldset>

          {!budget.ok && budget.message && <p className="err">{budget.message}</p>}
          {budget.degrade && budget.message && <p className="warn">{budget.message}</p>}

          <div className="actions">
            <button onClick={apply} disabled={blocked}>
              {status.kind === 'working' ? 'Flattening…' : 'Flatten'}
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
          <p>Flattened · {formatBytes(status.bytes.byteLength)}</p>
          <FilenameField value={filename} onChange={setFilename} />
          <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'flattened.pdf'))}>
            Download
          </button>
        </div>
      )}
    </>
  )
}
