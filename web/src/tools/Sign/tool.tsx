// Sign follows AddWatermark's shape (staged input -> budget check -> engine
// call with progress -> EngineError.code switch -> download) but stamps a
// captured signature image instead of text, via the new addImageWatermark
// op (engine/internal/ops/watermark.go) — api.ImageWatermarkForReader shares
// the exact same "key:value" desc syntax AddWatermark's text call already
// uses, just with scalefactor instead of points/color. See docs/tools/sign.md.
//
// The signature canvas is drawn on a fully transparent background (never
// filled) — pdfcpu embeds a PNG's alpha channel as a real /SMask (confirmed
// directly in the vendored source, not assumed), so only the ink strokes
// composite onto the page; nothing else in the document is touched, unlike
// Redact/Invert/Flatten's full-page rasterization. That's the whole point of
// this tool being a watermark-style stamp rather than another rasterize op.
//
// Selection defaults to the LAST page, not "all pages" — a contract usually
// gets signed once, on one page, not stamped identically onto every page.
// "All pages" stays available (checkbox) for a genuine per-page initial.

import { useEffect, useRef, useState } from 'react'
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

const CANVAS_W = 480
const CANVAS_H = 160

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

export default function SignTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [hasInk, setHasInk] = useState(false)
  const [position, setPosition] = useState('br')
  const [scalePercent, setScalePercent] = useState(25)
  const [rotation, setRotation] = useState(0)
  const [opacity, setOpacity] = useState(1)
  const [allPages, setAllPages] = useState(false)
  const [selectionText, setSelectionText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [filename, setFilename] = useState('signed.pdf')
  const caps = deviceCaps()

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)

  const budget = checkBudget(estimateEngineBytes(staged?.file.size ?? 0), caps)

  // Once the page count is known, default the selection to the last page —
  // the common "sign the last page of a contract" case, one keystroke away
  // from anything else.
  useEffect(() => {
    if (staged?.pages) setSelectionText(String(staged.pages))
  }, [staged?.pages])

  async function addFile(list: FileList | null) {
    const file = list?.[0]
    if (!file) return
    setStaged({ file })
    setStatus({ kind: 'idle' })
    setFilename(`${file.name.replace(/\.pdf$/i, '')}-signed.pdf`)
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

  function toCanvasCoords(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height
    return { x: clamp(x, 0, canvas.width), y: clamp(y, 0, canvas.height) }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (status.kind === 'working') return
    drawingRef.current = true
    lastPointRef.current = toCanvasCoords(e)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || !lastPointRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const p = toCanvasCoords(e)
    ctx.strokeStyle = '#111'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    lastPointRef.current = p
    setHasInk(true)
  }

  function onPointerUp() {
    drawingRef.current = false
    lastPointRef.current = null
  }

  function clearSignature() {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    setHasInk(false)
  }

  async function run() {
    if (!staged || !hasInk) return
    const canvas = canvasRef.current
    if (!canvas) return

    setStatus({ kind: 'working', stage: 'stamping', done: 0, total: 1 })
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('could not encode signature image')
      const image = await blob.arrayBuffer()
      const pdf = await staged.file.arrayBuffer()

      const selection = allPages
        ? undefined
        : selectionText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)

      const bytes = await engine.addImageWatermark(
        pdf,
        image,
        {
          selection,
          scale: scalePercent / 100,
          position,
          rotation,
          opacity,
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
    !staged ||
    !!staged.error ||
    staged.needsPassword ||
    !budget.ok ||
    !hasInk ||
    (!allPages && selectionText.trim() === '') ||
    status.kind === 'working'

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, stamped with a drawn signature" />

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
            <label>Draw your signature below</label>
          </p>
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            style={{
              width: '100%',
              maxWidth: `${CANVAS_W}px`,
              height: 'auto',
              aspectRatio: `${CANVAS_W} / ${CANVAS_H}`,
              touchAction: 'none',
              cursor: 'crosshair',
              border: '1px dashed var(--line)',
              background: 'var(--bg-subtle, transparent)',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            role="img"
            aria-label="Signature drawing area"
          />
          <div className="actions actions--plain">
            <button onClick={clearSignature} disabled={!hasInk || status.kind === 'working'}>
              Clear
            </button>
          </div>

          <fieldset>
            <legend>Placement</legend>
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
              Size (% of page width)
              <br />
              <input
                type="number"
                min={1}
                max={100}
                value={scalePercent}
                onChange={(e) => setScalePercent(clamp(Number(e.target.value), 1, 100))}
                style={{ width: '5rem' }}
              />
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
          </fieldset>

          <fieldset>
            <legend>Pages</legend>
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
            <br />
            <label>
              <input type="radio" checked={allPages} onChange={() => setAllPages(true)} /> All pages (e.g. initial
              every page)
            </label>
          </fieldset>

          <div className="actions">
            <button onClick={run} disabled={blocked}>
              {status.kind === 'working' ? 'Signing…' : 'Sign'}
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
          <p>Signed · {formatBytes(status.bytes.byteLength)}</p>
          <FilenameField value={filename} onChange={setFilename} />
          <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'signed.pdf'))}>
            Download
          </button>
        </div>
      )}
    </>
  )
}
