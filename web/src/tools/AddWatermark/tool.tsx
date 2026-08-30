// Add Watermark follows the Rotate/Merge shape: staged input -> device-tier
// budget check -> engine call with progress -> EngineError.code switch ->
// download. See docs/tools/add-watermark.md — the first Phase 4 tool, text
// only in V1 (image/PDF watermarks are a small follow-on, not a different
// design, per that doc's Deferred section).
//
// Rotation is always sent explicitly (0 by default), unlike pdfcpu's own CLI
// default of a diagonal placement when no rotation is given — see the doc
// for why that trade-off was made rather than adding a "diagonal" preset.

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

const POSITIONS: { value: string; label: string }[] = [
  { value: 'tl', label: 'Top left' },
  { value: 'tc', label: 'Top center' },
  { value: 'tr', label: 'Top right' },
  { value: 'l', label: 'Left' },
  { value: 'c', label: 'Center' },
  { value: 'r', label: 'Right' },
  { value: 'bl', label: 'Bottom left' },
  { value: 'bc', label: 'Bottom center' },
  { value: 'br', label: 'Bottom right' },
]

export default function AddWatermarkTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [text, setText] = useState('')
  const [fontSize, setFontSize] = useState(36)
  const [color, setColor] = useState('gray')
  const [position, setPosition] = useState('c')
  const [rotation, setRotation] = useState(0)
  const [opacity, setOpacity] = useState(0.5)
  const [onTop, setOnTop] = useState(true)
  const [allPages, setAllPages] = useState(true)
  const [selectionText, setSelectionText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [filename, setFilename] = useState('watermarked.pdf')
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
          text,
          selection,
          fontSize,
          color,
          position,
          rotation,
          opacity,
          onTop,
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
    !staged ||
    !!staged.error ||
    staged.needsPassword ||
    !budget.ok ||
    text.trim() === '' ||
    (!allPages && selectionText.trim() === '')

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, stamped with text" />

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
              Watermark text
              <br />
              <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="DRAFT, CONFIDENTIAL, …"
              />
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
                placeholder="gray, red, #808080, or 0.5 0.5 0.5"
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
              Rotation (degrees)
              <br />
              <input
                type="number"
                min={-180}
                max={180}
                value={rotation}
                onChange={(e) => setRotation(Number(e.target.value))}
                style={{ width: '5rem' }}
              />
            </label>{' '}
            <label>
              Opacity
              <br />
              <input
                type="number"
                min={0.01}
                max={1}
                step={0.05}
                value={opacity}
                onChange={(e) => setOpacity(Number(e.target.value))}
                style={{ width: '5rem' }}
              />
            </label>
          </p>

          <p>
            <label>
              <input type="checkbox" checked={onTop} onChange={(e) => setOnTop(e.target.checked)} /> Draw on top of
              page content (uncheck for a true watermark that sits behind it)
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
          </fieldset>

          <div className="actions">
            <button onClick={run} disabled={blocked || status.kind === 'working'}>
              {status.kind === 'working' ? 'Watermarking…' : 'Add Watermark'}
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
          <p>Watermarked · {formatBytes(status.bytes.byteLength)}</p>
          <FilenameField value={filename} onChange={setFilename} />
          <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'watermarked.pdf'))}>
            Download
          </button>
        </div>
      )}
    </>
  )
}
