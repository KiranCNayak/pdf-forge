// PdfToZip is mechanically PdfToImage plus archiving (docs/tools/pdf-to-zip.md
// calls it that explicitly) — same render.open()/renderPage() shape, same
// batch-with-pause discipline, same cancel-via-ref (this loops per page
// client-side, unlike ExtractText's single call). The only genuinely new part
// is streaming pages into a ZIP instead of collecting them into React state.
//
// First tool in the repo needing an actual ZIP dependency (jszip) — flagged
// per docs/PARALLEL.md before adding it. JSZip holds the whole archive in
// memory before generateAsync(), which is *the* memory ceiling for this tool
// (the doc's words: "the sum of all compressed images must fit"), so pages
// are added and dropped one at a time rather than accumulated in an array
// first, and the estimate is shown up front rather than discovered at page
// 280 of 300.
//
// Single-page documents skip the ZIP entirely and hand back the rendered
// image directly, per the doc's edge case — a one-entry archive is friction
// with no benefit.

import { useRef, useState } from 'react'
import JSZip from 'jszip'
import { FilePicker } from '../../components/FilePicker'
import { checkBudget, deviceCaps, estimateRenderBytes, formatBytes } from '../../lib/device'
import { downloadBlob, downloadBytes } from '../../lib/download'
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

type DoneResult =
  | { single: true; bytes: Uint8Array; pageNr: number; effectiveDpi: number }
  | { single: false; blob: Blob }

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; done: number; total: number }
  | { kind: 'done'; result: DoneResult }
  | { kind: 'error'; message: string; code: string }

const DPI_OPTIONS = [72, 150, 300, 450, 600]

function baseName(name: string): string {
  return name.replace(/\.pdf$/i, '')
}

export default function PdfToZipTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  // JPEG default, not PNG — the doc's explicit call: PNG's ~1.5× cost
  // compounds across every page in a bulk job, and photos gain nothing from
  // lossless.
  const [format, setFormat] = useState<'jpeg' | 'png'>('jpeg')
  const [dpi, setDpi] = useState(150)
  const [allPages, setAllPages] = useState(true)
  const [selectionText, setSelectionText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const caps = deviceCaps()
  const cancelRef = useRef(false)

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
  // Same approximation PdfToImage uses for a single rendered page, summed
  // across the batch — close enough to warn before starting, per the doc's
  // "show it, don't discover it at page 280" instruction. JSZip's own DEFLATE
  // pass barely shrinks already-compressed JPEG/PNG bytes, so this doesn't
  // need a separate compression-aware estimator.
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
    const docId = staged.docId
    cancelRef.current = false
    setStatus({ kind: 'working', done: 0, total: selectedPages.length })

    try {
      if (selectedPages.length === 1) {
        const pageNr = selectedPages[0]
        const r = await render.renderPage(docId, pageNr, { dpi, format })
        setStatus({
          kind: 'done',
          result: { single: true, bytes: new Uint8Array(r.bytes), pageNr, effectiveDpi: r.effectiveDpi },
        })
        return
      }

      const zip = new JSZip()
      const ext = format === 'png' ? 'png' : 'jpg'
      const width = String(selectedPages.length).length

      for (let i = 0; i < selectedPages.length; i++) {
        if (cancelRef.current) {
          setStatus({ kind: 'error', message: 'Cancelled.', code: 'ERR_CANCELLED' })
          return
        }

        const pageNr = selectedPages[i]
        const r = await render.renderPage(docId, pageNr, { dpi, format })
        // Add straight to the archive and let r.bytes go out of scope — never
        // collect rendered pages in an array first. See the file header.
        zip.file(`page-${String(pageNr).padStart(width, '0')}.${ext}`, r.bytes)
        setStatus({ kind: 'working', done: i + 1, total: selectedPages.length })

        const atBatchBoundary = (i + 1) % caps.maxPagesPerBatch === 0
        if (atBatchBoundary && i + 1 < selectedPages.length) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }

      const blob = await zip.generateAsync({ type: 'blob', streamFiles: true })
      setStatus({ kind: 'done', result: { single: false, blob } })
    } catch (err) {
      if (err instanceof RenderError) {
        setStatus({ kind: 'error', message: err.userMessage, code: err.code })
      } else {
        setStatus({ kind: 'error', message: String(err), code: 'ERR_INTERNAL' })
      }
    }
  }

  function download(result: DoneResult) {
    if (result.single) {
      const ext = format === 'png' ? 'png' : 'jpg'
      const mime = format === 'png' ? 'image/png' : 'image/jpeg'
      downloadBytes(result.bytes, `${baseName(staged?.file.name ?? 'page')}-p${result.pageNr}.${ext}`, mime)
    } else {
      downloadBlob(result.blob, `${baseName(staged?.file.name ?? 'pages')}.zip`)
    }
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
      <FilePicker onFiles={addFile} hint="One PDF, every page rendered and zipped" />

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

          {selectedPages.length > 1 && (
            <p className="muted">
              Estimated ZIP ≈ {formatBytes(estimateRenderBytes(selectedPages.length, scale, format))} across{' '}
              {selectedPages.length} pages
            </p>
          )}
          {selectedPages.length === 1 && (
            <p className="muted">Only one page selected — you'll get the image directly, no ZIP.</p>
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
          {status.result.single ? (
            <p>
              Page {status.result.pageNr} rendered at {status.result.effectiveDpi} DPI ·{' '}
              {formatBytes(status.result.bytes.byteLength)}
            </p>
          ) : (
            <p>ZIP ready · {formatBytes(status.result.blob.size)}</p>
          )}
          <button onClick={() => download(status.result)}>Download</button>
        </div>
      )}
    </>
  )
}
