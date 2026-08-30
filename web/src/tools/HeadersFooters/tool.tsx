// Headers & Footers is a pure UI layer over the addWatermark op — same
// reasoning as PageNumbers, but a header AND a footer are two independent
// placements, and AddWatermarks only places one watermark per call. This
// file chains two engine.addWatermark calls instead: the header call's
// output bytes become the footer call's input. See
// docs/tools/headers-footers.md for why that composes for free (every op
// here is []byte in, []byte out, no filesystem or shared state).
//
// Watermarking preserves an input's existing encryption (verified — pdfcpu
// re-applies it on write using the same conf), so the same password, if
// any, is reused for both calls without re-prompting.

import { useState } from 'react'
import { FilenameField } from '../../components/FilenameField'
import { FilePicker } from '../../components/FilePicker'
import { engine } from '../../engine/EngineClient'
import { EngineError } from '../../engine/protocol'
import { checkBudget, deviceCaps, estimateEngineBytes, formatBytes } from '../../lib/device'
import { downloadBytes } from '../../lib/download'
import { sanitizeFilename } from '../../lib/filename'

interface Staged {
  file: File
  pages?: number
  needsPassword?: boolean
  error?: string
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; stage: string; done: number; total: number }
  | { kind: 'done'; bytes: Uint8Array }
  | { kind: 'error'; message: string; code: string }

const ALIGNMENTS = [
  { value: 'l', label: 'Left' },
  { value: 'c', label: 'Center' },
  { value: 'r', label: 'Right' },
]

