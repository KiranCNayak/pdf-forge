// Page Numbers is a pure UI layer over the addWatermark op — no new engine
// code, no new EngineClient method. See docs/tools/page-numbers.md for why:
// pdfcpu substitutes %p{offset}/%P tokens PER PAGE inside AddWatermarks
// itself, so a text string like "Page %p0 of %P" already does the right
// thing with the code AddWatermark already has. This file's only job is to
// build that token string from a friendlier format-preset + "start at" UI
// and always send onTop:true, rotation:0 (a page number behind content or at
// an angle defeats the point).

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

type Format = 'n' | 'n-of-total' | 'n-slash-total'

const FORMATS: { value: Format; label: string }[] = [
  { value: 'n', label: 'Page number only — "1"' },
  { value: 'n-of-total', label: '"Page 1 of 5"' },
  { value: 'n-slash-total', label: '"1 / 5"' },
]

const POSITIONS = [
  { value: 'tl', label: 'Top left' },
  { value: 'tc', label: 'Top center' },
  { value: 'tr', label: 'Top right' },
  { value: 'bl', label: 'Bottom left' },
  { value: 'bc', label: 'Bottom center' },
  { value: 'br', label: 'Bottom right' },
]

function buildText(format: Format, offset: number): string {
  switch (format) {
    case 'n':
      return `%p${offset}`
    case 'n-of-total':
      return `Page %p${offset} of %P`
    case 'n-slash-total':
      return `%p${offset} / %P`
  }
}

export default function PageNumbersTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [format, setFormat] = useState<Format>('n-of-total')
  const [startAt, setStartAt] = useState(1)
  const [position, setPosition] = useState('bc')
  const [fontSize, setFontSize] = useState(11)
  const [color, setColor] = useState('black')
  const [allPages, setAllPages] = useState(true)
  const [selectionText, setSelectionText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [filename, setFilename] = useState('numbered.pdf')
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
      const buffer = await staged.file.arrayBuffer()
      const selection = allPages
        ? undefined
        : selectionText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
      const bytes = await engine.addWatermark(
        buffer,
        {
          text: buildText(format, startAt - 1),
          selection,
          fontSize,
          color,
          position,
          rotation: 0,
          opacity: 1,
          onTop: true,
          password: staged.needsPassword ? password : undefined,
        },
        (done, total, stage) => setStatus({ kind: 'working', stage, done, total }),
      )
      setStatus({ kind: 'done', bytes })
    } catch (err) {
      if (err instanceof EngineError) {
        setStatus({ kind: 'error', message: err.userMessage, code: err.code })
      } else {
        setStatus({ kind: 'error', message: String(err), code: 'ERR_INTERNAL' })
      }
    }
  }

  const blocked =
    !staged || !!staged.error || staged.needsPassword || !budget.ok || (!allPages && selectionText.trim() === '')

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, page numbers added" />

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
              Format
              <br />
              <select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
                {FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>{' '}
            <label>
              Start numbering at
              <br />
              <input
                type="number"
                value={startAt}
                onChange={(e) => setStartAt(Number(e.target.value))}
                style={{ width: '5rem' }}
              />
            </label>
          </p>

          <p>
            <label>
              Position
              <br />
              <select value={position} onChange={(e) => setPosition(e.target.value)}>
                {POSITIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>{' '}
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
              {status.kind === 'working' ? 'Numbering…' : 'Add Page Numbers'}
            </button>
            {status.kind === 'working' && <button onClick={() => engine.terminate()}>Cancel</button>}
          </div>
        </>
      )}

      {status.kind === 'working' && (
        <p className="muted">
          {status.stage} {status.total > 0 && `${status.done}/${status.total}`}
        </p>
      )}

      {status.kind === 'error' && (
        <p className="err">
          {status.message} <code>{status.code}</code>
        </p>
      )}

      {status.kind === 'done' && (
        <div className="result">
          <p>Numbered · {formatBytes(status.bytes.byteLength)}</p>
          <FilenameField value={filename} onChange={setFilename} />
          <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'numbered.pdf'))}>
            Download
          </button>
        </div>
      )}
    </>
  )
}
