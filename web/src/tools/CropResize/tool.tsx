// Crop & Resize follows the Rotate shape. See docs/tools/crop-resize.md.
//
// Two independently-shaped calls (engine.crop / engine.resize) share one
// tool because they share one route in docs/TOOL_CATALOG.md — a mode toggle
// switches which one runs, not which params are visible on top of a shared
// shape. Crop trims the visible area (sets /CropBox, leaves content alone);
// Resize scales the whole page (media box AND content).

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

type Mode = 'crop' | 'resize'
type ResizeMode = 'scale' | 'pageSize' | 'dimensions'

const PAGE_SIZES = ['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid']

export default function CropResizeTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<Mode>('crop')

  // Crop fields
  const [top, setTop] = useState(0)
  const [right, setRight] = useState(0)
  const [bottom, setBottom] = useState(0)
  const [left, setLeft] = useState(0)

  // Resize fields
  const [resizeMode, setResizeMode] = useState<ResizeMode>('scale')
  const [scale, setScale] = useState(1.5)
  const [pageSize, setPageSize] = useState('A4')
  const [landscape, setLandscape] = useState(false)
  const [width, setWidth] = useState(595)
  const [height, setHeight] = useState(842)

  const [allPages, setAllPages] = useState(true)
  const [selectionText, setSelectionText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [filename, setFilename] = useState('resized.pdf')
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
      const pw = staged.needsPassword ? password : undefined
      const onProgress = (done: number, total: number, stage: string) =>
        setStatus({ kind: 'working', stage, done, total })

      const bytes =
        mode === 'crop'
          ? await engine.crop(buffer, { top, right, bottom, left, selection, password: pw }, onProgress)
          : resizeMode === 'scale'
            ? await engine.resize(buffer, { mode: 'scale', scale, selection, password: pw }, onProgress)
            : resizeMode === 'pageSize'
              ? await engine.resize(
                  buffer,
                  { mode: 'pageSize', pageSize: landscape ? `${pageSize}L` : pageSize, selection, password: pw },
                  onProgress,
                )
              : await engine.resize(buffer, { mode: 'dimensions', width, height, selection, password: pw }, onProgress)

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
    (!allPages && selectionText.trim() === '') ||
    (mode === 'resize' && resizeMode === 'scale' && (scale <= 0 || scale === 1)) ||
    (mode === 'resize' && resizeMode === 'dimensions' && (width <= 0 || height <= 0))

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, cropped or resized" />

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

          <fieldset>
            <legend>Mode</legend>
            <label>
              <input type="radio" checked={mode === 'crop'} onChange={() => setMode('crop')} /> Crop (trim visible
              area)
            </label>
            <br />
            <label>
              <input type="radio" checked={mode === 'resize'} onChange={() => setMode('resize')} /> Resize (scale
              the whole page)
            </label>
          </fieldset>

          {mode === 'crop' && (
            <p>
              <label>
                Top (pt)
                <br />
                <input
                  type="number"
                  value={top}
                  onChange={(e) => setTop(Number(e.target.value))}
                  style={{ width: '5rem' }}
                />
              </label>{' '}
              <label>
                Right (pt)
                <br />
                <input
                  type="number"
                  value={right}
                  onChange={(e) => setRight(Number(e.target.value))}
                  style={{ width: '5rem' }}
                />
              </label>{' '}
              <label>
                Bottom (pt)
                <br />
                <input
                  type="number"
                  value={bottom}
                  onChange={(e) => setBottom(Number(e.target.value))}
                  style={{ width: '5rem' }}
                />
              </label>{' '}
              <label>
                Left (pt)
                <br />
                <input
                  type="number"
                  value={left}
                  onChange={(e) => setLeft(Number(e.target.value))}
                  style={{ width: '5rem' }}
                />
              </label>
            </p>
          )}

          {mode === 'resize' && (
            <>
              <fieldset>
                <legend>Resize by</legend>
                <label>
                  <input type="radio" checked={resizeMode === 'scale'} onChange={() => setResizeMode('scale')} />{' '}
                  Scale factor
                </label>
                <br />
                <label>
                  <input
                    type="radio"
                    checked={resizeMode === 'pageSize'}
                    onChange={() => setResizeMode('pageSize')}
                  />{' '}
                  Page size
                </label>
                <br />
                <label>
                  <input
                    type="radio"
                    checked={resizeMode === 'dimensions'}
                    onChange={() => setResizeMode('dimensions')}
                  />{' '}
                  Exact dimensions
                </label>
              </fieldset>

              {resizeMode === 'scale' && (
                <p>
                  <label>
                    Scale (1 = unchanged, 2 = double, 0.5 = half)
                    <br />
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={scale}
                      onChange={(e) => setScale(Number(e.target.value))}
                      style={{ width: '6rem' }}
                    />
                  </label>
                </p>
              )}

              {resizeMode === 'pageSize' && (
                <p>
                  <label>
                    Page size
                    <br />
                    <select value={pageSize} onChange={(e) => setPageSize(e.target.value)}>
                      {PAGE_SIZES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>{' '}
                  <label>
                    <input type="checkbox" checked={landscape} onChange={(e) => setLandscape(e.target.checked)} />{' '}
                    Landscape
                  </label>
                </p>
              )}

              {resizeMode === 'dimensions' && (
                <p>
                  <label>
                    Width (pt)
                    <br />
                    <input
                      type="number"
                      min={1}
                      value={width}
                      onChange={(e) => setWidth(Number(e.target.value))}
                      style={{ width: '6rem' }}
                    />
                  </label>{' '}
                  <label>
                    Height (pt)
                    <br />
                    <input
                      type="number"
                      min={1}
                      value={height}
                      onChange={(e) => setHeight(Number(e.target.value))}
                      style={{ width: '6rem' }}
                    />
                  </label>
                </p>
              )}
            </>
          )}

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
              {status.kind === 'working' ? 'Working…' : mode === 'crop' ? 'Crop' : 'Resize'}
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
          <p>
            {mode === 'crop' ? 'Cropped' : 'Resized'} · {formatBytes(status.bytes.byteLength)}
          </p>
          <FilenameField value={filename} onChange={setFilename} />
          <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'resized.pdf'))}>
            Download
          </button>
        </div>
      )}
    </>
  )
}