/** The exact byte range a Uint8Array view covers, as its own ArrayBuffer —
 * needed because engine.addWatermark's result may be a view over a larger
 * transferred buffer, and the next call needs precisely these bytes as its
 * input. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export default function HeadersFootersTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [headerText, setHeaderText] = useState('')
  const [headerAlign, setHeaderAlign] = useState('c')
  const [footerText, setFooterText] = useState('')
  const [footerAlign, setFooterAlign] = useState('c')
  const [fontSize, setFontSize] = useState(11)
  const [color, setColor] = useState('black')
  const [allPages, setAllPages] = useState(true)
  const [selectionText, setSelectionText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [filename, setFilename] = useState('with-header-footer.pdf')
  const caps = deviceCaps()

  const budget = checkBudget(estimateEngineBytes(staged?.file.size ?? 0), caps)

  async function addFile(list: FileList | null) {
    const file = list?.[0]
    if (!file) return
    setStaged({ file })
    setStatus({ kind: 'idle' })

    try {
      const pages = await engine.pageCount(await file.arrayBuffer())
      setStaged((cur) => (cur && cur.file === file ? { ...cur, pages } : cur))
    } catch (err) {
      if (err instanceof EngineError && err.code === 'ERR_ENCRYPTED') {
        setStaged((cur) => (cur && cur.file === file ? { ...cur, needsPassword: true } : cur))
      } else {
        const msg = err instanceof EngineError ? err.userMessage : 'Could not read this file.'
        setStaged((cur) => (cur && cur.file === file ? { ...cur, error: msg } : cur))
      }
    }
  }

  async function confirmPassword() {
    if (!staged) return
    try {
      const pages = await engine.pageCount(await staged.file.arrayBuffer(), password)
      setStaged((cur) => (cur ? { ...cur, pages, needsPassword: false, error: undefined } : cur))
    } catch (err) {
      const msg = err instanceof EngineError ? err.userMessage : 'Could not read this file.'
      setStaged((cur) => (cur ? { ...cur, error: msg } : cur))
    }
  }

  async function run() {
    if (!staged) return
    setStatus({ kind: 'working', stage: 'reading', done: 0, total: 0 })
    try {
      let buffer = await staged.file.arrayBuffer()
      const selection = allPages
        ? undefined
        : selectionText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
      const pw = staged.needsPassword ? password : undefined

      if (headerText.trim()) {
        const bytes = await engine.addWatermark(
          buffer,
          {
            text: headerText,
            selection,
            fontSize,
            color,
            position: `t${headerAlign}`,
            rotation: 0,
            opacity: 1,
            onTop: true,
            password: pw,
          },
          (done, total) => setStatus({ kind: 'working', stage: 'header', done, total }),
        )
        buffer = toArrayBuffer(bytes)
      }

      if (footerText.trim()) {
        const bytes = await engine.addWatermark(
          buffer,
          {
            text: footerText,
            selection,
            fontSize,
            color,
            position: `b${footerAlign}`,
            rotation: 0,
            opacity: 1,
            onTop: true,
            password: pw,
          },
          (done, total) => setStatus({ kind: 'working', stage: 'footer', done, total }),
        )
        buffer = toArrayBuffer(bytes)
      }

      setStatus({ kind: 'done', bytes: new Uint8Array(buffer) })
    } catch (err) {
      if (err instanceof EngineError) {
        setStatus({ kind: 'error', message: err.userMessage, code: err.code })
      } else {
        setStatus({ kind: 'error', message: String(err), code: 'ERR_INTERNAL' })
      }
    }
  }

  const blocked =
    !staged ||
    !!staged.error ||
    staged.needsPassword ||
    !budget.ok ||
    (!headerText.trim() && !footerText.trim()) ||
    (!allPages && selectionText.trim() === '')

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, header and/or footer added" />

      {staged && (
        <p className="muted">
          {staged.file.name} · {formatBytes(staged.file.size)}
          {staged.pages !== undefined && ` · ${staged.pages} page${staged.pages === 1 ? '' : 's'}`}
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

      {staged && !staged.needsPassword && (
        <>
          <p className="muted">
            Device tier <code>{caps.tier}</code> (cap {formatBytes(caps.maxFileBytes)})
          </p>
          {!budget.ok && budget.message && <p className="err">{budget.message}</p>}
          {budget.degrade && budget.message && <p className="warn">{budget.message}</p>}

          <p>
            <label>
              Header text (optional)
              <br />
              <input
                type="text"
                value={headerText}
                onChange={(e) => setHeaderText(e.target.value)}
                placeholder="Document title, Page %p0 of %P, …"
              />
            </label>{' '}
            <label>
              Header alignment
              <br />
              <select value={headerAlign} onChange={(e) => setHeaderAlign(e.target.value)} disabled={!headerText}>
                {ALIGNMENTS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          </p>

          <p>
            <label>
              Footer text (optional)
              <br />
              <input
                type="text"
                value={footerText}
                onChange={(e) => setFooterText(e.target.value)}
                placeholder="Confidential, © 2026, …"
              />
            </label>{' '}
            <label>
              Footer alignment
              <br />
              <select value={footerAlign} onChange={(e) => setFooterAlign(e.target.value)} disabled={!footerText}>
                {ALIGNMENTS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          </p>

          <p>
            <label>
              Font size
              <br />
              <input
                type="number"
                min={1}
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
                style={{ width: '5rem' }}
              />
            </label>{' '}
            <label>
              Color
              <br />
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="black, gray, #808080, or 0.5 0.5 0.5"
              />
            </label>
          </p>

          <fieldset>
            <legend>Pages</legend>
            <label>
              <input type="radio" checked={allPages} onChange={() => setAllPages(true)} /> All pages
            </label>
            <br />
            <label>
              <input type="radio" checked={!allPages} onChange={() => setAllPages(false)} /> Selected pages (
              <code>1-3, 5, even, odd</code>)
              <br />
              <input
                type="text"
                disabled={allPages}
                value={selectionText}
                onChange={(e) => setSelectionText(e.target.value)}
                placeholder="1-3, 5, even, odd"
              />
            </label>
          </fieldset>

          <div className="actions">
            <button onClick={run} disabled={blocked || status.kind === 'working'}>
              {status.kind === 'working' ? 'Applying…' : 'Apply'}
            </button>
            {status.kind === 'working' && <button onClick={() => engine.terminate()}>Cancel</button>}
          </div>
        </>
      )}

      {status.kind === 'working' && (
        <p className="muted">
          {status.stage === 'header' && 'Applying header…'}
          {status.stage === 'footer' && 'Applying footer…'}
          {status.stage !== 'header' && status.stage !== 'footer' && status.stage}
        </p>
      )}

      {status.kind === 'error' && (
        <p className="err">
          {status.message} <code>{status.code}</code>
        </p>
      )}

      {status.kind === 'done' && (
        <div className="result">
          <p>Applied · {formatBytes(status.bytes.byteLength)}</p>
          <FilenameField value={filename} onChange={setFilename} />
          <button
            onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'with-header-footer.pdf'))}
          >
            Download
          </button>
        </div>
      )}
    </>
  )
}
