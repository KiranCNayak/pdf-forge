// The first render-worker tool. Follows the Merge shape where it can, but
// diverges where the render worker's API does: `render.open()` loads the
// document once and hands back a `docId` that stays valid across many
// `renderPage` calls, instead of the engine's one-shot buffer-in/buffer-out.
// See docs/tools/pdf-to-image.md and web/src/lib/render/RenderClient.ts.
//
// Cancellation checks a ref between pages rather than calling
// `render.terminate()` — terminating the worker would drop the open
// `docId`, and unlike the Go engine's stateless per-call ops, this tool's
// state (the open document) lives *in* the worker between calls.
//
// No ZIP dependency (same call as Split, docs/PARALLEL.md) — multiple pages
// download individually, staggered, via "Download all".

import { useEffect, useRef, useState } from 'react'
import { FilePicker } from '../../components/FilePicker'
import { downloadBytes } from '../../lib/download'
import { checkBudget, deviceCaps, estimateRenderBytes, formatBytes } from '../../lib/device'
import { parsePageSelection } from '../../lib/pageSelection'
import { render } from '../../lib/render/RenderClient'
import { RenderError } from '../../lib/render/protocol'

interface Staged {
  file: File
  docId?: string
  pageCount?: number
  needsPassword?: boolean
  error?: string
}

interface RenderedPage {
  pageNr: number
  bytes: Uint8Array
  effectiveDpi: number
  clamped: boolean
  url: string
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; done: number; total: number }
  | { kind: 'done'; pages: RenderedPage[] }
  | { kind: 'error'; message: string; code: string }

const DPI_OPTIONS = [72, 150, 300, 450, 600]

function revokeUrls(s: Status) {
  if (s.kind === 'done') s.pages.forEach((p) => URL.revokeObjectURL(p.url))
}

function baseName(name: string): string {
  return name.replace(/\.pdf$/i, '')
}

