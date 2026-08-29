// Extract Text pulls text out of a PDF via the render worker's line/paragraph
// /column reconstruction (docs/tools/extract-text.md). This is JS, not Go,
// despite pdfcpu having api.ExtractContent: pdf.js reconstructs *layout* from
// glyph transform matrices — line breaks, paragraphs, columns, reading order —
// and pdfcpu's lower-level extraction would mean rebuilding that inference
// ourselves, worse. The boundary rule in docs/HLD.md §4 cuts the other way
// here, deliberately.
//
// A single render.extractText() call spans every requested page and streams
// a per-page callback, so the preview fills in incrementally rather than
// waiting on the whole document. Because it's one call, not a client-side
// per-page loop like PdfToImage's, cancellation terminates the worker
// (dropping the open docId) instead of checking a ref between iterations —
// same shape as the Go engine tools' cancel button.
//
// No budget gate: the doc calls this op "light — text only, no canvases",
// unlike renderPage's quadratic-in-DPI canvas cost, so there's no dedicated
// estimator to check against (device.ts has none for text extraction).
//
// V1 scope: the preview pane is a plain scrollable block, not virtualised.
// The doc flags virtualisation as worth doing for very large (1000-page)
// documents; revisit if that turns out to matter in practice.

import { useEffect, useRef, useState } from 'react'
import { FilePicker } from '../../components/FilePicker'
import { formatBytes } from '../../lib/device'
import { downloadBytes } from '../../lib/download'
import { parsePageSelection } from '../../lib/pageSelection'
import { render } from '../../lib/render/RenderClient'
import { RenderError, type ExtractedPage, type ExtractTextResult } from '../../lib/render/protocol'

interface Staged {
  file: File
  docId?: string
  pageCount?: number
  needsPassword?: boolean
  error?: string
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; done: number; total: number; pages: ExtractedPage[] }
  | { kind: 'done'; result: ExtractTextResult }
  | { kind: 'error'; message: string; code: string }

function baseName(name: string): string {
  return name.replace(/\.pdf$/i, '')
}

export default function ExtractTextTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [allPages, setAllPages] = useState(true)
  const [selectionText, setSelectionText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(copiedTimer.current), [])

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
    setStatus({ kind: 'working', done: 0, total: selectedPages.length, pages: [] })
    try {
      const result = await render.extractText(docId, { pages: selectedPages }, (pageNr, text) => {
        setStatus((cur) =>
          cur.kind === 'working' ? { ...cur, done: cur.done + 1, pages: [...cur.pages, { pageNr, text }] } : cur,
        )
      })
      setStatus({ kind: 'done', result })
    } catch (err) {
      if (err instanceof RenderError) {
        setStatus({ kind: 'error', message: err.userMessage, code: err.code })
        // Terminating the worker (cancel, or a worker-level crash) drops the
        // open docId — force a re-add rather than leave a stale one staged.
        if (err.code === 'ERR_CANCELLED' || err.code === 'ERR_WORKER_FAILED') {
          setStaged((cur) => (cur ? { ...cur, docId: undefined, pageCount: undefined } : cur))
        }
      } else {
        setStatus({ kind: 'error', message: String(err), code: 'ERR_INTERNAL' })
      }
    }
  }

  async function copyAll(text: string) {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 2000)
  }

  function downloadText(text: string) {
    const bytes = new TextEncoder().encode(text)
    downloadBytes(bytes, `${baseName(staged?.file.name ?? 'document')}.txt`, 'text/plain')
  }

  const blocked =
    !staged?.docId ||
    staged.needsPassword ||
    !!selectionError ||
    selectedPages.length === 0 ||
    status.kind === 'working'

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, text extracted in your browser" />

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

          <div className="actions">
            <button onClick={run} disabled={blocked}>
              {status.kind === 'working' ? 'Extracting…' : 'Extract text'}
            </button>
            {status.kind === 'working' && <button onClick={() => render.terminate()}>Cancel</button>}
          </div>
        </>
      )}

      {status.kind === 'working' && (
        <p className="muted">
          Extracting {status.done}/{status.total}
        </p>
      )}

      {status.kind === 'error' && (
        <p className="err">
          {status.message} <code>{status.code}</code>
        </p>
      )}

      {(status.kind === 'working' || status.kind === 'done') && (
        <div className="result">
          {status.kind === 'done' && status.result.isScanned && (
            <p className="warn">
              This looks like a scanned document — no text layer was found. Text extraction needs
              OCR, which we don't offer yet.
            </p>
          )}
          {status.kind === 'done' && !status.result.isScanned && status.result.lowConfidence && (
            <p className="warn">
              A large share of characters didn't map cleanly — this document's font encoding may be
              incomplete. Extracted text below may contain garbled characters.
            </p>
          )}

          {status.kind === 'done' && !status.result.isScanned && (
            <>
              <p className="muted">{status.result.fullText.length.toLocaleString()} characters</p>
              <div className="actions">
                <button onClick={() => copyAll(status.result.fullText)}>{copied ? 'Copied!' : 'Copy All'}</button>
                <button onClick={() => downloadText(status.result.fullText)}>Download .txt</button>
              </div>
            </>
          )}

          {/* Plain scrollable block, not the shared `ol.files` grid — this is a
              single long text preview, not a list of files. See the file header
              for the virtualisation trade-off. */}
          <pre
            style={{
              maxHeight: '24rem',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              padding: '.75rem',
              marginTop: '1rem',
              border: '1px solid var(--line)',
              borderRadius: '6px',
              fontSize: '.85rem',
            }}
          >
            {(status.kind === 'done' ? status.result.pages : status.pages)
              .map((p) => `--- page ${p.pageNr} ---\n${p.text}`)
              .join('\n\n')}
          </pre>
        </div>
      )}
    </>
  )
}