export default function PdfToImageTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [format, setFormat] = useState<'jpeg' | 'png'>('jpeg')
  const [dpi, setDpi] = useState(150)
  const [allPages, setAllPages] = useState(true)
  const [selectionText, setSelectionText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const caps = deviceCaps()
  const cancelRef = useRef(false)

  // Whichever 'done' state is current when this unmounts or is replaced
  // gets its object URLs revoked — see the note on RenderedPage.url below.
  useEffect(() => () => revokeUrls(status), [status])

  const availableDpis = DPI_OPTIONS.filter((d) => d <= caps.maxDPI)

  let selectedPages: number[] = []
  let selectionError: string | undefined
  if (staged?.pageCount) {
    if (allPages) {
      selectedPages = Array.from({ length: staged.pageCount }, (_, i) => i + 1)
    } else {
      try {
        selectedPages = parsePageSelection(selectionText, staged.pageCount)
      } catch (err) {
        selectionError = err instanceof Error ? err.message : String(err)
      }
    }
  }

  const scale = dpi / 72
  const budget = checkBudget(estimateRenderBytes(selectedPages.length, scale, format), caps)

  async function addFile(list: FileList | null) {
    const file = list?.[0]
    if (!file) return
    if (staged?.docId) render.close(staged.docId)
    setStaged({ file })
    setStatus({ kind: 'idle' })
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

  async function run() {
    if (!staged?.docId || selectedPages.length === 0) return
    cancelRef.current = false
    setStatus({ kind: 'working', done: 0, total: selectedPages.length })

    const results: RenderedPage[] = []
    try {
      for (let i = 0; i < selectedPages.length; i++) {
        if (cancelRef.current) {
          setStatus({ kind: 'error', message: 'Cancelled.', code: 'ERR_CANCELLED' })
          return
        }

        const pageNr = selectedPages[i]
        const r = await render.renderPage(staged.docId, pageNr, { dpi, format })
        const bytes = new Uint8Array(r.bytes)
        const mime = format === 'png' ? 'image/png' : 'image/jpeg'
        const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }))
        results.push({ pageNr, bytes, effectiveDpi: r.effectiveDpi, clamped: r.clamped, url })
        setStatus({ kind: 'working', done: i + 1, total: selectedPages.length })

        // Pause between batches so Chrome's GC (triggers after ~1-1.5s idle)
        // has a chance to reclaim the canvases/textures freed per page in
        // the worker. See docs/tools/pdf-to-image.md's memory section.
        const atBatchBoundary = (i + 1) % caps.maxPagesPerBatch === 0
        if (atBatchBoundary && i + 1 < selectedPages.length) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
      setStatus({ kind: 'done', pages: results })
    } catch (err) {
      if (err instanceof RenderError) {
        setStatus({ kind: 'error', message: err.userMessage, code: err.code })
      } else {
        setStatus({ kind: 'error', message: String(err), code: 'ERR_INTERNAL' })
      }
    }
  }

  function pageFilename(pageNr: number): string {
    const ext = format === 'png' ? 'png' : 'jpg'
    return `${baseName(staged?.file.name ?? 'page')}-p${pageNr}.${ext}`
  }

  function downloadAll(pages: RenderedPage[]) {
    const mime = format === 'png' ? 'image/png' : 'image/jpeg'
    pages.forEach((p, i) => setTimeout(() => downloadBytes(p.bytes, pageFilename(p.pageNr), mime), i * 150))
  }

  const blocked =
    !staged?.docId ||
    staged.needsPassword ||
    !!selectionError ||
    selectedPages.length === 0 ||
    !budget.ok ||
    status.kind === 'working'

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, rendered to images" />

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
          <p className="muted">
            Device tier <code>{caps.tier}</code> (max {caps.maxDPI} DPI, {caps.maxPagesPerBatch} pages per batch)
          </p>
          {!budget.ok && budget.message && <p className="err">{budget.message}</p>}
          {budget.degrade && budget.message && <p className="warn">{budget.message}</p>}

          <fieldset>
            <legend>Format</legend>
            <label>
              <input type="radio" checked={format === 'jpeg'} onChange={() => setFormat('jpeg')} /> JPG
            </label>
            <br />
            <label>
              <input type="radio" checked={format === 'png'} onChange={() => setFormat('png')} /> PNG
            </label>
          </fieldset>

          <fieldset>
            <legend>DPI</legend>
            <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
              {availableDpis.map((d) => (
                <option key={d} value={d}>
                  {d} DPI
                </option>
              ))}
            </select>
          </fieldset>

          <fieldset>
            <legend>Pages</legend>
            <label>
              <input type="radio" checked={allPages} onChange={() => setAllPages(true)} /> All pages
            </label>
            <br />
            <label>
              <input type="radio" checked={!allPages} onChange={() => setAllPages(false)} /> Selected pages (
              <code>1-3, 5</code>)
              <br />
              <input
                type="text"
                disabled={allPages}
                value={selectionText}
                onChange={(e) => setSelectionText(e.target.value)}
                placeholder="1-3, 5"
              />
            </label>
            {selectionError && <p className="err">{selectionError}</p>}
          </fieldset>

          {selectedPages.length > 0 && (
            <p className="muted">
              Estimated output ≈{' '}
              {formatBytes(estimateRenderBytes(selectedPages.length, scale, format))} across{' '}
              {selectedPages.length} page{selectedPages.length === 1 ? '' : 's'}
            </p>
          )}

          <div className="actions">
            <button onClick={run} disabled={blocked}>
              {status.kind === 'working' ? 'Converting…' : 'Convert'}
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
          <p>
            {status.pages.length} image{status.pages.length === 1 ? '' : 's'} rendered.
            {status.pages.some((p) => p.clamped) && ' Some pages were clamped to a lower DPI (very large page size).'}
          </p>
          {/* Not the shared `ol.files` grid — that's a 2-column layout with no room
              for a thumbnail, and this is the first tool that has one. Plain flex
              instead of adding a thumbnail variant to the shared stylesheet. */}
          <ol style={{ listStyle: 'none', padding: 0, margin: '1rem 0' }}>
            {status.pages.map((p) => (
              <li
                key={p.pageNr}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '.75rem',
                  padding: '.5rem 0',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <img src={p.url} alt={`Page ${p.pageNr}`} style={{ maxWidth: '64px', maxHeight: '84px' }} />
                <span style={{ flex: 1 }}>
                  Page {p.pageNr} · {p.effectiveDpi} DPI{p.clamped && ' (clamped)'} ·{' '}
                  {formatBytes(p.bytes.byteLength)}
                </span>
                <button onClick={() => downloadBytes(p.bytes, pageFilename(p.pageNr), format === 'png' ? 'image/png' : 'image/jpeg')}>
                  Download
                </button>
              </li>
            ))}
          </ol>
          {status.pages.length > 1 && <button onClick={() => downloadAll(status.pages)}>Download all</button>}
        </div>
      )}
    </>
  )
}
